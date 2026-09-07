import asyncio
import os
import re
import shutil
import sys
import tempfile
import time
import unittest

from vierrataleai.utils.logger import logger
import vierrataleai.cli as cli_mod
from vierrataleai.cli import _write_from_response


def _async(coro):
    return asyncio.run(coro)


class IntegrationTest(unittest.TestCase):
    work = None
    config_dir = None
    log_path = None

    @classmethod
    def setUpClass(cls):
        cls.work = tempfile.mkdtemp(prefix="vierra-int-")
        cls.config_dir = tempfile.mkdtemp(prefix="vierra-cfg-")
        cls.orig_cwd = os.getcwd()
        logger.init(base_dir=cls.config_dir)
        cls.log_path = logger.get_path()
        os.chdir(cls.work)

    @classmethod
    def tearDownClass(cls):
        os.chdir(cls.orig_cwd)
        shutil.rmtree(cls.work, ignore_errors=True)
        shutil.rmtree(cls.config_dir, ignore_errors=True)

    def setUp(self):
        for f in os.listdir(self.work):
            p = os.path.join(self.work, f)
            shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else os.remove(p)
        with open(self.log_path, "w", encoding="utf-8"):
            pass

    def tearDown(self):
        time.sleep(0.25)  # let daemon validation threads finish before next test

    async def _run(self, response, request_text, preexisting=()):
        for name in preexisting:
            with open(os.path.join(self.work, name), "w", encoding="utf-8") as f:
                f.write("old")
        notices = []

        async def _decline(_msg):
            return False

        cli_mod._confirm_overwrite = _decline
        await _write_from_response(response, FakeUI(notices), request_text)
        time.sleep(0.25)
        disk = sorted(os.listdir(self.work))
        log_text = self._stable_log()
        events = re.findall(r"^[0-9]{4}.*?\[(\w+)\]", log_text, re.M)
        return {"disk": disk, "notices": notices, "events": events, "log": log_text}

    def _stable_log(self):
        """Wait until the log stops changing so daemon validation threads settle."""
        prev = None
        for _ in range(15):  # up to ~3s
            try:
                cur = open(self.log_path, encoding="utf-8").read()
            except OSError:
                cur = ""
            if prev is not None and cur == prev:
                return cur
            prev = cur
            time.sleep(0.2)
        return prev or ""

    def run_scenario(self, *args, **kw):
        return _async(self._run(*args, **kw))

    def test_clean_python_web_route_writes_app_py_cleanly(self):
        r = self.run_scenario(
            '```python\nfrom flask import Flask\napp = Flask(__name__)\n\n@app.route("/")\n'
            'def home():\n    return "<h1>Hi</h1>"\n```',
            "make a web with html and python route them all",
        )
        self.assertEqual(r["disk"], ["app.py"])
        self.assertTrue(os.path.exists(os.path.join(self.work, "app.py")))
        self.assertFalse(any("Heads up" in m or "couldn't compile" in m for m in r["notices"]), r["notices"])
        self.assertIn("FILE", r["events"])
        self.assertNotIn("WARN", r["events"])
        self.assertNotIn("ERROR", r["events"])

    def test_junk_placeholder_reply_saved_but_warned(self):
        r = self.run_scenario(
            '```python\ndef generate_web_project(file_name="web_project.py"):\n'
            '  f.write("[0] # This is a Python web project file.")\n'
            '  f.write(\'<script src="https://code.google.com/add-on/script/google-chrome-extension.js">\')\n```',
            "make a web with python",
        )
        self.assertIn("app.py", r["disk"])
        self.assertTrue(any("Heads up" in m for m in r["notices"]), r["notices"])
        self.assertIn("WARN", r["events"])
        self.assertIn("[WARN] possible junk content saved to app.py", r["log"])

    def test_truncated_reply_caught_by_compile_check(self):
        r = self.run_scenario(
            '```python\ndef broken():\n  f.write("[0] never closed\n  return 1\n```',
            "write a python script",
        )
        self.assertIn("script.py", r["disk"])
        self.assertTrue(any("couldn't compile" in m for m in r["notices"]), r["notices"])
        self.assertIn("ERROR", r["events"])

    def test_multi_file_project_with_folder(self):
        r = self.run_scenario(
            "FOLDER: site\n"
            "FILE: site/index.html\n```html\n<h1>Hi</h1>\n```\n"
            "FILE: site/style.css\n```css\nbody { color: red; }\n```\n"
            "FILE: site/app.py\n```python\nfrom flask import Flask\napp = Flask(__name__)\n```\n",
            "make a website",
        )
        self.assertEqual(r["disk"], ["site"])
        self.assertTrue(os.path.exists(os.path.join(self.work, "site/index.html")))
        self.assertTrue(os.path.exists(os.path.join(self.work, "site/style.css")))
        self.assertTrue(os.path.exists(os.path.join(self.work, "site/app.py")))
        self.assertGreaterEqual(r["events"].count("FILE"), 4)

    def test_unclosed_fence_extracts_cleanly(self):
        r = self.run_scenario('Here you go:\n```python\nprint("hi")\n', "write a python script")
        self.assertIn("script.py", r["disk"])
        content = open(os.path.join(self.work, "script.py"), encoding="utf-8").read()
        self.assertNotIn("Here you go", content)
        self.assertNotIn("```", content)
        self.assertIn("[FILE] wrote file script.py", r["log"])

    def test_prose_only_reply_saves_nothing(self):
        r = self.run_scenario(
            "Sure! To summarize, python is a great language because...",
            "write me a python script how to sort a list",
        )
        self.assertEqual(r["disk"], [])
        self.assertTrue(any("without any code blocks" in m for m in r["notices"]), r["notices"])
        self.assertEqual(r["events"], [])

    def test_story_request_saves_prose_txt(self):
        r = self.run_scenario(
            "Long ago, in a land far away...",
            "tell me a story about timun mas and save it to a file",
        )
        self.assertIn("timun-mas.txt", r["disk"])
        self.assertIn("[FILE] wrote file timun-mas.txt", r["log"])

    def test_truncated_trailing_file_block_rescued(self):
        r = self.run_scenario(
            "FILE: site/index.html\n```html\n<h1>Hi</h1>\n```\n"
            "FILE: site/app.py\n```python\nfrom flask import Flask\napp = Flask(__name__)\n",
            "make a website",
        )
        self.assertTrue(os.path.exists(os.path.join(self.work, "site/index.html")), r["disk"])
        self.assertTrue(os.path.exists(os.path.join(self.work, "site/app.py")), r["disk"])
        app = open(os.path.join(self.work, "site/app.py"), encoding="utf-8").read()
        self.assertNotIn("```", app)
        self.assertIn("from flask", app)
        self.assertGreaterEqual(r["events"].count("FILE"), 2)

    def test_single_truncated_file_block_rescued(self):
        r = self.run_scenario(
            "FILE: script.py\n```python\nfrom flask import Flask\napp = Flask(__name__)\n",
            "write a python script",
        )
        self.assertIn("script.py", r["disk"], r["disk"])
        content = open(os.path.join(self.work, "script.py"), encoding="utf-8").read()
        self.assertNotIn("```", content)
        self.assertIn("(rescued truncated block)", r["log"])

    def test_multi_block_reply_warns_only_first_saved(self):
        r = self.run_scenario(
            "```html\n<h1>Hi</h1>\n<main>Page</main>\n```\n"
            "```css\nbody { color: red; }\n```\n",
            "make me an html page with css styling",
        )
        self.assertIn("index.html", r["disk"])
        self.assertTrue(any("only index.html was saved" in m for m in r["notices"]), r["notices"])
        self.assertIn("WARN", r["events"])
        self.assertIn("[WARN] multi-block reply: saved only index.html", r["log"])

    def test_existing_file_skipped_with_logged_reason(self):
        r = self.run_scenario('```python\nprint("hi")\n```', "write a python script", ("script.py",))
        self.assertTrue(any("Skipped" in m for m in r["notices"]), r["notices"])
        self.assertIn("[FILE] skipped file script.py", r["log"])

    def test_plain_question_logs_nothing(self):
        r = self.run_scenario(
            "Python is a programming language designed by Guido van Rossum.",
            "what is python",
        )
        self.assertEqual(r["disk"], [])
        self.assertEqual(r["notices"], [])
        self.assertEqual(r["events"], [])

    def test_solo_code_block_saved_with_minimal_prose(self):
        r = self.run_scenario(
            '```python\nfrom flask import Flask\napp = Flask(__name__)\n\n@app.route("/")\n'
            'def h():\n    return "ok"\n```\nHere is your file.',
            "help me build a flask api",
        )
        self.assertIn("app.py", r["disk"])
        self.assertIn("FILE", r["events"])


class FakeUI:
    def __init__(self, notices):
        self.notices = notices

    def notify(self, msg):
        self.notices.append(msg)


if __name__ == "__main__":
    unittest.main()