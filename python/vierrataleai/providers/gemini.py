import json
import urllib.request
import urllib.error
from typing import AsyncGenerator, List, Optional

from .base import BaseProvider
from ..catalog import get_real_model, get_display_name, get_all_models
from .. import config


class GeminiProvider(BaseProvider):
    def __init__(self):
        super().__init__("gemini")

    @property
    def display_name(self):
        return "Nebula"

    def _resolve_model(self, model_name: str) -> str:
        if model_name.startswith("gemini-"):
            return model_name
        return "gemini-2.0-flash"

    async def is_available(self) -> bool:
        return bool(config.get("gemini_api_key"))

    async def list_models(self) -> List[dict]:
        if not config.get("gemini_api_key"):
            return []
        return [
            {"real_name": real, "display_name": get_display_name(real)}
            for real in get_all_models()
            if real.startswith("gemini-")
        ]

    async def stream(
        self,
        messages: List[dict],
        options: Optional[dict] = None,
    ) -> AsyncGenerator[str, None]:
        options = options or {}
        key = config.get("gemini_api_key")
        if not key:
            raise RuntimeError("[ERR-0004] Cloud API key not configured. Add it to the config and try again.")

        model = self._resolve_model(options.get("model", config.get("model")))
        system_prompt = options.get("system_prompt", "")

        contents = [
            {"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
            for m in messages
        ]
        if system_prompt:
            contents.insert(0, {"role": "user", "parts": [{"text": f"System: {system_prompt}"}]})

        body = json.dumps({
            "contents": contents,
            "generationConfig": {
                "temperature": options.get("temperature", config.get("temperature")),
                "maxOutputTokens": options.get("max_tokens", config.get("max_tokens")),
            },
        }).encode()

        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model}:streamGenerateContent?key={key}&alt=sse"
        )
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
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
                    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                    text = parts[0].get("text", "") if parts else ""
                    if text:
                        yield text
                except json.JSONDecodeError:
                    continue
