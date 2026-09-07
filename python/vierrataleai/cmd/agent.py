import asyncio
import json
import os
import os.path
import re
import subprocess
import sys
from typing import Any, Dict, List, Optional

from ..utils.logger import logger
from ..utils.filetree import render_file_tree
from .. import config as cfg
from .executor import SafeCommandExecutor
from .tools import TOOL_EXECUTORS, dispatch_tool, make_executor, pick_package_manager

MAX_PLANNING_ROUNDS = 3
MAX_STEPS = 8

TOOL_PLAN_PROMPT = """\
You can run commands and touch files on the user's machine inside the current workspace to satisfy their request.

Reply with EXACTLY ONE JSON array of the tool calls needed to do the job, in order. Each element is one JSON object:

{"name":"run_command","command":"mkdir -p test"}
{"name":"create_file","path":"test/index.js","content":"console.log('hi')"}
{"name":"create_directory","path":"src"}
{"name":"read_file","path":"package.json"}
{"name":"list_directory","path":"."}
{"name":"delete_file","path":"old.txt"}
{"name":"download_url","url":"https://example.com/file.zip","dir":"downloads"}
{"name":"todo_add","text":"install dependencies"}
{"name":"todo_list"}
{"name":"todo_update","index":1,"done":true}
{"name":"todo_clear"}

Rules:
- run_command runs WITHOUT a shell. Allowed commands: mkdir touch ls pwd cat cp mv rm npm npx node python python3 git echo printf apt apt-get pkg.
- run_command supports arguments with spaces (quote them). No shell operators (&& | > ; etc.), no wildcards for rm, no inline -e/-c code for node/python, no paths outside the workspace.
- To create a file containing code or text, ALWAYS use create_file (never echo/cat > …). Pass the full content in "content".
- Prefer create_file over redirecting output.
- If you need to create a folder first, plan create_directory before create_file inside it.
- To download a file, web asset, archive or folder listing from the web, use download_url with the full URL. dir is optional (defaults to ~/Downloads).
- To install a system package the user asked for, use run_command with pkg (Termux/Android) or apt/apt-get (Linux), e.g. {"name":"run_command","command":"pkg install -y curl wget"}. The -y/--yes confirm flag is added automatically — never use && or sudo.
- For multi-step work, track your progress with todo_add/todo_list/todo_update (e.g. todo_add for each remaining subtask, todo_update to mark steps done).
- Code you create must be runnable. For Python servers bind to 127.0.0.1, read PORT from the environment (default 8000), and fall back to a free port (port 0) when the default is taken. HTML/CSS/JS must be self-contained and reference each other by relative filename.
- If NO tools are needed, reply exactly: NONE
- Output the JSON array only — no prose, no markdown fences unless the array is inside them."""


def tool_results_prompt(results_json: str) -> str:
    return (
        "The tools below were ALREADY executed in the workspace. Their results:\n\n"
        + results_json
        + "\n\nGive the user a short, natural reply (in the user's own language) "
          "telling them what happened. Keep the whole reply under 40 words. "
          "Do NOT tell them to run the commands yourself. "
          "If they asked for a file containing code and files were created with content, "
          "you may also emit FILE: blocks if more files are still required."
    )


# Auto error fixing: shown to the model when a tool call fails so it can emit
# a corrected plan instead of giving up. Bounded by MAX_AUTO_FIXES per run.
MAX_AUTO_FIXES = 3


def tool_fix_prompt(call: Dict[str, Any], result: Dict[str, Any]) -> str:
    failed = {
        "success": False,
        "exitCode": result.get("exit_code"),
        "stdout": result.get("stdout"),
        "stderr": result.get("stderr"),
    }
    return (
        "A tool call made while working in the workspace FAILED. Fix the problem "
        "so the original request can complete.\n\n"
        f"Failed tool call:\n{json.dumps(call, indent=2, ensure_ascii=False)}\n\n"
        f"Failure:\n{json.dumps(failed, indent=2, ensure_ascii=False)}\n\n"
        "Emit a NEW tool plan (a JSON array of tool calls) that corrects the failure — "
        "for example re-create the file with the error fixed, run a command to repair it, "
        "or download/read what is missing. If your previous plan skipped a required step "
        "(like creating a parent folder), include it. Use todo tools to track remaining "
        "subtasks if useful. Reply with exactly one JSON array, or the single word NONE "
        "if no tool call can fix this."
    )


# ---------------------------------------------------------------------- #
# Detection
# ---------------------------------------------------------------------- #

OP_PATTERNS = [
    r"\b(buat|create|make|new|touch)\b[^.!?\n]{0,40}\b(folder|dir|directory)\b",
    r"\b(buat|create|make|new|touch|tulis|write)\b[^.!?\n]{0,40}\b(file|berkas)\b",
    r"\b(hapus|delete|delete!|remove|rm|buang)\b",
    r"\b(lihat|tampilkan|show|list|ls|buka|isi)\b[^.!?\n]{0,30}\b(folder|dir|directory|isi)\b",
    r"\b(pwd|where am i|direktori|folder sekarang|folder kerja)\b",
    r"\b(ganti nama|rename|ren|pindah|move|mv)\b",
    r"\b(copy|duplicate|salin|cp)\b",
    r"\b(npm|yarn|pnpm)\s+(install|i|add|run|start|dev|test|build|init|create)\b",
    r"\b(jalankan|run|execute|exec)\b[^.!?\n]{0,20}\b(npm|node|python|git)\b",
    r"\bgit\s+(status|add|commit|push|pull|clone|init|log|diff|remote)\b",
    r"\b(buat|create|make|generate)\b[^.!?\n]{0,40}\b(project|proyek|app|aplikasi|web|website|site|situs|webpage|halaman)\b",
    r"\b(pack|kemas|satukan|taruh|simpan)\b[^.!?\n]{0,50}\b(folder|dir|directory)\b",
    r"\b(download|unduh|ambil|grab|save)\b[^.!?\n]{0,80}\b(file|gambar|image|pdf|zip|video|audio|musik|music|data|foto|photo|dokumen|document|asset|berkas|lampiran)\b",
    r"\b(download|unduh|save|simpan)\b[^.!?\n]{0,30}\b(itu|semua|ini|all|ininya|those|dari page|dari halaman|from the page|from that page)\b",
    r"https?://[^\s]+\.(?:pdf|zip|tar|gz|7z|rar|docx?|xlsx?|pptx?|mp[34]|wav|ogg|csv|json|png|jpe?g|gif|webp|svg)\b",
]

_OP_RE = [re.compile(p, re.I) for p in OP_PATTERNS]


def looks_like_operation_request(text: str) -> bool:
    return any(p.search(text or "") for p in _OP_RE)


# ---------------------------------------------------------------------- #
# Tool-plan parsing
# ---------------------------------------------------------------------- #

_TOKEN = r"[A-Za-z0-9_./-]+"
_FILLERS = "(?:lalu|dan|didalamnya|di dalamnya|dengan|untuk|baru|dulu|ya|please|then|and|inside|new)"


def normalize_tool_call(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict) or not isinstance(raw.get("name"), str):
        return None
    name = raw["name"]
    if name not in TOOL_EXECUTORS:
        return None
    if name == "run_command":
        if not isinstance(raw.get("command"), str) or not raw["command"].strip():
            return None
        return {"name": name, "params": {"command": raw["command"]}}
    if name in {"create_file"}:
        if not isinstance(raw.get("path"), str) or not raw["path"].strip():
            return None
        return {"name": name, "params": {"path": raw["path"], "content": str(raw.get("content", ""))}}
    if name in {"create_directory", "read_file", "delete_file", "list_directory"}:
        if not isinstance(raw.get("path"), str):
            return None
        return {"name": name, "params": {"path": raw["path"]}}
    if name == "download_url":
        if not isinstance(raw.get("url"), str) or not raw["url"].strip():
            return None
        params: Dict[str, Any] = {"url": raw["url"]}
        if isinstance(raw.get("dir"), str) and raw["dir"].strip():
            params["dir"] = raw["dir"].strip()
        return {"name": name, "params": params}
    if name == "todo_add":
        if not isinstance(raw.get("text"), str) or not raw["text"].strip():
            return None
        return {"name": name, "params": {"text": raw["text"]}}
    if name == "todo_update":
        if not str(raw.get("index", "")).strip().isdigit():
            return None
        params = {"index": int(raw["index"])}
        if isinstance(raw.get("done"), bool):
            params["done"] = raw["done"]
        if isinstance(raw.get("text"), str) and raw["text"].strip():
            params["text"] = raw["text"]
        return {"name": name, "params": params}
    if name in {"todo_list", "todo_clear"}:
        return {"name": name, "params": {}}
    return None


def parse_tool_plan(text: str) -> List[Dict[str, Any]]:
    t = (text or "").strip()
    if not t:
        return []
    if re.match(r"^\s*NONE\b", t, re.I):
        return []

    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", t, re.I)
    candidate = fenced.group(1) if fenced else t

    arr_m = re.search(r"\[[\s\S]*\]", candidate)
    obj_m = re.search(r"\{[\s\S]*\}", candidate)
    parsed = None
    if arr_m:
        try:
            parsed = json.loads(arr_m.group(0))
        except Exception:
            parsed = None
    if parsed is None and obj_m:
        try:
            parsed = [json.loads(obj_m.group(0))]
        except Exception:
            parsed = None
    if not isinstance(parsed, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in parsed:
        n = normalize_tool_call(item)
        if n:
            out.append(n)
    return out


# ---------------------------------------------------------------------- #
# Heuristic fallback
# ---------------------------------------------------------------------- #

def _named_token(text: str, pattern: str) -> Optional[str]:
    m = re.search(pattern, text, re.I)
    if not m:
        return None
    raw = m.group(m.lastindex or 1).strip()
    if not raw or re.fullmatch(_FILLERS, raw, re.I):
        return None
    return raw


def _code_named_file(text: str) -> Optional[str]:
    m = re.search(r"([\w.-]+\.(?:html?|css|js|jsx|ts|tsx|json|md|txt|py|php|rb|go|yaml|yml|sh|csv|sql))", text, re.I)
    return m.group(1) if m else None


def _strip_qualifier(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    stripped = re.sub(r"^(named|called|bernama|berjudul|dengan nama|menjadi|as|to)\s*", "", value, flags=re.I).strip()
    return stripped or None


def _scaffold_files(text: str) -> List[Dict[str, Any]]:
    lower = text.lower()
    kind_m = re.search(r"\b(react|node|nodejs|python|py|next|vue|vite)\b", lower)
    kind = kind_m.group(1) if kind_m else None
    named = re.search(r"\b(project|proyek|app)\b\s+(?:sederhana|simple|baru|dengan|menggunakan)?\s*([A-Za-z0-9_-]+)", text, re.I)
    base = (named.group(2) if named else "").replace("/", "-").strip("-") if named else ""
    base = re.sub(r"[^a-z0-9._-]", "", base, flags=re.I) or ""
    prefix = (base + "/") if base else ""
    files: List[Dict[str, Any]] = []

    if kind in {"react", "vue", "vite"}:
        app_name = base or "my-app"
        if kind == "vue":
            files += [
                {"name": "create_file", "params": {"path": f"{app_name}/package.json", "content": json.dumps({
                    "name": app_name, "version": "1.0.0", "private": True, "type": "module",
                    "scripts": {"dev": "vite", "build": "vite build"},
                    "dependencies": {"vue": "^3.5.0"},
                    "devDependencies": {"@vitejs/plugin-vue": "^5.1.0", "vite": "^5.4.8"}
                }, indent=2) + "\n"}},
                {"name": "create_file", "params": {"path": f"{app_name}/index.html", "content": (
                    '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n'
                    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n'
                    f'  <title>{_title_case(app_name.replace("_", " "))}</title>\n'
                    '</head>\n<body>\n  <div id="app"></div>\n  <script type="module" src="/src/main.js"></script>\n</body>\n</html>\n'
                )}},
                {"name": "create_file", "params": {"path": f"{app_name}/src/main.js", "content": "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')\n"}},
                {"name": "create_file", "params": {"path": f"{app_name}/src/App.vue", "content": '<template>\n  <div class="app">\n    <h1>Welcome to Vue</h1>\n    <p>Built with Vue 3 + Vite.</p>\n  </div>\n</template>\n'}},
            ]
        else:
            files += [{"name": "create_directory", "params": {"path": app_name}}]
            files += _tsx_url(app_name, _title_case(app_name.replace("_", " ")), "")
        return files

    if kind in {"python", "py"}:
        return [{"name": "create_file", "params": {"path": prefix + "app.py", "content": "print('hello')\n"}}]
    if kind in {"node", "nodejs"}:
        app_name = base or "my-app"
        return [
            {"name": "create_file", "params": {"path": prefix + "package.json", "content": json.dumps({
                "name": app_name, "version": "1.0.0", "type": "module", "main": "index.js",
                "scripts": {"start": "node index.js"}
            }, indent=2) + "\n"}},
            {"name": "create_file", "params": {"path": prefix + "index.js", "content": f"console.log('Hello from {app_name}')\n"}},
        ]
    if named:
        return [{"name": "create_directory", "params": {"path": named.group(2).strip()}}]
    return []


def _folder_plan_name(text: str) -> str:
    m = re.search(
        r"\b(?:folder|dir|directory|into|inside|bernama|named)\b\s+(?:a\s+|the\s+|an\s+|new\s+|baru\s+)?([A-Za-z0-9_.-]+)",
        text,
        re.I,
    )
    name = m.group(1) if m else ""
    if re.fullmatch(r"(a|an|the|new|baru|folder|dir|directory|into|inside|named|bernama)", name, re.I):
        return ""
    return name


_WEB_TITLE_STOP = {"a", "an", "the", "of", "for", "in", "on", "to", "from", "with", "and", "or", "at", "into", "about"}


def _title_case(value: str) -> str:
    words = [w for w in re.split(r"[_\- ]+", value or "") if w]
    out = []
    for i, w in enumerate(words):
        lw = w.lower()
        if i > 0 and lw in _WEB_TITLE_STOP:
            out.append(lw)
        else:
            out.append(lw[:1].upper() + lw[1:])
    return " ".join(out)


def _escape_html(value) -> str:
    return (
        str(value or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _sanitize_web(name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", str(name or ""))
    safe = safe.strip("-")[:60]
    return safe or "webapp"


_TOPIC_STOP = {"a", "an", "the", "my", "our", "your", "his", "her", "its", "new", "sebuah"}


def _web_topic_name(text: str) -> str:
    raw = text or ""
    m = re.search(r"\b(?:tentang|mengenai|about)\s+([A-Za-z0-9][A-Za-z0-9 _-]{0,23})", raw, re.I)
    if not m:
        m = re.search(r"\b(?:bernama|berjudul|dengan nama|named|called)\s+([A-Za-z0-9][A-Za-z0-9 _-]{0,23})", raw, re.I)
    if not m:
        m = re.search(
            r"\b(?:buat|create|make|generate|bikin)\b[^.!?\n]{0,24}(?:(?:me|saya|aku)\s+)?(?:a|an|sebuah|satu)\s+([A-Za-z0-9][A-Za-z0-9 _-]{0,23})(?=\s+(?:web\s*(?:app|page|site)?|website|situs|webpage|halaman)\b)",
            raw,
            re.I,
        )
    if not m:
        return ""
    first = m.group(1).strip().split()[0].lower()
    if first in _TOPIC_STOP:
        return ""
    return m.group(1).strip()[:24]


def _web_stack(text: str) -> Dict[str, bool]:
    t = text or ""
    node = bool(re.search(r"\bnode(js)?\b|express", t, re.I))
    tsx = bool(re.search(r"\breact\b|\btsx\b|\btypescript\b|\bts\b", t, re.I))
    return {"node": node, "python": not node, "js": True, "tsx": tsx}


_WEB_SECTIONS = ["about", "features", "gallery", "stats", "contact"]

_WEB_SECTION_LABELS = {
    "about": "About",
    "features": "Features",
    "gallery": "Gallery",
    "stats": "Stats",
    "contact": "Contact",
}

_PALETTES = {
    "purple": {"accent": "#7c3aed", "accent2": "#06b6d4"},
    "blue": {"accent": "#2563eb", "accent2": "#06b6d4"},
    "cyan": {"accent": "#0891b2", "accent2": "#38bdf8"},
    "green": {"accent": "#059669", "accent2": "#34d399"},
    "amber": {"accent": "#d97706", "accent2": "#f59e0b"},
    "rose": {"accent": "#e11d48", "accent2": "#fb7185"},
    "pink": {"accent": "#db2777", "accent2": "#a855f7"},
    "orange": {"accent": "#ea580c", "accent2": "#fbbf24"},
    "slate": {"accent": "#64748b", "accent2": "#94a3b8"},
}


def _web_style_name(text: str) -> str:
    t = text or ""
    if re.search(r"\b(minimal|simple|simplistic|simplify)\b", t, re.I) and not re.search(r"\b(dark|gelap)\b", t, re.I):
        return "minimal"
    if re.search(r"\b(light|terang|bright|clean|pastel|white)\b", t, re.I) and not re.search(r"\b(dark|gelap)\b", t, re.I):
        return "light"
    return "dark"


def _web_palette(text: str) -> Dict[str, str]:
    t = (text or "").lower()
    order = [
        (r"purple|violet|ungu", "purple"),
        (r"blue|biru", "blue"),
        (r"cyan|teal", "cyan"),
        (r"green|emerald|hijau", "green"),
        (r"gold|amber|yellow|kuning", "amber"),
        (r"red|rose|merah", "rose"),
        (r"pink", "pink"),
        (r"orange|oranye", "orange"),
        (r"gray|grey|slate|abu", "slate"),
    ]
    for pattern, key in order:
        if re.search(pattern, t):
            return dict(_PALETTES[key])
    hexm = re.search(r"#([0-9a-f]{6})\b", t, re.I)
    if hexm:
        return {"accent": "#" + hexm.group(1).lower(), "accent2": "#06b6d4"}
    return dict(_PALETTES["purple"])


def _hex_to_rgb(hex_: str):
    m = re.match(r"^#?([0-9a-f]{6})$", (hex_ or "").strip(), re.I)
    if not m:
        return None
    n = int(m.group(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]


def _rgb_string(hex_: str, default) -> str:
    rgb = _hex_to_rgb(hex_) or default
    return ", ".join(str(c) for c in rgb)


# Renders the stylesheet from a design config. With the default values the
# output is byte-identical to the base stylesheet.
def _web_css(accent: str = "#7c3aed", accent2: str = "#06b6d4", style: str = "dark") -> str:
    a = _rgb_string(accent, [124, 58, 237])
    b = _rgb_string(accent2, [6, 182, 212])
    light_a = "0.06" if style == "minimal" else "0.12"
    light_b = "0.05" if style == "minimal" else "0.1"
    css = _WEB_STYLE_CSS
    css = css.replace("--accent: #7c3aed;", f"--accent: {accent};")
    css = css.replace("--accent-2: #06b6d4;", f"--accent-2: {accent2};")
    css = css.replace("rgba(124, 58, 237, 0.35)", f"rgba({a}, 0.35)")
    css = css.replace("rgba(6, 182, 212, 0.25)", f"rgba({b}, 0.25)")
    css = css.replace("rgba(6, 182, 212, 0.08)", f"rgba({b}, 0.08)")
    css = css.replace("rgba(124, 58, 237, 0.12)", f"rgba({a}, {light_a})")
    css = css.replace("rgba(6, 182, 212, 0.1)", f"rgba({b}, {light_b})")
    return css


# Cheap, reliable design config derived directly from the request text. Used
# when the AI model is unavailable or fails to return a JSON config.
def _probe_web_config(text: str, folder_name: str = "") -> Dict[str, Any]:
    topic = _web_topic_name(text)
    folder = folder_name or _folder_plan_name(text) or _sanitize_web(topic or "webapp")
    name_base = topic or ("Webapp" if folder == "webapp" else re.sub(r"[_]+", " ", folder))
    palette = _web_palette(text)
    return {
        "name": _title_case(name_base),
        "folder": folder,
        "topic": topic,
        "description": "",
        "style": _web_style_name(text),
        "accent": palette["accent"],
        "accent2": palette["accent2"],
        "sections": list(_WEB_SECTIONS),
    }


WEB_CONFIG_PROMPT = """\
You are a web designer. The user asked to build a website. Reply with ONLY a compact JSON object (no markdown fences, no commentary) in exactly this shape:

{"name":"SiteTitle","description":"one upbeat sentence for the hero","accent":"#7c3aed","accent2":"#06b6d4"}

Rules:
- name: short site title, max 40 chars, no quote or angle-bracket characters.
- description: one friendly sentence describing the site for the hero, max 160 chars, and it must not contain any double-quote, angle-bracket, ampersand or backslash characters.
- accent and accent2: 6-digit hex colors that work together. Use the colors the user names when they name any.
Honour any name, style and colors the user gives in their request. Keep it short - the JSON only, under 120 words in total."""


def _normalize_web_config(raw: str, fallback: Dict[str, Any]) -> Dict[str, Any]:
    cleaned = re.sub(r"```[a-z]*\n?", "", raw or "", flags=re.I).replace("```", "").strip()
    obj = None
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0 and end > start:
        try:
            obj = json.loads(cleaned[start : end + 1])
        except (ValueError, TypeError):
            obj = None
    if not isinstance(obj, dict):
        obj = {}

    def s(value, limit):
        if isinstance(value, str) and value.strip():
            return value.strip()[:limit]
        return ""

    raw_sections = []
    if isinstance(obj.get("sections"), list):
        seen = set()
        for item in obj["sections"]:
            val = s(item, 40)
            if val in _WEB_SECTIONS and val not in seen:
                seen.add(val)
                raw_sections.append(val)
    style = obj.get("style") if isinstance(obj.get("style"), str) and obj["style"] in ("dark", "light", "minimal") else fallback["style"]
    accent = obj.get("accent") if _hex_to_rgb(obj.get("accent")) else fallback["accent"]
    accent2 = obj.get("accent2") if _hex_to_rgb(obj.get("accent2")) else fallback["accent2"]
    return {
        "name": s(obj.get("name"), 40) or fallback["name"],
        "folder": _sanitize_web(s(obj.get("folder"), 40) or fallback["folder"]),
        "topic": s(obj.get("topic"), 40) or fallback["topic"],
        "description": s(obj.get("description"), 160) or "",
        "style": style,
        "accent": str(accent).lower() if _hex_to_rgb(accent) else fallback["accent"],
        "accent2": str(accent2).lower() if _hex_to_rgb(accent2) else fallback["accent2"],
        "sections": raw_sections or fallback["sections"],
    }


# Asks the model for the site's design config. Returns None when the provider
# is missing or the answer is unusable, so callers can fall back to probing.
async def _web_design_config(provider: Any, messages: List[Dict[str, Any]], request_text: str) -> Optional[Dict[str, Any]]:
    if provider is None or not callable(getattr(provider, "complete", None)):
        return None
    try:
        raw = await _complete_web_config(provider, messages, request_text, WEB_CONFIG_PROMPT)
    except Exception as err:
        logger.log("PLAN", f"web AI design config unavailable ({err}); using heuristic design")
        return None
    return _normalize_web_config(raw or "", _probe_web_config(request_text))


# Runs a short, bounded request to the design model and returns the raw reply,
# or raises when the provider is missing, the request errors or the 15s budget
# is exceeded. Callers fall back to heuristics when it raises.
async def _complete_web_config(provider: Any, messages: List[Dict[str, Any]], request_text: str, system_prompt: str) -> str:
    comp = getattr(provider, "complete", None)
    if comp is None or not callable(comp):
        raise RuntimeError("no design provider")
    history = messages[-6:] if messages else []
    timeout_ms = min(int(cfg.get("plan_timeout_ms") or 120000), 15000)
    plan_opts = {"model": cfg.get_effective_model(provider.name), "system_prompt": system_prompt, "max_tokens": 150}

    def worker() -> str:
        sync = getattr(provider, "_complete_sync", None)
        if callable(sync):
            return sync([*history, {"role": "user", "content": request_text}], plan_opts)
        coro = comp([*history, {"role": "user", "content": request_text}], plan_opts)
        if asyncio.iscoroutine(coro):
            return asyncio.run(coro)
        return coro

    return await asyncio.wait_for(asyncio.to_thread(worker), timeout=timeout_ms / 1000.0)


# ---------------------------------------------------------------------- #
# Refine-after-build: the user tweaks the site they already got
# (colours, theme, title, sections...) and we re-render it in place.
# ---------------------------------------------------------------------- #

def _web_refine_prompt(base: Dict[str, Any]) -> str:
    return (
        "You are a web designer editing an existing website. Current site: name = "
        f'"{base.get("name", "")}", theme = {base.get("style", "dark")}, '
        f'accent color = {base.get("accent", "#7c3aed")}, accent2 = {base.get("accent2", "#06b6d4")}. '
        "The user asked to change this site. Reply with ONLY a JSON object (no markdown fences, no commentary) "
        "that contains ONLY the keys that should change, from this set:\n"
        '{"name":"SiteTitle","description":"one upbeat sentence for the hero","accent":"#7c3aed","accent2":"#06b6d4"}\n'
        "Rules:\n"
        "- name: short site title, max 40 chars, no quote or angle-bracket characters.\n"
        "- description: one friendly sentence for the hero, max 160 chars, and it must not contain any double-quote, angle-bracket, ampersand or backslash characters.\n"
        "- accent and accent2: 6-digit hex colors that work together.\n"
        "Honour only what the user asks to change; leave everything else exactly as-is. "
        "Keep it short - the JSON only, under 120 words in total."
    )


def _last_built_web_folder(messages: Optional[List[Dict[str, Any]]]) -> Optional[str]:
    last = None
    for m in messages or []:
        content = ""
        if isinstance(m, dict):
            raw = m.get("content", "")
            content = raw if isinstance(raw, str) else json.dumps(raw)
        else:
            content = str(m)
        matches = re.findall(r"([A-Za-z0-9_.-]+/index\.html)", content)
        if matches:
            last = matches[-1]
    if not last:
        return None
    return re.sub(r"/index\.html$", "", last, flags=re.I).replace("\\", "/")


_WEB_REFINE_CHANGE_VERB = re.compile(
    r"\b(make|set|switch|change|turn|convert|update|re-?color|re-?style|re-?design|add|remove|delete|drop|hide|use|apply|adjust|repaint|restyle|recolor|redesign)\b",
    re.I,
)
_WEB_REFINE_TARGET = re.compile(
    r"\b(it|this|the site|the website|the web\s*site|the web\s*page|the page|the design|the layout|the title|the name|the brand|the background|the theme|the colou?rs?|the accen?t|the text|the home(?:page)?|my site|my website|our site|our website)\b"
    r"|\b(section|page|theme|mode|colou?r|palette|accent|style|title|name|background|font|dark|light|minimal|blue|red|green|purple|orange|yellow|pink|cyan|teal|indigo|violet|silver|gold|slate|gray|grey|black|white|neon)\b",
    re.I,
)
_WEB_REFINE_QUESTION = re.compile(
    r"^\s*(what|which|whose|does|did|is|are|was|were|how\s+(many|much|do|fast|long)|why|when|where|can\s+you\s+(tell|describe|show|explain))\b",
    re.I,
)
# Fresh website / folder / file / project builds belong to the normal plan path.
_WEB_REFINE_FRESH_BUILD = re.compile(
    r"\b(buat|create|make|generate|new|touch)\b[^.!?\n]{0,40}\b(folder|dir|directory|file|berkas|project|proyek|app|aplikasi|web\s*(app|page|site)?|website|site|situs|webpage|halaman)\b",
    re.I,
)


def _web_refine_request(text: str, messages: Optional[List[Dict[str, Any]]]) -> Optional[str]:
    t = (text or "").strip()
    if not t:
        return None
    if _WEB_REFINE_QUESTION.match(t):
        return None
    if _WEB_REFINE_FRESH_BUILD.search(t):
        return None
    if not _WEB_REFINE_CHANGE_VERB.search(t):
        return None
    if not _WEB_REFINE_TARGET.search(t):
        return None
    return _last_built_web_folder(messages)


# Re-derives the design config of an already-built site straight off disk.
def _web_config_from_folder(cwd: Optional[str], folder: str) -> Optional[Dict[str, Any]]:
    base_dir = os.path.join(cwd or ".", folder)

    def read(name: str) -> str:
        try:
            with open(os.path.join(base_dir, name), encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            return ""

    html = read("index.html")
    if not html:
        return None
    css = read("style.css")

    def dec(s: str) -> str:
        return s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')

    title_m = re.search(r"<title>([^<]*)</title>", html, re.I)
    name = dec(title_m.group(1) if title_m else "").strip()[:40] or _title_case(_sanitize_web(folder))
    hero_m = re.search(r'<p class="hero-sub">(.*?)</p>', html, re.S)
    description = ""
    if hero_m:
        d = dec(hero_m.group(1)).strip()
        if not re.match(r"^Everything you need to know about ", d, re.I) and not re.match(r"^A beautifully designed page", d, re.I):
            description = d[:200]
    style = "light" if 'data-theme="light"' in html else "dark"
    sections = [sid for sid in _WEB_SECTIONS if f'id="{sid}"' in html]
    accent_m = re.search(r"--accent:\s*#([0-9a-fA-F]{6})\b", css)
    accent2_m = re.search(r"--accent-2:\s*#([0-9a-fA-F]{6})\b", css)
    if read("src/App.tsx") or read("tsconfig.json"):
        backend = "tsx"
    elif read("server.js") or read("package.json"):
        backend = "node"
    else:
        backend = "python"
    return {
        "name": name,
        "folder": folder,
        "topic": "",
        "description": description,
        "style": style,
        "accent": "#" + accent_m.group(1).lower() if accent_m else "#7c3aed",
        "accent2": "#" + accent2_m.group(1).lower() if accent2_m else "#06b6d4",
        "sections": sections or list(_WEB_SECTIONS),
        "backend": backend,
    }


_WEB_COLOR_HINTS = [
    (re.compile(r"purple|violet|ungu"), "purple"),
    (re.compile(r"blue|biru|azure"), "blue"),
    (re.compile(r"cyan|teal"), "cyan"),
    (re.compile(r"green|emerald|hijau|lime"), "green"),
    (re.compile(r"gold|amber|yellow|kuning"), "amber"),
    (re.compile(r"red|rose|merah|maroon|crimson"), "rose"),
    (re.compile(r"pink"), "pink"),
    (re.compile(r"orange|oranye"), "orange"),
    (re.compile(r"gray|grey|slate|abu|silver|black|white"), "slate"),
]


def _palette_from_text(text: str, fallback_accent2: str) -> Optional[Dict[str, str]]:
    t = (text or "").lower()
    for pattern, key in _WEB_COLOR_HINTS:
        if pattern.search(t):
            return {"accent": _PALETTES[key]["accent"], "accent2": _PALETTES[key]["accent2"]}
    hexm = re.search(r"#([0-9a-f]{6})\b", t, re.I)
    if hexm:
        return {"accent": "#" + hexm.group(1).lower(), "accent2": fallback_accent2}
    return None


_WEB_SECTION_ALIASES = {
    "about": ["about", "about us", "overview", "intro", "pengenalan", "kenalan", "tentang"],
    "features": ["features", "services", "feature", "fitur", "keunggulan"],
    "gallery": ["gallery", "portfolio", "portofolio", "galeri", "photos", "images"],
    "stats": ["stats", "statistics", "statistik", "angka", "numbers", "metrics"],
    "contact": ["contact", "kontak", "hubungi", "reach"],
}


# Applies the deterministic, prompt-derived edit hints on top of the current
# site config (baseline from disk).
def _apply_web_refine_hints(text: str, base: Dict[str, Any]) -> Dict[str, Any]:
    t = text or ""
    cfg = dict(base)
    cfg["topic"] = base.get("topic") or ""

    pal = _palette_from_text(t, cfg.get("accent2", "#06b6d4"))
    if pal:
        cfg["accent"], cfg["accent2"] = pal["accent"], pal["accent2"]

    if re.search(r"\b(light|dark|minimal|bright|clean|pastel|white|terang|gelap|simpl(e|istic|ify)|night|midnight)\b", t, re.I):
        cfg["style"] = _web_style_name(t)

    qm = re.search(
        r'(?:change|rename|set|update|make)\b[^.!?\n]{0,30}\b(?:the\s+)?(?:title|name|brand)\b[^.!?\n]{0,24}\b(?:to|as|:|be|into)\b[^.!?\n]{0,6}"([^"]{1,40})"',
        t,
        re.I,
    )
    um = re.search(
        r'(?:change|rename|set|update|make)\b[^.!?\n]{0,30}\b(?:the\s+)?(?:title|name|brand)\b[^.!?\n]{0,24}\b(?:to|as|:|be|into)\b[^.!?\n]{0,2}\b([A-Za-z0-9][\w &!\'-]{1,40})\b',
        t,
        re.I,
    )
    title_match = qm or um
    if title_match:
        nm = re.sub(r"[.!?\n]+$", "", title_match.group(1)).strip()
        if nm:
            cfg["name"] = nm[:40]

    add_sw = re.compile(r"\b(add|include|insert|put|bring|with|plus|and)\b", re.I)
    rem_sw = re.compile(r"\b(remove|delete|drop|hide|cut|without|lose|minus)\b", re.I)
    adds: List[str] = []
    rems: List[str] = []
    for sid, names in _WEB_SECTION_ALIASES.items():
        for name in names:
            for m in re.finditer(r"\b" + re.escape(name) + r"\b", t, re.I):
                before = t[max(0, m.start() - 26):m.start()]
                after = t[m.end():m.end() + 12]
                if rem_sw.search(before) or rem_sw.search(after):
                    if sid not in rems:
                        rems.append(sid)
                elif add_sw.search(before) or add_sw.search(after):
                    if sid not in adds:
                        adds.append(sid)
    sections = list(cfg.get("sections") or _WEB_SECTIONS)
    for sid in adds:
        if sid not in sections:
            sections.append(sid)
    for sid in rems:
        sections = [s for s in sections if s != sid]
    cfg["sections"] = sections
    return cfg


# Re-renders an already-built site in place from the refined config. Returns
# None when there is no previous site to refine.
async def _web_refine(provider: Any, messages: List[Dict[str, Any]], request_text: str, cwd: str) -> Optional[List[Dict[str, Any]]]:
    folder = _web_refine_request(request_text, messages)
    if not folder:
        return None
    base = _web_config_from_folder(cwd, folder)
    if not base:
        return None
    cfg = _apply_web_refine_hints(request_text, base)
    try:
        raw = await _complete_web_config(provider, messages, request_text, _web_refine_prompt(base))
    except Exception:
        raw = ""
    if raw:
        got = _normalize_web_config(raw or "", cfg)
        if got.get("name") and got["name"] != cfg["name"]:
            cfg["name"] = got["name"]
        if got.get("description"):
            cfg["description"] = got["description"]
        if got.get("accent") and got["accent"] != cfg["accent"]:
            cfg["accent"] = got["accent"]
        if got.get("accent2") and got["accent2"] != cfg["accent2"]:
            cfg["accent2"] = got["accent2"]
        logger.log("PLAN", "web refine (AI design config)")
    else:
        logger.log("PLAN", "web refine (heuristic design)")
    hint = _web_stack(request_text)
    tsx = hint["tsx"]
    node = hint["node"] or base["backend"] == "node"
    stack = {"tsx": tsx, "js": True, "node": (not tsx) and node, "python": True}
    stack["python"] = (not tsx) and (not stack["node"])
    logger.log("PLAN", f"plan: web refine {folder}")
    return _render_web_plan(cfg, request_text, stack)


# True when a plan looks like an actual generated website (an index.html inside
# a folder plus at least one web file: stylesheet, backend or TSX config).
def _is_web_site_plan(plan: List[Dict[str, Any]]) -> bool:
    if not plan:
        return False
    files = [
        (str(call.get("params", {}).get("path", "") or "")).replace("\\", "/")
        for call in plan
        if call.get("name") == "create_file" and isinstance(call.get("params"), dict)
    ]
    if not any(p.endswith("/index.html") for p in files):
        return False
    return any(
        re.search(r"(?:^|/)(?:style\.css|app\.py|tsconfig\.json|server\.js|src/styles\.css)$", p)
        for p in files
    )



_WEB_STYLE_CSS = """\
:root {
  --bg: #0b1020;
  --bg-soft: #121a33;
  --card: #151d3a;
  --text: #e7ecf8;
  --muted: #94a3c8;
  --accent: #7c3aed;
  --accent-2: #06b6d4;
  --border: rgba(255, 255, 255, 0.08);
  --radius: 16px;
  --shadow: 0 18px 45px rgba(0, 0, 0, 0.35);
  --nav-h: 3.8rem;
}
html[data-theme="light"] {
  --bg: #f4f6fb;
  --bg-soft: #e7ecf6;
  --card: #ffffff;
  --text: #16213a;
  --muted: #5a6a8f;
  --border: rgba(22, 33, 58, 0.12);
  --shadow: 0 18px 45px rgba(22, 33, 58, 0.12);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background:
    radial-gradient(1200px 600px at 80% -10%, rgba(124, 58, 237, 0.35), transparent 60%),
    radial-gradient(900px 500px at 10% 0%, rgba(6, 182, 212, 0.25), transparent 55%),
    var(--bg);
  color: var(--text);
  line-height: 1.6;
}
html[data-theme="light"] body {
  background:
    radial-gradient(1200px 600px at 80% -10%, rgba(124, 58, 237, 0.12), transparent 60%),
    radial-gradient(900px 500px at 10% 0%, rgba(6, 182, 212, 0.1), transparent 55%),
    var(--bg);
}
::selection { background: var(--accent); color: #fff; }
a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 3px solid var(--accent-2); outline-offset: 2px;
}
.container { width: min(1080px, 92%); margin: 0 auto; }
h1, h2, h3 { line-height: 1.15; margin: 0 0 0.5em; }
h2 { font-size: clamp(1.6rem, 3vw, 2.2rem); }
section { scroll-margin-top: var(--nav-h); }
.site-header {
  position: sticky; top: 0; z-index: 50;
  background: rgba(11, 16, 32, 0.75);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  transition: box-shadow 0.25s ease;
}
html[data-theme="light"] .site-header { background: rgba(244, 246, 251, 0.8); }
.site-header.scrolled { box-shadow: 0 6px 22px rgba(0, 0, 0, 0.3); }
html[data-theme="light"] .site-header.scrolled { box-shadow: 0 6px 22px rgba(22, 33, 58, 0.12); }
.nav { display: flex; align-items: center; justify-content: space-between; padding: 0.8rem 0; }
.brand {
  font-size: 1.15rem; font-weight: 800; color: var(--text);
  text-decoration: none; letter-spacing: -0.02em;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.nav-links { display: flex; align-items: center; gap: 1.3rem; list-style: none; margin: 0; padding: 0; }
.nav-links li { display: flex; }
.nav-links a { color: var(--muted); text-decoration: none; font-weight: 600; transition: color 0.2s; }
.nav-links a:hover { color: var(--text); }
.nav-toggle { display: none; background: none; border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 0.4rem 0.7rem; cursor: pointer; }
.theme-toggle {
  background: rgba(255, 255, 255, 0.06); color: var(--text);
  border: 1px solid var(--border); border-radius: 999px;
  padding: 0.35rem 0.8rem; font: inherit; font-size: 0.8rem; font-weight: 700;
  cursor: pointer; transition: background 0.2s, box-shadow 0.2s;
}
.theme-toggle:hover { background: rgba(255, 255, 255, 0.14); }
html[data-theme="light"] .theme-toggle { background: rgba(22, 33, 58, 0.06); }
html[data-theme="light"] .theme-toggle:hover { background: rgba(22, 33, 58, 0.12); }
.hero { padding: clamp(3.5rem, 9vw, 7rem) 0 3.5rem; text-align: center; }
.hero-eyebrow {
  display: inline-flex; gap: 0.5rem; font-size: 0.8rem; font-weight: 600;
  color: var(--accent-2); letter-spacing: 0.08em; text-transform: uppercase;
  border: 1px solid var(--border); padding: 0.35rem 0.8rem; border-radius: 999px;
  background: rgba(6, 182, 212, 0.08);
}
.hero h1 {
  font-size: clamp(2.4rem, 6vw, 4.2rem); letter-spacing: -0.03em; margin: 0.8rem 0;
  background: linear-gradient(100deg, #fff 20%, #c4b5fd 50%, #67e8f9 80%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
html[data-theme="light"] .hero h1 {
  background: linear-gradient(100deg, #16213a 20%, #7c3aed 50%, #06b6d4 80%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.hero-sub { color: var(--muted); font-size: clamp(1rem, 2vw, 1.2rem); max-width: 620px; margin: 0 auto 1.8rem; }
.hero-actions { display: flex; gap: 0.9rem; justify-content: center; flex-wrap: wrap; }
.btn {
  display: inline-block; padding: 0.75rem 1.4rem; border-radius: 12px;
  font-weight: 700; text-decoration: none; transition: transform 0.15s, box-shadow 0.15s;
}
.btn:hover { transform: translateY(-2px); }
.btn-primary {
  color: #fff; background: linear-gradient(90deg, var(--accent), var(--accent-2));
  box-shadow: 0 8px 24px rgba(124, 58, 237, 0.35);
}
.btn-ghost { color: var(--text); border: 1px solid var(--border); background: rgba(255, 255, 255, 0.04); }
html[data-theme="light"] .btn-ghost { background: rgba(22, 33, 58, 0.04); }
.section { padding: clamp(2.5rem, 6vw, 4.5rem) 0; }
.section.alt { background: var(--bg-soft); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 2.5rem; align-items: center; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.2rem; margin-top: 1.5rem; }
.card, .stat-card {
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 1.4rem; box-shadow: var(--shadow);
}
.card h3 { margin-top: 0.2rem; }
.card .num, .stat-card strong {
  color: transparent; background: linear-gradient(90deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text; background-clip: text;
}
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1.2rem; margin-top: 1.5rem; }
.stat-card strong { font-size: 2rem; display: block; }
.stat-card span { color: var(--muted); font-size: 0.9rem; }
.gallery-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-top: 1.5rem; }
.tile {
  aspect-ratio: 16 / 10; border-radius: var(--radius); border: 1px solid var(--border);
  display: flex; align-items: flex-end; padding: 1rem;
  color: #fff; font-weight: 800; letter-spacing: 0.02em;
  background:
    linear-gradient(135deg, rgba(124, 58, 237, 0.9), rgba(6, 182, 212, 0.75)),
    radial-gradient(circle at 25% 25%, rgba(255, 255, 255, 0.4), transparent 45%);
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}
.tile.t2 { background: linear-gradient(135deg, rgba(6, 182, 212, 0.9), rgba(34, 211, 238, 0.7)); }
.tile.t3 { background: linear-gradient(135deg, rgba(217, 70, 239, 0.9), rgba(124, 58, 237, 0.7)); }
.tile.t4 { background: linear-gradient(135deg, rgba(16, 185, 129, 0.9), rgba(6, 182, 212, 0.7)); }
.tile:hover { transform: translateY(-6px); box-shadow: var(--shadow); }
.muted { color: var(--muted); }
code {
  background: rgba(255, 255, 255, 0.08); border: 1px solid var(--border);
  padding: 0.1rem 0.45rem; border-radius: 6px; font-size: 0.9em;
}
html[data-theme="light"] code { background: rgba(22, 33, 58, 0.06); }
.form-wrap { max-width: 560px; }
label { display: block; font-weight: 600; margin: 0.9rem 0 0.35rem; }
input, textarea {
  width: 100%; padding: 0.7rem 0.9rem; border-radius: 10px;
  border: 1px solid var(--border); background: rgba(255, 255, 255, 0.05);
  color: var(--text); font: inherit;
}
input:focus, textarea:focus { outline: 2px solid var(--accent); border-color: transparent; }
.form-status { margin-top: 0.8rem; font-weight: 600; }
.form-status.ok { color: #34d399; }
.form-status.err { color: #f87171; }
.site-footer {
  border-top: 1px solid var(--border); padding: 1.6rem 0; text-align: center;
  color: var(--muted); font-size: 0.9rem;
}
#back-to-top {
  position: fixed; right: 1.2rem; bottom: 1.2rem; z-index: 60;
  border: 1px solid var(--border); background: var(--card); color: var(--text);
  border-radius: 999px; padding: 0.7rem 1rem; font: inherit; font-weight: 800; cursor: pointer;
  opacity: 0; pointer-events: none; transform: translateY(8px);
  transition: opacity 0.25s ease, transform 0.25s ease, box-shadow 0.25s ease;
}
#back-to-top.show { opacity: 1; pointer-events: auto; transform: none; }
#back-to-top:hover { box-shadow: var(--shadow); }
.reveal { opacity: 0; transform: translateY(18px); transition: opacity 0.6s ease, transform 0.6s ease; }
.reveal.visible { opacity: 1; transform: none; }
@media (max-width: 760px) {
  .grid-2 { grid-template-columns: 1fr; }
  .nav-links {
    display: none; flex-direction: column; gap: 0.8rem;
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 1rem; position: absolute; right: 4%; top: 3.6rem; min-width: 200px;
  }
  .nav-links.open { display: flex; }
  .nav-links li { width: 100%; }
  .nav-toggle { display: block; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .reveal, .tile, #back-to-top, .site-header { transition: none; }
  .reveal { opacity: 1; transform: none; }
}
"""

_WEB_SCRIPT_JS = """\
(function () {
  'use strict';
  var root = document.documentElement;
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  var themeBtn = document.getElementById('theme-toggle');
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('theme'); } catch (err) {}
  var prefersLight = false;
  if (typeof window.matchMedia === 'function') {
    prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  }
  var theme = savedTheme || (prefersLight ? 'light' : 'dark');
  root.setAttribute('data-theme', theme);
  if (themeBtn) {
    themeBtn.textContent = theme === 'light' ? 'Dark' : 'Light';
    themeBtn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      themeBtn.textContent = next === 'light' ? 'Dark' : 'Light';
      try { localStorage.setItem('theme', next); } catch (err) {}
    });
  }

  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && revealEls.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('visible'); });
  }

  var headerEl = document.querySelector('.site-header');
  var topBtn = document.getElementById('back-to-top');
  function onScroll() {
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    if (headerEl) headerEl.classList.toggle('scrolled', y > 10);
    if (topBtn) topBtn.classList.toggle('show', y > 400);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  if (topBtn) {
    topBtn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  var visit = document.getElementById('stat-visits');
  var nameEl = document.getElementById('stat-name');
  if (visit && nameEl && typeof fetch === 'function') {
    fetch('/api/info')
      .then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); })
      .then(function (data) {
        visit.textContent = data.visits;
        nameEl.textContent = data.name;
      })
      .catch(function () { visit.textContent = 'offline'; });
  }

  var form = document.getElementById('contact-form');
  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var status = document.getElementById('form-status');
      var body = {
        name: form.elements.name ? form.elements.name.value : '',
        message: form.elements.message ? form.elements.message.value : ''
      };
      var finish = function (ok, text) {
        status.textContent = text;
        status.className = 'form-status ' + (ok ? 'ok' : 'err');
        if (ok) form.reset();
      };
      if (typeof fetch === 'function') {
        fetch('/api/contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
          .then(function (res) { return res.json(); })
          .then(function (data) { finish(Boolean(data.ok), data.ok ? 'Message sent, thank you!' : 'Could not send.'); })
          .catch(function () { finish(false, 'Backend unreachable - message not sent.'); });
      } else {
        finish(true, 'Thanks for your message! (static demo)');
      }
    });
  }
})();
"""

_WEB_APP_PY = """\
import errno
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8000"))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

VISITS_FILE = os.path.join(BASE_DIR, "visits.json")
MESSAGES_FILE = os.path.join(BASE_DIR, "messages.json")


def load_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def save_json(path: str, value) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(value, fh, indent=2)


def site_name() -> str:
    return os.path.basename(BASE_DIR)


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/info":
            visits = int(load_json(VISITS_FILE, 0)) + 1
            save_json(VISITS_FILE, visits)
            self._send_json({
                "name": site_name(),
                "visits": visits,
                "features": ["About", "Live data", "Responsive design"],
            })
            return
        if self.path == "/api/visit":
            visits = int(load_json(VISITS_FILE, 0)) + 1
            save_json(VISITS_FILE, visits)
            self._send_json({"visits": visits})
            return
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._send_json({"ok": False, "error": "invalid JSON"}, 400)
            return
        if self.path == "/api/contact":
            messages = load_json(MESSAGES_FILE, [])
            messages.append({
                "name": payload.get("name", ""),
                "message": payload.get("message", ""),
            })
            save_json(MESSAGES_FILE, messages)
            self._send_json({"ok": True, "saved": len(messages)})
            return
        self._send_json({"ok": False, "error": "unknown endpoint"}, 404)


if __name__ == "__main__":
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as err:
        if err.errno != errno.EADDRINUSE:
            raise
        print(f"Port {PORT} is already in use - picking a free port instead.")
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(f"Serving {site_name()} on http://127.0.0.1:{httpd.server_address[1]}")
    httpd.serve_forever()
"""

_WEB_SERVER_JS = """\
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, extname, sep } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = os.path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8080', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let visits = 0;

function safePath(p) {
  const full = join(__dirname, decodeURIComponent(p).replace(/^[\\\\/]+/, ''));
  if (full !== __dirname && !full.startsWith(__dirname + sep)) return null;
  return full;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function sendJson(res, payload, status) {
  send(res, status || 200, 'application/json; charset=utf-8', JSON.stringify(payload));
}

function readMessages() {
  try { return JSON.parse(readFileSync(join(__dirname, 'messages.json'), 'utf-8')); } catch { return []; }
}

function siteName() {
  return os.path.basename(__dirname);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  if (path === '/api/info') {
    visits += 1;
    sendJson(res, { name: siteName(), visits, features: ['About', 'Live data', 'Responsive design'] });
    return;
  }
  if (path === '/api/visit') {
    visits += 1;
    sendJson(res, { visits });
    return;
  }
  if (req.method === 'POST' && path === '/api/contact') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const messages = readMessages();
        messages.push(JSON.parse(body));
        writeFileSync(join(__dirname, 'messages.json'), JSON.stringify(messages, null, 2));
        sendJson(res, { ok: true });
      } catch {
        sendJson(res, { ok: false }, 400);
      }
    });
    return;
  }

  const full = safePath(path === '/' || path === '' ? '/index.html' : path);
  if (!full) { send(res, 404, 'text/plain; charset=utf-8', 'Not found'); return; }
  try {
    const buf = readFileSync(full);
    send(res, 200, MIME[extname(full)] || 'application/octet-stream', buf);
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Port ' + PORT + ' is already in use - picking a free port instead.');
    server.listen(0);
    return;
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Serving on http://127.0.0.1:' + server.address().port);
});
"""

_TSX_TSCONFIG = """\
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
"""

_TSX_VITE_CONFIG = """\
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
});
"""

_TSX_INDEX_HTML = """\
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="__TITLE__ - a React + TypeScript website generated automatically." />
    <title>__TITLE__</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
"""

_TSX_MAIN_TSX = """\
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
"""

_TSX_APP_TSX = """\
import { useEffect, useState, type FormEvent } from 'react';

type SiteInfo = { name: string; visits: number };

const APP_NAME = '__TITLE__';

const features = [
  { title: 'About', body: 'A clear, friendly introduction to __TOPIC__ and everything it covers, in a fast single-page app built with React and TypeScript.' },
  { title: 'Live', body: 'The UI is fully component-driven TSX, so any part of the page can update instantly without a full reload.' },
  { title: 'Responsive', body: 'Fluid grids, accessible markup and a strictly typed codebase make __TOPIC__ easy to extend and maintain.' },
];

export default function App() {
  const [info, setInfo] = useState<SiteInfo | null>(null);
  const [sync, setSync] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    fetch('/api/info')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SiteInfo | null) => {
        setInfo(data);
        setSync(data ? 'Live API request succeeded.' : 'Backend offline - showing defaults.');
      })
      .catch(() => setSync('Backend offline - showing defaults.'));
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload = {
      name: String(data.get('name') || ''),
      message: String(data.get('message') || ''),
    };
    if (typeof fetch === 'function') {
      fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then((res) => res.json())
        .then((res) => setSync(res.ok ? 'Message sent, thank you!' : 'Could not send the message.'))
        .catch(() => setSync('Backend unreachable - message not sent.'));
    } else {
      setSync('Thanks for your message! (static demo)');
    }
    event.currentTarget.reset();
  };

  return (
    <div className="shell">
      <header className="site-header">
        <nav className="nav container">
          <a className="brand" href="#top">{APP_NAME}</a>
          <button
            className="nav-toggle"
            type="button"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menu
          </button>
          <ul className={'nav-links' + (menuOpen ? ' open' : '')}>
            <li><a href="#about">About</a></li>
            <li><a href="#features">Features</a></li>
            <li><a href="#stats">Stats</a></li>
            <li><a href="#contact">Contact</a></li>
          </ul>
        </nav>
      </header>

      <main id="top">
        <section className="hero">
          <div className="container">
            <p className="hero-eyebrow">React 18 &middot; TypeScript &middot; Vite &middot; CSS</p>
            <h1>Welcome to {APP_NAME}</h1>
            <p className="hero-sub">A modern, typed single-page app about __TOPIC__, generated automatically and designed as clean, reusable TSX components.</p>
            <div className="hero-actions">
              <a className="btn btn-primary" href="#about">Explore {APP_NAME}</a>
              <a className="btn btn-ghost" href="#contact">Get in touch</a>
            </div>
          </div>
        </section>

        <section id="about" className="section">
          <div className="container">
            <h2>About __TOPIC__</h2>
            <p>This React + TypeScript (TSX) site was generated automatically from a single request. The UI lives in typed components inside src/, the design system lives in src/styles.css, and you can start editing right away.</p>
            <p>Run <code>npm install</code> then <code>npm run dev</code> to launch the Vite dev server. Type errors are checked on every save.</p>
          </div>
        </section>

        <section id="features" className="section alt">
          <div className="container">
            <h2>Features</h2>
            <div className="card-grid">
              {features.map((feature, index) => (
                <article className="card reveal" key={feature.title}>
                  <span className="num">0{index + 1}</span>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="stats" className="section">
          <div className="container">
            <h2>Live stats</h2>
            <div className="stat-grid">
              <div className="stat-card"><strong>{info ? info.visits : '...'}</strong><span>site visitors</span></div>
              <div className="stat-card"><strong>{info ? info.name : APP_NAME}</strong><span>current topic</span></div>
              <div className="stat-card"><strong>7</strong><span>generated files</span></div>
            </div>
            <p className="muted">{sync || 'Connecting to the backend API...'}</p>
          </div>
        </section>

        <section id="contact" className="section alt">
          <div className="container form-wrap">
            <h2>Contact</h2>
            <p className="muted">The form below posts to /api/contact when a backend is connected.</p>
            <form onSubmit={submit}>
              <label htmlFor="name">Your name</label>
              <input id="name" name="name" type="text" required />
              <label htmlFor="message">Message</label>
              <textarea id="message" name="message" rows={4} required></textarea>
              <button className="btn btn-primary" type="submit">Send message</button>
              {sync ? <p className="form-status" role="status">{sync}</p> : null}
            </form>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container">
          <p>{new Date().getFullYear()} &copy; {APP_NAME}. Crafted automatically by VierrataleAI.</p>
        </div>
      </footer>
    </div>
  );
}
"""


def _tsx_url(folder: str, title: str, topic: str, css: Optional[str] = None) -> List[Dict[str, Any]]:
    package_json = json.dumps({
        "name": folder,
        "private": True,
        "version": "1.0.0",
        "type": "module",
        "scripts": {"dev": "vite", "build": "tsc -b && vite build", "preview": "vite preview"},
        "dependencies": {"react": "^18.3.1", "react-dom": "^18.3.1"},
        "devDependencies": {
            "@types/react": "^18.3.10",
            "@types/react-dom": "^18.3.0",
            "@vitejs/plugin-react": "^4.3.1",
            "typescript": "^5.6.2",
            "vite": "^5.4.8",
        },
    }, indent=2) + "\n"
    return [
        {"name": "create_file", "params": {"path": f"{folder}/package.json", "content": package_json}},
        {"name": "create_file", "params": {"path": f"{folder}/tsconfig.json", "content": _TSX_TSCONFIG}},
        {"name": "create_file", "params": {"path": f"{folder}/vite.config.ts", "content": _TSX_VITE_CONFIG}},
        {"name": "create_file", "params": {"path": f"{folder}/index.html", "content": _TSX_INDEX_HTML.replace("__TITLE__", title)}},
        {"name": "create_file", "params": {"path": f"{folder}/src/main.tsx", "content": _TSX_MAIN_TSX}},
        {"name": "create_file", "params": {"path": f"{folder}/src/App.tsx", "content": _TSX_APP_TSX.replace("__TITLE__", title).replace("__TOPIC__", topic)}},
        {"name": "create_file", "params": {"path": f"{folder}/src/styles.css", "content": css or _WEB_STYLE_CSS}},
    ]


def _web_index_html(title: str, topic: str, backend: str, description: str = "", style: str = "dark", sections: Optional[List[str]] = None) -> str:
    subject = topic or title
    has_section = set(sections) if sections else set(_WEB_SECTIONS)
    nav_items = "\n        ".join(f'<li><a href="#{sid}">{_WEB_SECTION_LABELS[sid]}</a></li>' for sid in _WEB_SECTIONS if sid in has_section)
    theme_attr = "" if style == "dark" else ' data-theme="light"'
    hero_sub = (
        description
        or ("Everything you need to know about {} - made automatically, styled beautifully, and brought to life by a {} backend.".format(topic, backend) if topic
            else "A beautifully designed page made automatically - styled with CSS, made interactive with JavaScript, and powered by a {} backend.".format(backend))
    )
    if description:
        about_para = "{} Built automatically from a single request - no manual typing - and fully self-contained: HTML for structure, CSS for the design, JavaScript for the interaction and a {} server for the logic.".format(description, backend)
    elif topic:
        about_para = "This is a dedicated page for {}. It was generated automatically from a single request - no manual typing, no copy-paste - and it is fully self-contained: HTML for structure, CSS for the design, JavaScript for the interaction and a {} server for the logic.".format(topic, backend)
    else:
        about_para = "This site was generated automatically from a single request. It is fully self-contained: HTML for structure, CSS for the design, JavaScript for the interaction and a {} server for the logic.".format(backend)
    features = [
        ("About", "A clear, friendly introduction to {} and everything it covers, laid out on one responsive page."),
        ("Live", "The page never reloads - JavaScript talks to a {} API for live stats and message handling."),
        ("Responsive", "Fluid grids, a touch-friendly menu and accessible markup make {} work on any screen size."),
    ]
    cards = []
    for i, (name, blurb) in enumerate(features, start=1):
        text = blurb.format(subject if i in (1, 3) else backend)
        cards.append('<article class="card reveal"><span class="num">0{}</span><h3>{}</h3><p>{}</p></article>'.format(i, name, text))
    features_html = "\n        ".join(cards)

    hero_section = """    <section class="hero">
      <div class="container">
        <p class="hero-eyebrow">HTML &middot; CSS &middot; JavaScript &middot; {backend}</p>
        <h1>Welcome to {title}</h1>
        <p class="hero-sub">{hero_sub}</p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="#about">Explore {title}</a>
          <a class="btn btn-ghost" href="#contact">Get in touch</a>
        </div>
      </div>
    </section>""".format(backend=backend, title=title, hero_sub=hero_sub)

    about_section = """    <section id="about" class="section">
      <div class="container grid-2">
        <div>
          <h2>About {subject}</h2>
          <p>{about_para}</p>
          <p>Open the folder and run the server below - the whole page, including live stats, the contact form and the gallery, works out of the box.</p>
        </div>
        <div class="card-grid">
          <div class="card reveal"><span class="num">01</span><h3>Structure</h3><p>Semantic HTML with clear sections: hero, about, features, gallery, stats and contact.</p></div>
          <div class="card reveal"><span class="num">02</span><h3>Design</h3><p>A modern dark theme with gradients, a glass header, cards, gradient tiles and smooth reveal animations.</p></div>
          <div class="card reveal"><span class="num">03</span><h3>Logic</h3><p>{backend} backend serves the files and exposes an API used by the JavaScript frontend.</p></div>
        </div>
      </div>
    </section>""".format(subject=subject, about_para=about_para, backend=backend)

    features_section = """    <section id="features" class="section alt">
      <div class="container">
        <h2>Features</h2>
        <div class="card-grid">
        {features}
        </div>
      </div>
    </section>""".format(features=features_html)

    gallery_section = """    <section id="gallery" class="section">
      <div class="container">
        <h2>Gallery</h2>
        <p class="muted">A splash of color - pure CSS gradients, no images to download.</p>
        <div class="gallery-grid">
          <div class="tile">Card 01</div>
          <div class="tile t2">Card 02</div>
          <div class="tile t3">Card 03</div>
          <div class="tile t4">Card 04</div>
        </div>
      </div>
    </section>"""

    stats_section = """    <section id="stats" class="section">
      <div class="container">
        <h2>Live stats</h2>
        <div class="stat-grid">
          <div class="stat-card"><strong id="stat-visits">-</strong><span>site visitors</span></div>
          <div class="stat-card"><strong id="stat-name">{title}</strong><span>current topic</span></div>
          <div class="stat-card"><strong>4</strong><span>generated files</span></div>
        </div>
        <p class="muted">Numbers are served live by the {backend} backend at /api/info - one request per page load.</p>
      </div>
    </section>""".format(title=title, backend=backend)

    contact_section = """    <section id="contact" class="section alt">
      <div class="container form-wrap">
        <h2>Contact</h2>
        <p class="muted">Send a message - the {backend} backend saves it to messages.json.</p>
        <form id="contact-form" novalidate>
          <label for="name">Your name</label>
          <input id="name" name="name" type="text" required>
          <label for="message">Message</label>
          <textarea id="message" name="message" rows="4" required></textarea>
          <button class="btn btn-primary" type="submit">Send message</button>
          <p class="form-status" id="form-status" role="status"></p>
        </form>
      </div>
    </section>""".format(backend=backend)

    body = "\n\n".join(sec for sec in [
        hero_section,
        about_section if "about" in has_section else "",
        features_section if "features" in has_section else "",
        gallery_section if "gallery" in has_section else "",
        stats_section if "stats" in has_section else "",
        contact_section if "contact" in has_section else "",
    ] if sec)

    return """\
<!doctype html>
<html lang="en"{theme_attr}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{title} - a designed website built with HTML, CSS, JavaScript and {backend}.">
  <title>{title}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="site-header">
    <nav class="nav container">
      <a class="brand" href="#top">{title}</a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-label="Toggle navigation">Menu</button>
      <ul class="nav-links">
        {nav_items}
        <li><button class="theme-toggle" id="theme-toggle" type="button" aria-label="Toggle color theme">Theme</button></li>
      </ul>
    </nav>
  </header>

  <main id="top">
{body}
  </main>

  <button id="back-to-top" type="button" aria-label="Back to top">Top</button>

  <footer class="site-footer">
    <div class="container">
      <p><span id="year">2026</span> &copy; {title}. Crafted automatically by VierrataleAI.</p>
    </div>
  </footer>

  <script src="script.js"></script>
</body>
</html>
""".format(
        theme_attr=theme_attr,
        title=title,
        backend=backend,
        nav_items=nav_items,
        body=body,
    )


def _render_web_plan(config: Dict[str, Any], text: str, stack: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    stack = stack or _web_stack(text)
    safe_title = _escape_html(config["name"])
    safe_topic = _escape_html(_title_case(config["topic"])) if config["topic"] else ""
    safe_desc = _escape_html(config["description"]) if config["description"] else ""
    css = _web_css(config.get("accent", "#7c3aed"), config.get("accent2", "#06b6d4"), config.get("style", "dark"))

    if stack["tsx"]:
        return [
            {"name": "create_directory", "params": {"path": config["folder"]}},
            *_tsx_url(config["folder"], safe_title, safe_topic or safe_title, css),
        ]
    backend = "Node.js" if stack["node"] else "Python"
    plan: List[Dict[str, Any]] = [
        {"name": "create_directory", "params": {"path": config["folder"]}},
        {"name": "create_file", "params": {"path": f"{config['folder']}/index.html", "content": _web_index_html(safe_title, safe_topic, backend, safe_desc, config.get("style", "dark"), config.get("sections"))}},
        {"name": "create_file", "params": {"path": f"{config['folder']}/style.css", "content": css}},
    ]
    if stack["js"]:
        plan.append({"name": "create_file", "params": {"path": f"{config['folder']}/script.js", "content": _WEB_SCRIPT_JS}})
    if stack["node"]:
        plan.append({
            "name": "create_file",
            "params": {
                "path": f"{config['folder']}/package.json",
                "content": json.dumps({
                    "name": config["folder"], "version": "1.0.0", "type": "module", "main": "server.js",
                    "scripts": {"start": "node server.js"},
                }, indent=2) + "\n",
            },
        })
        plan.append({"name": "create_file", "params": {"path": f"{config['folder']}/server.js", "content": _WEB_SERVER_JS}})
    else:
        plan.append({"name": "create_file", "params": {"path": f"{config['folder']}/app.py", "content": _WEB_APP_PY}})
    return plan


def _web_site_plan(text: str, folder_name: str, config: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    return _render_web_plan(config or _probe_web_config(text, folder_name), text)


def _web_folder_plan(text: str, folder_name: str) -> List[Dict[str, Any]]:
    makes_web = re.search(
        r"\b(buat|create|make|generate)\b[^.!?\n]{0,40}\b(web\s*(app|page|site)?|website|situs|webpage|halaman)\b",
        text,
        re.I,
    ) or re.search(
        r"\b(web\s*app|website|situs|webpage)\b[^.!?\n]{0,40}\b(pack|kemas|satukan|folder|dir|directory)\b",
        text,
        re.I,
    )
    if not makes_web:
        return []
    return _web_site_plan(text, folder_name)


def heuristic_plan(request_text: str) -> List[Dict[str, Any]]:
    text = request_text or ""

    m = re.search(r"\b(copy|duplicate|salin|duplikat)\b[^.!?\n]*?([\w.-]+)\s+(?:ke|menjadi|jadi|as|to)\s+([\w.-]+)", text, re.I)
    if m:
        return [{"name": "run_command", "params": {"command": f"cp {m.group(2)} {m.group(3)}"}}]

    m = re.search(r"\b(ganti nama|rename|ren|pindah|move|mv)\b[^.!?\n]*?([\w.-]+)\s+(?:ke|menjadi|jadi|as|to)\s+([\w.-]+)", text, re.I)
    if m and re.search(r"\.[A-Za-z0-9]+$", m.group(2)) and re.search(r"\.[A-Za-z0-9]+$", m.group(3)):
        return [{"name": "run_command", "params": {"command": f"mv {m.group(2)} {m.group(3)}"}}]

    m = re.search(r"\b(hapus|delete|remove|rm|buang)\b\s+(?:the\s+|file\s+)?([\w./-]+)", text, re.I)
    if m:
        return [{"name": "delete_file", "params": {"path": m.group(2)}}]

    m = re.search(r"\b(git\s+(?:status|log|diff|remote\s*-v|status\s*-\w*))\b", text, re.I)
    if m:
        return [{"name": "run_command", "params": {"command": m.group(1)}}]

    m = re.search(r"\b(npm|yarn|pnpm)\s+(install|i|add|run|start|dev|test|build|init|create|exec)\b([^.!?\n]*)", text, re.I)
    if m:
        cmd = f"{m.group(1)} {m.group(2)}{m.group(3)}".strip()
        return [{"name": "run_command", "params": {"command": cmd}}]

    # System package installs: explicit "pkg/apt install …" and generic
    # "install <pkg>" requests ("pasang curl", "install wget").
    m = re.search(r"\b(pkg|apt-get|apt)\s+(install|i|add)\s+(.+)$", text, re.I)
    if m:
        pkgs = [p for p in re.split(r"\s+", m.group(3).strip())[:8] if re.match(r"^[a-z0-9][a-z0-9.+_~-]*$", p, re.I)]
        if pkgs:
            return [{"name": "run_command", "params": {"command": f"{m.group(1)} install {' '.join(pkgs)}"}}]

    if re.search(r"\b(install|pasang|installkan|menginstall|menginstal|set\s*up|setup)\b", text, re.I) \
            and not re.search(r"\b(npm|yarn|pnpm|npx|bun|pip|pip3|uv|conda|apt|pkg)\b", text, re.I) \
            and not re.search(r"node modules|modules|dependenc\w+|package\.json|requirements(\.txt)?|virtualenv|pip\b|cargo\b|go get\b", text, re.I):
        target = re.search(
            r"\b(install|pasang|installkan|menginstall|menginstal|set\s*up|setup)\b\s+(?:(the|a|an|package|paket|tool|alat|program|utility|latest)\s+)?([a-z0-9][a-z0-9.+_~-]{1,63})\b",
            text, re.I,
        )
        blocked = {"project", "proyek", "folder", "direktori", "file", "berkas", "code", "kode",
                   "dependencies", "dependensi", "app", "aplikasi", "gui", "the", "a", "an", "for",
                   "to", "in", "on", "from", "with", "and", "dan", "lalu", "semua", "ini", "itu",
                   "now", "please", "tolong"}
        if target and target.group(3).lower() not in blocked:
            manager = pick_package_manager()
            return [{"name": "run_command", "params": {"command": f"{manager} install {target.group(3)}"}}]

    m = re.search(r"\b(jalankan|run|execute|exec|kerjakan)\b\s+(node|python3?|git)\b\s*([\w./-]*)", text, re.I)
    if m:
        cmd = f"{m.group(2)} {m.group(3)}".strip()
        return [{"name": "run_command", "params": {"command": cmd}}]

    if re.search(r"\b(project|proyek|aplikasi|app)\b", text, re.I) and re.search(r"\b(buat|create|make|generate)\b", text, re.I):
        files = _scaffold_files(text)
        if files:
            return files

    web_plan = _web_folder_plan(text, _folder_plan_name(text))
    if web_plan:
        return web_plan

    if re.search(r"\b(pwd|where am i)\b", text, re.I) or re.search(r"\b(direktori|folder sekarang|folder kerja)\b", text, re.I):
        return [{"name": "run_command", "params": {"command": "pwd"}}]

    dl = re.search(r"\b(download|unduh|ambil|grab|save|simpan)\b[^.!?\n]{0,60}(https?://[^\s<>\"']+)", text, re.I)
    if not dl:
        dl = re.search(r"(https?://[^\s<>\"']+\.(?:pdf|zip|tar|gz|7z|rar|docx?|xlsx?|mp[34]|wav|png|jpe?g|gif|webp|svg|json|csv))(?:\s|$)", text, re.I)
    if dl:
        url = dl.group(2) if dl.lastindex and dl.lastindex >= 2 else dl.group(1)
        return [{"name": "download_url", "params": {"url": url}}]

    folder_name = _named_token(
        text,
        rf"\b(buat|create|make|new)\b[^.!?\n]{{0,30}}(?<![A-Za-z0-9_-])\b(folder|dir|directory)\b\s+(?:(?:named|called|bernama|berjudul|dengan\s+nama|as|to)\s+)?({_TOKEN})",
    ) or _named_token(text, rf"\b(folder|dir|directory)\b\s+(?:(?:named|called|bernama|berjudul|dengan\s+nama|as|to)\s+)?({_TOKEN})[\s\S]{{0,10}}$")
    folder_name = _strip_qualifier(folder_name)
    file_name = _code_named_file(text) or _named_token(
        text,
        rf"\b(buat|create|make|new|touch)\b[^.!?\n]{{0,30}}(?<![A-Za-z0-9_-])\b(file|berkas)\b\s+({_TOKEN})",
    )
    file_name = _strip_qualifier(file_name)
    if file_name or folder_name:
        plan: List[Dict[str, Any]] = []
        if folder_name:
            plan.append({"name": "create_directory", "params": {"path": folder_name}})
        if file_name:
            inside = bool(re.search(r"\b(di\s+dalamnya|didalamnya|di dalam|inside|dalam)\b", text, re.I))
            target = f"{folder_name}/{file_name}" if folder_name and inside else file_name
            content = ""
            if re.search(r"\.(txt|md|markdown|csv|json)$", file_name, re.I):
                says = re.search(r"\b(says?|said|berisi|isinya|bertuliskan)\s+[\"']?([^\"'.!?\n]{1,120})[\"']?", text, re.I)
                if says:
                    content = says.group(2).strip() + "\n"
            plan.append({"name": "create_file", "params": {"path": target, "content": content}})
        return plan

    if re.search(r"\b(lihat|tampilkan|show|list|ls|buka|isi)\b", text, re.I):
        pm = re.search(r"\b(src|test|public|dist|node_modules)\b", text, re.I)
        return [{"name": "list_directory", "params": {"path": pm.group(1) if pm else "."}}]
    return []


# ---------------------------------------------------------------------- #
# Provider complete abstraction
# ---------------------------------------------------------------------- #

async def _provider_complete(provider: Any, messages: List[Dict[str, Any]], options: Dict[str, Any]) -> str:
    comp = getattr(provider, "complete", None)
    if comp and asyncio.iscoroutinefunction(comp):
        return await comp(messages, options)
    # Fallback: collect the async generator
    out = ""
    async for chunk in provider.stream(messages, options):
        out += chunk or ""
    return out


# ---------------------------------------------------------------------- #
# Agent loop
# ---------------------------------------------------------------------- #

async def plan_once(provider: Any, messages: List[Dict[str, Any]], request_text: str, options: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    options = options or {}
    if options.get("heuristic_first", True):
        fast = heuristic_plan(request_text)
        if fast:
            if _is_web_site_plan(fast):
                wcfg = await _web_design_config(provider, messages, request_text)
                if wcfg:
                    explicit = _folder_plan_name(request_text)
                    if explicit:
                        wcfg["folder"] = explicit
                    logger.log("PLAN", "plan: web site (AI design config)")
                    return _web_site_plan(request_text, wcfg["folder"], wcfg)
                logger.log("PLAN", "plan: web site (heuristic design)")
            else:
                logger.log("PLAN", "plan: heuristic (fast path)")
            return fast
    timeout_ms = options.get("plan_timeout_ms") or cfg.get("plan_timeout_ms")
    history = messages[-6:] if messages else []
    plan_opts = {"model": cfg.get_effective_model(provider.name), "system_prompt": TOOL_PLAN_PROMPT, "max_tokens": 400}

    def _plan_worker() -> str:
        comp = getattr(provider, "_complete_sync", None)
        if callable(comp):
            return comp([*history, {"role": "user", "content": request_text}], plan_opts)
        coro = provider.complete([*history, {"role": "user", "content": request_text}], plan_opts)
        if asyncio.iscoroutine(coro):
            return asyncio.run(coro)
        return coro

    try:
        text = await asyncio.wait_for(asyncio.to_thread(_plan_worker), timeout=timeout_ms / 1000.0)
    except asyncio.TimeoutError:
        logger.log("PLAN", f"model plan exceeded {timeout_ms}ms")
        text = ""
    except Exception as err:
        logger.log("PLAN", f"model plan failed ({err}); falling back to heuristic")
        text = ""
    plan = parse_tool_plan(text)
    if plan:
        return plan
    heuristic = heuristic_plan(request_text)
    if heuristic:
        logger.log("PLAN", "plan fallback: heuristic")
    return heuristic


def _call_label(call: Dict[str, Any]) -> str:
    params = call.get("params") or {}
    if call["name"] == "run_command":
        return params.get("command", "")
    if call["name"] == "download_url":
        return f"download_url({params.get('url', '')})"
    if call["name"] in ("todo_add", "todo_update"):
        return f"{call['name']}({json.dumps(params, ensure_ascii=False)})"
    return f"{call['name']}({params.get('path', '')})"


def _execute_tool_call(executor, call: Dict[str, Any], chat_ui: Any, messages: List[Dict[str, Any]], cwd: Optional[str]) -> Dict[str, Any]:
    label = _call_label(call)
    if chat_ui:
        chat_ui.set_status(f"Running: {label}")
        chat_ui.set_thinking(True)
        chat_ui.render(messages)
    res = dispatch_tool(executor, call)
    logger.log("EXEC", f"{label} -> {res['exit_code']}{' [timeout]' if res['timed_out'] else ''}")
    if res["success"]:
        if chat_ui:
            chat_ui.notify(f"\u2713 {label}")
        if (res["stdout"] or "").strip():
            logger.log("EXEC", f"{label} stdout: {res['stdout'].strip()[:500]}")
        if (res["stderr"] or "").strip():
            logger.log("WARN", f"{label} stderr: {res['stderr'].strip()[:500]}")
        if call["name"] == "create_file" and (call["params"].get("path") or "").lower().endswith(".py"):
            py_file = call["params"]["path"]
            target = os.path.join(cwd or ".", py_file) if not os.path.isabs(py_file) else py_file
            try:
                proc = subprocess.run(
                    [sys.executable, "-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", target],
                    capture_output=True, text=True, timeout=30,
                )
            except (FileNotFoundError, subprocess.TimeoutExpired):
                proc = None
            if proc is not None and proc.returncode == 1:
                detail = " ".join((proc.stderr or "").strip().split("\n")[-2:])
                if chat_ui:
                    chat_ui.notify(f"\u2717 python check failed: {py_file} ({detail})")
                logger.log("WARN", f"{label} failed python syntax check: {detail}")
    else:
        if chat_ui:
            chat_ui.notify(f"\u2717 {label}: {(res['stderr'] or 'failed').strip()[:300]}")
        logger.log("ERROR", "{} failed: {}".format(label, (res["stderr"] or res.get("stdout") or "exit {}".format(res["exit_code"])).strip()[:500]))
    return res


async def _plan_auto_fix(provider: Any, messages: List[Dict[str, Any]], request_text: str, call: Dict[str, Any], result: Dict[str, Any]) -> List[Dict[str, Any]]:
    history = messages[-6:] if messages else [{"role": "user", "content": str(request_text or "")}]
    timeout_ms = cfg.get("plan_timeout_ms")
    fix_opts = {"model": cfg.get_effective_model(provider.name), "system_prompt": TOOL_PLAN_PROMPT, "max_tokens": 400}

    def _worker() -> str:
        comp = getattr(provider, "_complete_sync", None)
        if callable(comp):
            return comp([*history, {"role": "user", "content": tool_fix_prompt(call, result)}], fix_opts)
        coro = provider.complete([*history, {"role": "user", "content": tool_fix_prompt(call, result)}], fix_opts)
        if asyncio.iscoroutine(coro):
            return asyncio.run(coro)
        return coro

    try:
        text = await asyncio.wait_for(asyncio.to_thread(_worker), timeout=timeout_ms / 1000.0)
    except asyncio.TimeoutError:
        logger.log("FIX", f"auto-fix exceeded {timeout_ms}ms")
        return []
    except Exception as err:
        logger.log("FIX", f"auto-fix plan failed ({err})")
        return []
    plan = parse_tool_plan(text)
    if plan:
        logger.log("FIX", "auto-fix plan: " + ", ".join(p["name"] for p in plan))
    return plan


async def run_with_tools(
    provider: Any,
    messages: List[Dict[str, Any]],
    request_text: str,
    chat_ui: Any = None,
    cwd: Optional[str] = None,
    timeout_ms: Optional[int] = None,
    heuristic_first: bool = True,
) -> Dict[str, Any]:
    refined_folder = _web_refine_request(request_text, messages)
    is_op = not refined_folder and looks_like_operation_request(request_text)
    if not refined_folder and not is_op:
        return {"results": []}
    executor = make_executor(cwd=cwd, timeout_ms=timeout_ms)
    results: List[Dict[str, Any]] = []
    auto_fixes = 0

    for _round in range(MAX_PLANNING_ROUNDS):
        if not is_op and _round == 0:
            plan = await _web_refine(provider, messages, request_text, cwd) or []
        else:
            plan = await plan_once(provider, messages, request_text, {"heuristic_first": heuristic_first})
        if not plan:
            break
        all_ok = True
        for call in plan[: max(1, MAX_STEPS - len(results))]:
            res = _execute_tool_call(executor, call, chat_ui, messages, cwd)
            results.append({"name": call["name"], "params": call["params"], "result": res})
            if not res["success"]:
                all_ok = False
            if res["timed_out"] and not res["success"]:
                break

            if not res["success"] and auto_fixes < MAX_AUTO_FIXES and len(results) < MAX_STEPS:
                auto_fixes += 1
                if chat_ui:
                    chat_ui.set_status("Auto-fixing failed step…")
                fix_plan = await _plan_auto_fix(provider, messages, request_text, call, res)
                fixed_ok = len(fix_plan) > 0
                for fcall in fix_plan[: max(1, MAX_STEPS - len(results))]:
                    fres = _execute_tool_call(executor, fcall, chat_ui, messages, cwd)
                    results.append({"name": fcall["name"], "params": fcall["params"], "result": fres})
                    if not fres["success"]:
                        fixed_ok = False
                        break
                if fixed_ok:
                    if chat_ui:
                        chat_ui.notify("Auto-fixed after failure.")
                    all_ok = True
        if all_ok or not results or _round >= MAX_PLANNING_ROUNDS - 1:
            break
    made_files = any(
        r["name"] in ("create_file", "create_directory") and r["result"]["success"]
        for r in results
    )
    if made_files:
        tree_text = "\n".join(render_file_tree(cwd or os.getcwd()))
        logger.log("TREE", tree_text[:2500])
        if chat_ui:
            chat_ui.notify(tree_text)
    if results and chat_ui:
        chat_ui.set_status("")
        chat_ui.set_thinking(True)
        chat_ui.render(messages)
    return {"results": results}
