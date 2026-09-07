from typing import Optional, Dict, List

# Model catalog. Display names use the countable VRTL branding:
# VRTL-<number>.<word>, e.g. VRTL-2.fast, VRTL-7.cloud-mini.
MODELS: Dict[str, str] = {
    "qwen3:0.6b": "VRTL-1.lite",
    "gemma3:1b": "VRTL-2.fast",
    "llama3.2:1b": "VRTL-3.small",
    "qwen2.5:1.5b": "VRTL-4.balanced",
    "qwen2.5-coder:1.5b": "VRTL-4.coder",
    "qwen3:1.7b": "VRTL-5.plus",
    "qwen2.5:3b": "VRTL-6.pro",
    "gpt-4o-mini": "VRTL-7.cloud-mini",
    "gpt-4o": "VRTL-8.cloud",
    "claude-3-5-haiku-20241022": "VRTL-9.cloud-fast",
    "claude-sonnet-4-20250514": "VRTL-10.cloud-pro",
    "gemini-2.0-flash": "VRTL-11.cloud-lite",
    "gemini-1.5-pro": "VRTL-12.cloud-plus",
}

# Older `vierratale-<word>` names, accepted everywhere for backwards
# compatibility (existing config files may still contain them).
LEGACY_DISPLAY: Dict[str, str] = {
    "vierratale-lite": "VRTL-1.lite",
    "vierratale-fast": "VRTL-2.fast",
    "vierratale-small": "VRTL-3.small",
    "vierratale-balanced": "VRTL-4.balanced",
    "vierratale-plus": "VRTL-5.plus",
    "vierratale-pro": "VRTL-6.pro",
    "vierratale-cloud-mini": "VRTL-7.cloud-mini",
    "vierratale-cloud": "VRTL-8.cloud",
    "vierratale-cloud-fast": "VRTL-9.cloud-fast",
    "vierratale-cloud-pro": "VRTL-10.cloud-pro",
    "vierratale-cloud-lite": "VRTL-11.cloud-lite",
    "vierratale-cloud-plus": "VRTL-12.cloud-plus",
}

REVERSE: Dict[str, str] = {v: k for k, v in MODELS.items()}

LOCAL_MODELS: List[str] = [
    "VRTL-1.lite",
    "VRTL-2.fast",
    "VRTL-3.small",
    "VRTL-4.balanced",
    "VRTL-4.coder",
    "VRTL-5.plus",
    "VRTL-6.pro",
]

CLOUD_MODELS: List[str] = [
    "VRTL-7.cloud-mini",
    "VRTL-8.cloud",
    "VRTL-9.cloud-fast",
    "VRTL-10.cloud-pro",
    "VRTL-11.cloud-lite",
    "VRTL-12.cloud-plus",
]

TIERS: Dict[str, str] = {
    "VRTL-1.lite": "minimal",
    "VRTL-2.fast": "fast",
    "VRTL-3.small": "small",
    "VRTL-4.balanced": "balanced",
    "VRTL-4.coder": "coder",
    "VRTL-5.plus": "plus",
    "VRTL-6.pro": "professional",
    "VRTL-7.cloud-mini": "cloud-mini",
    "VRTL-8.cloud": "cloud",
    "VRTL-9.cloud-fast": "cloud-fast",
    "VRTL-10.cloud-pro": "cloud-pro",
    "VRTL-11.cloud-lite": "cloud-lite",
    "VRTL-12.cloud-plus": "cloud-plus",
}


def normalize(display_name: str) -> str:
    """Map any known name (new or legacy) to the current VRTL display name."""
    return LEGACY_DISPLAY.get(display_name, display_name)


def get_real_model(display_name: str) -> str:
    return REVERSE.get(normalize(display_name), display_name)


def get_display_name(real_model: str) -> str:
    return MODELS.get(real_model, real_model)


def get_all_models() -> Dict[str, str]:
    return dict(MODELS)


def get_local_models() -> List[str]:
    return list(LOCAL_MODELS)


def get_cloud_models() -> List[str]:
    return list(CLOUD_MODELS)


def get_default_model() -> str:
    return "VRTL-2.fast"


def get_default_cloud_model() -> str:
    return "VRTL-7.cloud-mini"


def is_local_model(display_name: str) -> bool:
    return normalize(display_name) in LOCAL_MODELS


def is_cloud_model(display_name: str) -> bool:
    return normalize(display_name) in CLOUD_MODELS


def get_model_info(display_name: str) -> Optional[dict]:
    name = normalize(display_name)
    real = REVERSE.get(name)
    if not real:
        return None
    return {
        "display_name": display_name,
        "real_model": real,
        "is_local": name in LOCAL_MODELS,
        "is_cloud": name in CLOUD_MODELS,
        "tier": TIERS.get(name, "unknown"),
    }