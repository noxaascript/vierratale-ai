"""downloader.py - Downloader utility (files, folders, archives) in pure Python."""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import urllib.parse
import zipfile
import tarfile
from typing import Optional, Dict, Callable, Any

from .webfetch import UA, _browser_headers, _BLOCK_MARKERS

MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024  # 500MB cap

_ARCHIVE_RE = re.compile(r"\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|gz|bz2|7z|rar|xz)$", re.I)

_MIME_EXT = {
    "application/zip": "zip",
    "application/x-zip-compressed": "zip",
    "application/x-tar": "tar",
    "application/gzip": "gz",
    "application/x-gzip": "gz",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
    "application/json": "json",
    "text/html": "html",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
}


def _clean_name(name: str) -> str:
    name = str(name or "")
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name)
    name = re.sub(r"^\.+", "", name)
    name = re.sub(r"\.+$", "", name).strip()
    return (name or "download")[:200]


def _base_name(url: str) -> str:
    try:
        parts = urllib.parse.urlsplit(url)
        path = parts.path.rstrip("/")
        name = urllib.parse.unquote(path.split("/")[-1])
        if not name:
            host = (parts.hostname or "download").removeprefix("www.")
            return host or "download"
        return name
    except Exception:
        return "download"


def _file_name(url: str, content_type: str) -> str:
    base = _base_name(url)
    if content_type:
        ct = content_type.split(";")[0].strip().lower()
        ext = _MIME_EXT.get(ct)
        if ext and not base.lower().endswith("." + ext):
            return _clean_name(base) + "." + ext
    return _clean_name(base)


def _is_archive_url(url: str) -> bool:
    return bool(_ARCHIVE_RE.search(url.split("?")[0]))


def _join_url(base: str, rel: str):
    try:
        return urllib.parse.urljoin(base, rel)
    except Exception:
        return None


def _same_domain(a: str, b: str) -> bool:
    try:
        return urllib.parse.urlsplit(a).hostname == urllib.parse.urlsplit(b).hostname
    except Exception:
        return False


def _is_github_repo_url(url: str) -> bool:
    return bool(re.match(r"^https?://github\.com/[\w.-]+/[\w.-]+", url, re.I))


def _extract_archive(archive_path: str, dest_dir: str) -> None:
    os.makedirs(dest_dir, exist_ok=True)
    lower = str(archive_path).lower()
    try:
        if lower.endswith(".zip"):
            with zipfile.ZipFile(archive_path) as zf:
                for member in zf.infolist():
                    name = member.filename.replace("\\", "/")
                    target = os.path.join(dest_dir, *name.split("/"))
                    if not target.startswith(os.path.abspath(dest_dir)):
                        raise ValueError(f"Unsafe member in zip: {member.filename}")
                zf.extractall(dest_dir)
        elif any(lower.endswith(s) for s in (".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz")):
            with tarfile.open(archive_path, "r:*") as tf:
                for member in tf.getmembers():
                    target = os.path.join(dest_dir, *member.name.replace("\\", "/").split("/"))
                    if not target.startswith(os.path.abspath(dest_dir)):
                        raise ValueError(f"Unsafe member in tar: {member.name}")
                tf.extractall(dest_dir)
        elif lower.endswith(".gz"):
            subprocess.run(["gzip", "-dkf", archive_path], check=True)
        elif lower.endswith(".7z"):
            subprocess.run(["7z", "x", archive_path, f"-o{dest_dir}", "-y"], check=True)
        elif lower.endswith(".rar"):
            subprocess.run(["unrar", "x", archive_path, dest_dir], check=True)
        else:
            raise ValueError(f"Cannot extract archive: {archive_path}")
    except (OSError, subprocess.CalledProcessError) as e:
        raise RuntimeError(f"Could not extract {archive_path}: {e}") from e


class Downloader:
    @staticmethod
    def _fetch(url: str, timeout: int = 30000):
        req = urllib.request.Request(url, headers=_browser_headers("*/*"))
        return urllib.request.urlopen(req, timeout=timeout / 1000)

    @classmethod
    def download_file(
        cls,
        url: str,
        dir: str = os.getcwd(),
        filename: Optional[str] = None,
        timeout: int = 30000,
        on_progress: Optional[Callable[[int], None]] = None,
    ) -> Dict[str, Any]:
        os.makedirs(dir, exist_ok=True)
        with cls._fetch(url, timeout) as resp:
            content_type = resp.headers.get("Content-Type") or ""
            final_url = resp.geturl() or url
            name = filename or _file_name(final_url, content_type)
            dest = os.path.join(dir, _clean_name(name))
            received = 0
            with open(dest, "wb") as fh:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > MAX_DOWNLOAD_BYTES:
                        raise RuntimeError(f"Download exceeded {MAX_DOWNLOAD_BYTES} byte cap")
                    fh.write(chunk)
            if on_progress:
                on_progress(received)
            return {
                "ok": True, "path": dest, "size": received,
                "content_type": content_type, "url": final_url, "name": name,
            }

    @classmethod
    def download(
        cls,
        url: str,
        dir: str = os.getcwd(),
        filename: Optional[str] = None,
        timeout: int = 30000,
        on_progress: Optional[Callable[[int], None]] = None,
        extract: bool = True,
    ) -> Dict[str, Any]:
        with cls._fetch(url, timeout) as resp:
            content_type = resp.headers.get("Content-Type") or ""
            is_html = bool(re.match(r"text/html|application/xhtml", content_type, re.I))
            is_plain = bool(re.match(r"text/plain|text/markdown|application/json|\+json|text/csv", content_type, re.I))
            final_url = resp.geturl() or url

            if is_html or is_plain:
                body = resp.read(MAX_DOWNLOAD_BYTES).decode("utf-8", errors="ignore")
                if on_progress:
                    on_progress(len(body))

                if is_html and _blocked(body):
                    raise RuntimeError("Download blocked by anti-bot protection.")

                if _is_github_repo_url(final_url):
                    return cls._download_github(final_url, dir, filename, on_progress)

                if is_html and _is_directory_listing(body):
                    return cls._download_listing(final_url, body, dir, filename, on_progress)

                name = filename or _file_name(final_url, content_type)
                dest = os.path.join(dir, _clean_name(name))
                os.makedirs(dir, exist_ok=True)
                with open(dest, "w", encoding="utf-8", errors="ignore") as fh:
                    fh.write(body)
                return {"ok": True, "path": dest, "size": len(body), "kind": "file", "url": final_url, "name": name}

            # Binary / archive stream.
            body_parts = []
            received = 0
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                received += len(chunk)
                if received > MAX_DOWNLOAD_BYTES:
                    raise RuntimeError(f"Download exceeded {MAX_DOWNLOAD_BYTES} byte cap")
                body_parts.append(chunk)
            if on_progress:
                on_progress(received)
            name = filename or _file_name(final_url, content_type)
            dest = os.path.join(dir, _clean_name(name))
            os.makedirs(dir, exist_ok=True)
            with open(dest, "wb") as fh:
                for part in body_parts:
                    fh.write(part)

            kind = "file"
            if _is_archive_url(name) or re.search(r"application/(zip|x-zip|x-tar|gzip)|multipart/x-zip", content_type, re.I):
                kind = "archive"
                if extract:
                    extract_dir = re.sub(r"\.(zip|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar|7z|rar)$", "", dest, flags=re.I)
                    _extract_archive(dest, extract_dir)
                    return {**result_base(dest, received, final_url, name), "kind": kind, "extracted": extract_dir}
            return {**result_base(dest, received, final_url, name), "kind": kind}

    @classmethod
    def _download_listing(cls, url, html, dir, filename, on_progress):
        name = filename or _clean_name(_base_name(url))
        folder_dir = os.path.join(dir, name)
        os.makedirs(folder_dir, exist_ok=True)
        count = [0]
        for href in _listing_links(html):
            resolved = _join_url(url, href)
            if not resolved or not _same_domain(url, resolved):
                continue
            is_subdir = href.endswith("/")
            file_name = _clean_name(_base_name(resolved))
            try:
                if is_subdir:
                    _download_listing_recursive(cls, resolved, os.path.join(folder_dir, file_name), on_progress, count)
                else:
                    cls.download_file(resolved, dir=folder_dir, filename=file_name, on_progress=on_progress)
                count[0] += 1
            except Exception:
                continue
        if on_progress:
            on_progress(count[0])
        return {"ok": True, "path": folder_dir, "kind": "folder", "url": url, "name": name}

    @classmethod
    def _download_github(cls, url, dir, filename, on_progress):
        zip_url = _github_zip_url(url)
        name = filename or _clean_name(_base_name(url)) or "repo"
        dest_dir = os.path.join(dir, name)
        os.makedirs(dest_dir, exist_ok=True)
        tmp = os.path.join(tempfile.gettempdir(), f"github-{os.getpid()}.zip")
        try:
            cls.download_file(zip_url, dir=tempfile.gettempdir(), filename=os.path.basename(tmp), timeout=60000, on_progress=on_progress)
            _extract_archive(tmp, dest_dir)
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        return {"ok": True, "path": dest_dir, "kind": "folder", "url": url, "name": name}


def result_base(dest, size, url, name):
    return {"ok": True, "path": dest, "size": size, "url": url, "name": name}


def _download_listing_recursive(cls, url, folder_dir, on_progress, count):
    os.makedirs(folder_dir, exist_ok=True)
    try:
        with cls._fetch(url, timeout=15000) as resp:
            content_type = resp.headers.get("Content-Type") or ""
            if not re.match(r"text/html|application/xhtml", content_type, re.I):
                return
            body = resp.read(200000).decode("utf-8", errors="ignore")
    except Exception:
        return
    if not _is_directory_listing(body):
        return
    for href in _listing_links(body):
        resolved = _join_url(url, href)
        if not resolved or not _same_domain(url, resolved):
            continue
        file_name = _clean_name(_base_name(resolved))
        try:
            if href.endswith("/"):
                _download_listing_recursive(cls, resolved, os.path.join(folder_dir, file_name), on_progress, count)
            else:
                cls.download_file(resolved, dir=folder_dir, filename=file_name, on_progress=on_progress)
            count[0] += 1
        except Exception:
            continue


def _blocked(body: str) -> bool:
    s = (body or "")[:4000].lower()
    return any(m in s for m in _BLOCK_MARKERS)


def _is_directory_listing(html: str) -> bool:
    s = str(html or "")[:20000].lower()
    has_links = "<a href=" in s
    if not has_links:
        return False
    return bool(
        re.search(r"<a[^>]+href=[^>]*>\s*\.\.[\s<]", s)
        or "index of /" in s
        or "directory listing for" in s
        or "parent directory" in s
        or re.search(r"<h1>.*listing.*</h1>", s)
    )


def _listing_links(html: str):
    out = []
    for m in re.finditer(r'<a[^>]+href\s*=\s*"([^"]+)"[^>]*>(.*?)</a>', html, re.I | re.S):
        href = m.group(1)
        if not href:
            continue
        if href.startswith(("#", "?", "javascript:")) or href.startswith("..") or href in ("/", "../"):
            continue
        out.append(href)
    return out


def _github_zip_url(url: str) -> str:
    m = re.match(r"^https?://github\.com/([\w.-]+)/([\w.-]+)", url)
    if not m:
        return url.rstrip("/") + ".zip"
    owner, repo = m.group(1), m.group(2)
    path = urllib.parse.urlsplit(url).path.rstrip("/").split("/")
    if len(path) >= 4 and path[2] == "tree" and path[3]:
        branch = "/".join(path[3:])
        return f"https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{branch}"
    if len(path) >= 5 and path[2] == "archive":
        return f"https://codeload.github.com/{owner}/{repo}/zip/{'/'.join(path[3:])}"
    return f"https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{_default_branch(owner, repo)}"


def _default_branch(owner: str, repo: str) -> str:
    import json
    try:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{owner}/{repo}",
            headers={"User-Agent": "vierrataleai-downloader", "Accept": "application/vnd.github+json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8", errors="ignore")).get("default_branch") or "main"
    except Exception:
        return "main"