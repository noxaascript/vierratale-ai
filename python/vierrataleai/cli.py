import asyncio
import re
import signal
import sys
import argparse
import threading
import json
import os
from typing import Optional

from . import config
from . import catalog
from . import engine as installer
from .providers import auto_detect, create, get_available
from .ui.terminal import Terminal
from .ui.banner import load_system_prompt
from .ui.branding import Branding
from .ui.chatbox import ChatUI, FrameThrottle
from .ui.input import LineEditor
from .utils.websearch import WebSearch
from .utils.webfetch import WebFetch
from .utils.downloader import Downloader
from .utils.filewriter import FileWriter
from .utils.logger import logger
from .cmd.agent import run_with_tools, tool_results_prompt, looks_like_operation_request
from .cmd.todos import load_todos, add_todo, update_todo, clear_todos, save_todos, format_todos, todos_file
from .utils.intents import detect_intent, extract_search_topic, looks_like_story_request
from .utils.platform import is_termux
from . import session as session_mod

ui = Terminal()

INSTALL_STEPS = [
    "Checking the AI engine",
    "Installing dependencies",
    "Downloading the model",
    "Linking the vierrataleai command",
    "Optimizing for this device",
]


async def fake_install(work) -> None:
    """Run an install coroutine while painting a fake animated progress bar.
    Real engine/model output is hidden so first-run feels quick and clean."""
    import sys

    steps = INSTALL_STEPS
    i = 0
    try:
        isatty = sys.stdout.isatty()
    except Exception:
        isatty = False

    def render():
        nonlocal i
        i += 1
        frames = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
        stage = steps[(i // 8) % len(steps)]
        pct = 8 + ((i * 7) % 85)
        bar = frames[i % len(frames)]
        fill_len = 1 + (i % 20)
        fill = "█" * fill_len + "░" * (20 - fill_len)
        line = f"\r  {bar} \033[1m{pct}%\033[0m {stage} [\033[38;2;6;182;212m{fill}\033[0m]"
        sys.stdout.write(line)
        sys.stdout.flush()

    async def ticker():
        while True:
            render()
            await asyncio.sleep(0.11)

    task = asyncio.ensure_future(ticker())
    try:
        result = await work()
    finally:
        task.cancel()
        if isatty:
            sys.stdout.write("\r\x1b[2K")
        sys.stdout.write("  \033[1;32m✔\033[0m \033[1;2m100%\033[0m \033[2mReady\033[0m\n")
        sys.stdout.flush()
    return result

HELP_TEXT = f"""
{Branding.APP_NAME} {Branding.VERSION}
Usage: vierrataleai [options]

Options:
  --provider, -p <name>   Provider: cortex, openai (default: auto-detect)
  --model, -m <name>      Model: e.g. VTL-2.7-Flash/3.5-Reason/6.0-Reason
  --clear                 (deprecated: screen is always cleared on start)
  --install, --setup      Install engine + model + a 'vierrataleai' command, then run
  --version, -v           Show version
  --help, -h              Show this help

Missing dependencies (engine + model) are installed automatically on start.

Commands (in chat):
  /help                   Show commands
  /model [name]           Switch model
  /provider [name]        Switch provider
  /models                 List available models
  /search <query>         Search the web and summarize with AI
  /fetch <url>            Open a link and summarize its content
  /download <url>         Download a file, folder listing or archive
  /todos                  List the todo list (add <text> | done/undone <n> | clear)
  /log [n|path]           Show the last n log entries (default 30), or the log file path
  /clear                  Clear screen
  /new                    Start a new empty session (keeps old ones)
  /sessions               List saved sessions
  /session new [name]     Create and switch to a session
  /session open <name|#>  Resume a session (e.g. /session open #2)
  /session delete <name|#>  Delete a session
  /session backup [name|#]  Back up a session to a .bak.json (auto on fresh start)
  /session backups        List session backups
  /session restore <n|#>  Restore a backup into a session
  /quit                   Exit
"""

SLASH_COMMANDS = [
    {"name": "help", "desc": "Show all commands"},
    {"name": "clear", "desc": "Clear the screen"},
    {"name": "new", "desc": "Start a new empty conversation"},
    {"name": "model", "args": "[name]", "desc": "Switch model"},
    {"name": "provider", "args": "[name]", "desc": "Switch provider"},
    {"name": "models", "desc": "List available models"},
    {"name": "search", "args": "<query>", "desc": "Search the web and summarize"},
    {"name": "fetch", "args": "<url>", "desc": "Open a link and summarize"},
    {"name": "download", "args": "<url>", "desc": "Download a file / folder / archive"},
    {"name": "sessions", "desc": "List saved sessions"},
    {"name": "session", "args": "new | open | delete | backup | restore", "desc": "Manage sessions"},
    {"name": "todos", "args": "[add <text> | done <n> | undone <n> | clear]", "desc": "Manage the todo list"},
    {"name": "log", "args": "[n | path]", "desc": "Show recent log entries"},
    {"name": "quit", "desc": "Exit"},
]

_EDITOR = None


async def answer_with_search(messages, provider, query: str, system_prompt: str, config, chat_ui: ChatUI, request_text: str = ""):
    chat_ui.clear_notices()
    chat_ui.set_status(f'Searching the web for "{query}"…')
    chat_ui.render(messages)
    results = WebSearch.search(query)

    if results:
        chat_ui.set_status("")
        chat_ui.notify(f"Found {len(results)} web result(s) for \"{query}\"")
        search_context = "\n\n".join(
            f"{i+1}. {r['title']}\n   URL: {r['url']}\n   {r['snippet']}"
            for i, r in enumerate(results)
        )
        user_content = (
            f'Web search results for "{query}":\n\n{search_context}\n\n'
            f"Answer based on these results."
        )
        if looks_like_story_request(request_text):
            user_content += (
                " If this is a famous story, folk tale, legend, or myth, "
                "tell the real, well-known version fully and save it to a .txt file too."
            )
    else:
        chat_ui.set_status("")
        chat_ui.notify("No web results — answering from my own knowledge.")
        user_content = query

    messages.append({"role": "user", "content": user_content, "hidden": True})
    session_mod.save(messages)
    chat_ui.set_thinking(True)
    chat_ui.render(messages)

    response = ""
    frame = FrameThrottle(lambda: chat_ui.render(messages))
    async for chunk in provider.stream(
        messages,
        {
            "model": config.get_effective_model(provider.name),
            "system_prompt": system_prompt,
            "max_tokens": 600,
        },
    ):
        response += chunk
        chat_ui.set_streaming(response)
        frame.schedule()

    frame.flush()
    if response:
        messages.append({"role": "assistant", "content": response})
        logger.log("AI", response)
        chat_ui.set_streaming(None)
        await _write_from_response(response, chat_ui, request_text)
    chat_ui.render(messages)
    session_mod.save(messages)


def _extract_url(text: str) -> Optional[str]:
    import re
    m = re.search(r"https?://[^\s<>\"']+", text, re.I)
    return m.group(0) if m else None


async def answer_with_fetch(messages, provider, url: str, system_prompt: str, config, chat_ui: ChatUI, request_text: str = ""):
    chat_ui.clear_notices()
    chat_ui.set_status(f"Opening {url}…")
    chat_ui.render(messages)
    try:
        page = WebFetch.fetch(url)
    except Exception as err:
        chat_ui.set_status("")
        chat_ui.notify(str(err))
        logger.log("ERROR", str(err))
        chat_ui.render(messages)
        return

    chat_ui.set_status("")
    assets = page.get("assets") or []
    chat_ui.notify(f"Opened: {page['title'] or page['url']}{f' · {len(assets)} download ready' if assets else ''}")
    content = page["text"].strip()
    if not content:
        chat_ui.notify("Nothing readable found on that page.")
        chat_ui.render(messages)
        return

    asset_block = ""
    if assets:
        asset_block = (
            "\n\nDownloadable files found on the page:\n"
            + "\n".join(f"{i+1}. [{a['type']}] {a['name']} — {a['url']}" for i, a in enumerate(assets))
            + "\n\nIf the user asks to download any of these, tell them it is saved at ~/Downloads "
              "and actually download each one with the download_url tool."
        )

    messages.append({
        "role": "user",
        "content": (
            f'Here is the content fetched from the URL "{page["url"]}" '
            f'({page["title"] or "no title"}):\n\n{content}{asset_block}\n\n'
            f"Please summarize and answer based on this content. Be concise."
        ),
        "hidden": True,
    })
    session_mod.save(messages)
    chat_ui.set_thinking(True)
    chat_ui.render(messages)

    response = ""
    frame = FrameThrottle(lambda: chat_ui.render(messages))
    async for chunk in provider.stream(
        messages,
        {
            "model": config.get_effective_model(provider.name),
            "system_prompt": system_prompt,
            "max_tokens": 600,
        },
    ):
        response += chunk
        chat_ui.set_streaming(response)
        frame.schedule()

    frame.flush()
    if response:
        messages.append({"role": "assistant", "content": response})
        logger.log("AI", response)
        chat_ui.set_streaming(None)
        await _write_from_response(response, chat_ui, request_text)
    chat_ui.render(messages)
    session_mod.save(messages)


async def answer_with_download(messages, provider, url: str, system_prompt: str, config, chat_ui: ChatUI, request_text: str = ""):
    chat_ui.clear_notices()
    chat_ui.set_status(f"Downloading {url}…")
    chat_ui.render(messages)
    try:
        result = Downloader.download(url, dir=config.get("download_dir"))
    except Exception as err:
        chat_ui.set_status("")
        chat_ui.notify(str(err))
        logger.log("ERROR", str(err))
        chat_ui.render(messages)
        return

    chat_ui.set_status("")
    kind = result.get("kind", "file")
    location = result["path"]
    note = "\n(contents extracted into that folder)" if result.get("extracted") else ""
    chat_ui.notify(f"{kind[0].upper() + kind[1:]} downloaded → {location}{note}")
    logger.log("FILE", f"downloaded {kind} {url} -> {location}")

    summary_content = (
        f'The user downloaded {kind} from "{url}". Saved to: {location}'
        + (f', extracted to {result["extracted"]}' if result.get("extracted") else "")
        + f" ({result.get('size', 0)} bytes)."
    )
    messages.append({"role": "user", "content": summary_content, "hidden": True})
    session_mod.save(messages)
    chat_ui.set_thinking(True)
    chat_ui.render(messages)

    response = ""
    frame = FrameThrottle(lambda: chat_ui.render(messages))
    async for chunk in provider.stream(
        messages,
        {
            "model": config.get_effective_model(provider.name),
            "system_prompt": system_prompt,
            "max_tokens": 300,
        },
    ):
        response += chunk
        chat_ui.set_streaming(response)
        frame.schedule()

    frame.flush()
    if response:
        messages.append({"role": "assistant", "content": response})
        logger.log("AI", response)
        chat_ui.set_streaming(None)
        await _write_from_response(response, chat_ui, request_text)
    chat_ui.render(messages)
    session_mod.save(messages)


def handle_todos_command(user_input, chat_ui, messages, cwd):
    chat_ui.clear_notices()
    rest = user_input.strip()[len("/todos"):].strip()
    tf = todos_file(cwd)
    if not rest:
        out = f"Todos ({tf}):\n{format_todos(load_todos(cwd))}"
    elif rest.lower().startswith("add "):
        err = add_todo(cwd, rest[4:].strip())
        out = err.get("error") if err.get("error") else f"Todos ({tf}):\n{format_todos(load_todos(cwd))}"
    elif re.match(r"^done\s+\d+$", rest, re.I):
        err = update_todo(cwd, int(re.match(r"^done\s+(\d+)$", rest, re.I).group(1)), done=True)
        out = err.get("error") if err.get("error") else f"Todos ({tf}):\n{format_todos(load_todos(cwd))}"
    elif re.match(r"^undone\s+\d+$", rest, re.I):
        err = update_todo(cwd, int(re.match(r"^undone\s+(\d+)$", rest, re.I).group(1)), done=False)
        out = err.get("error") if err.get("error") else f"Todos ({tf}):\n{format_todos(load_todos(cwd))}"
    elif re.match(r"^remove\s+\d+$", rest, re.I):
        n = int(re.match(r"^remove\s+(\d+)$", rest, re.I).group(1))
        todos = load_todos(cwd)
        if n - 1 < 0 or n - 1 >= len(todos):
            out = f"No todo #{n}."
        else:
            save_todos(cwd, [t for i, t in enumerate(todos) if i != n - 1])
            out = f"Todos ({tf}):\n{format_todos(load_todos(cwd))}"
    elif rest.lower() == "clear":
        clear_todos(cwd)
        out = f"Todos cleared ({tf}). (no todos yet)"
    elif rest.isdigit():
        n = int(rest)
        todos = load_todos(cwd)
        if n - 1 < 0 or n - 1 >= len(todos):
            out = f"No todo #{n}."
        else:
            err = update_todo(cwd, n, done=not todos[n - 1]["done"])
            out = err.get("error") if err.get("error") else f"Todos ({tf}):\n{format_todos(load_todos(cwd))}"
    else:
        out = "Usage: /todos [add <text> | done <n> | undone <n> | remove <n> | <n> (toggle) | clear]"
    chat_ui.notify(out)
    logger.log("CMD", f"todos: {rest or '(list)'}")
    chat_ui.render(messages)


async def answer_with_tools(messages, provider, request_text, system_prompt, config, chat_ui, cwd):
    timeout_ms = int(config.get("command_timeout_ms"))
    try:
        outcome = await run_with_tools(
            provider,
            messages,
            request_text,
            chat_ui=chat_ui,
            cwd=cwd,
            timeout_ms=timeout_ms,
        )
    except Exception as err:
        chat_ui.notify(str(err) or "Tool error")
        logger.log("ERROR", str(err) or "Tool error")
        chat_ui.render(messages)
        return True
    results = outcome["results"]
    if not results:
        return False

    messages.append({"role": "user", "content": request_text})
    rows = []
    for r in results:
        res = r["result"]
        if r["name"] == "run_command":
            params = {"command": res["command"]}
        else:
            path = r["params"].get("path")
            params = {"path": path} if path else {}
        rows.append({
            "tool": r["name"],
            "params": params,
            "success": res["success"],
            "stdout": res["stdout"],
            "stderr": res["stderr"],
            "exit_code": res["exit_code"],
        })
    messages.append({"role": "user", "content": tool_results_prompt(json.dumps(rows, indent=2)), "hidden": True})
    session_mod.save(messages)

    chat_ui.set_thinking(True)
    chat_ui.render(messages)

    response = ""
    frame = FrameThrottle(lambda: chat_ui.render(messages))
    try:
        async for chunk in provider.stream(
            messages,
            {"model": config.get_effective_model(provider.name), "system_prompt": system_prompt, "max_tokens": 220},
        ):
            response += chunk
            chat_ui.set_streaming(response)
            frame.schedule()
    except Exception as err:
        chat_ui.notify(str(err) or "Stream error")
        logger.log("ERROR", str(err) or "Stream error")
    frame.flush()
    if response:
        messages.append({"role": "assistant", "content": response})
        logger.log("AI", response)
        chat_ui.set_streaming(None)
        await _write_from_response(response, chat_ui, request_text)
    chat_ui.render(messages)
    session_mod.save(messages)
    return True


async def _confirm_overwrite(msg: str) -> bool:
    loop = asyncio.get_event_loop()
    try:
        if _EDITOR is not None:
            ans = await loop.run_in_executor(None, lambda: _EDITOR.question(msg))
        else:
            ans = await loop.run_in_executor(
                None,
                lambda: input(f"  \033[33m{msg}\033[0m (y/N) "),
            )
    except (KeyboardInterrupt, EOFError):
        return False
    return str(ans or "").strip().lower() in ("y", "yes")


_CODE_FILE_RE = re.compile(
    r"([\w.-]+\.(?:html?|css|json|jsx|tsx|mjs|cjs|ts|js|md|markdown|txt|py|php|rb|go|java|c|cpp|h|sh|bat|yml|yaml|xml|sql|svg|csv|env))",
    re.I,
)


_FILE_VERBS = (
    "write|save|make|create|generate|build|code|design|implement|produce|add|"
    "store|put|give me|show me|make me|help me|need|want|have"
)
_FILE_NOUNS = (
    "file|folder|directory|txt|json|md|markdown|text file|document|html|css|js|"
    "javascript|script|page|webpage|website|code|project|config|app|application|"
    "api|bot|game|tool|crawler|scraper"
)
_KNOWLEDGE_MARKERS = re.compile(
    r"\b(how|why|what is|what are|what's|whats|explain|learn|teach me|meaning|"
    r"means|used for|tutorial|why is|what does|is it|does it)\b",
    re.I,
)
_CONCRETE_FILE_ASK = re.compile(
    rf"\b(?:create|make|write|save|generate|build|produce)\b[^.!?\n]{{0,60}}"
    rf"\b(?:{_FILE_NOUNS})\b",
    re.I,
)
_FILE_ASK_STRONG = re.compile(
    rf"\b(?:{_FILE_VERBS})\b[^.!?]{{0,80}}\b(?:{_FILE_NOUNS})\b", re.I
)
_FILE_ASK_SENTENCE = re.compile(
    rf"\b(?:{_FILE_VERBS})\b[^.!?\n]{{0,160}}\b(?:{_FILE_NOUNS})\b", re.I
)

# Attached as a hidden user message to file requests so small local models
# reliably emit complete FILE: blocks with closed fences instead of free-style
# prose that gets truncated or never closes its code fences.
_FILE_BLOCK_PROMPT = """If the user asked you to create a file or project with code, output your whole answer as one or more file blocks — nothing else:

FILE: path/to/file.ext
```language
<complete, working code>
```

Rules:
- One FILE: header at the start of each file, immediately followed by its fenced code block.
- Always close every fence with ```.
- Write real, complete code on the first try — no placeholders, no "[0]", no Lorem ipsum, no "This is a basic example" filler, no fabricated external script URLs.
- If the request mentions serving or routing the files (e.g. a python web server, flask, routes), also write the server file (like app.py) that serves them.
"""


def _looks_like_file_request(text: str) -> bool:
    s = text or ""
    if _KNOWLEDGE_MARKERS.search(s) and not _CONCRETE_FILE_ASK.search(s):
        return False
    if _FILE_ASK_STRONG.search(s):
        return True
    return bool(_FILE_ASK_SENTENCE.search(s))


def _requested_file_name(text: str) -> Optional[str]:
    m = _CODE_FILE_RE.search(text or "")
    if m:
        return m.group(1)
    lower = (text or "").lower()
    if re.search(r"\b(python|py)\b", lower) and re.search(
        r"\b(html?|css|javascript|js|website|webpage|web|route)\b", lower
    ):
        return "app.py"
    if re.search(r"\b(python|py)\b", lower):
        return "script.py"
    if re.search(r"\b(flask|django|fastapi|streamlit)\b", lower):
        return "app.py"
    if re.search(r"\b(bash|zsh|shell)\b", lower):
        return "script.sh"
    if re.search(r"\b(javascript|js|script)\b", lower):
        return "script.js"
    if re.search(r"\b(typescript|ts)\b", lower):
        return "script.ts"
    if re.search(r"\bjson\b", lower):
        return "output.json"
    if re.search(r"\b(markdown|md)\b", lower):
        return "output.md"
    if re.search(r"\b(html?|webpage|website|page)\b", lower):
        return "index.html"
    if re.search(r"\bcss\b", lower):
        return "style.css"
    if re.search(r"\bapp\b", lower):
        return "app.py"
    if re.search(r"\b(yaml|yml)\b", lower):
        return "output.yml"
    if re.search(r"\bcsv\b", lower):
        return "output.csv"
    if re.search(r"\bsql\b", lower):
        return "output.sql"
    return None


def _extract_fallback_file(response: str, request_text: str) -> dict:
    lines = (response or "").split("\n")
    header_idx = next(
        (i for i, l in enumerate(lines) if re.match(r"^FILE:\s*.+$", l, re.I)), -1
    )
    if header_idx != -1:
        path = re.sub(r"^FILE:\s*", "", lines[header_idx], flags=re.I).strip()
        content = "\n".join(
            "" if re.match(r"^```", l.strip()) else l
            for l in lines[header_idx + 1 :]
        ).strip()
        return {"path": path, "content": content}
    fenced = re.search(r"```([\w./+-]*)[^\n]*\n?([\s\S]*?)(?:```|$)", response or "")
    if fenced:
        content = fenced.group(2).strip()
    else:
        content = re.sub(r"^FILE:\s*\S+\s*$", "", response or "", flags=re.M).strip()
    path = (
        _requested_file_name(request_text)
        or _language_file_name(fenced.group(1) if fenced else None)
        or _story_file_name(request_text)
    )
    return {"path": path, "content": content}


def _story_file_name(text: str) -> str:
    topic = extract_search_topic(text)
    raw = (topic or "story").lower()
    raw = re.sub(r"\s+and\s+(?:write|save|make|create|generate|build|give|put)\b.*$", "", raw)
    raw = re.sub(
        r"\s+(?:in|into|to)\s+.*?(?:file|txt|json|md|csv)\b.*$", "", raw
    )
    raw = re.sub(r"\s+for\s+me\s*$", "", raw).strip()
    slug = re.sub(r"[^a-z0-9]+", "-", raw).strip("-")
    return f"{slug or 'story'}.txt"


def _response_wants_file(response: str) -> bool:
    return bool(re.search(r"^(?:FILE|FOLDER):\s*\S", response or "", re.I | re.M))


_LANGUAGE_FILE_NAMES = {
    "html": "index.html",
    "htm": "index.html",
    "xml": "index.html",
    "css": "style.css",
    "js": "script.js",
    "javascript": "script.js",
    "ts": "script.ts",
    "json": "output.json",
    "md": "output.md",
    "markdown": "output.md",
    "py": "script.py",
    "python": "script.py",
    "txt": "output.txt",
    "sh": "script.sh",
    "bash": "script.sh",
    "yaml": "output.yml",
    "yml": "output.yml",
    "csv": "output.csv",
    "svg": "output.svg",
    "sql": "output.sql",
    "go": "main.go",
    "java": "Main.java",
    "rb": "script.rb",
    "php": "script.php",
    "c": "main.c",
    "cpp": "main.cpp",
    "h": "main.h",
}


def _language_file_name(lang: str) -> Optional[str]:
    return _LANGUAGE_FILE_NAMES.get((lang or "").lower())


def _response_is_solo_code(response: str) -> bool:
    blocks = re.findall(r"```[\w./+-]*[^\n]*\n?([\s\S]*?)(?:```|$)", response or "")
    if not blocks:
        return False
    total_code = sum(len(b) for b in blocks)
    prose = re.sub(r"```[\s\S]*?(?:```|$)", " ", response or "")
    prose = re.sub(r"\s+", " ", prose).strip()
    return total_code >= 50 and len(prose) <= 60


def _fallback_has_useful_code(response: str, request_text: str) -> bool:
    has_code = bool(re.search(r"```[\w./+-]*", response or "", re.M)) or _response_wants_file(
        response
    )
    return looks_like_story_request(request_text) or has_code


def _validate_written_code(file_name: str, chat_ui: ChatUI) -> None:
    """Compile-check a saved .py so truncated/broken replies never sit quietly."""
    if not file_name.lower().endswith(".py"):
        return

    def _check():
        try:
            source = open(file_name, encoding="utf-8").read()
            compile(source, file_name, "exec")
        except Exception as err:
            chat_ui.notify(
                f"Saved {file_name}, but Python couldn't compile it (the reply may have been cut short)."
            )
            logger.log("ERROR", f"invalid python saved to {file_name}: {err}")

    threading.Thread(target=_check, daemon=True).start()


def _looks_like_junk_code(content: str, file_name: str) -> bool:
    """Heuristic for placeholder/sample scaffolding emitted by weak local models."""
    text = content or ""
    return bool(
        re.search(
            r"(code\.google\.com|chrome-extension|Lorem ipsum|placeholder text|"
            r"\b[0-9]+\b\s*#\s*(This is|Python)|\bnot real code\b|\bcopy[-\s]?paste\b)",
            text,
            re.IGNORECASE,
        )
    )


def _warn_if_junk_code(file_name: str, content: str, chat_ui: ChatUI) -> None:
    if not _looks_like_junk_code(content, file_name):
        return
    chat_ui.notify(
        f"Heads up: {file_name} looks like placeholder/sample content (the local model may be too weak for real code). "
        f"Check it, or try importing from a stronger engine or model."
    )
    logger.log("WARN", f"possible junk content saved to {file_name}")


def _extract_file_blocks(response: str) -> list:
    """Tolerant FILE: block extraction (unclosed trailing fence allowed)."""
    blocks = []
    lines = (response or "").split("\n")
    n = len(lines)
    i = 0
    while i < n:
        m = re.match(r"^FILE:\s*(.+?)\s*$", lines[i], re.IGNORECASE)
        if m:
            j = i + 1
            while j < n and lines[j].strip() == "":
                j += 1
            fence = re.match(r"^```([\w./+-]*)", lines[j] if j < n else "")
            if fence:
                content = []
                k = j + 1
                while k < n and not re.match(r"^```", lines[k]):
                    content.append(lines[k])
                    k += 1
                blocks.append(
                    {"path": m.group(1).strip(), "language": fence.group(1), "content": "\n".join(content).strip()}
                )
                i = max(k, j + 1)
                continue
        i += 1
    return blocks


async def _write_from_response(response: str, chat_ui: ChatUI, request_text: str = "") -> None:
    parsed = FileWriter.parse(response)
    content_by_path = {f["path"]: f["content"] for f in parsed["files"]}
    results = await FileWriter.write(
        files=parsed["files"],
        folders=parsed["folders"],
        overwrite=False,
        confirm=_confirm_overwrite,
    )
    wrote_any = False
    for r in results:
        label = "folder" if r["kind"] == "folder" else "file"
        if r["status"] in ("written", "created"):
            wrote_any = True
            chat_ui.notify(f"Wrote {label}: {r['path']}")
            target = f" ({r['target']})" if r.get("target") else ""
            logger.log("FILE", f"wrote {label} {r['path']}{target}")
            _validate_written_code(r["path"], chat_ui)
            _warn_if_junk_code(r["path"], content_by_path.get(r["path"], ""), chat_ui)
        elif r["status"] == "skipped":
            chat_ui.notify(f"Skipped {label}: {r['path']} ({r['error']})")
            target = f" ({r['target']})" if r.get("target") else ""
            logger.log("FILE", f"skipped {label} {r['path']}{target}: {r['error']}")
        else:
            chat_ui.notify(f"Failed to write {label}: {r['path']} ({r['error']})")
            logger.log("ERROR", f"failed writing {label} {r['path']}: {r['error']}")

    handled_paths = {r["path"] for r in results if r["kind"] == "file"}
    for b in _extract_file_blocks(response):
        if b["path"] in handled_paths or not b["content"].strip():
            continue
        rescue = await FileWriter.write(
            files=[{"path": b["path"], "content": b["content"]}],
            overwrite=False,
            confirm=_confirm_overwrite,
        )
        r0 = rescue[0]
        if r0["status"] == "written":
            wrote_any = True
            chat_ui.notify(f"Wrote file: {b['path']} (recovered from truncated reply)")
            root_at = f" at {r0['target']}" if r0.get("target") else ""
            logger.log("FILE", f"wrote file {b['path']} (rescued truncated block){root_at}")
            _validate_written_code(b["path"], chat_ui)
            _warn_if_junk_code(b["path"], b["content"], chat_ui)
        elif r0["status"] == "skipped":
            chat_ui.notify(f"Skipped file: {b['path']} ({r0['error']})")
        else:
            chat_ui.notify(f"Failed to write file: {b['path']} ({r0['error']})")
            logger.log("ERROR", f"failed writing file {b['path']}: {r0['error']}")

    if not wrote_any and response and (
        _response_wants_file(response)
        or _response_is_solo_code(response)
        or _looks_like_file_request(request_text)
        or looks_like_story_request(request_text)
    ):
        fallback_info = _extract_fallback_file(response, request_text)
        name = fallback_info["path"]
        if not _fallback_has_useful_code(response, request_text):
            chat_ui.notify("The model replied without any code blocks — nothing was saved. Try again.")
            return
        if not fallback_info["content"].strip():
            chat_ui.notify("The model returned no code — nothing was saved. Try again.")
            return
        try:
            fallback = await FileWriter.write(
                files=[{"path": name, "content": fallback_info["content"]}],
                overwrite=False,
                confirm=_confirm_overwrite,
            )
        except Exception as err:
            chat_ui.notify(f"Failed to write file: {name} ({err})")
            return
        res = fallback[0]
        if res["status"] == "written":
            chat_ui.notify(f"Wrote file: {name}")
            res_at = f" ({res['target']})" if res.get("target") else ""
            logger.log("FILE", f"wrote file {name}{res_at}")
            _validate_written_code(name, chat_ui)
            _warn_if_junk_code(name, fallback_info["content"], chat_ui)
            fence_count = sum(1 for _ in re.finditer(r"```[\w./+-]*[^\n]*\n?[\s\S]*?(?:```|$)", response or ""))
            if fence_count > 1:
                chat_ui.notify(
                    f"Note: the reply contained {fence_count} code blocks but only {name} was saved. "
                    f"Ask me to save the others (one FILE: request per file)."
                )
                logger.log("WARN", f"multi-block reply: saved only {name} of {fence_count} code blocks")
        elif res["status"] == "skipped":
            chat_ui.notify(f"Skipped file: {name} ({res['error']})")
            res_at = f" ({res['target']})" if res.get("target") else ""
            logger.log("FILE", f"skipped file {name}{res_at}: {res['error']}")
        else:
            chat_ui.notify(f"Failed to write file: {name} ({res['error']})")
            logger.log("ERROR", f"failed writing file {name}: {res['error']}")


async def chat(provider, system_prompt: str, chat_ui: ChatUI):
    # Fresh start every launch: never resume silently. The old active session is
    # auto-backup'd (if it has messages) and stays on disk, reachable later via
    # /sessions and /session open.
    global _EDITOR
    session_mod.auto_backup()
    session_mod.create(None)
    messages = session_mod.load_active()
    session_name = session_mod.active_name()
    logger.log("SESSION", f"started provider={provider.name} model={config.get_effective_model(provider.name)} session={session_name}")
    if messages:
        user_count = sum(1 for m in messages if m.get("role") == "user")
        chat_ui.notify(f'Fresh session "{session_name}" ({user_count} previous message(s) carried). Use /sessions to open an old one.')
    else:
        chat_ui.notify(f'Hello! I am VierrataleAI (session "{session_name}"). Type /help for commands, or just start chatting.')

    editor = LineEditor(
        prompt=f"\033[1m\033[38;2;124;58;237m{Branding.USER_PROMPT}\033[0m \033[2m›\033[0m",
        commands=SLASH_COMMANDS,
    )
    _EDITOR = editor
    chat_ui.set_compositor(editor)
    editor.start()

    loop = asyncio.get_event_loop()
    chat_ui.render(messages)

    while True:
        try:
            chat_ui.render(messages)
            user_input = await loop.run_in_executor(None, editor.read_line)
            if user_input is None:
                break
            user_input = str(user_input)
            if not user_input.strip():
                continue

            cmd = user_input.strip().lower()

            if not cmd.startswith("/"):
                logger.log("USER", user_input.strip())

            if cmd in ("/quit", "/exit", "/q"):
                chat_ui.set_status("")
                print("  Goodbye!")
                logger.log("SESSION", "ended")
                editor.exit()
                sys.exit(0)

            if cmd == "/clear":
                chat_ui.clear_notices()
                chat_ui.set_status("")
                chat_ui.render(messages)
                continue

            if cmd == "/help":
                chat_ui.clear_notices()
                chat_ui.notify(
                    "Commands:\n  /search <query> · /fetch <url> · /model [name] · /provider [name]\n"
                    "  /models · /todos · /log [n|path] · /new · /sessions · /session new|open|delete|backup|restore\n"
                    "  /clear · /help · /quit"
                )
                chat_ui.render(messages)
                continue

            if cmd == "/log" or cmd.startswith("/log "):
                rest = user_input.strip()[4:].strip() if cmd.startswith("/log ") else ""
                chat_ui.clear_notices()
                if rest in ("path", "file"):
                    chat_ui.notify(f"Log file: {logger.get_path()}")
                elif rest.isdigit():
                    n = max(1, min(200, int(rest)))
                    lines = logger.tail(n)
                    chat_ui.notify("\n".join(lines) if lines else "No log entries yet.")
                else:
                    lines = logger.tail(30)
                    chat_ui.notify("\n".join(lines) if lines else "No log entries yet.")
                chat_ui.render(messages)
                continue

            if cmd == "/new":
                session_mod.auto_backup()
                created = session_mod.create(None)
                messages = session_mod.load_active()
                chat_ui.clear_notices()
                chat_ui.notify(
                    f'Started a new conversation (session: "{created}"). All messages cleared — '
                    "old ones are preserved, use /sessions to return."
                )
                chat_ui.render(messages)
                continue

            if cmd == "/sessions":
                chat_ui.clear_notices()
                sessions = session_mod.list_sessions()
                if not sessions:
                    chat_ui.notify("No sessions yet.")
                else:
                    for i, s in enumerate(sessions, 1):
                        marker = " (current)" if s["active"] else ""
                        plural = "" if s["count"] == 1 else "s"
                        chat_ui.notify(
                            f'{i}. {s["name"]}{marker} — {s["count"]} msg{plural} — {s["preview"]}'
                        )
                    chat_ui.notify("Open with /session open <name|#> · delete with /session delete <name|#>")
                chat_ui.render(messages)
                continue

            if cmd == "/session" or cmd.startswith("/session "):
                parts = user_input.strip().split()
                sub = parts[1] if len(parts) > 1 else ""
                chat_ui.clear_notices()
                if sub == "new":
                    name = " ".join(parts[2:]) or None
                    created = session_mod.create(name)
                    messages = session_mod.load_active()
                    chat_ui.notify(f'Session "{created}" created and active.')
                    chat_ui.render(messages)
                elif sub == "open":
                    target = " ".join(parts[2:]) or None
                    if not target:
                        chat_ui.notify("Usage: /session open <name|#index> — see /sessions.")
                    else:
                        opened = session_mod.open_session(target)
                        if not opened:
                            chat_ui.notify(f'Session "{target}" not found. Use /sessions to list.')
                        else:
                            messages = session_mod.load_active()
                            user_count = sum(1 for m in messages if m.get("role") == "user")
                            chat_ui.notify(f'Resumed session "{opened}" ({user_count} previous message(s)).')
                    chat_ui.render(messages)
                elif sub == "delete":
                    target = " ".join(parts[2:]) or None
                    if not target:
                        chat_ui.notify("Usage: /session delete <name|#index> — see /sessions.")
                    else:
                        removed = session_mod.remove(target)
                        if not removed:
                            chat_ui.notify(f'Session "{target}" not found. Use /sessions to list.')
                        else:
                            if session_mod.active_name() == removed:
                                messages = session_mod.load_active()
                                chat_ui.notify(
                                    f'Session "{removed}" deleted. Active session is now '
                                    f'"{session_mod.active_name()}".'
                                )
                            else:
                                chat_ui.notify(f'Session "{removed}" deleted.')
                    chat_ui.render(messages)
                elif sub == "backup":
                    target = " ".join(parts[2:]) or None
                    if target:
                        prev_active = session_mod.active_name()
                        opened = session_mod.open_session(target)
                        if not opened:
                            chat_ui.notify(f'Session "{target}" not found. Use /sessions to list.')
                        else:
                            saved = session_mod.auto_backup()
                            session_mod.open_session(prev_active)
                            if saved:
                                chat_ui.notify(f'Backed up session "{opened}" → {saved}. Restore with /session restore.')
                            else:
                                chat_ui.notify(f'Session "{opened}" is empty; nothing to back up.')
                    else:
                        saved = session_mod.auto_backup()
                        if saved:
                            chat_ui.notify(f'Backed up current session → {saved}. Restore with /session restore.')
                        else:
                            chat_ui.notify("No messages to back up.")
                    chat_ui.render(messages)
                elif sub == "backups":
                    backups = session_mod.list_backups()
                    chat_ui.clear_notices()
                    if not backups:
                        chat_ui.notify("No session backups found yet. They are created automatically on every fresh start.")
                    else:
                        chat_ui.notify(f"Session backups ({len(backups)}):")
                        for i, b in enumerate(backups[:20], 1):
                            chat_ui.notify(f"{i}. {b['name']}")
                        chat_ui.notify("Restore one with /session restore <name>")
                    chat_ui.render(messages)
                elif sub == "restore":
                    target = " ".join(parts[2:]) or None
                    if not target:
                        backups = session_mod.list_backups()
                        if backups:
                            chat_ui.clear_notices()
                            chat_ui.notify(f"Latest backups ({len(backups)}):")
                            for i, b in enumerate(backups[:10], 1):
                                chat_ui.notify(f"{i}. {b['name']}")
                            chat_ui.notify("Usage: /session restore <backup-name|#index>")
                        else:
                            chat_ui.notify("No backups found. Usage: /session restore <backup-name|#>")
                    else:
                        t = target
                        if t.startswith("#"):
                            backups = session_mod.list_backups()
                            idx = int(t[1:]) - 1
                            if 0 <= idx < len(backups):
                                t = backups[idx]["name"]
                        restored = session_mod.restore_backup(t)
                        if not restored:
                            chat_ui.notify(f'Backup "{target}" not found. Use /session backups to list.')
                        else:
                            messages = session_mod.load_active()
                            chat_ui.notify(f'Restored backup into session "{restored}".')
                    chat_ui.render(messages)
                else:
                    chat_ui.notify(
                        "Usage: /session new [name] · /session open <name|#> · /session delete <name|#> · "
                        "/session backup [name|#] · /session backups · /session restore <name|#>"
                    )
                    chat_ui.render(messages)
                continue

            if cmd == "/models":
                models = (
                    catalog.get_local_models()
                    if provider.is_local
                    else catalog.get_cloud_models()
                )
                installed = set()
                if provider.is_local:
                    for m in installer.get_installed_models(config.get("engine_host")):
                        installed.add(m)
                chat_ui.clear_notices()
                for m in models:
                    info = catalog.get_model_info(m)
                    current = " (active)" if m == config.get_effective_model(provider.name) else ""
                    if provider.is_local:
                        have = info["real_model"] in installed
                        chat_ui.notify(f"{m}{' ✓' if have else ' (not downloaded)'}{current} - {info['tier']}")
                    else:
                        chat_ui.notify(f"{m}{current} - {info['tier']}")
                if provider.is_local:
                    extras = [
                        m
                        for m in installed
                        if not catalog.get_model_info(m)
                        and m != config.get_effective_model(provider.name)
                    ]
                    if extras:
                        chat_ui.notify(f"  (+{len(extras)} additional engine models available)")
                chat_ui.render(messages)
                continue

            if cmd.startswith("/model"):
                parts = cmd.split()
                if len(parts) > 1:
                    model_name = parts[1]
                    canonical = catalog.normalize(model_name)
                    current = config.get_effective_model(provider.name)
                    info = catalog.get_model_info(canonical)

                    def apply_model(model):
                        config.save({"model": model})
                        config.set_provider_model(provider.name, model)
                        chat_ui.set_model(model, provider.display_name)

                    if provider.is_local and catalog.is_cloud_model(canonical):
                        chat_ui.notify(
                            f"Cannot use cloud model \"{canonical}\" on {provider.display_name} (local). "
                            f"Use /model VTL-2.7-Flash instead."
                        )
                    elif not info:
                        if provider.is_local:
                            switched = await _ensure_raw_local_model(model_name, chat_ui.notify)
                            if switched["ok"]:
                                apply_model(switched["model"])
                                reason = switched["reason"] or ""
                                chat_ui.notify(f"Model: {switched['model']}" + (f" — {reason}" if reason else ""))
                            else:
                                chat_ui.notify(f'Model "{model_name}" is not available. Current: {current}')
                        else:
                            chat_ui.notify(f"Unknown model: {model_name}")
                    elif info["is_local"]:
                        switched = await _ensure_local_model(canonical, chat_ui.notify)
                        if switched["ok"]:
                            apply_model(switched["model"])
                            reason = switched["reason"] or ""
                            chat_ui.notify(f"Model: {switched['model']}" + (f" — {reason}" if reason else ""))
                        else:
                            chat_ui.notify(
                                f'Could not switch to "{canonical}": {switched["reason"]}. Current: {current}'
                            )
                    else:
                        apply_model(canonical)
                        chat_ui.notify(f"Model: {canonical}")
                else:
                    chat_ui.notify(f"Current model: {config.get_effective_model(provider.name)}")
                chat_ui.render(messages)
                continue

            if cmd.startswith("/provider"):
                parts = cmd.split()
                if len(parts) > 1:
                    prov = parts[1]
                    if prov in ("cortex", "openai", "anthropic", "gemini"):
                        config.save({"provider": prov})
                        next_provider = create(prov)
                        if next_provider is not None and await next_provider.is_available():
                            provider = next_provider
                            chat_ui.notify(f"Provider: {prov}")
                        else:
                            chat_ui.notify(
                                f"Provider saved, but {prov} is not available right now. Will apply on restart."
                            )
                        if provider.is_local and catalog.is_cloud_model(
                            config.get_effective_model(provider.name)
                        ):
                            fallback = catalog.get_default_model()
                            config.save({"model": fallback})
                            config.set_provider_model(provider.name, fallback)
                            chat_ui.set_model(fallback, provider.display_name)
                            chat_ui.notify(
                                f"Cloud model can't run on {provider.display_name}; switched to {fallback}."
                            )
                    else:
                        chat_ui.notify(f"Unknown provider: {prov}")
                else:
                    chat_ui.notify(f"Current provider: {provider.name}")
                chat_ui.render(messages)
                continue

            if cmd.startswith("/system"):
                prompt = user_input.strip()[7:].strip()
                chat_ui.clear_notices()
                if prompt.lower() == "reset":
                    config.save({"system_prompt": ""})
                    system_prompt = load_system_prompt()
                    chat_ui.notify("System prompt reset to default.")
                elif prompt:
                    config.save({"system_prompt": prompt})
                    system_prompt = prompt
                    chat_ui.notify("System prompt updated.")
                else:
                    chat_ui.notify(f"Current system prompt: {system_prompt}")
                chat_ui.render(messages)
                continue

            if cmd.startswith("/search"):
                query = user_input.strip()[8:].strip()
                if not query:
                    chat_ui.notify("Usage: /search <query>")
                    chat_ui.render(messages)
                    continue
                chat_ui.clear_notices()
                chat_ui.set_status("")
                messages.append({"role": "user", "content": user_input})
                logger.log("USER", user_input.strip())
                await answer_with_search(messages, provider, query, system_prompt, config, chat_ui, user_input.strip())
                continue

            if cmd.startswith("/fetch"):
                url_part = user_input.strip()[6:].strip().split()[0] if user_input.strip()[6:].strip() else ""
                if not url_part:
                    chat_ui.notify("Usage: /fetch <url>")
                    chat_ui.render(messages)
                    continue
                chat_ui.clear_notices()
                chat_ui.set_status("")
                messages.append({"role": "user", "content": user_input})
                logger.log("USER", user_input.strip())
                await answer_with_fetch(messages, provider, url_part, system_prompt, config, chat_ui, user_input)
                continue

            if cmd.startswith("/download"):
                user_rest = user_input.strip()[10:].strip()
                url_part = user_rest.split()[0] if user_rest else ""
                if not url_part:
                    chat_ui.notify("Usage: /download <url>")
                    chat_ui.render(messages)
                    continue
                chat_ui.clear_notices()
                chat_ui.set_status("")
                messages.append({"role": "user", "content": user_input})
                logger.log("USER", user_input.strip())
                await answer_with_download(messages, provider, url_part, system_prompt, config, chat_ui, user_input)
                continue

            if cmd == "/todos" or cmd.startswith("/todos "):
                handle_todos_command(user_input, chat_ui, messages, os.getcwd())
                continue

            intent = detect_intent(user_input)
            if intent == "self":
                model = config.get_effective_model(provider.name)
                chat_ui.clear_notices()
                chat_ui.notify(
                    f"I'm running on {model} via the {provider.display_name} engine."
                )
                chat_ui.render(messages)
                continue

            if intent == "greeting":
                messages.append({"role": "user", "content": user_input})
                messages.append({"role": "assistant", "content": "Hello! How can I help you today?"})
                logger.log("AI", "Hello! How can I help you today?")
                session_mod.save(messages)
                chat_ui.clear_notices()
                chat_ui.render(messages)
                continue

            # Deterministic math: answer arithmetic ourselves (the small local
            # engine often hallucinates), so math never reaches the model.
            if not looks_like_operation_request(user_input):
                from .utils.math import try_solve_math
                math_answer = try_solve_math(user_input)
                if math_answer:
                    messages.append({"role": "user", "content": user_input})
                    messages.append({"role": "assistant", "content": math_answer})
                    logger.log("AI", math_answer)
                    session_mod.save(messages)
                    chat_ui.clear_notices()
                    chat_ui.render(messages)
                    continue

            if intent == "knowledge":
                topic = extract_search_topic(user_input) or user_input.strip()
                messages.append({"role": "user", "content": user_input})
                await answer_with_search(messages, provider, topic, system_prompt, config, chat_ui, user_input.strip())
                continue

            # If the message contains a bare URL, open it automatically and ask the AI to summarize.
            import re
            if re.search(r"https?://\S+", user_input, re.I):
                url = _extract_url(user_input)
                if url:
                    chat_ui.clear_notices()
                    chat_ui.set_status("")
                    messages.append({"role": "user", "content": user_input})
                    await answer_with_fetch(messages, provider, url, system_prompt, config, chat_ui, user_input)
                    continue

            if looks_like_operation_request(user_input):
                chat_ui.clear_notices()
                done = await answer_with_tools(
                    messages, provider, user_input.strip(), system_prompt, config, chat_ui, os.getcwd()
                )
                if done:
                    continue

            # Refine the last built website (colours, theme, title, sections...).
            # run_with_tools() decides whether it really is a refine request;
            # otherwise answer_with_tools() returns no results and normal chat
            # below takes over.
            if re.search(
                r"(make|switch|change|turn|set|use|add|remove|delete|drop|recolor|restyle|redesign|update|apply|repaint|adjust|rename)",
                user_input,
                re.I,
            ) and re.search(
                r"(it|site|website|page|theme|mode|color|colour|title|name|section|accent|background|style|design)",
                user_input,
                re.I,
            ):
                chat_ui.clear_notices()
                done = await answer_with_tools(
                    messages, provider, user_input.strip(), system_prompt, config, chat_ui, os.getcwd()
                )
                if done:
                    continue

            messages.append({"role": "user", "content": user_input})
            if _looks_like_file_request(user_input):
                messages.append({"role": "user", "content": _FILE_BLOCK_PROMPT, "hidden": True})
            session_mod.save(messages)

            chat_ui.set_thinking(True)
            chat_ui.render(messages)

            response = ""
            frame = FrameThrottle(lambda: chat_ui.render(messages))
            async for chunk in provider.stream(
                messages,
                {
                    "model": config.get_effective_model(provider.name),
                    "system_prompt": system_prompt,
                },
            ):
                response += chunk
                chat_ui.set_streaming(response)
                frame.schedule()

            frame.flush()
            if response:
                messages.append({"role": "assistant", "content": response})
                logger.log("AI", response)
                chat_ui.set_streaming(None)
                await _write_from_response(response, chat_ui, user_input)
            chat_ui.render(messages)
            session_mod.save(messages)

        except (KeyboardInterrupt, EOFError):
            print("\n  Goodbye!")
            logger.log("SESSION", "ended")
            editor.stop()
            sys.exit(0)
        except Exception as e:
            logger.log("ERROR", str(e))
            chat_ui.notify(str(e))
            chat_ui.render(messages)


async def _ensure_raw_local_model(real_model: str, notify=None) -> dict:
    host = config.get("engine_host")
    resolved = await asyncio.to_thread(installer.resolve_installed, host, real_model)
    if resolved["model"]:
        return {"ok": True, "model": resolved["model"], "reason": resolved["reason"]}
    if notify:
        notify(f"Downloading {real_model}… (this can take a while)")
    pulled = await asyncio.to_thread(installer.ensure_model_pulled, host, real_model)
    if pulled:
        if notify:
            notify(f"Model {real_model} ready.")
        return {"ok": True, "model": real_model, "reason": None}
    if notify:
        notify(f"Could not download {real_model}.")
    first = await asyncio.to_thread(installer.first_installed, host)
    if first:
        return {
            "ok": True,
            "model": first,
            "reason": f"Could not download {real_model}; using installed {first}",
        }
    return {"ok": False, "model": None, "reason": f"Could not download model: {real_model}"}


async def _ensure_local_model(model_name: str, notify=None) -> dict:
    info = catalog.get_model_info(model_name)
    if not info:
        return await _ensure_raw_local_model(model_name, notify)
    if not info["is_local"]:
        return {"ok": False, "model": None, "reason": f"{model_name} is not a local model"}
    return await _ensure_raw_local_model(info["real_model"], notify)


def main():
    parser = argparse.ArgumentParser(
        prog=Branding.APP_NAME,
        description=f"{Branding.APP_NAME} - Intelligent terminal assistant",
    )
    parser.add_argument("--provider", "-p", help="Provider: cortex, openai")
    parser.add_argument("--model", "-m", help="Model name")
    parser.add_argument("--clear", action="store_true", help="(deprecated) screen is always cleared on start")
    parser.add_argument(
        "--install", "--setup", action="store_true",
        help="Install engine + model + a 'vierrataleai' command, then run",
    )
    parser.add_argument("--version", "-v", action="version", version=f"{Branding.APP_NAME} {Branding.VERSION}")

    args = parser.parse_args()

    config.load()
    if args.provider:
        config.save({"provider": args.provider})
    if args.model:
        config.save({"model": catalog.normalize(args.model)})

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    if args.install:
        loop.run_until_complete(
            fake_install(lambda: loop.run_in_executor(None, installer.ensure))
        )
        ui.print_info(
            'Use install.sh to create the global "vierrataleai" / "vierratale" commands; '
            'then run them directly.'
        )

    loop.run_until_complete(
        ui.show_progress(
            ["Checking engine", "Installing dependencies", "Downloading model", "Optimizing"],
            lambda: loop.run_in_executor(None, installer.ensure),
        )
    )

    provider = loop.run_until_complete(auto_detect())
    if not provider:
        logger.init()
        logger.log("ERROR", "no provider available")
        ui.print_error("No AI engine available. Please install or configure a provider.")
        sys.exit(1)

    logger.init()
    chosen_model = config.get_effective_model(provider.name)
    if provider.is_local and catalog.is_cloud_model(chosen_model):
        fallback = catalog.get_default_model()
        config.save({"model": fallback})
        config.set_provider_model(provider.name, fallback)
        loop.run_until_complete(_ensure_local_model(fallback))
        logger.log(
            "WARN",
            f'cloud model "{chosen_model}" cannot run on local provider {provider.name}; switched to {fallback}',
        )
        ui.print_info(f'"{chosen_model}" is a cloud model and can\'t run on {provider.display_name}. Switched to {fallback}.')

    logger.log("APP", f"started provider={provider.name} model={config.get_effective_model(provider.name)}")

    config.save({"provider": provider.name})

    if provider.is_local:
        loop.run_until_complete(_ensure_local_model(config.get("model")))

    has_warmup = getattr(provider, "warmup", None)
    if has_warmup:
        loop.create_task(provider.warmup())

    # Always clear the screen at startup: everything above the CLI is removed so
    # the banner + conversation start on a clean slate. The banner itself is
    # drawn inside ChatUI.render(), so it can't be erased by the first render.
    ui.clear()

    system_prompt = load_system_prompt()

    chat_ui = ChatUI(
        model=config.get_effective_model(provider.name),
        engine=provider.display_name,
    )

    try:
        loop.run_until_complete(chat(provider, system_prompt, chat_ui))
    except (KeyboardInterrupt, EOFError):
        ui.print_info("Goodbye!")
