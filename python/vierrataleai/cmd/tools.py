import os
import re
import shutil
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Union

from .executor import SafeCommandExecutor, tool_result
from ..utils.downloader import Downloader
from .. import config as config_mod
from .todos import load_todos, add_todo, update_todo, clear_todos, format_todos


def _ok(*, command: str, stdout: str = "", cwd: str) -> Dict[str, Any]:
    return tool_result(success=True, command=command, stdout=stdout, stderr="", exit_code=0, cwd=cwd)


def _fail(*, command: str, stderr: str, exit_code: int = 1, cwd: str) -> Dict[str, Any]:
    return tool_result(success=False, command=command, stdout="", stderr=stderr, exit_code=exit_code, cwd=cwd)


def resolve_within(cwd: str, p: str, *, allow_root: bool = False) -> Path:
    base = Path(cwd).resolve()
    target = (base / p).resolve() if not os.path.isabs(p) else Path(p).resolve()
    outside = (target != base) and not str(target).startswith(str(base) + os.sep)
    if outside:
        raise ValueError(f"Refusing to access a path outside the workspace: {p}")
    if not allow_root and target == base and p.strip() not in ("", "."):
        raise ValueError("Refusing to use the workspace root as a file path.")
    return target


# ---------------------------------------------------------------------- #
# File-system tools
# ---------------------------------------------------------------------- #

def create_file(cwd: str, path: str, content: str = "") -> Dict[str, Any]:
    if not path or not str(path).strip():
        return _fail(command="create_file", stderr="Missing file path.", cwd=cwd)
    try:
        target = resolve_within(cwd, path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(content or ""), encoding="utf-8")
        return _ok(command=f'create_file("{path}")', stdout=f"created {path} ({len(str(content or ''))} bytes)", cwd=cwd)
    except Exception as exc:
        return _fail(command=f'create_file("{path}")', stderr=str(exc), cwd=cwd)


def create_directory(cwd: str, path: str) -> Dict[str, Any]:
    if not path or not str(path).strip():
        return _fail(command="create_directory", stderr="Missing directory path.", cwd=cwd)
    try:
        target = resolve_within(cwd, path, allow_root=True)
        target.mkdir(parents=True, exist_ok=True)
        return _ok(command=f'create_directory("{path}")', stdout=f"created directory {path}", cwd=cwd)
    except Exception as exc:
        return _fail(command=f'create_directory("{path}")', stderr=str(exc), cwd=cwd)


def read_file(cwd: str, path: str) -> Dict[str, Any]:
    if not path or not str(path).strip():
        return _fail(command="read_file", stderr="Missing file path.", cwd=cwd)
    try:
        target = resolve_within(cwd, path)
        content = target.read_text(encoding="utf-8")
        return _ok(command=f'read_file("{path}")', stdout=content, cwd=cwd)
    except Exception as exc:
        return _fail(command=f'read_file("{path}")', stderr=str(exc), cwd=cwd)


def list_directory(cwd: str, path: str = ".") -> Dict[str, Any]:
    try:
        target = resolve_within(cwd, path, allow_root=True)
        entries = sorted(
            (e.name + ("/" if e.is_dir() else "")) for e in target.iterdir()
        )
        return _ok(command=f'list_directory("{path}")', stdout="\n".join(entries) or "(empty)", cwd=cwd)
    except Exception as exc:
        return _fail(command=f'list_directory("{path}")', stderr=str(exc), cwd=cwd)


def delete_file(cwd: str, path: str) -> Dict[str, Any]:
    if not path or not str(path).strip():
        return _fail(command="delete_file", stderr="Missing path.", cwd=cwd)
    try:
        target = resolve_within(cwd, path)
        if Path(cwd).resolve() == target:
            return _fail(command=f'delete_file("{path}")', stderr="Refusing to delete the workspace root.", cwd=cwd)
        if not target.exists():
            return _fail(command=f'delete_file("{path}")', stderr=f"No such file or directory: {path}", cwd=cwd)
        if target.is_dir():
            import shutil
            shutil.rmtree(target)
        else:
            target.unlink()
        return _ok(command=f'delete_file("{path}")', stdout=f"removed {path}", cwd=cwd)
    except Exception as exc:
        return _fail(command=f'delete_file("{path}")', stderr=str(exc), cwd=cwd)


def pick_package_manager() -> str:
    """Pick the package manager for installing system packages.

    pkg is the Termux/Android wrapper; everywhere else prefer apt-get over apt.
    """
    for bin_name in ("pkg", "apt-get", "apt"):
        if shutil.which(bin_name):
            return bin_name
    return "apt"


def download_url(cwd: str, url: str, dir: Optional[str] = None) -> Dict[str, Any]:
    if not url or not str(url).strip() or not re.match(r"^https?://", str(url).strip(), re.I):
        return _fail(command="download_url", stderr="Invalid URL. Provide a valid http(s) address.", cwd=cwd)
    try:
        if dir:
            target_dir = str(resolve_within(cwd, dir, allow_root=True))
        else:
            target_dir = config_mod.get("download_dir")
        os.makedirs(target_dir, exist_ok=True)
        res = Downloader.download(str(url).strip(), dir=target_dir)
        kind = res.get("kind", "file")
        note = "\n(contents extracted into that folder)" if res.get("extracted") else ""
        return _ok(
            command=f'download_url("{url}")',
            stdout=f"downloaded {kind} → {res['path']}{note}",
            cwd=cwd,
        )
    except Exception as exc:
        return _fail(command="download_url", stderr=str(exc), cwd=cwd)


def todo_add(cwd: str, text: str) -> Dict[str, Any]:
    err = add_todo(cwd, text)
    if err.get("error"):
        return _fail(command=f'todo_add("{text}")', stderr=err["error"], cwd=cwd)
    return _ok(command=f'todo_add("{text}")', stdout=format_todos(load_todos(cwd)), cwd=cwd)


def todo_list(cwd: str) -> Dict[str, Any]:
    try:
        return _ok(command="todo_list", stdout=format_todos(load_todos(cwd)), cwd=cwd)
    except Exception as exc:
        return _fail(command="todo_list", stderr=str(exc), cwd=cwd)


def todo_update(cwd: str, index, done: Optional[bool] = None, text: Optional[str] = None) -> Dict[str, Any]:
    try:
        idx = int(index)
    except (TypeError, ValueError):
        return _fail(command=f"todo_update({index})", stderr=f"Invalid todo index: {index}", cwd=cwd)
    err = update_todo(cwd, idx, done=done, text=text)
    if err.get("error"):
        return _fail(command=f"todo_update({idx})", stderr=err["error"], cwd=cwd)
    return _ok(command=f"todo_update({idx})", stdout=format_todos(load_todos(cwd)), cwd=cwd)


def todo_clear(cwd: str) -> Dict[str, Any]:
    try:
        clear_todos(cwd)
        return _ok(command="todo_clear", stdout="(no todos yet)", cwd=cwd)
    except Exception as exc:
        return _fail(command="todo_clear", stderr=str(exc), cwd=cwd)


# ---------------------------------------------------------------------- #
# Dispatch registry
# ---------------------------------------------------------------------- #

TOOL_EXECUTORS: Dict[str, Callable[..., Dict[str, Any]]] = {
    "run_command": lambda ex, p: ex.run_command(p["command"]),
    "create_file": lambda ex, p: create_file(ex.cwd, p["path"], p.get("content", "")),
    "create_directory": lambda ex, p: create_directory(ex.cwd, p["path"]),
    "read_file": lambda ex, p: read_file(ex.cwd, p["path"]),
    "list_directory": lambda ex, p: list_directory(ex.cwd, p.get("path", ".")),
    "delete_file": lambda ex, p: delete_file(ex.cwd, p["path"]),
    "download_url": lambda ex, p: download_url(ex.cwd, p.get("url"), p.get("dir")),
    "todo_add": lambda ex, p: todo_add(ex.cwd, (p or {}).get("text")),
    "todo_list": lambda ex, p: todo_list(ex.cwd),
    "todo_update": lambda ex, p: todo_update(ex.cwd, (p or {}).get("index"), (p or {}).get("done"), (p or {}).get("text")),
    "todo_clear": lambda ex, p: todo_clear(ex.cwd),
}


def make_executor(cwd: Optional[Union[str, Path]] = None, timeout_ms: Optional[int] = None) -> SafeCommandExecutor:
    return SafeCommandExecutor(cwd=cwd, timeout_ms=timeout_ms)


def dispatch_tool(executor: SafeCommandExecutor, call: Dict[str, Any]) -> Dict[str, Any]:
    fn = TOOL_EXECUTORS.get(call.get("name"))
    if not fn:
        return tool_result(
            command=call.get("name", "(unknown tool)"),
            stderr=f'Unknown tool {call.get("name")}.',
            cwd=executor.cwd,
        )
    return fn(executor, call.get("params", {}))
