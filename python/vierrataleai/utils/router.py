"""Task-based model routing.

Looks at the user's message and picks the most suitable VTL model:

- file/folder/code/diff/git work  -> qwen2.5-coder (VTL-3.3-Pro)
- research/knowledge questions    -> qwen3 reasoning (VTL-3.5-Reason)
- everything else (daily chat)    -> gemma (VTL-2.7-Flash, the default)
"""
import re
from typing import Optional

from ..catalog import get_default_model

_CODE_MODEL = "VTL-3.3-Pro"
_RESEARCH_MODEL = "VTL-3.5-Reason"

# Explicit file/folder/diff/git work routes to the coding model.
_CODE_PATTERNS = (
    r"\b(file|files|folder|folders|directory|directories)\b",
    r"\b(diff|diffs|changes|changed)\b",
    r"\b(bug|bugs|bug fix|bugfix|fix|fixes|fixed|fixing)\b",
    r"\b(refactor|refactoring|debug|debugging|syntax|compile|compile error|traceback|crash)\b",
    r"\b(git|commit|commits|committing|merge|merging|pull request|merge request|repository)\b",
    r"\b(\.py|\.js|\.jsx|\.ts|\.tsx|\.html?|\.css|\.json|\.env|\.gitignore)\b",
    r"\b(package\.json|requirements\.txt|dockerfile|docker-compose(?:\.yml|\.yaml)?|setup\.py)\b",
    r"\b(script|app\.py|main\.py|server\.py|manage\.py|index\.html)\b",
    r"\b(create|write|make|update|edit|modify|add|remove|delete)\b"
    r"[^.!?\n]{0,60}\b(file|folder|directory|code|script|function|class|website|web app|app|project|config)\b",
)

# Research / knowledge requests route to the reasoning model.
_RESEARCH_PATTERNS = (
    r"\b(research|researching|study|studies|analy(?:ze|se)|explain|explanation|elaborate)\b",
    r"\bdifference between\b",
    r"\b(compare|comparison)\b",
    r"\b(summary|summarize|summarise|overview)\b",
    r"\b(meaning|definition|history|background|purpose|concept|theory|principle|mechanism)\b",
    r"\b(learn|teach me|tutorial|guide)\b",
    r"\b(what is|what are|what's|why is|why does|why do|how does|how to|how do)\b",
    r"\b(latest|news|current events|state of the art)\b",
)

_CODE_RE = [re.compile(p, re.I) for p in _CODE_PATTERNS]
_RESEARCH_RE = [re.compile(p, re.I) for p in _RESEARCH_PATTERNS]


def route_model(text: str) -> Optional[str]:
    """Pick the best model for `text`. Returns a VTL display name.

    Never raises; unknown/empty input falls back to the default model.
    """
    s = (text or "").strip().lower()
    if not s or s.startswith("/"):
        return None

    if any(r.search(s) for r in _CODE_RE):
        return _CODE_MODEL
    if any(r.search(s) for r in _RESEARCH_RE):
        return _RESEARCH_MODEL
    return get_default_model()