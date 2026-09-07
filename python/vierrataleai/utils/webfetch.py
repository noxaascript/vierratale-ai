import gzip
import html as html_mod
import json
import re
import urllib.error
import urllib.parse
import urllib.request
import zlib
from html.parser import HTMLParser
from typing import Dict, Optional

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
_ALT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15"
)
MAX_BYTES = 200000
MAX_TEXT = 8000

_TEXT_BLOCK_TAGS = {
    "script", "style", "noscript", "svg", "head", "title",
    "nav", "footer", "aside", "iframe", "form", "button",
    "template", "object",
}
_BLOCK_TAGS = {
    "p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
    "li", "tr", "br", "section", "article", "table", "ul", "ol",
    "blockquote", "pre",
}

_BLOCK_MARKERS = (
    "just a moment",
    "client challenge",
    "checking your browser",
    "enable javascript and cookies",
    "verify you are human",
    "challenge-platform",
    "attention required!",
    "unusual traffic",
    "access denied",
    "too many requests",
    "cf-error-details",
    "atomic challenge",
    "incapsula",
    "rh-captcha",
    "privacy pass",
    "error code: 1020",
)

ASSET_TYPES = {
    "pdf": "pdf", "zip": "zip", "tar": "tar", "gz": "gz", "7z": "7z", "rar": "rar",
    "doc": "doc", "docx": "docx", "xls": "xls", "xlsx": "xlsx", "ppt": "ppt", "pptx": "pptx",
    "mp3": "mp3", "mp4": "mp4", "wav": "wav", "ogg": "ogg", "webm": "webm", "mov": "mov",
    "csv": "csv", "json": "json", "ipynb": "ipynb", "txt": "txt", "md": "md",
    "png": "png", "jpg": "jpg", "jpeg": "jpeg", "gif": "gif", "webp": "webp", "svg": "svg", "ico": "ico",
    "py": "py", "js": "js", "ts": "ts", "sh": "sh",
}


def detect_asset_type(url: str):
    m = re.search(r"\.([a-z0-9]+)(?:[?#].*)?$", url, re.I)
    if not m:
        return None
    return ASSET_TYPES.get(m.group(1).lower())


def _browser_headers(accept="text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"):
    json_req = str(accept).startswith("application/json")
    return {
        "User-Agent": UA,
        "Accept": accept,
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Accept-Encoding": "gzip, deflate",
        "Sec-Fetch-Dest": "empty" if json_req else "document",
        "Sec-Fetch-Mode": "cors" if json_req else "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?0" if json_req else "?1",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }


def _alt_headers():
    h = _browser_headers()
    h["User-Agent"] = _ALT_UA
    return h


def _decode_gzip_body(raw: bytes) -> bytes:
    try:
        return gzip.decompress(raw)
    except Exception:
        return raw


def _deflate_body(raw: bytes) -> bytes:
    try:
        return zlib.decompress(raw)
    except Exception:
        try:
            return zlib.decompress(raw, -zlib.MAX_WBITS)
        except Exception:
            return raw


def _read_body(resp) -> bytes:
    raw = resp.read(MAX_BYTES)
    encoding = (resp.headers.get("Content-Encoding") or "").lower()
    if "gzip" in encoding:
        raw = _decode_gzip_body(raw)
    elif "deflate" in encoding:
        raw = _deflate_body(raw)
    return raw


def _blocked(body: str) -> bool:
    s = (body or "")[:4000].lower()
    return any(marker in s for marker in _BLOCK_MARKERS)


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if self._skip_depth and tag in _TEXT_BLOCK_TAGS:
            self._skip_depth += 1
            return
        if tag in _TEXT_BLOCK_TAGS:
            self._skip_depth = 1
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in _TEXT_BLOCK_TAGS:
            if self._skip_depth:
                self._skip_depth -= 1
            return
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip_depth:
            text = re.sub(r"[ \t]+", " ", data)
            if text.strip() or text.strip("\n") == "\n":
                self.parts.append(text)


def _strip_tags(text: str) -> str:
    s = re.sub(r"<[^>]*>", "", str(text or ""))
    s = html_mod.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


class WebFetch:
    @staticmethod
    def normalize_url(raw: str) -> Optional[str]:
        raw = (raw or "").strip()
        if not raw:
            return None
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://", raw):
            # Already has an explicit scheme — must be http(s).
            if not re.match(r"^https?://", raw, re.I):
                return None
        elif not re.match(r"^https?://", raw, re.I):
            raw = "https://" + raw
        try:
            parts = urllib.parse.urlsplit(raw)
            if parts.scheme not in ("http", "https"):
                return None
            return urllib.parse.urlunsplit(parts)
        except Exception:
            return None

    @classmethod
    def fetch(cls, raw_url: str, max_text: int = MAX_TEXT) -> Dict[str, str]:
        url = cls.normalize_url(raw_url)
        if not url:
            raise ValueError("Invalid URL. Provide a valid http(s) address.")

        res = cls._get(url, _browser_headers())

        # Transport-level failure (TLS, no https) → retry plain http.
        if not res["ok"]:
            parts = urllib.parse.urlsplit(url)
            if parts.scheme == "https":
                alt = urllib.parse.urlunsplit(("http", parts.netloc, parts.path, parts.query, parts.fragment))
                if alt != url:
                    res = cls._get(alt, _browser_headers())

        # Hard wall with a challenge → one retry with a different UA.
        if res["ok"] and res["status"] in (403, 429) and _blocked(res["text"]):
            retried = cls._get(url, _alt_headers())
            if retried["ok"] and retried["status"] == 200 and not _blocked(retried["text"]):
                res = retried

        if not res["ok"]:
            registry = cls._registry_fallback(res["url"] or url, max_text)
            if registry:
                return registry
            raise RuntimeError(f"Could not reach {res['url'] or url}")

        status = res["status"]
        body_text = res["text"]
        blocked = status >= 400 or _blocked(body_text)
        if blocked:
            registry = cls._registry_fallback(res["url"] or url, max_text)
            if registry:
                return registry
        if blocked:
            raise RuntimeError(f"Request blocked (HTTP {status}) for {res['url'] or url}")

        kind = cls._classify(res["url"], res["content_type"], body_text)
        return cls._render(kind, res, body_text, max_text)

    @classmethod
    def _get(cls, url: str, headers: dict) -> Dict[str, object]:
        try:
            r = cls._fetch_bytes(url, headers)
            text = cls._decode_text(r["body"], r["content_type"])
            return {
                "ok": True, "url": r["url"], "status": r["status"],
                "content_type": r["content_type"], "body": r["body"], "text": text,
            }
        except Exception:
            return {"ok": False, "url": url}

    @classmethod
    def _fetch_bytes(cls, url: str, headers: dict, timeout: int = 15) -> Dict[str, object]:
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return {
                    "url": resp.geturl() or url,
                    "status": getattr(resp, "status", 200),
                    "content_type": (resp.headers.get("Content-Type") or "").lower(),
                    "body": _read_body(resp),
                }
        except urllib.error.HTTPError as e:
            try:
                return {
                    "url": e.geturl() or url,
                    "status": e.code,
                    "content_type": (e.headers.get("Content-Type") or "").lower(),
                    "body": _read_body(e),
                }
            finally:
                e.close()

    # --- charset-aware decoding --- #

    @staticmethod
    def _sniff_charset(content_type: str, body: bytes) -> str:
        m = re.search(r'charset=["\']?([a-z0-9._-]+)', content_type or "", re.I)
        if m:
            return m.group(1).lower()
        head = body[:2048].decode("latin1", "ignore").lower()
        meta = re.search(r'<meta[^>]+charset=["\']?\s*([a-z0-9._-]+)', head, re.I)
        if meta:
            return meta.group(1).lower()
        http_equiv = re.search(
            r'<meta[^>]+http-equiv=["\']content-type["\'][^>]+content=["\']text/html;\s*charset=([a-z0-9._-]+)',
            head, re.I,
        )
        return http_equiv.group(1).lower() if http_equiv else ""

    @classmethod
    def _bad_decode(cls, text: str, body: bytes) -> bool:
        if not text or not body:
            return False
        bad = text.count("\ufffd")
        return bad / max(1, len(body)) > 0.001

    @classmethod
    def _decode_text(cls, body: bytes, content_type: str) -> str:
        charset = cls._sniff_charset(content_type, body)
        if charset:
            try:
                return body.decode(charset, errors="replace")
            except LookupError:
                pass
        text = body.decode("utf-8", errors="replace")
        if cls._bad_decode(text, body):
            try:
                text = body.decode("windows-1252", errors="replace")
            except LookupError:
                pass
        return text

    # --- content-type classification --- #

    @staticmethod
    def _classify(url: str, content_type: str, text: str) -> str:
        meta = (str(content_type or "").split(";")[0] or "").strip().lower()
        head = (text or "")[:240].lstrip()
        if re.search(r"\bjson\b", meta) or re.search(r"\+\w*json\b", meta):
            return "json"
        if re.search(r"\b(?:rss|atom|xml)\b", meta):
            return "xml"
        if re.search(r"html", meta):
            return "html"
        if "markdown" in meta:
            return "markdown"
        if meta == "application/pdf":
            return "pdf"
        if re.match(r"^application/(?:json|x-ndjson|xml|rss|atom)", meta):
            return "json"
        if meta.startswith("text/") and "html" not in meta:
            return "text"
        if head.startswith(("{", "[")):
            return "json"
        if head.startswith("<?xml") or re.match(r"^<!DOCTYPE\s+(?!html)", head, re.I):
            return "xml"
        if re.match(r"^<!doctype html", head, re.I) or re.search(r"<html\b", head[:400], re.I):
            return "html"
        if re.match(r"^(image|video|audio|font)/", meta):
            return "binary"
        if meta.startswith("application/"):
            return "binary"
        if urllib.parse.urlsplit(url).path.lower().endswith(".pdf"):
            return "pdf"
        return "text"

    @staticmethod
    def _title_from_url(url: str) -> str:
        try:
            parts = urllib.parse.urlsplit(url)
            seg = urllib.parse.unquote(parts.path.rstrip("/").split("/")[-1]) if parts.path != "/" else ""
            base = re.sub(r"^www\.", "", parts.netloc, flags=re.I)
            if seg and not re.search(r"\.(html?|php|aspx?)$", seg, re.I):
                return base
            cleaned = re.sub(r"\.(html?|php|aspx?)$", "", seg, flags=re.I).replace("-", " ").replace("_", " ").strip()
            return cleaned or base
        except Exception:
            return url

    @classmethod
    def _render(cls, kind: str, res: dict, body_text: str, max_text: int) -> Dict[str, str]:
        url = res["url"]

        if kind in ("json",):
            flat = body_text.strip()
            try:
                flat = cls._flatten_json(json.loads(body_text))
            except Exception:
                pass
            return {"url": url, "title": cls._title_from_url(url), "text": flat[:max_text], "assets": []}

        if kind == "xml":
            return {
                "url": url,
                "title": cls._title_from_url(url),
                "text": cls._xml_to_text(body_text)[:max_text],
                "assets": cls._extract_assets(body_text, url),
            }

        if kind in ("text", "markdown"):
            return {"url": url, "title": cls._title_from_url(url), "text": body_text.strip()[:max_text], "assets": []}

        if kind in ("pdf", "binary"):
            asset_type = detect_asset_type(url) or "file"
            if kind == "pdf":
                asset_type = "pdf"
            return {
                "url": url,
                "title": cls._title_from_url(url),
                "text": cls._binary_note(res, kind, asset_type),
                "assets": [{"url": url, "name": cls._asset_name(url, asset_type), "type": asset_type}],
            }

        # HTML
        desc = cls._extract_description(body_text)
        text = cls._extract_text(body_text)
        if len(text) < 2400 and len(text) < max_text:
            embedded = cls._extract_embedded_json(body_text)
            if embedded is not None:
                flat = cls._flatten_json(embedded).strip()
                if flat:
                    text = f"{text}\n\n[embedded page data]\n{flat}".strip()
            links = cls._extract_links(body_text, url)
            if len(links) >= 3 and len(text) < 2400:
                entries = "\n".join(f"- {l['text']}: {l['url']}" for l in links[:25])
                text = f"{text}\n\n[Links on page]\n{entries}".strip()
        out = text[:max_text]
        if desc and len(out) < max_text - 600 and desc[:40] not in out:
            out = f"{desc[:400]}\n\n{out}"
        title = cls._extract_title(body_text) or cls._title_from_url(url)
        return {"url": url, "title": title, "text": out, "assets": cls._extract_assets(body_text, url)}

    @staticmethod
    def _binary_note(res: dict, kind: str, asset_type: str) -> str:
        ct = res["content_type"] or "unknown content type"
        size = f"~{(len(res.get('body') or b'')) / 1024:.1f} KB" if res.get("body") else "?"
        kind_word = "PDF" if kind == "pdf" else "binary/non-text file"
        extra = f" (type: {asset_type})" if asset_type != "file" else ""
        return (
            f"This resource is a {kind_word} ({ct}, {size}) and cannot be read as text.\n"
            f"Use the download_url tool to save it locally: {res['url']}{extra}"
        )

    @classmethod
    def _flatten_json(cls, data, max_lines: int = 600) -> str:
        out = []

        def walk(v, label=""):
            if len(out) >= max_lines:
                return
            if v is None:
                if label:
                    out.append(f"{label}: null")
                return
            if isinstance(v, list):
                if label:
                    out.append(f"{label} ({len(v)})")
                for i, item in enumerate(v):
                    walk(item, f"{label}[{i}]" if label else f"[{i}]")
            elif isinstance(v, dict):
                if label:
                    out.append(f"{label} {{{len(v)}}}")
                for k, val in v.items():
                    walk(val, f"{label}.{k}" if label else k)
            else:
                s = re.sub(r"\s+", " ", v).strip() if isinstance(v, str) else str(v)
                out.append(f"{label}: {s[:400]}" if label else s[:400])

        walk(data)
        return "\n".join(out)

    # --- XML / feeds / sitemaps --- #

    @classmethod
    def _xml_to_text(cls, xml: str) -> str:
        doc = (xml or "").lstrip()
        if re.search(r"<(?:sitemapindex|urlset)\b", doc, re.I):
            locs = []
            for m in re.finditer(r"<(?:[a-z][\w.-]*:)?loc(?:[^>]*)>([\s\S]*?)</(?:[a-z][\w.-]*:)?loc>", xml, re.I):
                u = _strip_tags(m.group(1))
                if u and re.match(r"^https?://", u, re.I) and u not in locs:
                    locs.append(u)
                if len(locs) >= 100:
                    break
            if locs:
                return f"Sitemap ({len(locs)} URLs)\n" + "\n".join(f"* {u}" for u in locs[:60])
        if re.search(r"<(?:rss|feed)\b", doc, re.I):
            return cls._feed_to_text(xml)
        return cls._extract_text(xml)[:MAX_TEXT]

    @classmethod
    def _feed_to_text(cls, xml: str) -> str:
        lines = []
        top = re.search(
            r"<(?:[a-z][\w.-]*:)?(channel|feed)[\s\S]*?</(?:[a-z][\w.-]*:)?\1>", xml, re.I
        )
        title = ""
        if top:
            t = re.search(r"<(?:[a-z][\w.-]*:)?title(?:[^>]*)>([\s\S]*?)</(?:[a-z][\w.-]*:)?title>", top.group(0), re.I)
            if t:
                title = _strip_tags(t.group(1))
        if title:
            lines.append(title)

        count = 0
        for m in re.finditer(
            r"<(?:[a-z][\w.-]*:)?(item|entry)[\s\S]*?</(?:[a-z][\w.-]*:)?\1>", xml, re.I
        ):
            if count >= 40:
                break
            b = m.group(0)
            count += 1
            it = re.search(r"<(?:[a-z][\w.-]*:)?title(?:[^>]*)>([\s\S]*?)</(?:[a-z][\w.-]*:)?title>", b, re.I)
            il = re.search(r"<(?:[a-z][\w.-]*:)?link(?:[^>]*)>([\s\S]*?)</(?:[a-z][\w.-]*:)?link>", b, re.I) or \
                 re.search(r"<(?:[a-z][\w.-]*:)?link(?:[^>]*)\bhref=[\"']([^\"']+)[\"']", b, re.I)
            di = re.search(r"<(?:[a-z][\w.-]*:)?(?:description|summary|subtitle)(?:[^>]*)>([\s\S]*?)</(?:[a-z][\w.-]*:)?(?:description|summary|subtitle)>", b, re.I)
            item = []
            if it:
                item.append(_strip_tags(it.group(1)))
            if il:
                item.append("  " + _strip_tags(il.group(1)))
            if di and di.group(1).strip():
                d = _strip_tags(di.group(1))
                if d:
                    item.append(f"  {d}")
            if item:
                lines.append("\n".join(item))

        if not lines:
            return cls._extract_text(xml)[:MAX_TEXT]
        return "\n\n".join(lines)

    # --- SPA / embedded JSON --- #

    @classmethod
    def _extract_embedded_json(cls, html_text: str):
        nxt = re.search(r"<script[^>]+id=[\"']__NEXT_DATA__[\"'][^>]*>([\s\S]*?)</script>", html_text, re.I)
        if nxt and nxt.group(1).strip():
            try:
                return json.loads(nxt.group(1).strip())
            except Exception:
                pass
        for m in re.finditer(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>([\s\S]*?)</script>", html_text, re.I):
            if not m.group(1).strip():
                continue
            try:
                return json.loads(m.group(1).strip())
            except Exception:
                continue
        st = re.search(r"window\.__PRELOADED_STATE__\s*=", html_text, re.I)
        if st:
            i = st.end()
            start = i
            depth = 0
            while i < len(html_text):
                ch = html_text[i]
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        break
                i += 1
            if depth == 0:
                try:
                    return json.loads(html_text[start:i + 1].rstrip().rstrip(";").strip())
                except Exception:
                    pass
        return None

    @staticmethod
    def _extract_description(html_text: str) -> str:
        m1 = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']*)["\'][^>]*>', html_text, re.I)
        if m1:
            return _strip_tags(m1.group(1))
        m2 = re.search(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+name=["\']description["\'][^>]*>', html_text, re.I)
        return _strip_tags(m2.group(1)) if m2 else ""

    @classmethod
    def _extract_links(cls, html_text: str, base_url: str):
        links = []
        seen = set()
        for m in re.finditer(r'<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', html_text, re.I | re.S):
            href = m.group(1).strip().split("#")[0]
            if not href or re.match(r"^(javascript|mailto|tel|data):", href, re.I):
                continue
            try:
                resolved = urllib.parse.urljoin(base_url, href)
                parts = urllib.parse.urlsplit(resolved)
                if parts.scheme not in ("http", "https"):
                    continue
            except Exception:
                continue
            if resolved in seen:
                continue
            seen.add(resolved)
            text = _strip_tags(m.group(2))[:80]
            links.append({"text": text or resolved, "url": resolved})
            if len(links) >= 30:
                break
        return links

    # --- Registry fallback (npm + PyPI) via their open JSON APIs ---------- #

    @classmethod
    def _registry_fallback(cls, url: str, max_text: int):
        spec = cls._npm_spec(url)
        if spec:
            try:
                return cls._npm_fallback(spec, url, max_text)
            except Exception:
                pass
        spec = cls._pypi_spec(url)
        if spec:
            try:
                return cls._pypi_fallback(spec, url, max_text)
            except Exception:
                pass
        return None

    @staticmethod
    def _npm_spec(url: str) -> Optional[str]:
        m = re.search(r"npmjs\.\w+/package/([@a-zA-Z0-9._~-]+(?:/[@a-zA-Z0-9._~-]+)?)", url, re.I)
        return m.group(1) if m else None

    @staticmethod
    def _pypi_spec(url: str) -> Optional[str]:
        m = re.search(r"pypi\.org/project/([a-zA-Z0-9._-]+)", url, re.I)
        return m.group(1) if m else None

    @classmethod
    def _fetch_json(cls, api_url: str) -> dict:
        req = urllib.request.Request(api_url, headers=_browser_headers("application/json"))
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(_read_body(resp).decode("utf-8", errors="replace"))

    @classmethod
    def _npm_fallback(cls, spec: str, page_url: str, max_text: int) -> Dict[str, str]:
        pkg = urllib.parse.quote(spec, safe="")  # '@vierratale/ai' -> %40vierratale%2Fai
        data = cls._fetch_json(f"https://registry.npmjs.org/{pkg}")
        dist_tags = data.get("dist-tags") or {}
        version = dist_tags.get("latest") or dist_tags.get("beta") or next(iter(data.get("versions") or {}), None)
        meta = (data.get("versions") or {}).get(version) or {}
        deps = meta.get("dependencies") or data.get("dependencies") or {}
        lines = [
            f"{data.get('name')} (npm package)",
            f"Latest version: {version}",
            meta.get("description") or data.get("description") or "",
            f"License: {meta.get('license') or data.get('license') or 'N/A'}",
            f"Dependencies: {len(deps)}",
            "",
        ]
        readme = str(data.get("readme") or "").strip()
        if readme:
            lines.append(readme[:max_text])
        return {
            "url": page_url,
            "title": f"{data.get('name')} · npm",
            "text": "\n".join(l for l in lines if l)[:max_text],
        }

    @classmethod
    def _pypi_fallback(cls, spec: str, page_url: str, max_text: int) -> Dict[str, str]:
        data = cls._fetch_json(f"https://pypi.org/pypi/{urllib.parse.quote(spec)}/json")
        info = data.get("info") or {}
        lines = [
            f"{info.get('name')} (PyPI package)",
            f"Version: {info.get('version')}",
            info.get("summary") or "",
            f"Requires Python: {info.get('requires_python') or 'N/A'}",
            f"License: {info.get('license') or 'N/A'}",
            f"Home: {info.get('home_page') or info.get('project_url') or 'N/A'}",
            "",
        ]
        desc = str(info.get("description") or "").strip()
        if desc:
            lines.append(desc[:max_text])
        return {
            "url": page_url,
            "title": f"{info.get('name')} · PyPI",
            "text": "\n".join(l for l in lines if l)[:max_text],
        }

    # --- extraction ------------------------------------------------------- #

    @staticmethod
    def _extract_assets(html_text: str, base_url: str):
        found = []
        seen = set()
        refs = []
        for m in re.finditer(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>', html_text, re.I):
            refs.append((m.group(1), "a"))
        for m in re.finditer(r'<(?:img|source|video|audio|embed|iframe)[^>]+src=["\']([^"\']+)["\'][^>]*>', html_text, re.I):
            refs.append((m.group(1), "src"))
        for m in re.finditer(r'<(?:a|source)[^>]+data-(?:file|download|src)=["\']([^"\']+)["\'][^>]*>', html_text, re.I):
            refs.append((m.group(1), "data"))

        for raw, _attr in refs:
            resolved = WebFetch._resolve_asset_url(raw, base_url)
            if not resolved or resolved in seen:
                continue
            rel = raw.strip().lower()
            if rel.startswith(("tel:", "mailto:", "javascript:")):
                continue
            ptype = detect_asset_type(resolved)
            if not ptype:
                continue
            path_lower = urllib.parse.urlsplit(resolved).path.lower()
            if path_lower.endswith((".html", ".htm")):
                continue
            seen.add(resolved)
            found.append({
                "url": resolved,
                "name": WebFetch._asset_name(resolved, ptype),
                "type": ptype,
            })
            if len(found) >= 30:
                break
        found.sort(key=lambda x: x["type"])
        return found

    @staticmethod
    def _resolve_asset_url(raw: str, base_url: str):
        href = str(raw or "").strip().split("#")[0]
        if not href or href.lower().startswith("data:"):
            return None
        try:
            return urllib.parse.urljoin(base_url, href)
        except Exception:
            return None

    @staticmethod
    def _asset_name(url: str, asset_type: str):
        path = urllib.parse.urlsplit(url).path.split("/")
        name = urllib.parse.unquote(path[-1]) if path and path[-1] else ""
        if not name or asset_type == "unknown":
            host = urllib.parse.urlsplit(url).hostname or "download"
            name = re.sub(r"[^a-z0-9.-]", "_", host, flags=re.I) + "." + asset_type
        if "." not in name:
            name += "." + asset_type
        return name[:120]

    @staticmethod
    def _extract_title(html_text: str) -> str:
        m = re.search(r"<title[^>]*>([^<]*)</title>", html_text, re.I)
        return html_mod.unescape(m.group(1)).strip() if m else ""

    @classmethod
    def _extract_text(cls, html_text: str) -> str:
        s = re.sub(r"<!--[\s\S]*?-->", " ", html_text or "")
        parser = _TextExtractor()
        try:
            parser.feed(s)
        except Exception:
            pass
        text = "".join(parser.parts)
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r" *\n *", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()