import os
import signal
import sys
import threading
import termios
import tty

from .branding import Branding
from .chatbox import C, _visible, _pad_right

MAX_POPUP = 9


def _column_width(term_width):
    w = term_width if term_width and term_width > 44 else 96
    return max(40, min(100, w - 8))


def _center_pad(col, term_width):
    w = term_width if term_width and term_width > 44 else 96
    return " " * max(0, (w - col) // 2)


class LineEditor:
    """Raw-mode bottom-anchored line editor.

    Draws a fixed input bar on the last terminal row and, when the draft starts
    with "/", a popup box listing matching slash commands above it. Falls back
    to plain line reading when stdin is not a TTY (piped input, tests).
    """

    def __init__(self, prompt="", commands=None, on_exit=None, stream=None, write=None, dims=None):
        self.prompt = prompt
        self.commands = commands or []
        self.on_exit = on_exit
        self.stream = stream if stream is not None else sys.stdin
        self.write = write if write is not None else (lambda s: (sys.stdout.write(s), sys.stdout.flush()))
        self.dims = dims

        self.buffer = []
        self.cursor = 0
        self.view_offset = 0
        self.history = []
        self.hist_index = -1
        self.last_line = ""
        self.popup = None
        self.question_text = None
        self.busy = False
        self.pending_lines = []
        self.started = False
        self._exit_requested = False
        self._lock = threading.Lock()
        self._saved_flags = None
        self._old_winch = None

    # ----- geometry -----

    def _cols(self):
        if self.dims:
            return max(20, self.dims()[0] or 96)
        try:
            import shutil
            return max(20, shutil.get_terminal_size().columns)
        except Exception:
            return 96

    def _rows(self):
        if self.dims:
            return max(8, self.dims()[1] or 24)
        try:
            import shutil
            return max(8, shutil.get_terminal_size().lines)
        except Exception:
            return 24

    @property
    def is_tty(self):
        try:
            return bool(self.stream.isatty())
        except Exception:
            return False

    def reserved_rows(self):
        if not self.is_tty:
            return 0
        return self._popup_h() if self.popup else 1

    def _popup_h(self):
        n = min(len(self.popup["matches"]), MAX_POPUP) if self.popup else 0
        return min(max(1, n) + 2, max(2, self._rows() - 1))

    def _text(self):
        return "".join(self.buffer)

    # ----- lifecycle -----

    def start(self):
        if self.started:
            return self
        self.started = True
        if self.is_tty:
            fd = self.stream.fileno()
            self._saved_flags = termios.tcgetattr(fd)
            tty.setraw(fd)
            self._old_winch = signal.signal(signal.SIGWINCH, lambda *_: self.draw())
        else:
            try:
                self.write(self.prompt)
            except Exception:
                pass
        self.draw()
        return self

    def stop(self):
        if self._saved_flags is not None:
            try:
                termios.tcsetattr(self.stream.fileno(), termios.TCSADRAIN, self._saved_flags)
            except Exception:
                pass
            self._saved_flags = None
        if self._old_winch is not None:
            try:
                signal.signal(signal.SIGWINCH, self._old_winch)
            except Exception:
                pass
            self._old_winch = None

    def exit(self):
        self._exit_requested = True
        self._submit_if_pending()
        self.stop()

    def _submit_if_pending(self):
        if self._text():
            self.buffer = []
            self.cursor = 0

    # ----- public reading API (blocking; run from an executor thread) -----

    def read_line(self):
        if self._exit_requested:
            return None
        if self.pending_lines:
            line = self.pending_lines.pop(0)
            self._record_history(line)
            return line
        if self.is_tty:
            while not self._exit_requested:
                key = self._read_key()
                if key is None:
                    self._feed_key("ctrl-d")
                else:
                    self._feed_char(key)
                if self.pending_lines:
                    line = self.pending_lines.pop(0)
                    self._record_history(line)
                    return line
            return None
        try:
            raw = self.stream.readline()
        except (KeyboardInterrupt, EOFError):
            return None
        line = raw.rstrip("\r\n")
        self._record_history(line)
        return line

    def question(self, text):
        self.question_text = str(text or "")
        self.buffer = []
        self.cursor = 0
        self.popup = None
        self.draw()
        return self.read_line()

    def set_busy(self, flag):
        self.busy = bool(flag)

    def _feed_key(self, key):
        if key == "ctrl-d":
            self._ctrl_d()

    # ----- internal state -----

    def _record_history(self, line):
        if line and (not self.history or line != self.history[-1]):
            self.history.append(line)
            if len(self.history) > 200:
                self.history.pop(0)
        self.hist_index = -1

    def _push(self, line):
        self._record_history(line)
        self.pending_lines.append(line)

    def _submit(self):
        line = self._text()
        self.question_text = None
        if self.busy:
            self._push(line)
            self.buffer = []
            self.cursor = 0
            self.popup = None
            self.draw()
            return
        if self.popup:
            self._accept_popup()
            self.draw()
            return
        self._push(line)
        self.buffer = []
        self.cursor = 0
        self.popup = None
        self.draw()

    def _matches(self, text):
        if not text.startswith("/"):
            return []
        base = text[1:].strip().split()[0] if len(text) > 1 else ""
        return [c for c in self.commands if c["name"].startswith(base)]

    def _sync_popup(self):
        s = self._text()
        if not s.startswith("/"):
            self.popup = None
            return
        words = s[1:].split(" ")
        base = words[0] or ""
        if len(words) >= 2 and any(c["name"] == base for c in self.commands):
            self.popup = None
            return
        matches = self._matches(s)
        if not matches:
            self.popup = None
            return
        sel = min(self.popup["selected"], len(matches) - 1) if self.popup and self.popup["selected"] >= 0 else -1
        self.popup = {"matches": matches, "selected": sel}

    def _accept_popup(self):
        m = self.popup["matches"][self.popup["selected"] if self.popup["selected"] >= 0 else 0] if self.popup and self.popup["matches"] else None
        if not m:
            self.popup = None
            self._push(self._text())
            self.buffer = []
            self.cursor = 0
            self.draw()
            return
        if m.get("args"):
            self.buffer = list("/%s " % m["name"])
            self.cursor = len(self.buffer)
            self.view_offset = 0
            self.popup = None
            self.draw()
        else:
            self.popup = None
            self._push("/%s" % m["name"])
            self.buffer = []
            self.cursor = 0
            self.draw()

    def _tab(self):
        if self.popup:
            matches = self.popup["matches"]
            if matches:
                self.popup["selected"] = min(len(matches) - 1, self.popup["selected"] + 1)
            return
        if self._text().startswith("/"):
            self._sync_popup()
            return
        self.buffer[self.cursor:self.cursor] = [" ", " "]
        self.cursor += 2

    def _ctrl_c(self):
        if self.popup:
            self.popup = None
        elif self.on_exit:
            self._exit_requested = True
            self.on_exit()
            self.stop()
        else:
            self._exit_requested = True
            self.stop()

    def _ctrl_d(self):
        if not self._text():
            self._exit_requested = True
            if self.on_exit:
                self.on_exit()
                self.stop()

    def _backspace(self):
        if self.cursor > 0:
            del self.buffer[self.cursor - 1]
            self.cursor -= 1
            self._sync_popup()

    def _insert(self, ch):
        self.buffer.insert(self.cursor, ch)
        self.cursor += 1
        self._sync_popup()

    def _key(self, key):
        if key == "up":
            if self.popup and self.popup["matches"]:
                self.popup["selected"] = max(0, self.popup["selected"] - 1)
            else:
                self._hist(-1)
        elif key == "down":
            if self.popup and self.popup["matches"]:
                self.popup["selected"] = min(len(self.popup["matches"]) - 1, self.popup["selected"] + 1)
            else:
                self._hist(1)
        elif key == "shift-tab":
            if self.popup and self.popup["matches"]:
                self.popup["selected"] = max(0, self.popup["selected"] - 1)
        elif key == "left":
            self.cursor = max(0, self.cursor - 1)
        elif key == "right":
            self.cursor = min(len(self.buffer), self.cursor + 1)
        elif key == "ctrl-left":
            self._word_jump(-1)
        elif key == "ctrl-right":
            self._word_jump(1)
        elif key == "home":
            self.cursor = 0
        elif key == "end":
            self.cursor = len(self.buffer)
        elif key == "delete":
            if self.cursor < len(self.buffer):
                del self.buffer[self.cursor]
            self._sync_popup()
        elif key == "esc":
            self.popup = None

    def _word_jump(self, direction):
        if direction < 0:
            while self.cursor > 0 and self.buffer[self.cursor - 1] == " ":
                self.cursor -= 1
            while self.cursor > 0 and self.buffer[self.cursor - 1] != " ":
                self.cursor -= 1
        else:
            while self.cursor < len(self.buffer) and self.buffer[self.cursor] == " ":
                self.cursor += 1
            while self.cursor < len(self.buffer) and self.buffer[self.cursor] != " ":
                self.cursor += 1

    def _hist(self, direction):
        if not self.history:
            return
        if self.hist_index == -1:
            self.last_line = self._text()
            self.hist_index = len(self.history)
        self.hist_index = min(len(self.history), max(0, self.hist_index + direction))
        if self.hist_index == len(self.history):
            self.buffer = list(self.last_line)
        else:
            self.buffer = list(self.history[self.hist_index])
        self.cursor = len(self.buffer)

    # ----- input consumption -----

    def _feed(self, raw):
        for ch in raw:
            self._feed_char(ch)

    def _feed_char(self, ch):
        if not ch:
            return
        if ch == "\r" or ch == "\n":
            self._submit()
        elif ch == "\t":
            self._tab()
        elif ch == "\x03":
            self._ctrl_c()
        elif ch == "\x04":
            self._ctrl_d()
        elif ch == "\x7f":
            self._backspace()
        elif ch == "\x1b[A":
            self._key("up")
        elif ch == "\x1b[B":
            self._key("down")
        elif ch == "\x1b[C":
            self._key("right")
        elif ch == "\x1b[D":
            self._key("left")
        elif ch == "\x1b[H":
            self._key("home")
        elif ch == "\x1b[F":
            self._key("end")
        elif ch == "\x1b[3~":
            self._key("delete")
        elif ch == "\x1b[Z":
            self._key("shift-tab")
        elif ch == "\x1b[1;5C":
            self._key("ctrl-right")
        elif ch == "\x1b[1;5D":
            self._key("ctrl-left")
        elif ch == "\x1b":
            self._key("esc")
        else:
            self._insert(ch)
        self.draw()

    # ----- key parsing (raw terminal) -----

    def _read_key(self):
        """Reads one decoded key/character from the raw terminal (blocking)."""
        fd = self.stream.fileno()
        b = os.read(fd, 1)
        if not b:
            return None
        byte = b[0]
        if byte == 0x1B:
            return self._read_escape(fd)
        if byte < 0x20 or byte == 0x7F:
            return chr(byte)
        if byte < 0x80:
            return chr(byte)
        if byte < 0xC0:
            return chr(byte)
        if byte < 0xE0:
            n = 2
        elif byte < 0xF0:
            n = 3
        else:
            n = 4
        data = b
        for _ in range(n - 1):
            extra = os.read(fd, 1)
            if not extra:
                break
            data += extra
        try:
            return data.decode("utf-8")
        except Exception:
            return None

    def _read_escape(self, fd):
        b2 = os.read(fd, 1)
        if not b2:
            return "\x1b"
        if b2 != b"[":
            return "\x1b"
        param = b""
        while True:
            c = os.read(fd, 1)
            if not c:
                break
            if c in b"0123456789;":
                param += c
            else:
                fin = c
                break
        try:
            fin = fin.decode("ascii")
        except Exception:
            fin = ""
        if fin == "A":
            return "\x1b[A"
        if fin == "B":
            return "\x1b[B"
        if fin == "C":
            return "\x1b[C"
        if fin == "D":
            return "\x1b[D"
        if fin == "H" or param in (b"1", b"7"):
            return "\x1b[H"
        if fin == "F" or param in (b"4", b"8"):
            return "\x1b[F"
        if param == b"3":
            return "\x1b[3~"
        if param == b"Z":
            return "\x1b[Z"
        if param == b"1;5" and fin == "C":
            return "\x1b[1;5C"
        if param == b"1;5" and fin == "D":
            return "\x1b[1;5D"
        return "\x1b"

    # ----- drawing -----

    def _input_prefix(self):
        if self.question_text is not None:
            return (
                "  \033[33m%s (y/N)\033[0m \033[1m\033[38;2;124;58;237m%s\033[0m \033[2m›\033[0m "
                % (self.question_text, Branding.USER_PROMPT)
            )
        return "%s " % self.prompt

    def draw(self):
        if not self.is_tty:
            return
        with self._lock:
            R = self._rows()
            cols = self._cols()
            col = _column_width(cols)
            pad = _center_pad(col, cols)

            prev_h = getattr(self, "_last_popup_h", 1)
            cur_h = self._popup_h() if self.popup else 1
            clear_top = max(1, R - max(prev_h, cur_h) + 1)
            out = []
            for r in range(clear_top, R + 1):
                out.append("\x1b[%d;1H\x1b[2K" % r)
            self._last_popup_h = cur_h

            if self.popup:
                box_h = self._popup_h()
                list_rows = min(len(self.popup["matches"]), MAX_POPUP)
                box = max(8, col)
                inner = max(1, box - 8)
                top = R - box_h + 1
                head = "  \033[38;2;124;58;237m╭─\033[0m \033[1m\033[38;2;6;182;212mCommands\033[0m\033[38;2;124;58;237m "
                fill = max(0, box - _visible(head) - 1)
                out.append("\x1b[%d;1H%s%s%s%s╮\033[0m" % (top, pad, head, "─" * fill, (" " * 0)))
                li = top + 1
                for i in range(list_rows):
                    m = self.popup["matches"][i]
                    selected = i == self.popup["selected"]
                    name = "\033[1m\033[38;2;6;182;212m/%s\033[0m" % m["name"] if selected else "\033[1m\033[38;2;124;58;237m/%s\033[0m" % m["name"]
                    args = " \033[2m%s\033[0m" % m.get("args", "") if m.get("args") else ""
                    desc = "  \033[2m%s\033[0m" % m.get("desc", "") if m.get("desc") else ""
                    body = " %s %s%s%s" % ("›" if selected else "·", name, args, desc)
                    style = "\033[38;2;6;182;212m\033[1m" if selected else ""
                    out.append("\x1b[%d;1H\x1b[2K%s  \033[38;2;124;58;237m│\033[0m %s%s%s \033[38;2;124;58;237m│\033[0m" % (li, pad, style, _pad_right(body, inner), "\033[0m" if selected else ""))
                    li += 1
                hint = "\033[2m ↑↓  Tab pick   Enter run   Esc close\033[0m" if list_rows else "\033[2m Esc close\033[0m"
                foot = "  \033[38;2;124;58;237m╰%s╯\033[0m" % ("─" * max(0, box - 6))
                out.append("\x1b[%d;1H\x1b[2K%s%s%s" % (li, pad, foot, hint))
                o = self._text()
                prefix_len = _visible(pad + self._input_prefix())
                max_vis = max(1, cols - prefix_len - 1)
                off = self.view_offset
                if self.cursor < off:
                    off = self.cursor
                if self.cursor > off + max_vis - 1:
                    off = self.cursor - max_vis + 1
                self.view_offset = off
                shown = o[off:off + max_vis]
                out.append("\x1b[%d;1H\x1b[2K%s%s%s" % (R, pad, self._input_prefix(), shown))
                cursor_col = min(prefix_len + (self.cursor - off) + 1, cols)
                out.append("\x1b[%d;%dH" % (R, cursor_col))
                self.write("".join(out))
            else:
                o = self._text()
                prefix_len = _visible(pad + self._input_prefix())
                max_vis = max(1, cols - prefix_len - 1)
                off = self.view_offset
                if self.cursor < off:
                    off = self.cursor
                if self.cursor > off + max_vis - 1:
                    off = self.cursor - max_vis + 1
                self.view_offset = off
                shown = o[off:off + max_vis]
                out.append("\x1b[%d;1H\x1b[2K%s%s%s" % (R, pad, self._input_prefix(), shown))
                cursor_col = min(prefix_len + (self.cursor - off) + 1, cols)
                out.append("\x1b[%d;%dH" % (R, cursor_col))
                self.write("".join(out))
