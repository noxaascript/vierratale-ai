import os
import sys
from pathlib import Path


def is_linux() -> bool:
    return sys.platform.startswith("linux")


def is_mac() -> bool:
    return sys.platform == "darwin"


def is_windows() -> bool:
    return sys.platform == "win32"


def is_termux() -> bool:
    return "TERMUX_VERSION" in os.environ or "android" in sys.platform


def get_home_dir() -> Path:
    return Path.home()


def get_config_dir() -> Path:
    if is_termux():
        return Path.home() / ".config" / "vierrataleai"
    xdg = os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))
    return Path(xdg) / "vierrataleai"
