from typing import Optional, Dict, List

# Model catalog. Display names use the opaque VTL branding:
# VTL-<number>.<name>, e.g. VTL-2.7-Flash, VTL-4.0.
# The real engine tags are mapped to display names here and kept internal.
MODELS: Dict[str, str] = {
    "qwen3:0.6b": "VTL-2.5-Mini",
    "gemma3:1b": "VTL-2.7-Flash",
    "llama3.2:1b": "VTL-2.9-Core",
    "llama3.2:3b": "VTL-3.2-Orbit",
    "qwen2.5:1.5b": "VTL-3.1-Plus",
    "qwen2.5-coder:1.5b": "VTL-3.3-Pro",
    "qwen3:1.7b": "VTL-3.5-Reason",
    "qwen2.5:3b": "VTL-3.7-Ultra",
    "gemma3:4b": "VTL-4.7-Gusto",
    "phi4-mini": "VTL-5.4-Tempo",
    "glm4:9b": "VTL-5.2-Pinnacle",
    "qwen3:4b": "VTL-5.9-Sovereign",
    "gpt-4o-mini": "VTL-4.0",
    "gpt-4o": "VTL-4.2-Omni",
    "claude-3-5-haiku-20241022": "VTL-4.5-Plus",
    "claude-sonnet-4-20250514": "VTL-5.0-Pro",
    "gemini-2.0-flash": "VTL-6.0-Reason",
    "gemini-1.5-pro": "VTL-7.0-Omnij",
    "kimi-k2.6:cloud": "VTL-8.0-Fabric",
    "kimi-k2.7-code:cloud": "VTL-9.0-Forge",
    "kimi-k3": "VTL-10.0-Singularity",
}

# Legacy display names (older `VRTL-*` and `vierratale-<word>`), accepted
# everywhere for backwards compatibility (existing config files may contain
# them). All map onto the current VTL display names.
LEGACY_DISPLAY: Dict[str, str] = {
    "VRTL-1.lite": "VTL-2.5-Mini",
    "VRTL-2.fast": "VTL-2.7-Flash",
    "VRTL-3.small": "VTL-2.9-Core",
    "VRTL-4.balanced": "VTL-3.1-Plus",
    "VRTL-4.coder": "VTL-3.3-Pro",
    "VRTL-5.plus": "VTL-3.5-Reason",
    "VRTL-6.pro": "VTL-3.7-Ultra",
    "VRTL-7.cloud-mini": "VTL-4.0",
    "VRTL-8.cloud": "VTL-4.2-Omni",
    "VRTL-9.cloud-fast": "VTL-4.5-Plus",
    "VRTL-10.cloud-pro": "VTL-5.0-Pro",
    "VRTL-11.cloud-lite": "VTL-6.0-Reason",
    "VRTL-12.cloud-plus": "VTL-7.0-Omnij",
    "vierratale-lite": "VTL-2.5-Mini",
    "vierratale-fast": "VTL-2.7-Flash",
    "vierratale-small": "VTL-2.9-Core",
    "vierratale-balanced": "VTL-3.1-Plus",
    "vierratale-plus": "VTL-3.5-Reason",
    "vierratale-pro": "VTL-3.7-Ultra",
    "vierratale-cloud-mini": "VTL-4.0",
    "vierratale-cloud": "VTL-4.2-Omni",
    "vierratale-cloud-fast": "VTL-4.5-Plus",
    "vierratale-cloud-pro": "VTL-5.0-Pro",
    "vierratale-cloud-lite": "VTL-6.0-Reason",
    "vierratale-cloud-plus": "VTL-7.0-Omnij",
}

REVERSE: Dict[str, str] = {v: k for k, v in MODELS.items()}

LOCAL_MODELS: List[str] = [
    "VTL-2.5-Mini",
    "VTL-2.7-Flash",
    "VTL-2.9-Core",
    "VTL-3.2-Orbit",
    "VTL-3.1-Plus",
    "VTL-3.3-Pro",
    "VTL-3.5-Reason",
    "VTL-3.7-Ultra",
    "VTL-4.7-Gusto",
    "VTL-5.4-Tempo",
    "VTL-5.2-Pinnacle",
    "VTL-5.9-Sovereign",
]

CLOUD_MODELS: List[str] = [
    "VTL-4.0",
    "VTL-4.2-Omni",
    "VTL-4.5-Plus",
    "VTL-5.0-Pro",
    "VTL-6.0-Reason",
    "VTL-7.0-Omnij",
    "VTL-8.0-Fabric",
    "VTL-9.0-Forge",
    "VTL-10.0-Singularity",
]

TIERS: Dict[str, str] = {
    "VTL-2.5-Mini": "minimal",
    "VTL-2.7-Flash": "fast",
    "VTL-2.9-Core": "small",
    "VTL-3.2-Orbit": "small",
    "VTL-3.1-Plus": "balanced",
    "VTL-3.3-Pro": "coder",
    "VTL-3.5-Reason": "reasoning",
    "VTL-3.7-Ultra": "ultra",
    "VTL-4.7-Gusto": "balanced",
    "VTL-5.4-Tempo": "balanced",
    "VTL-5.2-Pinnacle": "pro",
    "VTL-5.9-Sovereign": "pro",
    "VTL-4.0": "cloud-mini",
    "VTL-4.2-Omni": "cloud",
    "VTL-4.5-Plus": "cloud-fast",
    "VTL-5.0-Pro": "cloud-pro",
    "VTL-6.0-Reason": "cloud-lite",
    "VTL-7.0-Omnij": "cloud-plus",
    "VTL-8.0-Fabric": "cloud-fabric",
    "VTL-9.0-Forge": "cloud-forge",
    "VTL-10.0-Singularity": "cloud-singularity",
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
    return "VTL-4.0"


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
