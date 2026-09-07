"""Workspace file-tree rendering for the CLI.

Used after the agent creates folders/files so the user sees the resulting
structure at a glance instead of only a flat list of tool results.
"""

import os
from pathlib import Path
from typing import List

# Directories that are never worth expanding in a workspace tree.
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".cache"}


def render_file_tree(
    root_dir: str = ".",
    *,
    max_depth: int = 4,
    max_entries: int = 150,
) -> List[str]:
    """Render a compact box-drawing tree of a directory.

    Returns a list of lines starting with "." for the workspace root. Bounded
    so huge folders (node_modules, caches, download dirs, ...) can never flood
    a chat with thousands of lines.
    """
    base = Path(root_dir or os.getcwd())
    lines: List[str] = ["."]
    entries = 0

    def _walk(directory: Path, depth: int, prefix: str) -> None:
        nonlocal entries
        if entries >= max_entries:
            return
        try:
            names = sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return
        names = [p for p in names if p.name not in SKIP_DIRS]
        for i, child in enumerate(names):
            if entries >= max_entries:
                return
            last = i == len(names) - 1
            lines.append(f"{prefix}{'└── ' if last else '├── '}{child.name}")
            entries += 1
            if child.is_dir() and depth < max_depth:
                _walk(child, depth + 1, f"{prefix}{'    ' if last else '│   '}")

    _walk(base, 0, "")
    if entries >= max_entries:
        lines.append(f"… showing first {entries} entries")
    return lines