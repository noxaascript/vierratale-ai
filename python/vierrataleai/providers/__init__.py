from .cortex import CortexProvider
from .openai import OpenAIProvider
from .anthropic import AnthropicProvider
from .gemini import GeminiProvider
from .base import BaseProvider
from .. import config

_providers = {}


def _get_providers():
    global _providers
    if not _providers:
        _providers = {
            "cortex": CortexProvider(),
            "openai": OpenAIProvider(),
            "anthropic": AnthropicProvider(),
            "gemini": GeminiProvider(),
        }
    return _providers


async def auto_detect():
    providers = _get_providers()
    requested = config.get("provider")

    if requested != "auto" and requested in providers:
        if await providers[requested].is_available():
            return providers[requested]

    for name in ["cortex", "openai", "anthropic", "gemini"]:
        if await providers[name].is_available():
            return providers[name]

    return None


def create(name: str):
    providers = _get_providers()
    return providers.get(name)


def get_available():
    return _get_providers()
