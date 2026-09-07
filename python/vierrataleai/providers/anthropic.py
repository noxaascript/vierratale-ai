import json
import urllib.request
import urllib.error
from typing import AsyncGenerator, List, Optional

from .base import BaseProvider
from ..catalog import get_real_model, get_display_name, get_all_models
from .. import config


class AnthropicProvider(BaseProvider):
    def __init__(self):
        super().__init__("anthropic")

    @property
    def display_name(self):
        return "Nebula"

    def _resolve_model(self, model_name: str) -> str:
        if model_name.startswith("claude-"):
            return model_name
        return "claude-3-5-haiku-20241022"

    async def is_available(self) -> bool:
        return bool(config.get("anthropic_api_key"))

    async def list_models(self) -> List[dict]:
        if not config.get("anthropic_api_key"):
            return []
        return [
            {"real_name": real, "display_name": get_display_name(real)}
            for real in get_all_models()
            if real.startswith("claude-")
        ]

    async def stream(
        self,
        messages: List[dict],
        options: Optional[dict] = None,
    ) -> AsyncGenerator[str, None]:
        options = options or {}
        key = config.get("anthropic_api_key")
        if not key:
            raise RuntimeError("[ERR-0004] Cloud API key not configured. Add it to the config and try again.")

        model = self._resolve_model(options.get("model", config.get("model")))
        system_prompt = options.get("system_prompt", "")

        system = []
        if system_prompt:
            system.append({"type": "text", "text": system_prompt})
        api_messages = [
            {"role": m["role"], "content": m["content"]}
            for m in messages
        ]

        body = json.dumps({
            "model": model,
            "system": system if system else None,
            "messages": api_messages,
            "max_tokens": options.get("max_tokens", config.get("max_tokens")),
            "stream": True,
            "temperature": options.get("temperature", config.get("temperature")),
        }).encode()

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=body,
            headers={
                "Content-Type": "application/json",
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
            },
        )

        try:
            resp = urllib.request.urlopen(req, timeout=240)
        except urllib.error.HTTPError as err:
            raise RuntimeError(
                f"[ERR-0003] The cloud provider returned HTTP {err.code}. Check your API key in config."
            )
        except Exception as err:
            raise RuntimeError("[ERR-0001] Could not reach the API (no response within 120s). Check your network connection.")

        buffer = ""
        for chunk in iter(lambda: resp.read(1024), b""):
            buffer += chunk.decode("utf-8", errors="ignore")
            lines = buffer.split("\n")
            buffer = lines.pop() or ""
            for line in lines:
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                try:
                    data = json.loads(data_str)
                    if data.get("type") == "content_block_delta":
                        text = data.get("delta", {}).get("text", "")
                        if text:
                            yield text
                except json.JSONDecodeError:
                    continue
