import re
import html as html_mod
import json
import urllib.request
import urllib.parse
import http.cookiejar
from typing import List, Dict

GOOGLE_SEARCH = "https://www.google.com/search"
STARTPAGE_SEARCH = "https://www.startpage.com/sp/search"
DDG_SEARCH = "https://html.duckduckgo.com/html/"
WIKI_SEARCH = "https://en.wikipedia.org/w/api.php"

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
GOOGLE_HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
    "Cookie": "CONSENT=YES+cb.20220419-07-p0.en+FX+700; SOCS=CAISEwgDEgk0NzU3NTA3MjQaBwgAARICIAA",
}
STARTPAGE_HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


class WebSearch:
    @classmethod
    def search(cls, query: str, max_results: int = 5) -> List[Dict[str, str]]:
        results = cls._search_google(query, max_results)
        if results:
            return results

        startpage = cls._search_startpage(query, max_results)
        if startpage:
            for r in startpage:
                r["source"] = "google"
            return startpage

        results = cls._search_duckduckgo(query, max_results)
        if results:
            return results

        return cls._search_wikipedia(query, max_results)

    # ---- Google (primary) ----
    @classmethod
    def _search_google(cls, query: str, max_results: int) -> List[Dict[str, str]]:
        url = f"{GOOGLE_SEARCH}?q={urllib.parse.quote(query)}&num={max(max_results, 5)}&hl=en&gl=us&udm=14"
        try:
            html_text = cls._fetch(url, GOOGLE_HEADERS)
            if is_blocked_body(html_text) or is_startpage_challenge(html_text):
                return []
            return cls._parse_google(html_text, max_results)
        except Exception:
            return []

    @staticmethod
    def _parse_google(html_text: str, max_results: int) -> List[Dict[str, str]]:
        results = []
        seen = set()
        pattern = re.compile(
            r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(?:(?!</a>).)*?<h3[^>]*>(.*?)</h3>(?:(?!</a>).)*?</a>',
            re.I | re.S,
        )
        for m in pattern.finditer(html_text):
            if len(results) >= max_results:
                break
            url = decode_google_url(m.group(1))
            if not url or not re.match(r"^https?:", url):
                continue
            title = WebSearch._strip_tags(m.group(2))
            if not title or url in seen:
                continue
            after = html_text[m.end() : m.end() + 2000]
            snippet = WebSearch._snippet_after(after)
            seen.add(url)
            results.append({"title": title, "url": url, "snippet": snippet, "source": "google"})
        return results

    @staticmethod
    def _snippet_after(after: str) -> str:
        vwi = re.search(r'<div[^>]*class=["\']VwiC3b[^"\']*["\'][^>]*>([\s\S]{0,500}?)</div>', after)
        if vwi:
            text = WebSearch._strip_tags(vwi.group(1))
            if text:
                return text[:300]
        span = re.search(r"<span[^>]*>([\s\S]{0,500}?)</span>", after)
        if span:
            text = WebSearch._strip_tags(span.group(1))
            if text:
                return text[:300]
        byline = WebSearch._strip_tags(after[:1200])
        return byline[:300]

    # ---- Startpage (Google-powered fallback) ----
    @classmethod
    def _startpage_cookie(cls) -> str:
        try:
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            opener.open(urllib.request.Request("https://www.startpage.com/", headers=STARTPAGE_HEADERS), timeout=8)
            return "; ".join(c.name + "=" + c.value for c in opener.handlers[1].cj if hasattr(opener.handlers[1], "cj"))
        except Exception:
            return ""

    @classmethod
    def _search_startpage(cls, query: str, max_results: int) -> List[Dict[str, str]]:
        try:
            cookie = cls._startpage_cookie()
            body = urllib.parse.urlencode({
                "query": query, "cat": "web", "language": "english", "privacy_preference": "0",
            }).encode()
            headers = dict(STARTPAGE_HEADERS)
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            if cookie:
                headers["Cookie"] = cookie
            req = urllib.request.Request(STARTPAGE_SEARCH, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=12) as resp:
                html_text = resp.read().decode("utf-8", errors="ignore")
            if is_blocked_body(html_text) or is_startpage_challenge(html_text):
                return []
            return cls._parse_startpage(html_text, max_results)
        except Exception:
            return []

    @staticmethod
    def _parse_startpage(html_text: str, max_results: int) -> List[Dict[str, str]]:
        results = []
        seen = set()
        pattern = re.compile(
            r'<a[^>]+href="((?:https?:)?//[^"]+)"[^>]*>(?:(?!</a>).)*?<h3[^>]*>(.*?)</h3>(?:(?!</a>).)*?</a>',
            re.I | re.S,
        )
        for m in pattern.finditer(html_text):
            if len(results) >= max_results:
                break
            url = m.group(1)
            if url.startswith("//"):
                url = "https:" + url
            if not url.startswith("http") or re.search(r"startpage\.com|google\.com", url):
                continue
            title = WebSearch._strip_tags(m.group(2))
            if not title or url in seen:
                continue
            after = html_text[m.end() : m.end() + 2000]
            snippet = WebSearch._snippet_after(after)
            seen.add(url)
            results.append({"title": title, "url": url, "snippet": snippet, "source": "google"})
        if results:
            return results
        return WebSearch._parse_startpage_older(html_text, max_results)

    @staticmethod
    def _parse_startpage_older(html_text: str, max_results: int) -> List[Dict[str, str]]:
        results = []
        blocks = re.split(r'<section class="w-gl__result"|class="result"', html_text, flags=re.I)[1:]
        for block in blocks[:max_results]:
            a = re.search(r'href="((?:https?:)?//[^"]+)"', block)
            t = re.search(r"<h3[^>]*>(.*?)</h3>", block, re.S)
            if not a or not t:
                continue
            url = a.group(1)
            if url.startswith("//"):
                url = "https:" + url
            results.append({
                "title": WebSearch._strip_tags(t.group(1)),
                "url": url,
                "snippet": WebSearch._strip_tags(block)[:300],
                "source": "google",
            })
        return results

    # ---- DuckDuckGo ----
    @classmethod
    def _search_duckduckgo(cls, query: str, max_results: int) -> List[Dict[str, str]]:
        url = DDG_SEARCH + "?q=" + urllib.parse.quote(query)
        try:
            html_text = cls._fetch(url, {"User-Agent": UA})
        except Exception:
            return []
        return cls._parse_duckduckgo(html_text, max_results)

    @classmethod
    def _parse_duckduckgo(cls, html_text: str, max_results: int) -> List[Dict[str, str]]:
        results = []
        pattern = re.compile(
            r'<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>'
            r'[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)</a>'
        )
        count = 0
        for match in pattern.finditer(html_text):
            if count >= max_results:
                break
            raw_url = match.group(1)
            title = cls._strip_tags(match.group(2))
            snippet = cls._strip_tags(match.group(3))
            url = cls._decode_ddg_url(raw_url)
            if url and "duckduckgo.com/y.js" not in url:
                results.append({"title": title, "url": url, "snippet": snippet, "source": "duckduckgo"})
                count += 1
        return results

    # ---- Wikipedia ----
    @classmethod
    def _search_wikipedia(cls, query: str, max_results: int) -> List[Dict[str, str]]:
        params = urllib.parse.urlencode({
            "action": "query",
            "list": "search",
            "srsearch": query,
            "srlimit": max_results,
            "format": "json",
            "utf8": "1",
        })
        url = WIKI_SEARCH + "?" + params
        try:
            html_text = cls._fetch(url, {"User-Agent": UA})
            data = json.loads(html_text)
        except Exception:
            return []
        results = []
        for r in data.get("query", {}).get("search", []):
            title = r.get("title", "")
            results.append({
                "title": title,
                "url": f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}",
                "snippet": cls._strip_tags(r.get("snippet", "")),
                "source": "wikipedia",
            })
        return results

    # ---- helpers ----
    @staticmethod
    def _fetch(url: str, headers: Dict[str, str], timeout: int = 12) -> str:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            charset = resp.headers.get_content_charset() or "utf-8"
            return body.decode(charset, errors="ignore")

    @staticmethod
    def _decode_ddg_url(url: str) -> str:
        m = re.search(r"uddg=([^&]+)", url)
        if m:
            return urllib.parse.unquote(m.group(1))
        return url

    @staticmethod
    def _strip_tags(text: str) -> str:
        text = re.sub(r"<[^>]*>", "", text)
        text = html_mod.unescape(text)
        return text.strip()


def is_blocked_body(html_text: str) -> bool:
    s = (html_text or "")[:5000].lower()
    return bool(re.search(
        r"enablejs|sorry/index|unusual traffic|recaptcha|captcha|proof.?of.?work|just a moment|browser check",
        s,
    ))


def is_startpage_challenge(body: str) -> bool:
    s = (body or "")[:3000]
    return bool(re.search(r'challenge|"difficulty"|"issuedAt"', s))


def decode_google_url(url: str) -> str:
    if not url:
        return url
    if url.startswith("/url?"):
        m = re.search(r"[?&]q=([^&]+)", url)
        if m:
            try:
                return urllib.parse.unquote(m.group(1).replace("+", " "))
            except Exception:
                return m.group(1)
        return url
    if url.startswith("/"):
        return url
    try:
        return urllib.parse.unquote(url)
    except Exception:
        return url