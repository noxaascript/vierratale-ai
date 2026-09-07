import re

from .branding import Branding

C = Branding.COLORS
_BOLD = "\033[1m"
_RESET = "\033[0m"
_DIM = "\033[2m"
_CYAN = "\033[38;2;6;182;212m"
_GREEN = "\033[38;2;16;185;129m"
_PURPLE = "\033[38;2;124;58;237m"
_CLEAR = "\x1b[2J\x1b[H"


def _visible(s: str) -> int:
    return len(re.sub(r"\x1b\[[0-9;]*m", "", s))


def _pad_right(text: str, width: int) -> str:
    t = str(text or "")
    return t + " " * max(0, width - _visible(t))


def _wrap_lines(text: str, width: int) -> list:
    out = []
    src = str(text or "")
    for raw in src.split("\n"):
        if not raw.strip():
            out.append("")
            continue
        words = [w for w in raw.split() if w]
        cur = ""
        for word in words:
            if len(word) >= width:
                if cur:
                    out.append(cur)
                    cur = ""
                for i in range(0, len(word), width):
                    out.append(word[i : i + width])
                continue
            nxt = f"{cur} {word}" if cur else word
            if _visible(nxt) > width:
                if cur:
                    out.append(cur)
                cur = word
            else:
                cur = nxt
        if cur:
            out.append(cur)
    return out


def _hard_wrap(text: str, width: int) -> list:
    out = []
    src = str(text or "").replace("\t", "  ")
    for raw in src.split("\n"):
        if _visible(raw) <= width:
            out.append(raw)
        else:
            for i in range(0, len(raw), width):
                out.append(raw[i : i + width])
    return out


def _column_width(term_width: int) -> int:
    w = term_width if term_width and term_width > 44 else 96
    return max(40, min(100, w - 8))


def _center_pad(col: int, term_width: int) -> str:
    w = term_width if term_width and term_width > 44 else 96
    pad = max(0, (w - col) // 2)
    return " " * pad


def _highlight(text: str) -> str:
    def bold(m):
        return f"{_BOLD}{m.group(1)}{_RESET}"

    def code(m):
        return f"{_CYAN}{m.group(1)}{_RESET}"

    text = re.sub(r"\*\*([^*]+)\*\*", bold, str(text))
    return re.sub(r"`([^`]+)`", code, text)


def _split_blocks(text: str) -> list:
    blocks = []
    pattern = re.compile(r"```([\w./+-]*)[^\n]*\n?([\s\S]*?)(?:```|$)")
    last = 0
    for m in pattern.finditer(str(text)):
        if m.start() > last:
            blocks.append({"code": False, "text": text[last : m.start()]})
        blocks.append(
            {"code": True, "lang": m.group(1) or "code", "content": m.group(2)}
        )
        last = m.end()
    if last < len(text):
        blocks.append({"code": False, "text": text[last:]})
    return blocks


def _code_box(lang: str, content: str, w: int) -> list:
    """Render a code box at width *w* (already inside the centered column)."""
    out = []
    # The box carries its own 4-space indent, so shrink the horizontal
    # dimensions so the whole box fits inside the column.
    box = max(8, w - 4)
    inner = max(1, box - 8)
    head = f"    {_GREEN}╭─{_RESET} {_BOLD}{_GREEN}{lang or 'code'}{_RESET}{_GREEN} "
    fill = max(0, box - _visible(head) - 1)
    out.append(f"{head}{'─' * fill}╮{_RESET}")
    lines = _hard_wrap(content, inner)
    while lines and lines[-1].strip() == "":
        lines.pop()
    if not lines:
        lines.append("")
    for line in lines:
        out.append(f"    {_GREEN}│{_RESET} {_pad_right(line, inner)} {_GREEN}│{_RESET}")
    out.append(f"    {_GREEN}╰{'─' * max(0, box - 6)}╯{_RESET}")
    return out


def _content_rows(content: str, w: int) -> list:
    rows = []
    width = max(20, w - 4)
    for b in _split_blocks(content):
        if b["code"]:
            rows.extend(_code_box(b["lang"], b["content"], w))
        else:
            lines = _wrap_lines(b["text"], width)
            if not lines:
                lines = [""]
            for line in lines:
                rows.append("" if line.strip() == "" else f"    {_highlight(line)}")
    return rows


class FrameThrottle:
    def __init__(self, render):
        self._render = render
        self._last = 0.0

    def schedule(self):
        import time

        now = time.monotonic()
        if now - self._last >= 0.04:
            self._last = now
            self._render()

    def flush(self):
        self._render()


def _centered(row: str, pad: str) -> str:
    return f"{pad}{row}"


class ChatUI:
    def __init__(self, model: str = "", engine: str = ""):
        self.model = model
        self.engine = engine
        self.status = ""
        self.notices = []
        self.streaming = None
        self.thinking = False
        self.compositor = None

    def set_compositor(self, compositor) -> None:
        self.compositor = compositor

    def width(self):
        import shutil

        try:
            return shutil.get_terminal_size().columns
        except Exception:
            return 96

    def set_model(self, model: str, engine: str) -> None:
        self.model = model
        self.engine = engine

    def set_status(self, text: str) -> None:
        self.status = str(text or "")
        self.thinking = False
        self.streaming = None

    def set_thinking(self, flag: bool) -> None:
        self.thinking = bool(flag)
        self.streaming = None

    def set_streaming(self, text: str) -> None:
        self.streaming = str(text or "")
        self.thinking = False

    def notify(self, text: str) -> None:
        if text:
            self.notices.append(str(text))

    def clear_notices(self) -> None:
        self.notices = []

    def _banner_rows(self, col):
        """Banner drawn as part of the full clear+draw cycle so the old
        show_banner() (erased by the first render) can't flash/garbled."""
        out = []

        # Center the art as a BLOCK: pad every line to the widest one, then use
        # a single shared left indent so the llama's rows stay glued together.
        art = [line.rstrip() for line in Branding.BANNER.split("\n")]
        art_w = max(_visible(line) for line in art) if art else 0
        pad_l = max(0, (col - art_w) // 2)
        for line in art:
            out.append(f"{' ' * pad_l}{_PURPLE}{line}{_RESET}")

        def center(s):
            return " " * max(0, (col - _visible(s)) // 2) + s
        out.append(
            center(
                f"{_BOLD}{_CYAN}▸ {Branding.APP_NAME} · {self.model} · {self.engine}{_RESET}"
            )
        )
        out.append("")
        box = max(24, col - 6)

        def pad_r(s):
            return s + " " * max(1, box - _visible(s))

        row = lambda content: center(f"  {_PURPLE}│{_RESET} {content} {_PURPLE}│{_RESET}")
        out.append(center(f"  {_PURPLE}┌{'─' * (box + 2)}┐{_RESET}"))
        out.append(row(pad_r(f"  {_BOLD}{_PURPLE}Model{_RESET}")))
        out.append(row(pad_r(f"   {_CYAN}{self.model}{_RESET}")))
        out.append(row(pad_r(f"  {_BOLD}{_PURPLE}Engine{_RESET}")))
        out.append(row(pad_r(f"   {_CYAN}{self.engine}{_RESET}")))
        out.append(center(f"  {_PURPLE}└{'─' * (box + 2)}┘{_RESET}"))
        out.append("")
        out.append(center(f"{_DIM}Type /help for commands · /quit to exit{_RESET}"))
        out.append("")
        return out

    def render(self, messages) -> None:
        import shutil
        import sys

        w = self.width()
        col = _column_width(w)
        pad = _center_pad(col, w)
        out = [_CLEAR]
        # Banner (opencode style header) at the top of the centered column.
        for row in self._banner_rows(col):
            out.append(f"{pad}{row}")
        if self.status:
            out.append(f"{pad}  {_DIM}{self.status}{_RESET}")
        out.append("")

        for m in messages or []:
            if not m or m.get("hidden") or not m.get("content"):
                continue
            title = "You" if m.get("role") == "user" else Branding.AI_PROMPT
            color = _CYAN if m.get("role") == "user" else _PURPLE
            out.append(_centered(f"  {_BOLD}{color}{title}{_RESET}", pad))
            for row in _content_rows(m.get("content"), col):
                out.append(_centered(row, pad))
            out.append("")

        if self.thinking:
            out.append(_centered(f"  {_BOLD}{_PURPLE}{Branding.AI_PROMPT}{_RESET}", pad))
            out.append(_centered(f"    {_DIM}···{_RESET}", pad))
            out.append("")
        elif self.streaming is not None:
            out.append(_centered(f"  {_BOLD}{_PURPLE}{Branding.AI_PROMPT}{_RESET}", pad))
            rows = _content_rows(self.streaming, col)
            for r in rows or ["    "]:
                out.append(_centered(r, pad))
            out.append("")

        for n in self.notices:
            for line in _wrap_lines(n, col - 4):
                out.append(_centered(f"  {_DIM}{line}{_RESET}", pad))
        if self.notices:
            out.append("")

        # Pin the latest content to the bottom so streaming never re-scrolls
        # through older messages (which caused a flash).
        rows = 999
        try:
            if sys.stdout.isatty():
                size = shutil.get_terminal_size().lines
                if size and size > 8:
                    rows = size
        except Exception:
            pass
        content = out[1:]
        reserved = 0
        if self.compositor is not None:
            reserved = max(0, self.compositor.reserved_rows())
        available = max(3, rows - reserved)
        body = content[-available:] if len(content) > available else content
        print(_CLEAR + "\n".join(body), flush=True)
        if self.compositor is not None:
            self.compositor.draw()