"""Gather the local git working-tree changes as compact model context.

Used by the code-diff feature: when a turn is auto-routed to the coding
model, the current `git status` + diff are attached to the conversation so
the model "shares" the files it is being asked about.
"""
import os
import subprocess
from typing import List, Optional

_BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".bz2",
    ".7z", ".exe", ".dll", ".so", ".dylib", ".woff", ".woff2", ".ttf", ".ico",
    ".o", ".a", ".pyc", ".wasm", ".mp4", ".mov", ".mp3", ".wav",
}


def _run(cwd: str, args: List[str], timeout: int = 8) -> Optional[str]:
    try:
        r = subprocess.run(
            ["git", "-C", cwd, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return r.stdout if r.returncode == 0 else None
    except (subprocess.SubprocessError, OSError, ValueError):
        return None


def _inlined_untracked(path: str, cwd: str, max_chars: int) -> Optional[str]:
    ext = os.path.splitext(path)[1].lower()
    if ext in _BINARY_EXT:
        return "(binary)"
    full = os.path.join(cwd, path)
    try:
        if os.path.isdir(full):
            return None
        text = open(full, encoding="utf-8", errors="replace").read()
    except OSError:
        return None
    if len(text) <= max_chars:
        return text.rstrip()
    return text[:max_chars].rstrip() + "\n… (file truncated)"


def git_changes(
    cwd: str = ".",
    max_chars: int = 6000,
    max_untracked_files: int = 2,
    max_untracked_chars: int = 1200,
) -> Optional[str]:
    """Return the working-tree changes as a context block, or None.

    Returns None when `cwd` is not a git repository or nothing changed.
    """
    status = _run(cwd, ["status", "--porcelain"])
    if not status or not status.strip():
        return None

    lines = status.strip().splitlines()
    untracked = [
        ln[3:].strip()
        for ln in lines
        if ln.startswith("??") and not ln[3:].strip().endswith("/")
    ]

    stat = "\n".join(
        x for x in (_run(cwd, ["diff", "--stat"]), _run(cwd, ["diff", "--cached", "--stat"])) if x
    ).strip()
    diff_body = "\n".join(
        x for x in (_run(cwd, ["diff"]), _run(cwd, ["diff", "--cached"])) if x
    ).strip()

    parts = [
        "CODE TASK — the local git working tree was shared with you.",
        "",
        "Changed files:",
        *[f"- {ln}" for ln in lines[:25]],
    ]

    if untracked:
        parts += ["", "Untracked (new) files:"]
        shown = 0
        for path in untracked:
            if shown >= max_untracked_files:
                parts.append(f"- {path} (content not inlined; use the read_file tool)")
                continue
            inlined = _inlined_untracked(path, cwd, max_untracked_chars)
            if inlined is None:
                parts.append(f"- {path}")
            elif inlined == "(binary)":
                parts.append(f"- {path} (binary)")
            else:
                parts.append(f"- {path}:\n{inlined}")
                shown += 1

    if stat:
        parts += ["", "Change summary:", stat]
    if diff_body:
        parts += ["", "Diff:", diff_body]

    block = "\n".join(parts)
    if len(block) > max_chars:
        block = block[:max_chars].rstrip() + "\n… (shared diff truncated)"
    return block