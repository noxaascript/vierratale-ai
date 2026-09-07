import json
import urllib.request
import urllib.error
import asyncio
from typing import AsyncGenerator, List, Optional

from .base import BaseProvider
from ..catalog import get_real_model, get_display_name
from .. import config

# Keep the prompt a local engine must re-process per call bounded: the
# system prompt plus the most recent messages. Sending the whole growing
# history makes prompt-processing time unbounded on slow hardware.
MAX_CONTEXT_MESSAGES = 12


def _build_engine_messages(system_prompt: str, messages: List[dict]) -> List[dict]:
    engine_messages = []
    if system_prompt:
        engine_messages.append({"role": "system", "content": system_prompt})
    for msg in messages:
        engine_messages.append({"role": msg["role"], "content": msg["content"]})
    if len(engine_messages) > MAX_CONTEXT_MESSAGES:
        return [engine_messages[0], *engine_messages[-(MAX_CONTEXT_MESSAGES - 1):]]
    return engine_messages


class CortexProvider(BaseProvider):
    def __init__(self):
        super().__init__("cortex")
        self.host = config.get("engine_host")
        self.is_local = True

    async def is_available(self) -> bool:
        try:
            req = urllib.request.Request(f"{self.host}/api/tags")
            resp = urllib.request.urlopen(req, timeout=3)
            return resp.status == 200
        except Exception:
            return False

    async def list_models(self) -> List[dict]:
        try:
            req = urllib.request.Request(f"{self.host}/api/tags")
            resp = urllib.request.urlopen(req, timeout=5)
            data = json.loads(resp.read())
            return [
                {
                    "real_name": m["name"],
                    "display_name": get_display_name(m["name"]),
                    "size": m.get("size", 0),
                }
                for m in data.get("models", [])
            ]
        except Exception:
            return []

    async def stream(
        self,
        messages: List[dict],
        options: Optional[dict] = None,
    ) -> AsyncGenerator[str, None]:
        options = options or {}
        model = get_real_model(options.get("model", config.get("model")))
        engine_messages = _build_engine_messages(options.get("system_prompt", ""), messages)

        body = json.dumps({
            "model": model,
            "messages": engine_messages,
            "stream": True,
            "keep_alive": config.get("keep_alive"),
            "options": {
                "num_ctx": config.get("num_ctx"),
                "num_predict": options.get("max_tokens") or config.get("max_tokens"),
                "temperature": options.get("temperature", config.get("temperature")),
                "num_thread": config.get("num_threads"),
            },
        }).encode()

        req = urllib.request.Request(
            f"{self.host}/api/chat",
            data=body,
            headers={"Content-Type": "application/json"},
        )

        try:
            resp = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as err:
            err_body = ""
            try:
                err_body = err.read().decode("utf-8", "ignore")[:300]
            except Exception:
                pass
            if err.code == 404 or "not found" in err_body.lower():
                raise RuntimeError(
                    f'[ERR-0002] Model "{model}" is not installed on the engine. '
                    "If you picked a cloud model, use /model VTL-3.7-Ultra or /provider openai."
                )
            raise RuntimeError(
                f"[ERR-0003] The engine returned HTTP {err.code}. Check the engine status or run /model VTL-2.7-Flash."
            )
        except Exception as err:
            raise RuntimeError(
                "[ERR-0001] Could not reach the engine (no response within 600s). "
                "Make sure the local engine is running."
            )

        buffer = ""
        for chunk in iter(lambda: resp.read(1024), b""):
            buffer += chunk.decode("utf-8", errors="ignore")
            lines = buffer.split("\n")
            buffer = lines.pop() or ""

            for line in lines:
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                    content = data.get("message", {}).get("content", "")
                    if content:
                        yield content
                    if data.get("done"):
                        return
                except json.JSONDecodeError:
                    continue

    def _complete_sync(self, messages: List[dict], options: Optional[dict] = None) -> str:
        options = options or {}
        model = get_real_model(options.get("model", config.get("model")))
        engine_messages = _build_engine_messages(options.get("system_prompt", ""), messages)

        body = json.dumps({
            "model": model,
            "messages": engine_messages,
            "stream": True,
            "keep_alive": config.get("keep_alive"),
            "options": {
                "num_ctx": config.get("num_ctx"),
                "num_predict": options.get("max_tokens") or config.get("max_tokens"),
                "temperature": options.get("temperature", config.get("temperature")),
                "num_thread": config.get("num_threads"),
            },
        }).encode()
        req = urllib.request.Request(
            f"{self.host}/api/chat",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        try:
            resp = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as err:
            err_body = ""
            try:
                err_body = err.read().decode("utf-8", "ignore")[:300]
            except Exception:
                pass
            if err.code == 404 or "not found" in err_body.lower():
                raise RuntimeError(
                    f'[ERR-0002] Model "{model}" is not installed on the engine. '
                    "If you picked a cloud model, use /model VTL-3.7-Ultra or /provider openai."
                )
            raise RuntimeError(
                f"[ERR-0003] The engine returned HTTP {err.code}. Check the engine status or run /model VTL-2.7-Flash."
            )
        except Exception as err:
            raise RuntimeError(
                "[ERR-0001] Could not reach the engine (no response within 600s). "
                "Make sure the local engine is running."
            )

        output = ""
        buffer = ""
        for chunk in iter(lambda: resp.read(1024), b""):
            buffer += chunk.decode("utf-8", errors="ignore")
            lines = buffer.split("\n")
            buffer = lines.pop() or ""
            for line in lines:
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                    content = data.get("message", {}).get("content", "")
                    if content:
                        output += content
                    if data.get("done"):
                        return output
                except json.JSONDecodeError:
                    continue
        return output

    async def complete(self, messages: List[dict], options: Optional[dict] = None) -> str:
        return await asyncio.to_thread(self._complete_sync, messages, options)

async def warmup(self) -> None:
        # Fire-and-forget: ask the engine to load the model eagerly, then abort
        # as soon as generation starts. The engine runs with a single slot, so
        # an in-flight non-streaming 'hi' would block the first real request.
        model = get_real_model(config.get("model"))
        body = json.dumps({
            "model": model,
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
            "keep_alive": config.get("keep_alive"),
            "options": {"num_ctx": config.get("num_ctx")},
        }).encode()

        def _warm():
            resp = urllib.request.urlopen(
                urllib.request.Request(
                    f"{self.host}/api/chat",
                    data=body,
                    headers={"Content-Type": "application/json"},
                ),
                timeout=30,
            )
            buffer = ""
            for chunk in iter(lambda: resp.read(1024), b""):
                buffer += chunk.decode("utf-8", errors="ignore")
                lines = buffer.split("\n")
                buffer = lines.pop() or ""
                for line in lines:
                    if not line.strip():
                        continue
                    try:
                        if json.loads(line).get("message", {}).get("content"):
                            return
                    except json.JSONDecodeError:
                        continue

        try:
            await asyncio.to_thread(_warm)
        except Exception:
            pass
