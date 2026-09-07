import asyncio
import json
import os
import shutil
import tempfile
import unittest

from vierrataleai.cmd.agent import (
    looks_like_operation_request, parse_tool_plan, heuristic_plan,
    normalize_tool_call, run_with_tools, plan_once,
    _last_built_web_folder, _web_refine_request, _web_config_from_folder, _apply_web_refine_hints,
)
from vierrataleai import config as cfg



class FakeProvider:
    name = "fake"

    def __init__(self, plan):
        self.plan = plan

    async def complete(self, messages, options=None):
        return self.plan


class ToolAgentTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="vierra-agent-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def run_coro(self, coro):
        return asyncio.run(coro)

    def test_detection_recognizes_operations(self):
        for q in (
            "buat folder test",
            "buat file index.js",
            "tulis file readme.txt",
            "hayu hapus file test.txt",
            "lihat isi folder",
            "jalankan npm install express",
            "khakkan npm install",
            "buat project react sederhana",
            "run python script.py",
            "git status",
            "make me a web and pack it into a folder",
            "buat website sederhana dalam folder",
            "build a site and taruh ke folder demo",
        ):
            self.assertTrue(looks_like_operation_request(q), q)
        for q in ("apa itu javascript?", "musim apa sekarang?", "who is wiie?", "ceritakan tentang kamu"):
            self.assertFalse(looks_like_operation_request(q), q)

    def test_heuristic_plan(self):
        self.assertEqual(
            heuristic_plan("buat folder demo-x"),
            [{"name": "create_directory", "params": {"path": "demo-x"}}],
        )
        self.assertEqual(
            heuristic_plan("buat file index.js"),
            [{"name": "create_file", "params": {"path": "index.js", "content": ""}}],
        )
        self.assertEqual(
            heuristic_plan("buat folder test lalu buat index.js didalamnya"),
            [
                {"name": "create_directory", "params": {"path": "test"}},
                {"name": "create_file", "params": {"path": "test/index.js", "content": ""}},
            ],
        )
        self.assertEqual(heuristic_plan("hapus file test.txt"), [{"name": "delete_file", "params": {"path": "test.txt"}}])
        self.assertEqual(heuristic_plan("lihat isi folder"), [{"name": "list_directory", "params": {"path": "."}}])
        self.assertEqual(heuristic_plan("pwd"), [{"name": "run_command", "params": {"command": "pwd"}}])
        self.assertEqual(heuristic_plan("npm install express"), [{"name": "run_command", "params": {"command": "npm install express"}}])
        self.assertEqual(len(heuristic_plan("buat project react sederhana")), 8)
        self.assertEqual(heuristic_plan("buat project react sederhana")[0]["params"]["path"], "react")

    def test_web_scaffold_heuristic_builds_runnable_folder(self):
        plan = heuristic_plan("make me a web using html,css and javascript and pack it into a folder")
        self.assertEqual(len(plan), 5)
        self.assertEqual(plan[0], {"name": "create_directory", "params": {"path": "webapp"}})
        self.assertEqual(plan[1]["params"]["path"], "webapp/index.html")
        self.assertIn("<!doctype html>", plan[1]["params"]["content"])
        self.assertEqual(plan[2]["params"]["path"], "webapp/style.css")
        self.assertEqual(plan[3]["params"]["path"], "webapp/script.js")
        self.assertEqual(plan[4]["params"]["path"], "webapp/app.py")
        self.assertIn("SimpleHTTPRequestHandler", plan[4]["params"]["content"])

        named = heuristic_plan("buat website sederhana bernama demo-web dalam folder")
        self.assertEqual(named[0]["params"]["path"], "demo-web")
        self.assertEqual(named[4]["params"]["path"], "demo-web/app.py")

    def test_web_scaffold_designed_around_subject(self):
        plan = heuristic_plan("make me a website about gemini, use html combine css, and logics python and javascript")
        self.assertEqual(len(plan), 5)
        self.assertEqual(plan[0]["name"], "create_directory")
        self.assertEqual(plan[0]["params"]["path"], "gemini")
        self.assertEqual(plan[1]["params"]["path"], "gemini/index.html")
        self.assertIn("Welcome to Gemini", plan[1]["params"]["content"])
        self.assertNotIn("Hello from", plan[1]["params"]["content"])
        self.assertEqual(plan[2]["params"]["path"], "gemini/style.css")
        self.assertIn(".card-grid", plan[2]["params"]["content"])
        self.assertEqual(plan[3]["params"]["path"], "gemini/script.js")
        self.assertIn("fetch('/api/info'", plan[3]["params"]["content"])
        self.assertEqual(plan[4]["params"]["path"], "gemini/app.py")
        self.assertIn("SimpleHTTPRequestHandler", plan[4]["params"]["content"])
        self.assertIn("/api/contact", plan[4]["params"]["content"])
        self.assertNotIn('src="https:', plan[1]["params"]["content"])

    def test_web_scaffold_node_uses_node_server(self):
        plan = heuristic_plan("make a website about coffee, use html css and node")
        self.assertEqual(len(plan), 6)
        paths = [p["params"]["path"] for p in plan]
        self.assertIn("coffee/index.html", paths)
        self.assertIn("coffee/script.js", paths)
        self.assertIn("coffee/package.json", paths)
        self.assertIn("coffee/server.js", paths)
        self.assertNotIn("coffee/app.py", paths)
        server = next(p for p in plan if p["params"]["path"] == "coffee/server.js")
        self.assertIn("http.createServer", server["params"]["content"])

    def test_web_scaffold_react_builds_tsx_project(self):
        plan = heuristic_plan("make a react website about gemini")
        paths = [p["params"]["path"] for p in plan]
        self.assertEqual(len(plan), 8)
        self.assertIn("gemini/package.json", paths)
        self.assertIn("gemini/tsconfig.json", paths)
        self.assertIn("gemini/vite.config.ts", paths)
        self.assertIn("gemini/index.html", paths)
        self.assertIn("gemini/src/main.tsx", paths)
        self.assertIn("gemini/src/App.tsx", paths)
        self.assertIn("gemini/src/styles.css", paths)
        app = next(p for p in plan if p["params"]["path"] == "gemini/src/App.tsx")["params"]["content"]
        self.assertIn("Welcome to", app)
        self.assertIn("Gemini", app)
        self.assertNotIn("__TITLE__", app)
        self.assertNotIn("__TOPIC__", app)
        idx = next(p for p in plan if p["params"]["path"] == "gemini/index.html")["params"]["content"]
        self.assertNotIn("__TITLE__", idx)
        self.assertIn("Gemini", idx)

    def test_project_scaffolds_emit_tool_names(self):
        for q in ["buat project react sederhana", "buat project node app", "buat project python app"]:
            plan = heuristic_plan(q)
            self.assertGreaterEqual(len(plan), 1)
            for item in plan:
                self.assertIsInstance(item["name"], str)
                self.assertTrue(item["name"])
                self.assertIsInstance(item["params"]["path"], str)
        self.assertEqual(heuristic_plan("buat project react sederhana")[1]["name"], "create_file")

    def test_web_scaffold_heuristic_does_not_fire_for_plain_requests(self):
        self.assertEqual(heuristic_plan("buat folder demo"), [{"name": "create_directory", "params": {"path": "demo"}}])
        self.assertEqual(heuristic_plan("buat file index.js"), [{"name": "create_file", "params": {"path": "index.js", "content": ""}}])

    def test_web_scaffold_captures_stylish_subject(self):
        plan = heuristic_plan("make me a stylish-ai website")
        self.assertEqual(len(plan), 5)
        self.assertEqual(plan[0]["name"], "create_directory")
        self.assertEqual(plan[0]["params"]["path"], "stylish-ai")
        idx = next(p for p in plan if p["params"]["path"] == "stylish-ai/index.html")["params"]["content"]
        self.assertIn("Welcome to Stylish Ai", idx)
        self.assertNotIn("Welcome to Webapp", idx)

    def test_web_scaffold_applies_palette_and_light_style(self):
        blue = heuristic_plan("make a dark premium blue website about analytics")
        blue_css = next(p for p in blue if p["params"]["path"] == "analytics/style.css")["params"]["content"]
        self.assertIn("--accent: #2563eb;", blue_css)

        light = heuristic_plan("make a clean light website about coffee")
        light_html = next(p for p in light if p["params"]["path"] == "coffee/index.html")["params"]["content"]
        self.assertIn('<html lang="en" data-theme="light">', light_html)
        light_css = next(p for p in light if p["params"]["path"] == "coffee/style.css")["params"]["content"]
        self.assertIn("rgba(124, 58, 237, 0.12)", light_css)

    def test_plan_once_applies_ai_design_config_for_website(self):
        cfg_json = json.dumps({
            "name": "Stylish Ai",
            "folder": "stylish-ai",
            "topic": "stylish AI",
            "description": "A bold, modern showcase for a stylish AI studio.",
            "style": "dark",
            "accent": "#0ea5e9",
            "accent2": "#22d3ee",
            "sections": ["about", "features", "gallery", "stats", "contact"],
        })
        seen = {}

        class DesignerProvider:
            name = "fake"

            async def complete(self, messages, options=None):
                seen["prompt"] = (options or {}).get("system_prompt", "")
                return cfg_json

        plan = self.run_coro(plan_once(DesignerProvider(), [], "make me a stylish-ai website"))
        self.assertEqual(plan[0]["name"], "create_directory")
        self.assertEqual(plan[0]["params"]["path"], "stylish-ai")
        html = next(p for p in plan if p["params"]["path"] == "stylish-ai/index.html")["params"]["content"]
        css = next(p for p in plan if p["params"]["path"] == "stylish-ai/style.css")["params"]["content"]
        self.assertIn("Welcome to Stylish Ai", html)
        self.assertIn("A bold, modern showcase for a stylish AI studio.", html)
        self.assertIn("--accent: #0ea5e9;", css)
        self.assertIn("You are a web designer", seen["prompt"])

    def test_plan_once_falls_back_to_heuristic_design_when_ai_config_bad(self):
        class BadProvider:
            name = "fake"

            async def complete(self, messages, options=None):
                return "sorry, no json here"

        plan = self.run_coro(plan_once(BadProvider(), [], "make me a stylish-ai website"))
        self.assertEqual(plan[0]["params"]["path"], "stylish-ai")
        html = next(p for p in plan if p["params"]["path"] == "stylish-ai/index.html")["params"]["content"]
        self.assertIn("Welcome to Stylish Ai", html)

    def test_plan_once_falls_back_to_heuristic_when_model_slow(self):
        os.environ["VIERRATALE_PLAN_TIMEOUT_MS"] = "200"
        cfg.load()

        class SlowProvider:
            name = "slow"

            async def complete(self, messages, options=None):
                await asyncio.sleep(10)
                return ""

        plan = self.run_coro(plan_once(SlowProvider(), [], "buat file hello.js", {"heuristic_first": False}))
        self.assertEqual(plan, [{"name": "create_file", "params": {"path": "hello.js", "content": ""}}])
        os.environ.pop("VIERRATALE_PLAN_TIMEOUT_MS", None)
        cfg.load()

    def test_heuristic_fast_path_never_touches_model(self):
        called = {"hit": False}

        class ExplodingProvider:
            name = "explode"

            async def complete(self, messages, options=None):
                called["hit"] = True
                raise RuntimeError("model must not be called")

        plan = self.run_coro(plan_once(ExplodingProvider(), [], "make me a folder named quick-x"))
        self.assertEqual(plan, [{"name": "create_directory", "params": {"path": "quick-x"}}])
        self.assertFalse(called["hit"], "model plan round was skipped entirely")

    def test_parse_tool_plan_tolerates_fences(self):
        self.assertEqual(len(parse_tool_plan('[{"name":"create_directory","path":"test"}]')), 1)
        fenced = parse_tool_plan('Rencana:\n```json\n[{"name":"create_file","path":"a.js","content":"x"}]\n```\nSelesai.')
        self.assertEqual(len(fenced), 1)
        self.assertEqual(fenced[0]["name"], "create_file")
        single = parse_tool_plan('{"name":"run_command","command":"mkdir -p z"}')
        self.assertEqual(len(single), 1)
        self.assertEqual(parse_tool_plan("NONE"), [])
        self.assertEqual(parse_tool_plan("tidak butuh tool"), [])
        self.assertEqual(parse_tool_plan('{"name":"untrusted","command":"x"}'), [])

    def test_normalize_only_known_tools(self):
        self.assertEqual(
            normalize_tool_call({"name": "create_file", "path": "x.js", "content": "hi"}),
            {"name": "create_file", "params": {"path": "x.js", "content": "hi"}},
        )
        self.assertIsNone(normalize_tool_call({"name": "create_file"}))
        self.assertIsNone(normalize_tool_call({"name": "run_command", "command": 42}))
        self.assertIsNone(normalize_tool_call({"name": "sudo", "command": "rm -rf /"}))

    def test_demo_ai_creates_dir_and_file(self):
        provider = FakeProvider(
            json.dumps([
                {"name": "create_directory", "path": "test"},
                {"name": "create_file", "path": "test/index.js", "content": 'console.log("halo")'},
            ])
        )
        out = self.run_coro(
            run_with_tools(provider, [], "buat folder test lalu buat index.js didalamnya", cwd=self.dir, heuristic_first=False)
        )
        self.assertEqual(len(out["results"]), 2)
        self.assertTrue(out["results"][0]["result"]["success"], out["results"][0]["result"]["stderr"])
        self.assertTrue(out["results"][1]["result"]["success"], out["results"][1]["result"]["stderr"])
        with open(os.path.join(self.dir, "test", "index.js")) as fh:
            self.assertEqual(fh.read(), 'console.log("halo")')

    def test_heuristic_plans_system_package_install(self):
        for q in ["install curl", "pasang wget", "install the package jq", "pkg install lsof htop"]:
            plan = heuristic_plan(q)
            self.assertEqual(len(plan), 1, q)
            self.assertEqual(plan[0]["name"], "run_command")
            self.assertRegex(plan[0]["params"]["command"], r"^(pkg|apt(-get)?) install ", q)
        self.assertEqual(
            heuristic_plan("npm install express"),
            [{"name": "run_command", "params": {"command": "npm install express"}}],
        )
        self.assertEqual(heuristic_plan("install the project into a folder"), [])
        self.assertEqual(heuristic_plan("install node modules"), [])

    def test_run_with_tools_shows_file_tree(self):
        class CapturingChatUI:
            def __init__(self):
                self.notices = []

            def notify(self, text):
                self.notices.append(text)

            def set_status(self, *_a, **_k):
                pass

            def set_thinking(self, *_a, **_k):
                pass

            def render(self, *_a, **_k):
                pass

        provider = FakeProvider(
            json.dumps([
                {"name": "create_directory", "path": "demo"},
                {"name": "create_file", "path": "demo/halo.txt", "content": "hello"},
            ])
        )
        ui = CapturingChatUI()
        out = self.run_coro(
            run_with_tools(
                provider, [], "buat folder demo lalu buat file halo.txt didalamnya",
                cwd=self.dir, heuristic_first=False, chat_ui=ui,
            )
        )
        self.assertEqual(len(out["results"]), 2)
        self.assertEqual(len(ui.notices), 3, ui.notices)
        tree = ui.notices[-1]
        self.assertIn("demo", tree)
        self.assertIn("halo.txt", tree)
        self.assertTrue("\u251c" in tree or "\u2514" in tree)

    def test_heuristic_fallback_when_model_plan_unusable(self):
        provider = FakeProvider("Maaf, saya tidak bisa menjalankan tool. Tolong lakukan manual.")
        out = self.run_coro(
            run_with_tools(provider, [], "buat folder demo-heuristic", cwd=self.dir, heuristic_first=False)
        )
        self.assertEqual(len(out["results"]), 1)
        self.assertEqual(out["results"][0]["name"], "create_directory")
        self.assertTrue(os.path.isdir(os.path.join(self.dir, "demo-heuristic")))

    def test_model_plan_error_falls_back_to_heuristic(self):
        class FailingProvider:
            name = "fake"

            async def complete(self, messages, options=None):
                raise RuntimeError('[ERR-0002] model "VRTL-6.pro" is not installed on the engine.')

        out = self.run_coro(
            run_with_tools(FailingProvider(), [], "buat folder test-error", cwd=self.dir, heuristic_first=False)
        )
        self.assertEqual(len(out["results"]), 1)
        self.assertEqual(out["results"][0]["name"], "create_directory")
        self.assertTrue(os.path.isdir(os.path.join(self.dir, "test-error")))

    # ---- refine-after-build -------------------------------------------------

    def _built_site_message(self, folder="stylish-ai"):
        return {
            "role": "user",
            "hidden": True,
            "content": json.dumps(
                [
                    {"tool": "create_directory", "params": {"path": folder}},
                    {"tool": "create_file", "params": {"path": f"{folder}/index.html"}},
                    {"tool": "create_file", "params": {"path": f"{folder}/style.css"}},
                ]
            ),
        }

    def _build_site_disk(self, folder="stylish-ai"):
        for call in heuristic_plan("make me a stylish-ai website"):
            if call["name"] == "create_directory":
                continue
            if call["name"] != "create_file":
                continue
            os.makedirs(os.path.join(self.dir, call["params"]["path"].split("/")[0]), exist_ok=True)
            with open(os.path.join(self.dir, call["params"]["path"]), "w", encoding="utf-8") as fh:
                fh.write(call["params"]["content"])

    def test_refine_last_built_folder_finds_site(self):
        self.assertEqual(_last_built_web_folder([self._built_site_message()]), "stylish-ai")
        self.assertIsNone(_last_built_web_folder([]))
        later = [
            {"role": "user", "content": "hi"},
            self._built_site_message(),
            {"role": "user", "content": "then built gemini/index.html"},
        ]
        self.assertEqual(_last_built_web_folder(later), "gemini")

    def test_refine_request_gates_change_phrasing(self):
        msg = [self._built_site_message()]
        self.assertEqual(_web_refine_request("make it blue", msg), "stylish-ai")
        self.assertEqual(_web_refine_request("change the title to acme corp", msg), "stylish-ai")
        self.assertEqual(_web_refine_request("add a gallery section", msg), "stylish-ai")
        self.assertEqual(_web_refine_request("switch to light theme", msg), "stylish-ai")
        self.assertEqual(_web_refine_request("apa itu javascript?", msg), None)
        self.assertEqual(_web_refine_request("what color is the site?", msg), None)
        self.assertEqual(_web_refine_request("make me a website about cats", msg), None)
        self.assertEqual(_web_refine_request("buat folder testing", msg), None)
        self.assertEqual(_web_refine_request("remove gallery section", msg), "stylish-ai")
        self.assertEqual(_web_refine_request("drop the contact section", msg), "stylish-ai")
        self.assertEqual(_web_refine_request("make it blue", []), None)
        self.assertEqual(_web_refine_request("the site is awesome", msg), None)
        self.assertEqual(_web_refine_request("make it simple", msg), "stylish-ai")

    def test_refine_config_from_folder(self):
        self._build_site_disk()
        cfg = _web_config_from_folder(self.dir, "stylish-ai")
        self.assertEqual(cfg["name"], "Stylish Ai")
        self.assertEqual(cfg["folder"], "stylish-ai")
        self.assertEqual(cfg["style"], "dark")
        self.assertEqual(cfg["accent"], "#7c3aed")
        self.assertEqual(cfg["description"], "")
        self.assertEqual(cfg["sections"], ["about", "features", "gallery", "stats", "contact"])
        self.assertIsNone(_web_config_from_folder(self.dir, "nope"))

    def test_refine_hints_map_colours_themes_sections_titles(self):
        base = {
            "name": "Stylish Ai", "folder": "stylish-ai", "topic": "", "description": "",
            "style": "dark", "accent": "#7c3aed", "accent2": "#06b6d4",
            "sections": ["about", "features", "gallery", "stats", "contact"],
        }
        blue = _apply_web_refine_hints("make it blue", base)
        self.assertEqual(blue["accent"], "#2563eb")
        self.assertEqual(blue["accent2"], "#06b6d4")
        self.assertEqual(blue["style"], "dark")

        self.assertEqual(_apply_web_refine_hints("switch to light theme", base)["style"], "light")
        self.assertEqual(_apply_web_refine_hints("make it minimal", base)["style"], "minimal")

        drop = _apply_web_refine_hints("remove gallery and contact sections", base)
        self.assertEqual(drop["sections"], ["about", "features", "stats"])

        title = _apply_web_refine_hints("change the title to acme corp", base)
        self.assertEqual(title["name"], "acme corp")

    def test_refine_run_with_tools_rerenders_site(self):
        self._build_site_disk()
        provider = FakeProvider(
            json.dumps(
                {
                    "name": "Stylish Ai",
                    "description": "A modern AI studio with calm cyan energy.",
                }
            )
        )
        out = self.run_coro(
            run_with_tools(
                provider,
                [{"role": "user", "content": "make me a stylish-ai website"}, self._built_site_message()],
                "switch to light theme, make it cyan, remove gallery section",
                cwd=self.dir,
            )
        )
        self.assertTrue(len(out["results"]) >= 4, out["results"])
        with open(os.path.join(self.dir, "stylish-ai", "index.html"), encoding="utf-8") as fh:
            idx = fh.read()
        with open(os.path.join(self.dir, "stylish-ai", "style.css"), encoding="utf-8") as fh:
            css = fh.read()
        self.assertIn("Welcome to Stylish Ai", idx)
        self.assertIn("A modern AI studio with calm cyan energy.", idx)
        self.assertIn('data-theme="light"', idx)
        self.assertNotIn('<section id="gallery"', idx)
        self.assertIn("--accent: #0891b2;", css)
        self.assertNotIn("--accent: #7c3aed;", css)

    # ------------------------------------------------------------------ #
    # Todos
    # ------------------------------------------------------------------ #

    def test_normalize_todo_tools(self):
        self.assertEqual(
            normalize_tool_call({"name": "todo_add", "text": "x"}),
            {"name": "todo_add", "params": {"text": "x"}},
        )
        self.assertEqual(normalize_tool_call({"name": "todo_list"}), {"name": "todo_list", "params": {}})
        self.assertEqual(normalize_tool_call({"name": "todo_clear"}), {"name": "todo_clear", "params": {}})
        self.assertEqual(
            normalize_tool_call({"name": "todo_update", "index": 3, "done": True}),
            {"name": "todo_update", "params": {"index": 3, "done": True}},
        )
        self.assertIsNone(normalize_tool_call({"name": "todo_add", "text": ""}))
        self.assertIsNone(normalize_tool_call({"name": "todo_update", "index": "abc"}))

    def test_run_with_tools_tracks_todos(self):
        provider = FakeProvider(
            json.dumps(
                [
                    {"name": "todo_add", "text": "setup project"},
                    {"name": "todo_add", "text": "write code"},
                    {"name": "todo_update", "index": 1, "done": True},
                    {"name": "todo_list"},
                ]
            )
        )
        out = self.run_coro(
            run_with_tools(provider, [], "buat project todos-demo", cwd=self.dir, heuristic_first=False)
        )
        self.assertEqual(len(out["results"]), 4)
        for r in out["results"]:
            self.assertTrue(r["result"]["success"], r["result"]["stderr"])
        with open(os.path.join(self.dir, ".todos.json"), encoding="utf-8") as fh:
            todos = json.load(fh)
        self.assertEqual(len(todos), 2)
        self.assertEqual(todos[0]["text"], "setup project")
        self.assertTrue(todos[0]["done"])
        self.assertEqual(todos[1]["text"], "write code")
        self.assertFalse(todos[1]["done"])
        self.assertIn("write code", out["results"][3]["result"]["stdout"])

    # ------------------------------------------------------------------ #
    # Auto error fixing
    # ------------------------------------------------------------------ #

    def test_auto_fix_retries_failed_step(self):
        provider = FailingThenProvider(
            [
                json.dumps([{"name": "run_command", "command": "cat missing.txt"}]),
                json.dumps([{"name": "create_file", "path": "recovered.txt", "content": "fixed"}]),
            ]
        )
        out = self.run_coro(
            run_with_tools(provider, [], "buat file fix.txt", cwd=self.dir, heuristic_first=False)
        )
        self.assertEqual(len(out["results"]), 2)
        self.assertFalse(out["results"][0]["result"]["success"])
        self.assertEqual(out["results"][1]["name"], "create_file")
        self.assertTrue(out["results"][1]["result"]["success"], out["results"][1]["result"]["stderr"])
        self.assertTrue(os.path.exists(os.path.join(self.dir, "recovered.txt")))
        self.assertEqual(provider.calls, 2)

    def test_auto_fix_is_bounded(self):
        provider = FailingThenProvider([json.dumps([{"name": "run_command", "command": "cat missing.txt"}])])
        out = self.run_coro(
            run_with_tools(provider, [], "buat file fixb.txt", cwd=self.dir, heuristic_first=False)
        )
        self.assertEqual(provider.calls, 6)
        self.assertEqual(len(out["results"]), 6)
        self.assertTrue(all(not r["result"]["success"] for r in out["results"]))


class FailingThenProvider:
    name = "fake"

    def __init__(self, plans):
        self.plans = plans
        self.calls = 0

    async def complete(self, messages, options=None):
        plan = self.plans[min(self.calls, len(self.plans) - 1)]
        self.calls += 1
        return plan


if __name__ == "__main__":
    unittest.main()