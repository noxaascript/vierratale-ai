import unittest

from vierrataleai.ui.input import LineEditor

CMDS = [
    {"name": "help", "desc": "Show all commands"},
    {"name": "clear", "desc": "Clear the screen"},
    {"name": "new", "desc": "Start a new empty conversation"},
    {"name": "search", "args": "<query>", "desc": "Search the web"},
    {"name": "fetch", "args": "<url>", "desc": "Open a link"},
    {"name": "quit", "desc": "Exit"},
]


class FakeTTY:
    def isatty(self):
        return True

    def fileno(self):
        return 0


def make_editor():
    writes = []
    editor = LineEditor(
        stream=FakeTTY(),
        commands=CMDS,
        dims=lambda: (100, 24),
        write=lambda s: writes.append(s),
    )
    return editor, writes


def feed(editor, keys):
    for k in keys:
        editor._feed_char(k)


class LineEditorTestCase(unittest.TestCase):
    def test_popup_opens_and_lists_commands(self):
        ed, _ = make_editor()
        feed(ed, ["/"])
        self.assertIsNotNone(ed.popup)
        self.assertEqual([m["name"] for m in ed.popup["matches"]], [c["name"] for c in CMDS])

    def test_popup_filters(self):
        ed, _ = make_editor()
        feed(ed, ["/"])
        feed(ed, ["s", "e"])
        self.assertEqual([m["name"] for m in ed.popup["matches"]], ["search"])

    def test_tab_cycles_and_escape_closes(self):
        ed, _ = make_editor()
        feed(ed, ["/"])
        feed(ed, ["\t"])
        self.assertEqual(ed.popup["selected"], 0)
        feed(ed, ["\t"])
        self.assertEqual(ed.popup["selected"], 1)
        feed(ed, ["\x1b"])
        self.assertIsNone(ed.popup)

    def test_arrows_navigate_popup(self):
        ed, _ = make_editor()
        feed(ed, ["/"])
        self.assertEqual(ed.popup["selected"], -1)
        feed(ed, ["\x1b[B"])
        self.assertEqual(ed.popup["selected"], 0)
        feed(ed, ["\x1b[B"])
        self.assertEqual(ed.popup["selected"], 1)
        feed(ed, ["\x1b[A"])
        self.assertEqual(ed.popup["selected"], 0)

    def test_enter_runs_noarg_command(self):
        ed, _ = make_editor()
        feed(ed, ["/", "c", "l"])
        feed(ed, ["\r"])
        self.assertEqual(ed.pending_lines, ["/clear"])

    def test_enter_on_args_command_completes_and_keeps_editing(self):
        ed, _ = make_editor()
        feed(ed, ["/", "s", "e"])
        feed(ed, ["\r"])
        self.assertEqual("".join(ed.buffer), "/search ")
        self.assertIsNone(ed.popup)
        feed(ed, ["c", "a", "t", "s"])
        feed(ed, ["\r"])
        self.assertEqual(ed.pending_lines, ["/search cats"])

    def test_args_after_command_closes_popup_and_submits(self):
        ed, _ = make_editor()
        feed(ed, ["/", "s", "e", "a", "r", "c", "h", " ", "c", "a", "t", "s"])
        self.assertIsNone(ed.popup)
        feed(ed, ["\r"])
        self.assertEqual(ed.pending_lines, ["/search cats"])

    def test_bare_url_after_command_preserved(self):
        ed, _ = make_editor()
        feed(ed, ["/", "f", "e", "t", "c", "h", " ", "h", "t", "t", "p", "s", ":", "/", "/", "x", "/", "y"])
        feed(ed, ["\r"])
        self.assertEqual(ed.pending_lines, ["/fetch https://x/y"])

    def test_backspace_and_arrows(self):
        ed, _ = make_editor()
        feed(ed, ["h", "e", "l", "l", "o", " ", "w", "o", "r", "l", "d"])
        feed(ed, ["\x7f"])
        feed(ed, ["\x1b[D"])
        feed(ed, ["X"])
        feed(ed, ["\x1b[C"])
        self.assertEqual("".join(ed.buffer), "hello worXl")

    def test_utf8_multibyte(self):
        ed, _ = make_editor()
        feed(ed, ["h", "a", "l", "o", " ", "✓"])
        feed(ed, ["\r"])
        self.assertEqual(ed.pending_lines, ["halo ✓"])

    def test_question_reads_answer(self):
        ed, _ = make_editor()
        ed.question_text = "Overwrite?"
        feed(ed, ["y"])
        feed(ed, ["\r"])
        self.assertEqual(ed.pending_lines, ["y"])
        self.assertIsNone(ed.question_text)

    def test_enter_while_busy_queues(self):
        ed, _ = make_editor()
        ed.busy = True
        feed(ed, ["q", "u", "e", "u", "e", "d", " ", "l", "i", "n", "e"])
        feed(ed, ["\r"])
        ed.busy = False
        self.assertEqual(ed.read_line(), "queued line")

    def test_arrow_up_recalls_history(self):
        ed, _ = make_editor()
        feed(ed, ["f", "i", "r", "s", "t"])
        feed(ed, ["\r"])
        feed(ed, ["s", "e", "c", "o", "n", "d"])
        feed(ed, ["\r"])
        feed(ed, ["\x1b[A"])
        feed(ed, ["\r"])
        self.assertEqual(ed.pending_lines, ["first", "second", "second"])

    def test_ctrl_d_on_empty_triggers_exit(self):
        ed, _ = make_editor()
        exited = {"ok": False}
        ed.on_exit = lambda: exited.update(ok=True)
        feed(ed, ["\x04"])
        self.assertTrue(exited["ok"])

    def test_draw_renders_popup_and_input_bar(self):
        ed, writes = make_editor()
        feed(ed, ["/"])
        writes.clear()
        ed.draw()
        out = "".join(writes)
        import re

        out = re.sub(r"\x1b\[[0-9;]*m", "", out)
        self.assertIn("Commands", out)
        self.assertIn("/help", out)
        self.assertIn("/quit", out)
        self.assertIn("╭", out)
        self.assertIn("╰", out)


if __name__ == "__main__":
    unittest.main()