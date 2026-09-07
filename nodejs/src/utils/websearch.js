const GOOGLE_SEARCH = 'https://www.google.com/search';
const STARTPAGE_SEARCH = 'https://www.startpage.com/sp/search';
const DDG_SEARCH = 'https://html.duckduckgo.com/html/';
const WIKI_SEARCH = 'https://en.wikipedia.org/w/api.php';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const GOOGLE_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
  Cookie: 'CONSENT=YES+cb.20220419-07-p0.en+FX+700; SOCS=CAISEwgDEgk0NzU3NTA3MjQaBwgAARICIAA',
};
const STARTPAGE_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function isBlockedBody(html) {
  const s = String(html || '').slice(0, 5000).toLowerCase();
  return /enablejs|sorry\/index|unusual traffic|recaptcha|captcha|proof.?of.?work|just a moment|browser check/.test(s);
}

function isStartpageChallenge(body) {
  return /challenge|"difficulty"|"issuedAt"/.test(String(body || '').slice(0, 3000));
}

function stripTags(text) {
  const map = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#039;': "'", '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
    '&#x27;': "'", '&hellip;': '...', '&#8211;': '-', '&#8217;': "'",
  };
  return String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-zA-Z0-9#]+;/g, (m) => map[m] ?? '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function decodeGoogleUrl(url) {
  if (!url) return url;
  if (url.startsWith('/url?')) {
    const m = url.match(/[?&]q=([^&]+)/);
    return m ? safeDecode(m[1]) : url;
  }
  if (url.startsWith('/') ) return url;
  return safeDecode(url);
}

function safeDecode(s) {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' '));
  } catch {
    return String(s);
  }
}

export class WebSearch {
  static async search(query, maxResults = 5) {
    const results = await this._searchGoogle(query, maxResults);
    if (results.length > 0) return results;

    const startpage = await this._searchStartpage(query, maxResults);
    if (startpage.length > 0) return startpage.map((r) => ({ ...r, source: 'google' }));

    const ddg = await this._searchDuckDuckGo(query, maxResults);
    if (ddg.length > 0) return ddg;

    return this._searchWikipedia(query, maxResults);
  }

  static async _searchGoogle(query, maxResults) {
    const url = `${GOOGLE_SEARCH}?q=${encodeURIComponent(query)}&num=${Math.max(maxResults, 5)}&hl=en&gl=us&udm=14`;
    try {
      const resp = await fetch(url, {
        headers: GOOGLE_HEADERS,
        signal: AbortSignal.timeout(12000),
        redirect: 'follow',
      });
      if (!resp.ok) return [];
      const html = await resp.text();
      if (isBlockedBody(html) || isStartpageChallenge(html)) return [];
      return this._parseGoogle(html, maxResults);
    } catch {
      return [];
    }
  }

  static async _searchStartpage(query, maxResults) {
    try {
      const cookie = await this._startpageCookie();
      const resp = await fetch(STARTPAGE_SEARCH, {
        method: 'POST',
        headers: {
          ...STARTPAGE_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookie,
        },
        body: `query=${encodeURIComponent(query)}&cat=web&language=english&privacy_preference=0`,
        signal: AbortSignal.timeout(12000),
        redirect: 'follow',
      });
      if (!resp.ok) return [];
      const html = await resp.text();
      if (isBlockedBody(html) || isStartpageChallenge(html)) return [];
      return this._parseStartpage(html, maxResults);
    } catch {
      return [];
    }
  }

  static async _startpageCookie() {
    try {
      const home = await fetch('https://www.startpage.com/', {
        headers: STARTPAGE_HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      const cookies = home.headers.getSetCookie ? home.headers.getSetCookie() : [home.headers.get('set-cookie')].filter(Boolean);
      return cookies.map((c) => c.split(';')[0]).join('; ');
    } catch {
      return '';
    }
  }

  static _parseGoogle(html, maxResults) {
    const out = [];
    const seen = new Set();
    const resultRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(?:(?!<\/a>).)*?<h3[^>]*>(.*?)<\/h3>(?:(?!<\/a>).)*?<\/a>/gis;
    let m;
    while ((m = resultRegex.exec(html)) !== null && out.length < maxResults) {
      let url = decodeGoogleUrl(m[1]);
      if (!url || !/^https?:/.test(url)) continue;
      const title = stripTags(m[2]);
      if (!title || seen.has(url)) continue;
      const after = html.slice(resultRegex.lastIndex, resultRegex.lastIndex + 2000);
      const snippet = this._snippetAfter(after);
      seen.add(url);
      out.push({ title, url, snippet, source: 'google' });
    }
    return out;
  }

  static _snippetAfter(after) {
    const vwi = after.match(/<div[^>]*class=["']VwiC3b[^"']*["'][^>]*>([\s\S]{0,500}?)<\/div>/);
    if (vwi) {
      const text = stripTags(vwi[1]);
      if (text) return text.slice(0, 300);
    }
    const span = after.match(/<span[^>]*>([\s\S]{0,500}?)<\/span>/);
    if (span) {
      const text = stripTags(span[1]);
      if (text) return text.slice(0, 300);
    }
    const byline = after.slice(0, 1200).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return byline.slice(0, 300);
  }

  static _parseStartpage(html, maxResults) {
    const out = [];
    const seen = new Set();
    const linkRegex = /<a[^>]+href="((?:https?:)?\/\/[^"]+)"[^>]*>(?:(?!<\/a>).)*?<h3[^>]*>(.*?)<\/h3>(?:(?!<\/a>).)*?<\/a>/gis;
    let m;
    while ((m = linkRegex.exec(html)) !== null && out.length < maxResults) {
      let url = m[1];
      if (url.startsWith('//')) url = 'https:' + url;
      if (!url.startsWith('http') || /startpage\.com|google\.com/.test(url)) continue;
      const title = stripTags(m[2]);
      if (!title || seen.has(url)) continue;
      const after = html.slice(linkRegex.lastIndex);
      const snippet = this._snippetAfter(after);
      seen.add(url);
      out.push({ title, url, snippet, source: 'google' });
    }
    if (out.length > 0) return out;
    return this._parseStartpageOlder(html, maxResults);
  }

  static _parseStartpageOlder(html, maxResults) {
    const out = [];
    const blocks = html.split(/<section class="w-gl__result"|class="result"/gi).slice(1);
    for (const block of blocks.slice(0, maxResults)) {
      const a = block.match(/href="((?:https?:)?\/\/[^"]+)"/);
      const t = block.match(/<h3[^>]*>(.*?)<\/h3>/s);
      if (!a || !t) continue;
      let url = a[1];
      if (url.startsWith('//')) url = 'https:' + url;
      const snippet = stripTags(block).slice(0, 300);
      out.push({ title: stripTags(t[1]), url, snippet, source: 'google' });
    }
    return out;
  }

  static async _searchDuckDuckGo(query, maxResults) {
    const url = `${DDG_SEARCH}?q=${encodeURIComponent(query)}`;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return [];
      return this._parseDuckDuckGo(await resp.text(), maxResults);
    } catch {
      return [];
    }
  }

  static _parseDuckDuckGo(html, maxResults) {
    const results = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi;
    let match;
    let count = 0;
    while ((match = resultRegex.exec(html)) !== null && count < maxResults) {
      let url = match[1];
      const snippet = stripTags(match[3] || '');
      const title = stripTags(match[2] || '');
      url = this._decodeDdgUrl(url);
      if (url && !url.includes('duckduckgo.com/y.js')) {
        results.push({ title, url, snippet, source: 'duckduckgo' });
        count++;
      }
    }
    return results;
  }

  static _decodeDdgUrl(url) {
    const match = url.match(/uddg=([^&]+)/);
    return match ? safeDecode(match[1]) : url;
  }

  static async _searchWikipedia(query, maxResults) {
    const params = new URLSearchParams({
      action: 'query',
      list: 'search',
      srsearch: query,
      srlimit: String(maxResults),
      format: 'json',
      utf8: '1',
    });
    const url = `${WIKI_SEARCH}?${params.toString()}`;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      const search = data?.query?.search || [];
      return search.map((r) => ({
        title: r.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
        snippet: stripTags(r.snippet || ''),
        source: 'wikipedia',
      }));
    } catch {
      return [];
    }
  }
}