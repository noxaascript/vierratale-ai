import unittest
import sys

from vierrataleai.cli import (
    _looks_like_file_request,
    _requested_file_name,
    _extract_fallback_file,
    _story_file_name,
    _response_wants_file,
    _response_is_solo_code,
    _language_file_name,
    _fallback_has_useful_code,
    _looks_like_junk_code,
)


class FileFallbackTest(unittest.TestCase):
    def test_html_css_js_requests_are_file_requests(self):
        self.assertTrue(_looks_like_file_request("create an html page"))
        self.assertTrue(_looks_like_file_request("make me a css file"))
        self.assertTrue(_looks_like_file_request("write a javascript file"))
        self.assertFalse(_looks_like_file_request("tell me a story about the phoenix"))

    def test_natural_paraphrases_recognized(self):
        self.assertTrue(_looks_like_file_request("can you code a website html"))
        self.assertTrue(_looks_like_file_request("build a simple website"))
        self.assertTrue(_looks_like_file_request("do you have any html code for a login page"))
        self.assertTrue(_looks_like_file_request("design a nice webpage with css"))
        self.assertTrue(_looks_like_file_request("write me a python script how to sort a list"))
        self.assertFalse(_looks_like_file_request("can you show me how css works"))
        self.assertFalse(_looks_like_file_request("what is html"))
        self.assertFalse(_looks_like_file_request("explain css to me"))
        self.assertFalse(_looks_like_file_request("what is the weather"))

    def test_requested_file_name_inferred(self):
        self.assertEqual(_requested_file_name("create an html page"), "index.html")
        self.assertEqual(_requested_file_name("make a website"), "index.html")
        self.assertEqual(_requested_file_name("please style with css"), "style.css")
        self.assertEqual(_requested_file_name("write a javascript function"), "script.js")
        self.assertEqual(_requested_file_name("build me a config.json file"), "config.json")
        self.assertEqual(_requested_file_name("make a readme.md"), "readme.md")
        self.assertIsNone(_requested_file_name("hello there"))

    def test_unfenced_file_header_rescued(self):
        resp = "FILE: index.html\n<!doctype html>\n<html>…</html>"
        out = _extract_fallback_file(resp, "create an html page")
        self.assertEqual(out["path"], "index.html")
        self.assertIn("<!doctype html>", out["content"])

    def test_file_header_with_unclosed_fence_rescued(self):
        resp = "FILE: index.html\n```html\n<!doctype html>\n<title>Hi</title>\n"
        out = _extract_fallback_file(resp, "can you code a website")
        self.assertEqual(out["path"], "index.html")
        self.assertEqual(out["content"], "<!doctype html>\n<title>Hi</title>")

    def test_response_wants_file(self):
        self.assertTrue(_response_wants_file("FILE: index.html\n```html\n<p>Hi</p>\n```"))
        self.assertTrue(
            _response_wants_file("Let me save this:\nFILE: app.js\n```\nconsole.log(1)\n```")
        )
        self.assertTrue(_response_wants_file("FOLDER: assets"))
        self.assertFalse(_response_wants_file("Just a normal answer, no header here."))
        self.assertFalse(_response_wants_file(""))

    def test_response_is_solo_code(self):
        self.assertTrue(
            _response_is_solo_code(
                "Here you go:\n```html\n<!doctype html><body><h1>Hello world</h1></body></html>\n```"
            )
        )
        self.assertTrue(
            _response_is_solo_code(
                "```js\nfunction add(a, b) { return a + b; }\nconsole.log(add(1, 2));\n```"
            )
        )
        self.assertFalse(
            _response_is_solo_code("Let me explain the algorithm first. ```python\nx = 1\n``` And that is all.")
        )
        self.assertFalse(_response_is_solo_code("No code here, just text."))

    def test_language_file_name_and_fallback(self):
        self.assertEqual(_language_file_name("html"), "index.html")
        self.assertEqual(_language_file_name("python"), "script.py")
        self.assertEqual(_language_file_name("json"), "output.json")
        self.assertIsNone(_language_file_name("weirdlang"))
        out = _extract_fallback_file('```js\nconsole.log("hi");\n```', "hello there")
        self.assertEqual(out["path"], "script.js")
        self.assertEqual(out["content"], 'console.log("hi");')

    def test_fenced_code_without_header_rescued(self):
        resp = 'Here you go:\n```html\n<!doctype html><title>Hi</title>\n```'
        out = _extract_fallback_file(resp, "create an html page")
        self.assertEqual(out["path"], "index.html")
        self.assertEqual(out["content"], "<!doctype html><title>Hi</title>")

    def test_story_file_name_from_topic(self):
        self.assertEqual(
            _story_file_name("tell me a story about timun mas and save it to a file"),
            "timun-mas.txt",
        )

    def test_python_requests_save_with_py_name_not_js(self):
        self.assertEqual(_requested_file_name("write a python script"), "script.py")
        self.assertEqual(
            _requested_file_name("write me a python script how to sort a list"), "script.py"
        )
        self.assertEqual(_requested_file_name("python flask code"), "script.py")
        out = _extract_fallback_file(
            "Here:\n```python\nprint(\"hi\")\n```", "write a python script"
        )
        self.assertEqual(out["path"], "script.py")
        self.assertIn("print", out["content"])

    def test_prose_only_replies_never_saved_as_code(self):
        self.assertFalse(
            _fallback_has_useful_code(
                "Okay, let me explain how file saving works in detail...", "write a python script"
            )
        )
        self.assertFalse(
            _fallback_has_useful_code(
                "Okay, let’s build a Python file to generate a basic", "make a python file"
            )
        )
        self.assertTrue(
            _fallback_has_useful_code('```python\nprint("hi")\n```', "write a python script")
        )
        self.assertTrue(_fallback_has_useful_code("FILE: x.py\nprint(1)", "hello there"))
        self.assertTrue(
            _fallback_has_useful_code(
                "The legend says a phoenix rose from ashes and lived for a thousand years.",
                "tell me a story about the phoenix",
            )
        )

    def test_python_plus_web_routing_is_app_py(self):
        self.assertEqual(
            _requested_file_name(
                "make me a file about html,css and javascript to make a web, and please route them using python"
            ),
            "app.py",
        )
        self.assertEqual(
            _requested_file_name("make a web with css and html, route it with python flask"),
            "app.py",
        )
        self.assertEqual(_requested_file_name("write a python script to sort a list"), "script.py")
        self.assertEqual(_requested_file_name("code a website in html css js"), "script.js")
        out = _extract_fallback_file(
            "```python\nfrom flask import Flask\napp = Flask(__name__)\n```",
            "make a web with html and python",
        )
        self.assertEqual(out["path"], "app.py")

    def test_app_framework_shell_requests_map_to_names(self):
        self.assertEqual(_requested_file_name("make a flask app"), "app.py")
        self.assertEqual(_requested_file_name("build me a todo app"), "app.py")
        self.assertEqual(_requested_file_name("create a django project"), "app.py")
        self.assertEqual(_requested_file_name("set up a bash script"), "script.sh")
        self.assertEqual(_requested_file_name("create a typescript file"), "script.ts")
        self.assertEqual(_requested_file_name("write yaml config"), "output.yml")
        self.assertEqual(_requested_file_name("make a csv file"), "output.csv")

    def test_bare_unclosed_fence_extracted_to_end(self):
        resp = 'Okay, here is your code:\n```python\nprint("hi")\n'
        out = _extract_fallback_file(resp, "write a python script")
        self.assertEqual(out["path"], "script.py")
        self.assertEqual(out["content"], 'print("hi")')

    def test_app_ish_requests_are_file_requests(self):
        self.assertTrue(_looks_like_file_request("make a flask app"))
        self.assertTrue(_looks_like_file_request("build an api"))
        self.assertTrue(_looks_like_file_request("create a game"))
        self.assertFalse(_looks_like_file_request("what is an api for"))

    def test_bare_ts_in_normal_word_is_not_typescript(self):
        self.assertIsNone(_requested_file_name("please bring the cats"))
        self.assertIsNone(_requested_file_name("what is the best rate"))

    def test_junk_detector_flags_placeholders_but_not_real_code(self):
        junk = (
            'def generate_web_project(file_name="web_project.py"):\n'
            '    f.write("[0] # This is a Python web project file.")\n'
            '    f.write(\'<script src="https://code.google.com/add-on/script/google-chrome-extension.js">\')'
        )
        self.assertTrue(_looks_like_junk_code(junk, "app.py"))
        self.assertTrue(_looks_like_junk_code("Lorem ipsum dolor sit amet, building a website.", "index.html"))
        self.assertTrue(_looks_like_junk_code("some placeholder text here", "readme.md"))

        self.assertFalse(
            _looks_like_junk_code(
                "from flask import Flask\napp = Flask(__name__)\n\ndef index():\n    return '<h1>Hi</h1>'\n",
                "app.py",
            )
        )
        self.assertFalse(_looks_like_junk_code("print([0, 1, 2])\n", "script.py"))
        self.assertFalse(_looks_like_junk_code("a = value[0]  # index\n", "script.py"))


if __name__ == "__main__":
    unittest.main()