import asyncio
from datetime import datetime
from rich.console import Console
from rich.markdown import Markdown
from .branding import Branding


class Terminal:
    def __init__(self):
        self.console = Console()

    @staticmethod
    def _time():
        return datetime.now().strftime("%H:%M")

    def print_user(self, text: str) -> None:
        self.console.file.write("\r\x1b[K")
        self.console.print()
        self.console.print(f"  [bold #7c3aed]You[/bold #7c3aed]  [dim]{self._time()}[/dim]")
        self.console.print(f"  {text}")
        self.console.print()

    def print_ai_start(self) -> None:
        self.console.print()
        self.console.print(f"  [bold #7c3aed]{Branding.AI_PROMPT}[/bold #7c3aed]  [dim]{self._time()}[/dim]")
        self._prefix = True
        self._line = ""

    def begin_thinking(self) -> None:
        self._thinking = True
        self.console.print(
            "  [#06b6d4]│[/#06b6d4] [dim]· · ·[/dim]", end="", highlight=False
        )

    def end_thinking(self) -> None:
        self.console.file.write("\r\x1b[2K")
        self._prefix = True
        self.console.print("  [#06b6d4]│[/#06b6d4] ", end="", highlight=False)
        self._prefix = False

    def print_ai_chunk(self, text: str) -> None:
        if getattr(self, "_thinking", False):
            self.end_thinking()
            self._thinking = False
        if getattr(self, "_prefix", False):
            self.console.print("  [#06b6d4]│[/#06b6d4] ", end="", highlight=False)
            self._prefix = False
        self.console.print(text, end="", highlight=False)
        self._line += text
        if len(self._line) > 100:
            self._prefix = True
            self._line = ""

    def print_ai_end(self) -> None:
        self.console.print()
        self.console.print()

    def print_error(self, msg: str) -> None:
        self.console.print(f"  [bold red]✖[/bold red] {msg}")

    def print_info(self, msg: str) -> None:
        self.console.print(f"  [dim]{msg}[/dim]")

    def print_success(self, msg: str) -> None:
        self.console.print(f"  [bold green]✔[/bold green] {msg}")

    def print_warning(self, msg: str) -> None:
        self.console.print(f"  [bold yellow]⚠[/bold yellow] {msg}")

    def print_search_results(self, results) -> None:
        self.console.print("  [bold yellow]Web Search Results[/bold yellow]")
        for i, r in enumerate(results, 1):
            self.console.print(
                f"  [bold yellow]{i}.[/bold yellow] [bold]{r['title']}[/bold]"
            )
            self.console.print(f"     [dim]{r['url']}[/dim]")
            if r.get("snippet"):
                self.console.print(f"     {r['snippet'][:120]}")

    async def show_progress(self, steps, work) -> None:
        frames = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
        i = 0

        def render():
            nonlocal i
            i += 1
            stage = steps[(i // 8) % len(steps)]
            bar = frames[i % len(frames)]
            fill = "=" * (1 + (i % 18)) + ">" + " " * (18 - (i % 18))
            self.console.file.write(
                f"\r  [{bar}] [dim]{stage}[/dim] [[#06b6d4]{fill}[/#06b6d4]]"
            )
            self.console.file.flush()

        timer = asyncio.get_event_loop().call_later(0, lambda: _tick())

        def _tick():
            render()
            timer = asyncio.get_event_loop().call_later(0.1, _tick)

        try:
            await work()
        finally:
            timer.cancel()
            self.console.file.write("\r\x1b[2K")
            self.console.print(f"  [bold green]✔[/bold green] [dim]Ready[/dim]")
            self.console.print()

    def print_markdown(self, text: str) -> None:
        self.console.print(Markdown(text))

    def clear(self) -> None:
        self.console.clear()
