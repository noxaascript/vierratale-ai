from abc import ABC, abstractmethod
from typing import AsyncGenerator, List, Optional


class BaseProvider(ABC):
    def __init__(self, name: str):
        self.name = name
        self.is_local = False

    @property
    def display_name(self) -> str:
        return "Cortex"

    @abstractmethod
    async def stream(
        self,
        messages: List[dict],
        options: Optional[dict] = None,
    ) -> AsyncGenerator[str, None]:
        yield ""

    # Non-streaming convenience: collects the stream. Providers may override
    # with a proper single-shot request (see CortexProvider).
    async def complete(self, messages: List[dict], options: Optional[dict] = None) -> str:
        out = ""
        async for chunk in self.stream(messages, options):
            out += chunk or ""
        return out

    @abstractmethod
    async def list_models(self) -> List[dict]:
        return []

    @abstractmethod
    async def is_available(self) -> bool:
        return False
