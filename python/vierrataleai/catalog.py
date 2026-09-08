from typing import Optional, Dict, List

# Model catalog. Display names use the opaque VTL branding:
# VTL-<number>.<name>, e.g. VTL-2.7-Flash, VTL-3.3-Pro.
# The real engine tags are mapped to display names here and kept internal.
MODELS: Dict[str, str] = {
    "gemma3:1b": "VTL-2.7-Flash",
    "llama3.2:1b": "VTL-2.9-Core",
    "qwen2.5:1.5b": "VTL-3.1-Plus",
    "qwen2.5-coder:1.5b": "VTL-3.3-Pro",
    "qwen3:1.7b": "VTL-3.5-Reason",
}

# Legacy display names (older `VRTL-*` and `vierratale-<word>`), accepted
# everywhere for backwards compatibility (existing config files may contain
# them). All map onto the current VTL display names.
LEGACY_DISPLAY: Dict[str, str] = {
    "VRTL-2.fast": "VTL-2.7-Flash",
    "VRTL-3.small": "VTL-2.9-Core",
    "VRTL-4.balanced": "VTL-3.1-Plus",
    "VRTL-4.coder": "VTL-3.3-Pro",
    "VRTL-5.plus": "VTL-3.5-Reason",
    "vierratale-fast": "VTL-2.7-Flash",
    "vierratale-small": "VTL-2.9-Core",
    "vierratale-balanced": "VTL-3.1-Plus",
    "vierratale-plus": "VTL-3.5-Reason",
}

REVERSE: Dict[str, str] = {v: k for k, v in MODELS.items()}

LOCAL_MODELS: List[str] = [
    "VTL-2.7-Flash",
    "VTL-2.9-Core",
    "VTL-3.1-Plus",
    "VTL-3.3-Pro",
    "VTL-3.5-Reason",
]

CLOUD_MODELS: List[str] = []

TIERS: Dict[str, str] = {
    "VTL-2.7-Flash": "fast",
    "VTL-2.9-Core": "small",
    "VTL-3.1-Plus": "balanced",
    "VTL-3.3-Pro": "coder",
    "VTL-3.5-Reason": "reasoning",
}


def normalize(display_name: str) -> str:
    """Map any known name (new or legacy) to the current VTL display name."""
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
    return "VTL-2.7-Flash"


def get_default_cloud_model() -> str:
    return CLOUD_MODELS[0] if CLOUD_MODELS else ""


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
