import json
import urllib.request
import urllib.error
from typing import AsyncGenerator, List, Optional

from .base import BaseProvider
from ..catalog import get_real_model, get_display_name, is_local_model, is_cloud_model
from .. import config


class OpenAIProvider(BaseProvider):
    def __init__(self):
        super().__init__("openai")

    async def is_available(self) -> bool:
        key = config.get("openai_api_key")
        if not key:
            return False
        try:
            req = urllib.request.Request(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {key}"},
            )
            resp = urllib.request.urlopen(req, timeout=5)
            return resp.status == 200
        except Exception:
            return False

    async def list_models(self) -> List[dict]:
        key = config.get("openai_api_key")
        if not key:
            return []
        try:
            req = urllib.request.Request(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {key}"},
            )
            resp = urllib.request.urlopen(req, timeout=10)
            data = json.loads(resp.read())
            return [
                {
                    "real_name": m["id"],
                    "display_name": get_display_name(m["id"]),
                }
                for m in data.get("data", [])
                if m["id"].startswith("gpt-")
            ]
        except Exception:
            return []

    def _resolve_model(self, model_name: str) -> str:
        if is_local_model(model_name) or not is_cloud_model(model_name):
            return "gpt-4o-mini"
        return get_real_model(model_name)

    async def stream(
        self,
        messages: List[dict],
        options: Optional[dict] = None,
    ) -> AsyncGenerator[str, None]:
        options = options or {}
        key = config.get("openai_api_key")
        if not key:
            raise RuntimeError("[ERR-0004] Cloud API key not configured. Add it to the config and try again.")

        model = self._resolve_model(options.get("model", config.get("model")))
        system_prompt = options.get("system_prompt", "")

        api_messages = []
        if system_prompt:
            api_messages.append({"role": "system", "content": system_prompt})
        for msg in messages:
            api_messages.append({"role": msg["role"], "content": msg["content"]})

        body = json.dumps({
            "model": model,
            "messages": api_messages,
            "stream": True,
            "temperature": options.get("temperature", config.get("temperature")),
            "max_tokens": options.get("max_tokens", config.get("max_tokens")),
        }).encode()

        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
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
                if data_str == "[DONE]":
                    return
                try:
                    data = json.loads(data_str)
                    content = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    if content:
                        yield content
                except json.JSONDecodeError:
                    continue
