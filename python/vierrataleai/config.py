import json
import os
from pathlib import Path
from typing import Any, Optional

from .catalog import normalize as _normalize_model

def _config_dir() -> Path:
    return Path.home() / ".config" / "vierrataleai"


def _config_file() -> Path:
    return _config_dir() / "config.json"

DEFAULTS = {
    "provider": "auto",
    "model": "VTL-2.7-Flash",
    "engine_host": "http://127.0.0.1:11434",
    "num_ctx": 2048,
    "temperature": 0.7,
    "max_tokens": 4096,
    "keep_alive": "5m",
    "num_threads": 8,
    "command_timeout_ms": 300000,
    "plan_timeout_ms": 300000,
    "download_dir": str(Path.home() / "Downloads"),
}

_config: Optional[dict] = None


def _load_config_file() -> dict:
    try:
        if _config_file().exists():
            return json.loads(_config_file().read_text())
    except Exception:
        pass
    return {}


def _get_env(key: str, fallback: Any) -> Any:
    return os.environ.get(key, fallback)


def load() -> dict:
    global _config
    file_cfg = _load_config_file()
    # Migration: accept legacy 'cortex_host' key if 'engine_host' is absent.
    engine_host = file_cfg.get("engine_host") or file_cfg.get("cortex_host") or DEFAULTS["engine_host"]
    _config = {
        "provider": _get_env("VIERRATALE_PROVIDER", file_cfg.get("provider", DEFAULTS["provider"])),
        "model": _get_env("VIERRATALE_MODEL", file_cfg.get("model", DEFAULTS["model"])),
        "engine_host": _get_env("VIERRATALE_ENGINE_HOST", _get_env("VIERRATALE_CORTEX_HOST", engine_host)),
        "num_ctx": int(_get_env("VIERRATALE_NUM_CTX", file_cfg.get("num_ctx", DEFAULTS["num_ctx"]))),
        "temperature": float(_get_env("VIERRATALE_TEMPERATURE", file_cfg.get("temperature", DEFAULTS["temperature"]))),
        "max_tokens": int(_get_env("VIERRATALE_MAX_TOKENS", file_cfg.get("max_tokens", DEFAULTS["max_tokens"]))),
        "keep_alive": _get_env("VIERRATALE_KEEP_ALIVE", file_cfg.get("keep_alive", DEFAULTS["keep_alive"])),
        "num_threads": int(_get_env("VIERRATALE_NUM_THREADS", file_cfg.get("num_threads", DEFAULTS["num_threads"]))),
        "openai_api_key": _get_env("OPENAI_API_KEY", file_cfg.get("openai_api_key", "")),
        "anthropic_api_key": _get_env("ANTHROPIC_API_KEY", file_cfg.get("anthropic_api_key", "")),
        "gemini_api_key": _get_env("GEMINI_API_KEY", file_cfg.get("gemini_api_key", "")),
        "system_prompt": file_cfg.get("system_prompt", ""),
        "provider_models": file_cfg.get("provider_models", {}),
        "command_timeout_ms": int(_get_env("VIERRATALE_COMMAND_TIMEOUT_MS", file_cfg.get("command_timeout_ms", DEFAULTS["command_timeout_ms"]))),
        "plan_timeout_ms": int(_get_env("VIERRATALE_PLAN_TIMEOUT_MS", file_cfg.get("plan_timeout_ms", DEFAULTS["plan_timeout_ms"]))),
        "download_dir": _get_env("VIERRATALE_DOWNLOAD_DIR", file_cfg.get("download_dir", DEFAULTS["download_dir"])),
    }
    return _config


def get(key: str) -> Any:
    if _config is None:
        load()
    return _config[key]


def get_all() -> dict:
    if _config is None:
        load()
    return dict(_config)


def save(overrides: Optional[dict] = None) -> None:
    global _config
    if _config is None:
        load()
    if overrides:
        _config.update(overrides)
    _config_dir().mkdir(parents=True, exist_ok=True)
    _config_file().write_text(json.dumps(_config, indent=2))


def get_config_dir() -> Path:
    return _config_dir()


def get_provider_model(provider: str) -> Optional[str]:
    if _config is None:
        load()
    return (_config.get("provider_models") or {}).get(provider) or None


def set_provider_model(provider: str, model: str) -> None:
    if _config is None:
        load()
    _config["provider_models"] = _config.get("provider_models") or {}
    _config["provider_models"][provider] = model
    save()


def get_effective_model(provider: str) -> str:
    raw = get_provider_model(provider) or get("model")
    return _normalize_model(raw)
