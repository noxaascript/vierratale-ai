import os
import re
import shutil
import stat
import subprocess
import sys
import urllib.request
import urllib.error
import json
import time
from pathlib import Path
from typing import Optional

from . import config
from . import catalog


def _is_engine_installed() -> bool:
    try:
        result = subprocess.run(
            ["which", "ollama"],
            capture_output=True,
            timeout=5,
        )
        if result.returncode == 0:
            return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    for p in ["/usr/local/bin/ollama", "/usr/bin/ollama"]:
        if Path(p).exists():
            return True
    return False


def _is_engine_running(host: str) -> bool:
    try:
        req = urllib.request.Request(f"{host}/api/tags")
        resp = urllib.request.urlopen(req, timeout=3)
        return resp.status == 200
    except Exception:
        return False


def _install_engine() -> bool:
    try:
        subprocess.run(
            "curl -fsSL https://ollama.com/install.sh | sh",
            shell=True,
            capture_output=True,
            timeout=300,
        )
    except Exception:
        return False
    return _is_engine_installed()


def _start_engine() -> None:
    host = config.get("engine_host")
    try:
        # No systemd available here, so launch the daemon directly, detached,
        # and poll until it responds instead of relying on a service manager.
        subprocess.Popen(
            ["ollama", "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        for _ in range(30):
            time.sleep(1)
            if _is_engine_running(host):
                break
    except Exception:
        pass


def _get_installed_models(host: str) -> list:
    try:
        req = urllib.request.Request(f"{host}/api/tags")
        resp = urllib.request.urlopen(req, timeout=5)
        data = json.loads(resp.read())
        return [m["name"] for m in data.get("models", [])]
    except Exception:
        return []


def _pull_model(host: str, model: str) -> bool:
    try:
        data = json.dumps({"name": model, "stream": False}).encode()
        req = urllib.request.Request(
            f"{host}/api/pull",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        resp = urllib.request.urlopen(req, timeout=600)
        return resp.status == 200
    except Exception:
        return False


def ensure_model_pulled(host: str, model: str) -> bool:
    if model in _get_installed_models(host):
        return True
    return _pull_model(host, model)


def get_installed_models(host: str) -> list:
    return _get_installed_models(host)


def _family_of(model: str) -> str:
    base = model.split(":")[0].lower()
    for suffix in ("-coder", "-instruct", "-reasoning", "-chat", "-base", "-tiny", "-nano"):
        if base.endswith(suffix):
            return base[: -len(suffix)]
    return base


def _size_of(model: str) -> float:
    size = model.split(":")[1] if ":" in model else ""
    match = re.search(r"(\d+(?:\.\d+)?)(m|b)", size, re.I)
    if not match:
        return float("inf")
    value = float(match.group(1))
    return value * 1000 if match.group(2).lower() == "b" else value


def _resolve_from_list(installed: list, real_model: str) -> Optional[dict]:
    if real_model in installed:
        return {"model": real_model, "substituted": False, "reason": None}
    fam = _family_of(real_model)
    best, best_dist = None, float("inf")
    for m in installed:
        if _family_of(m) != fam:
            continue
        dist = abs(_size_of(m) - _size_of(real_model)) + 0.5
        if dist < best_dist:
            best, best_dist = m, dist
    if best:
        return {
            "model": best,
            "substituted": True,
            "reason": f'"{real_model}" is not installed; using {best} (same family)',
        }
    return {"model": None, "substituted": True, "reason": f'"{real_model}" is not installed'}


def resolve_installed(host: str, real_model: str) -> Optional[dict]:
    """Find the best already-installed match for a real model name."""
    installed = _get_installed_models(host)
    return _resolve_from_list(installed, real_model)


def first_installed(host: str) -> Optional[str]:
    installed = _get_installed_models(host)
    return installed[0] if installed else None


def ensure() -> bool:
    host = config.get("engine_host")

    if not _is_engine_installed():
        _install_engine()

    if not _is_engine_running(host):
        _start_engine()

    real_model = catalog.get_real_model(config.get("model"))
    installed = _get_installed_models(host)
    needs_pull = real_model not in installed and _resolve_from_list(installed, real_model) is None

    if needs_pull:
        _pull_model(host, real_model)

    return True


def is_ready() -> bool:
    host = config.get("engine_host")
    return _is_engine_running(host)


def _local_bin_dir() -> Path:
    xdg = os.environ.get("XDG_BIN_HOME")
    if xdg:
        return Path(xdg)
    home = os.environ.get("HOME")
    if home:
        return Path(home) / ".local" / "bin"
    return Path("/usr/local/bin")


def _is_on_path(directory: Path) -> bool:
    """True when `directory` (resolved) appears in PATH."""
    paths = [p.strip() for p in os.environ.get("PATH", "").split(os.pathsep) if p.strip()]
    try:
        resolved_dir = directory.resolve()
    except OSError:
        resolved_dir = directory.absolute()
    for p in paths:
        try:
            candidate = Path(p).resolve()
        except OSError:
            continue
        if candidate == resolved_dir:
            return True
    return False


def _choose_bin_dir() -> Path:
    """A writable bin dir already on PATH, else the local bin dir."""
    local = _local_bin_dir()
    if _is_on_path(local):
        return local
    for candidate in ("/usr/local/bin", "/usr/bin"):
        p = Path(candidate)
        try:
            if not p.exists():
                p.mkdir(parents=True, mode=0o755)
            probe = p / f".vierrataleai-write-test-{os.getpid()}"
            probe.write_text("")
            probe.unlink()
            return p
        except OSError:
            continue
    return local


def app_command_path() -> Path:
    return _choose_bin_dir() / "vierrataleai"


def app_command_installed() -> bool:
    return app_command_path().exists()


def install_app_command() -> Optional[str]:
    """Create globally callable 'vierrataleai' / 'vierratale' commands."""
    try:
        target = app_command_path()
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        pkg = Path(__file__).resolve().parent
        root = pkg.parent
        # sys.executable is the python that can import this module (and rich).
        py = sys.executable
        content = (
            '#!/bin/sh\n'
            f'PYTHONPATH="{root}" exec {py} -m vierrataleai "$@"\n'
        )
        for name in ("vierrataleai", "vierratale"):
            path = target.parent / name
            live = path.exists() and not path.is_symlink()
            if live:
                try:
                    live = content == path.read_text()
                except OSError:
                    live = False
            if not live:
                # Refresh: replace stale or foreign launchers so this command
                # always points at this install, even one updated in place.
                path.unlink(missing_ok=True)
                path.write_text(content)
                path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        return str(target)
    except Exception:
        return None


def install() -> dict:
    """Full install: engine + model + global 'vierrataleai' / 'vierratale' commands."""
    ensure()
    cmd = install_app_command()
    on_path = bool(cmd) and _is_on_path(Path(cmd).parent)
    alias = (Path(cmd).parent / "vierratale").as_posix() if cmd else None
    return {
        "installed": _is_engine_installed(),
        "running": _is_engine_running(config.get("engine_host")),
        "command": cmd,
        "commandAlias": alias,
        "commandOnPath": on_path,
    }
