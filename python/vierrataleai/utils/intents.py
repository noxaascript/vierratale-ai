import re
from typing import Optional

_QUESTION_PREFIXES = {
    "who", "what", "when", "where", "why", "how",
    "which", "whose", "whom", "is", "are", "was", "were",
    "can", "could", "does", "do", "did", "would", "should", "will",
}

_KNOWLEDGE_PREFIXES = (
    "tell me about", "what is", "what's", "who is", "who's",
    "what are", "who was", "when did", "when was", "where is",
    "where was", "how did", "how does", "how to", "why did", "why is",
    "latest", "news", "current",
)

_SELF_PHRASES = (
    "what model", "which model", "what model are you", "which model are you",
    "what are you", "who are you", "what's your name", "what is your name",
    "what language model", "what llm", "what ai model", "what ai are you",
    "your model", "what model do you use", "what model you use",
    "what engine", "which engine", "are you gpt", "are you chatgpt",
)

_ACTION_VERBS = r"create|make|write|save|generate|build|add|new|update|edit|install|put|set"
_FILE_THINGS = r"file|folder|directory|project|code|script|config|\.json|app|readme|package\.json|website|html|css"
_INFO_ASK = re.compile(r"^(how|what|why|when|where|which)\b", re.I)
_FILE_REQUEST = re.compile(
    rf"\b({_ACTION_VERBS})\b[^.!?]{{0,80}}\b({_FILE_THINGS})\b", re.I
)

_STORY_WORDS = (
    r"story|stories|tale|tales|legend|legends|myth|myths|fable|fables|"
    r"folklore|folktale|folk\s+tale|fairytale|fairy\s+tale"
)
_STORY_LINKS = r"about|of|regarding|recounting|called|named"
_TRIM_TAIL = r"\s+(?:and|in|into)\b|\s*[.!?]|$"

_STORY_SUBJECT_PATTERN = re.compile(
    rf"\b(?:{_STORY_WORDS})\s+(?:{_STORY_LINKS})\s+[a-z0-9]{{3,}}", re.I
)
_STORY_ASK_PATTERN = re.compile(
    rf"\b(?:tell|write|narrate|recite|make|create|generate|give|share|hear|listen to)\b"
    rf"[^.!?\n]{{0,60}}\b(?:{_STORY_WORDS})\b",
    re.I,
)
_STORY_CAPTURE = re.compile(
    rf"\b(?:{_STORY_WORDS})\s+(?:{_STORY_LINKS})\s+"
    rf"([^.!?\n]{{2,}}?)\s*(?={_TRIM_TAIL})",
    re.I,
)
_ABOUT_CAPTURE = re.compile(
    r"\b(?:tell me|talk|read|learn|research|hear|know|find out|look up|speak|write|give)\b"
    r"[^.!?\n]{0,30}\babout\s+([^.!?\n]{2,}?)\s*(?=\s+(?:and|in|into)\b|\s*[.!?]|$)",
    re.I,
)
_PLACE_PATTERN = re.compile(r"\bfrom\s+[a-z][a-z\s'.-]{1,40}$", re.I)

_GREETINGS = {
    "hi", "hello", "hey", "hii", "heyy", "howdy", "yo", "hai",
    "halo", "hallo", "hola", "hiya", "sup", "good morning",
    "good afternoon", "good evening", "good night", "selamat pagi",
    "selamat siang", "selamat sore", "selamat malam", "assalamualaikum",
}


def looks_like_story_request(text: str) -> bool:
    return bool(_STORY_ASK_PATTERN.search(text)) or bool(
        _STORY_SUBJECT_PATTERN.search(text)
    )


def extract_search_topic(text: str) -> Optional[str]:
    s = (text or "").strip()
    story = _STORY_CAPTURE.search(s)
    if story:
        return story.group(1).strip()
    about = _ABOUT_CAPTURE.search(s)
    return about.group(1).strip() if about else None


def detect_intent(text: str) -> str:
    lower = text.lower().strip()
    if lower.startswith("/"):
        return "command"

    if lower in _GREETINGS:
        return "greeting"

    if any(p in lower for p in _SELF_PHRASES):
        return "self"

    if _STORY_SUBJECT_PATTERN.search(lower) or _PLACE_PATTERN.search(lower):
        return "knowledge"

    is_knowledge_prefixed = any(
        lower.startswith(p + " ") or lower == p for p in _KNOWLEDGE_PREFIXES
    )

    if (
        not _INFO_ASK.match(lower)
        and not is_knowledge_prefixed
        and _FILE_REQUEST.search(lower)
    ):
        return "chat"

    is_question = lower.rstrip().endswith("?")
    first_word = lower.split()[0] if lower.split() else ""

    needs_web = False
    if is_question and first_word in _QUESTION_PREFIXES:
        needs_web = True
    if is_knowledge_prefixed:
        needs_web = True

    return "knowledge" if needs_web else "chat"
