import asyncio
import os
import re
from pathlib import Path

FILE_RE = re.compile(r"^FILE:\s*(.+?)\s*$", re.IGNORECASE)
FOLDER_RE = re.compile(r"^FOLDER:\s*(.+?)\s*$", re.IGNORECASE)
FENCE_RE = re.compile(r"^```")


class FileWriter:
    @staticmethod
    def parse(text: str) -> dict:
        files = []
        folders = []
        lines = (text or "").split("\n")
        n = len(lines)
        i = 0
        while i < n:
            m = FILE_RE.match(lines[i])
            if m:
                path = m.group(1).strip()
                j = i + 1
                while j < n and lines[j].strip() == "":
                    j += 1
                if j < n and FENCE_RE.match(lines[j]):
                    start = j + 1
                    end = start
                    while end < n and not FENCE_RE.match(lines[end]):
                        end += 1
                    if end < n:
                        files.append(
                            {
                                "path": path,
                                "language": lines[j][3:].strip(),
                                "content": "\n".join(lines[start:end]),
                            }
                        )
                        i = end + 1
                        continue
            m = FOLDER_RE.match(lines[i])
            if m:
                folders.append(m.group(1).strip())
            i += 1
        return {"files": files, "folders": folders}

    @staticmethod
    def resolve_target(path: str) -> Path:
        base = Path.cwd().resolve()
        target = (base / path).resolve()
        if target != base and not str(target).startswith(str(base) + os.sep):
            raise ValueError(
                f"Refusing to write outside the working directory: {path}"
            )
        return target

    @staticmethod
    async def write(
        files=None,
        folders=None,
        overwrite: bool = False,
        confirm=None,
    ) -> list:
        files = files or []
        folders = folders or []
        results = []

        for p in folders:
            try:
                target_folder = FileWriter.resolve_target(p)
                target_folder.mkdir(parents=True, exist_ok=True)
                results.append({"kind": "folder", "path": p, "target": str(target_folder), "status": "created"})
            except Exception as err:
                results.append(
                    {"kind": "folder", "path": p, "status": "error", "error": str(err)}
                )

        for f in files:
            try:
                target = FileWriter.resolve_target(f["path"])
            except Exception as err:
                results.append(
                    {"kind": "file", "path": f["path"], "status": "error", "error": str(err)}
                )
                continue
            if target.is_dir():
                results.append(
                    {"kind": "file", "path": f["path"], "target": str(target), "status": "error", "error": "Target is a directory"}
                )
                continue
            if target.exists() and confirm:
                ok = await confirm(f"Overwrite {f['path']}?")
                if not ok:
                    results.append(
                        {"kind": "file", "path": f["path"], "target": str(target), "status": "skipped", "error": "Declined"}
                    )
                    continue
            elif target.exists() and not overwrite:
                results.append(
                    {"kind": "file", "path": f["path"], "target": str(target), "status": "skipped", "error": "File already exists"}
                )
                continue
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(f["content"], encoding="utf-8")
                results.append({"kind": "file", "path": f["path"], "target": str(target), "status": "written"})
            except Exception as err:
                results.append(
                    {"kind": "file", "path": f["path"], "target": str(target), "status": "error", "error": str(err)}
                )

        return results