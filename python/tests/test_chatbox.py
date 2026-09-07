import unittest
from contextlib import redirect_stdout
from io import StringIO
import re

from vierrataleai.ui.chatbox import ChatUI, FrameThrottle


def strip_ansi(s: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", s)


class ChatUITest(unittest.TestCase):
    def test_render_header_role_labels_code_box_status(self):
        ui = ChatUI(model="lite", engine="Cortex")
        ui.set_status("Searching...")
        buf = StringIO()
        with redirect_stdout(buf):
            ui.render(
                [
                    {"role": "user", "content": "make an html page"},
                    {"role": "assistant", "content": 'Here:\n```html\n<p>Hi</p>\n```'},
                ]
            )
        out = strip_ansi(buf.getvalue())
        self.assertIn("VierrataleAI", out)
        self.assertIn("Searching", out)
        self.assertRegex(out, r"(?m)^ *You$")
        self.assertIn("make an html page", out)
        self.assertRegex(out, r"(?m)^ *AI$")
        self.assertIn("╭─ html", out)
        self.assertIn("│ <p>Hi</p>", out)
        self.assertRegex(out, r"(?m)^ *│ .+│$")
        self.assertIn("╰───", out)
        self.assertIn("╯", out)

    def test_hidden_messages_skipped(self):
        ui = ChatUI(model="lite")
        buf = StringIO()
        with redirect_stdout(buf):
            ui.render(
                [
                    {"role": "user", "content": "secret internal context", "hidden": True},
                    {"role": "user", "content": "visible query"},
                ]
            )
        out = strip_ansi(buf.getvalue())
        self.assertIn("visible query", out)
        self.assertNotIn("secret internal context", out)

    def test_plain_streaming_not_boxed(self):
        ui = ChatUI(model="lite")
        ui.set_streaming("Once upon a time...")
        buf = StringIO()
        with redirect_stdout(buf):
            ui.render([])
        out = strip_ansi(buf.getvalue())
        self.assertIn("Once upon a time", out)
        self.assertRegex(out, r"(?m)^ *AI$")
        # The streaming text line itself must be plain (not inside a code box).
        self.assertNotRegex(out, r"[│┃│].*Once upon a time")
        self.assertNotRegex(out, r"Once upon a time.*[│┃│]")
        self.assertNotRegex(out, r"(?:┌|╭)[^\n]*Once upon a time")

    def test_frame_throttle_coalesces(self):
        calls = []
        ft = FrameThrottle(lambda: calls.append(1))
        for _ in range(200):
            ft.schedule()
        before = len(calls)
        self.assertLess(before, 200)
        ft.flush()
        self.assertEqual(len(calls), before + 1)


if __name__ == "__main__":
    unittest.main()