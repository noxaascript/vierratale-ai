"""Slim engine helper: ensures the local engine runs and a model is usable.

The full installer (engine + model + command linking) lives in install.sh;
this module only provides the runtime bits the CLI needs to start/check the
engine and pull/select models on demand.
"""

import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Optional

from . import config
from . import catalog


def _is_engine_installed() -> bool:
    try:
        result = subprocess.run(["which", "ollama"], capture_output=True, timeout=5)
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
        import urllib.request

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
        import urllib.request

        req = urllib.request.Request(f"{host}/api/tags")
        resp = urllib.request.urlopen(req, timeout=5)
        data = json.loads(resp.read())
        return [m["name"] for m in data.get("models", [])]
    except Exception:
        return []


def _pull_model(host: str, model: str) -> bool:
    try:
        import urllib.request

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


def get_installed_models(host: str) -> list:
    return _get_installed_models(host)


def ensure_model_pulled(host: str, model: str) -> bool:
    if model in _get_installed_models(host):
        return True
    return _pull_model(host, model)


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
    if real_model not in installed:
        if _resolve_from_list(installed, real_model) is None:
            _pull_model(host, real_model)

    return True


def is_ready() -> bool:
    host = config.get("engine_host")
    return _is_engine_running(host)
