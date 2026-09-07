import json
import os.path
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

FILE_NAME = ".todos.json"


def todos_file(cwd: Optional[str] = None) -> str:
    return os.path.join(cwd or ".", FILE_NAME)


def load_todos(cwd: Optional[str] = None) -> List[Dict[str, Any]]:
    try:
        with open(todos_file(cwd), "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    out: List[Dict[str, Any]] = []
    for t in data:
        if isinstance(t, dict):
            text = str(t.get("text", "")).strip()
            if not text:
                continue
            out.append(
                {
                    "text": text,
                    "done": bool(t.get("done")),
                    "created_at": t.get("created_at"),
                    "updated_at": t.get("updated_at"),
                }
            )
        else:
            text = str(t or "").strip()
            if text:
                out.append({"text": text, "done": False, "created_at": None, "updated_at": None})
    return out


def save_todos(cwd: Optional[str], todos: List[Dict[str, Any]]) -> None:
    with open(todos_file(cwd), "w", encoding="utf-8") as fh:
        json.dump(todos, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def format_todos(todos: List[Dict[str, Any]]) -> str:
    if not todos:
        return "(no todos yet)"
    return "\n".join(f"{i + 1}. {'[x]' if t['done'] else '[ ]'} {t['text']}" for i, t in enumerate(todos))


def add_todo(cwd: Optional[str], text: str) -> Dict[str, Any]:
    clean = str(text or "").strip()
    if not clean:
        return {"error": "Missing todo text."}
    todos = load_todos(cwd)
    todos.append({"text": clean, "done": False, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "updated_at": None})
    save_todos(cwd, todos)
    return {"okay": True}


def update_todo(cwd: Optional[str], index: int, done: Optional[bool] = None, text: Optional[str] = None) -> Dict[str, Any]:
    todos = load_todos(cwd)
    i = int(index) - 1
    if i < 0 or i >= len(todos):
        return {"error": f"No todo #{index}."}
    if done is not None:
        todos[i]["done"] = bool(done)
    if text and str(text).strip():
        todos[i]["text"] = str(text).strip()
    todos[i]["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save_todos(cwd, todos)
    return {"okay": True}


def clear_todos(cwd: Optional[str]) -> Dict[str, Any]:
    save_todos(cwd, [])
    return {"okay": True}