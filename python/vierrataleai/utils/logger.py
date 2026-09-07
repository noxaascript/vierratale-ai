"""Automatic activity logger for VierrataleAI."""
from datetime import datetime
from pathlib import Path

from .. import config

_MAX_LINE = 2000


def _cap(text) -> str:
    s = str(text or "")
    return s if len(s) <= _MAX_LINE else s[:_MAX_LINE] + "…"


class Logger:
    """Writes one timestamped file per day into the config directory (logs/).

    A no-op until init() is called, so tests and library consumers never
    accidentally write into the real logs folder.
    """

    def __init__(self):
        self.dir = None
        self.file = None
        self._initialized = False

    def init(self, base_dir=None):
        if self._initialized:
            return self
        base = Path(base_dir) if base_dir else config.get_config_dir()
        self.dir = base / "logs"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.file = self.dir / f"vierrataleai-{datetime.now():%Y%m%d}.log"
        self._initialized = True
        return self

    def log(self, event: str, message: str = "") -> str:
        if not self._initialized:
            return ""
        line = f"{datetime.now():%Y-%m-%d %H:%M:%S} [{event}] {_cap(message)}"
        try:
            with open(self.file, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass
        return line

    def get_path(self) -> str:
        return str(self.file) if self.file else ""

    def tail(self, count: int = 30):
        if not self._initialized or not self.file or not self.file.exists():
            return []
        try:
            lines = self.file.read_text(encoding="utf-8").splitlines()
            return lines[-count:]
        except Exception:
            return []


logger = Logger()