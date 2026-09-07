import json
from pathlib import Path
from rich.console import Console
from rich.text import Text
from rich.panel import Panel
from .branding import Branding
from .. import config

PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


def load_system_prompt() -> str:
    custom = config.get("system_prompt")
    if custom:
        return custom
    try:
        json_path = PROMPTS_DIR / "system.json"
        data = json.loads(json_path.read_text())
        return data["system"]
    except Exception:
        return f"You are {Branding.APP_NAME}, an intelligent AI assistant. Be helpful, concise, and accurate."


def engine_display_name(provider: str) -> str:
    return Branding.ENGINE_NAMES.get(provider, "Cortex")


def show_banner(provider: str, model: str) -> None:
    from rich.text import Text as RichText

    console = Console()
    engine = engine_display_name(provider)
    width = 44
    pad = lambda s, extra=0: s + " " * max(1, width - len(RichText.from_markup(s).plain) - extra)

    banner_text = Text(Branding.BANNER, style="bold #7c3aed")
    console.print(banner_text)
    console.print(f"  [bold #06b6d4]▸ Vierratale AI ▸ {engine} Engine[/bold #06b6d4]")
    console.print()
    console.print(f"  ╔{'═' * width}╗")
    console.print(f"  ║{pad('  [bold #7c3aed]Model[/bold #7c3aed]')}║")
    console.print(f"  ║{pad('   [#06b6d4]' + model + '[/#06b6d4]')}║")
    console.print(f"  ║{pad('  [bold #7c3aed]Engine[/bold #7c3aed]')}║")
    console.print(f"  ║{pad('   [#06b6d4]' + engine + '[/#06b6d4]')}║")
    console.print(f"  ╚{'═' * width}╝")
    console.print()
    console.print("  [dim]Type /help for commands · /quit to exit[/dim]")
    console.print()
