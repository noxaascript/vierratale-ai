export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ALT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.4 Safari/605.1.15';

const MAX_BYTES = 200000; // 200KB cap
const MAX_TEXT = 8000;    // ~8k chars of readable text

const BLOCK_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'head', 'title',
  'nav', 'footer', 'aside', 'iframe', 'form', 'button', 'noscript',
]);

// Body markers that indicate an anti-bot wall instead of real content.
const BLOCK_MARKERS = [
  'just a moment',
  'client challenge',
  'checking your browser',
  'enable javascript and cookies',
  'verify you are human',
  'challenge-platform',
  'attention required!',
  'unusual traffic',
  'access denied',
  'too many requests',
  'cf-error-details',
  'atomic challenge',
  'incapsula',
  'rh-captcha',
  'privacy pass',
  'error code: 1020',
];

// Browser-like headers so header-based bot checks see a real browser.
export function browserHeaders(accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8') {
  return {
    'User-Agent': UA,
    Accept: accept,
    'Accept-Language': 'en-US,en;q=0.9',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': accept.startsWith('application/json') ? 'empty' : 'document',
    'Sec-Fetch-Mode': accept.startsWith('application/json') ? 'cors' : 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': accept.startsWith('application/json') ? '?0' : '?1',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
}

function altHeaders() {
  const h = browserHeaders();
  h['User-Agent'] = ALT_UA;
  return h;
}

// File types the AI can download off a fetched page.
const ASSET_TYPES = {
  pdf: 'pdf', zip: 'zip', tar: 'tar', gz: 'gz', '7z': '7z', rar: 'rar',
  doc: 'doc', docx: 'docx', xls: 'xls', xlsx: 'xlsx', ppt: 'ppt', pptx: 'pptx',
  mp3: 'mp3', mp4: 'mp4', wav: 'wav', ogg: 'ogg', webm: 'webm', mov: 'mov',
  csv: 'csv', json: 'json', ipynb: 'ipynb', txt: 'txt', md: 'md',
  png: 'png', jpg: 'jpg', jpeg: 'jpeg', gif: 'gif', webp: 'webp', svg: 'svg', ico: 'ico',
  py: 'py', js: 'js', ts: 'ts', sh: 'sh',
};
const ASSET_TYPE_RE = /\.([a-z0-9]+)(?:[?#].*)?$/i;

export function detectAssetType(url) {
  const m = ASSET_TYPE_RE.exec(url);
  if (!m) return null;
  return ASSET_TYPES[m[1].toLowerCase()] || null;
}

export function isBlockedBody(html) {
  const s = String(html || '').toLowerCase().slice(0, 4000);
  return BLOCK_MARKERS.some((m) => s.includes(m));
}

// Optional namespace prefix for XML tags (e.g. <sm:loc>).
const NSTAG = (name) => `(?:[a-z][\\w.-]*:)?${name}`;

export class WebFetch {
  static normalizeUrl(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) return null;
    let url = trimmed;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      // Already has an explicit scheme — must be http(s).
      if (!/^https?:\/\//i.test(url)) return null;
    } else if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.toString();
    } catch {
      return null;
    }
  }

  // Fetch any URL and return readable text regardless of content type.
  static async fetch(rawUrl, maxText = MAX_TEXT) {
    const url = this.normalizeUrl(rawUrl);
    if (!url) {
      throw new Error('Invalid URL. Provide a valid http(s) address.');
    }

    let res = await this._get(url, browserHeaders());

    // Transport-level failure (TLS, no https) → retry plain http.
    if (!res.ok) {
      const alt = url.replace(/^https:/i, 'http:');
      if (alt !== url) res = await this._get(alt, browserHeaders());
    }

    // Hard wall with a challenge challenge → one retry with a different UA.
    if (res.ok && (res.status === 403 || res.status === 429) && isBlockedBody(res.text)) {
      const retried = await this._get(url, altHeaders());
      if (retried.ok && retried.status === 200 && !isBlockedBody(retried.text)) res = retried;
    }

    if (!res.ok) {
      const registry = await this._registryFallback(res.url || url, maxText);
      if (registry) return registry;
      throw new Error(`Could not reach ${res.url || url}`);
    }

    const status = res.status;
    const bodyText = res.text;
    const blocked = status >= 400 || isBlockedBody(bodyText);
    if (blocked) {
      const registry = await this._registryFallback(res.url || url, maxText);
      if (registry) return registry;
    }
    if (blocked) {
      throw new Error(`Request blocked (HTTP ${status}) for ${res.url || url}`);
    }

    const kind = this._classify(res.url, res.contentType, bodyText);
    return this._render(kind, res, bodyText, maxText);
  }

  static async _get(url, headers) {
    try {
      const r = await this._fetchBytes(url, headers);
      const text = this._decodeText(r.body, r.contentType);
      return { ok: true, url: r.url, status: r.status, contentType: r.contentType, body: r.body, text };
    } catch {
      return { ok: false, url };
    }
  }

  static async _fetchBytes(url, headers) {
    let resp;
    try {
      resp = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(`Could not reach ${url}`);
    }

    const chunks = [];
    let total = 0;
    const reader = resp.body && resp.body.getReader();
    if (reader) {
      while (total < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        chunks.push(Buffer.from(value));
      }
      reader.cancel();
    }
    return {
      url: resp.url || url,
      status: resp.status,
      contentType: String(resp.headers.get('content-type') || '').toLowerCase(),
      body: Buffer.concat(chunks, total),
    };
  }

  // --- charset-aware decoding ------------------------------------------- //

  static _sniffCharset(contentType, bytes) {
    const m = /charset=(["']?)([a-z0-9._-]+)\1/i.exec(contentType || '');
    if (m) return m[2].toLowerCase();
    const head = bytes.slice(0, 2048).toString('latin1').toLowerCase();
    const meta = /<meta[^>]+charset=["']?\s*([a-z0-9._-]+)/i.exec(head);
    if (meta) return meta[1].toLowerCase();
    const httpEquiv = /<meta[^>]+http-equiv=["']content-type["'][^>]+content=["']text\/html; charset=([a-z0-9._-]+)/i.exec(head);
    return httpEquiv ? httpEquiv[1].toLowerCase() : '';
  }

  static _decodeText(bytes, contentType) {
    const charset = this._sniffCharset(contentType, bytes);
    if (charset) {
      try {
        return new TextDecoder(charset, { fatal: false }).decode(bytes);
      } catch {}
    }
    let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (this._badDecode(text, bytes)) {
      try {
        text = new TextDecoder('windows-1252', { fatal: false }).decode(bytes);
      } catch {}
    }
    return text;
  }

  static _badDecode(text, bytes) {
    if (!text || !bytes || bytes.length === 0) return false;
    let bad = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) bad++;
    return bad / bytes.length > 0.001;
  }

  // --- content-type classification --------------------------------------- //

  static _classify(url, contentType, text) {
    const meta = ((contentType || '').split(';')[0] || '').trim().toLowerCase();
    const head = (text || '').slice(0, 240).trimStart();
    if (/\bjson\b/.test(meta) || /\+\w*json\b/.test(meta)) return 'json';
    if (/\b(?:rss|atom|xml)\b/.test(meta) || meta === 'application/sitemap+xml') return 'xml';
    if (/\/xhtml\+html$/.test(meta) || /html/.test(meta)) return 'html';
    if (/markdown/.test(meta)) return 'markdown';
    if (meta === 'application/pdf') return 'pdf';
    if (/^application\/(?:json|x-ndjson|xml|rss|atom)/.test(meta)) return 'json';
    if (/^text\//.test(meta) && !/html/.test(meta)) return 'text';
    if (head.startsWith('{') || head.startsWith('[')) return 'json';
    if (head.startsWith('<?xml') || /^<!DOCTYPE\s+(?!html)/i.test(head)) return 'xml';
    if (/^<!doctype html/i.test(head) || /<html\b/i.test(head.slice(0, 400))) return 'html';
    if (/^(image|video|audio|font)\//.test(meta)) return 'binary';
    if (/^application\//.test(meta)) return 'binary';
    if (/\/pdf$/.test(url.split('?')[0].toLowerCase())) return 'pdf';
    return 'text';
  }

  static _render(kind, res, bodyText, maxText) {
    const url = res.url;

    if (kind === 'json') {
      let flat = bodyText.trim();
      try {
        flat = this._flattenJson(JSON.parse(bodyText));
      } catch {}
      return { url, title: this._titleFromUrl(url), text: flat.slice(0, maxText), assets: [] };
    }

    if (kind === 'xml') {
      return {
        url,
        title: this._titleFromUrl(url),
        text: this._xmlToText(bodyText).slice(0, maxText),
        assets: this._extractAssets(bodyText, url),
      };
    }

    if (kind === 'text' || kind === 'markdown') {
      return { url, title: this._titleFromUrl(url), text: bodyText.trim().slice(0, maxText), assets: [] };
    }

    if (kind === 'pdf' || kind === 'binary') {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        parsed = null;
      }
      let type = detectAssetType(url) || 'file';
      if (kind === 'pdf') type = 'pdf';
      return {
        url,
        title: this._titleFromUrl(url),
        text: this._binaryNote(res, kind, type),
        assets: [{ url, name: this._assetName(parsed, type), type }],
      };
    }

    // HTML
    const desc = this._extractDescription(bodyText);
    let text = this._extractText(bodyText);
    if (text.length < 2400 && text.length < maxText) {
      const embedded = this._extractEmbeddedJson(bodyText);
      if (embedded !== null && embedded !== undefined) {
        const flat = this._flattenJson(embedded).trim();
        if (flat) text = `${text}\n\n[embedded page data]\n${flat}`.trim();
      }
      const links = this._extractLinks(bodyText, url);
      if (links.length >= 3 && text.length < 2400) {
        text = `${text}\n\n[Links on page]\n${links.slice(0, 25).map((l) => `- ${l.text}: ${l.url}`).join('\n')}`.trim();
      }
    }
    let out = text.slice(0, maxText);
    if (desc && out.length < maxText - 600 && !out.includes(desc.slice(0, 40))) {
      out = `${desc.slice(0, 400)}\n\n${out}`;
    }
    let title = this._extractTitle(bodyText);
    if (!title) title = this._titleFromUrl(url);
    return { url, title, text: out, assets: this._extractAssets(bodyText, url) };
  }

  static _binaryNote(res, kind, type) {
    const ct = res.contentType || 'unknown content type';
    const size = res.body ? `~${(res.body.length / 1024).toFixed(1)} KB` : '?';
    return [
      `This resource is a ${kind === 'pdf' ? 'PDF' : 'binary/non-text file'} (${ct}, ${size}) and cannot be read as text.`,
      `Use the download_url tool to save it locally: ${res.url}${type !== 'file' ? ` (type: ${type})` : ''}`,
    ].join('\n');
  }

  static _titleFromUrl(url) {
    try {
      const u = new URL(url);
      const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      const base = u.hostname.replace(/^www\./i, '');
      if (seg && !/\.(html?|php|aspx?)$/i.test(seg)) return base;
      const cleaned = seg.replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_]+/g, ' ').trim();
      return cleaned || base;
    } catch {
      return url;
    }
  }

  static _flattenJson(data, maxLines = 600) {
    const out = [];
    const walk = (v, label) => {
      if (out.length >= maxLines) return;
      if (v === null || v === undefined) {
        if (label) out.push(`${label}: null`);
        return;
      }
      if (Array.isArray(v)) {
        if (label) out.push(`${label} (${v.length})`);
        for (let i = 0; i < v.length; i++) walk(v[i], label ? `${label}[${i}]` : `[${i}]`);
      } else if (typeof v === 'object') {
        if (label) out.push(`${label} {${Object.keys(v).length}}`);
        for (const k of Object.keys(v)) walk(v[k], label ? `${label}.${k}` : k);
      } else {
        const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : String(v);
        out.push(`${label ? label + ': ' : ''}${s.slice(0, 400)}`);
      }
    };
    walk(data, '');
    return out.join('\n');
  }

  // --- XML / feeds / sitemaps -------------------------------------------- //

  static _xmlToText(xml) {
    const doc = (xml || '').trimStart();
    if (/<sitemapindex\b/i.test(doc) || /<urlset\b/i.test(doc)) {
      const locs = [];
      const re = new RegExp(`<${NSTAG('loc')}(?:[^>]*)>([\\s\\S]*?)<\\/${NSTAG('loc')}>`, 'gi');
      let m;
      while ((m = re.exec(xml)) !== null) {
        const u = this._stripEntities(m[1]).replace(/\s+/g, ' ').trim();
        if (u && /^https?:\/\//i.test(u) && !locs.includes(u)) locs.push(u);
        if (locs.length >= 100) break;
      }
      if (locs.length) {
        return `Sitemap (${locs.length} URLs)\n${locs.slice(0, 60).map((u) => `* ${u}`).join('\n')}`;
      }
    }
    if (/<(?:rss|feed)\b/i.test(doc)) return this._feedToText(xml);
    return this._extractText(xml).slice(0, MAX_TEXT);
  }

  static _feedToText(xml) {
    const lines = [];
    const top = new RegExp(`<${NSTAG('channel')}[\\s\\S]*?<\\/${NSTAG('channel')}>|<${NSTAG('feed')}[\\s\\S]*?<\\/${NSTAG('feed')}>`, 'i');
    const topMatch = top.exec(xml);
    let title = '';
    if (topMatch) {
      const t = new RegExp(`<${NSTAG('title')}(?:[^>]*)>([\\s\\S]*?)<\\/${NSTAG('title')}>`, 'i').exec(topMatch[0]);
      if (t) title = this._stripTags(t[1]);
    }
    if (title) lines.push(title);

    const itemRe = new RegExp(`<${NSTAG('item')}[\\s\\S]*?<\\/${NSTAG('item')}>|<${NSTAG('entry')}[\\s\\S]*?<\\/${NSTAG('entry')}>`, 'gi');
    let m;
    let count = 0;
    while ((m = itemRe.exec(xml)) !== null && count < 40) {
      const b = m[0];
      count++;
      const it = new RegExp(`<${NSTAG('title')}(?:[^>]*)>([\\s\\S]*?)<\\/${NSTAG('title')}>`, 'i').exec(b);
      const il = new RegExp(`<${NSTAG('link')}(?:[^>]*)>([\\s\\S]*?)<\\/${NSTAG('link')}>`, 'i').exec(b) ||
                 new RegExp(`<${NSTAG('link')}(?:[^>]*)\\bhref=["']([^"']+)["']`, 'i').exec(b);
      const di = /<(?:[a-z][\w.-]*:)?(?:description|summary|subtitle)[^>]*>([\s\S]*?)<\/(?:[a-z][\w.-]*:)?(?:description|summary|subtitle)>/i.exec(b);
      const item = [];
      if (it) item.push(this._stripTags(it[1]));
      if (il) item.push(`  ${this._stripTags(il[1]).replace(/\s+/g, ' ').trim()}`);
      if (di && di[1].trim()) {
        const d = this._stripTags(di[1]);
        if (d) item.push(`  ${d}`);
      }
      if (item.length) lines.push(item.join('\n'));
    }
    if (lines.length === 0) return this._extractText(xml).slice(0, MAX_TEXT);
    return lines.join('\n\n');
  }

  // --- SPA / embedded JSON ------------------------------------------------ //

  static _extractEmbeddedJson(html) {
    const next = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (next && next[1].trim()) {
      try {
        return JSON.parse(next[1].trim());
      } catch {}
    }
    const ld = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let c;
    while ((c = ld.exec(html)) !== null) {
      if (!c[1].trim()) continue;
      try {
        return JSON.parse(c[1].trim());
      } catch {}
    }
    const st = /window\.__PRELOADED_STATE__\s*=\s*/i.exec(html);
    if (st) {
      let i = st.index + st[0].length;
      let depth = 0;
      const start = i;
      while (i < html.length) {
        const ch = html[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) break;
        }
        i++;
      }
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1).replace(/;?\s*$/, '').trim());
        } catch {}
      }
    }
    return null;
  }

  static _extractDescription(html) {
    const m1 = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i.exec(html);
    if (m1) return this._stripTags(m1[1]);
    const m2 = /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i.exec(html);
    return m2 ? this._stripTags(m2[1]) : '';
  }

  static _extractLinks(html, baseUrl) {
    const links = [];
    const seen = new Set();
    const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>((?:[^<]|<(?!\/a\b)[^>]+>)*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1].trim().split('#')[0];
      if (!href || /^(javascript|mailto|tel|data):/i.test(href)) continue;
      let resolved;
      try {
        const u = new URL(href, baseUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        resolved = u.toString();
      } catch {
        continue;
      }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const text = this._stripTags(m[2]).slice(0, 80);
      links.push({ text: text || resolved, url: resolved });
      if (links.length >= 30) break;
    }
    return links;
  }

  // --- Registry fallback (npm + PyPI) via their open JSON APIs ---------- //

  static async _registryFallback(url, maxText) {
    const npm = this._npmSpec(url);
    if (npm) {
      try {
        return await this._npmFallback(npm, url, maxText);
      } catch {}
    }
    const pypi = this._pypiSpec(url);
    if (pypi) {
      try {
        return await this._pypiFallback(pypi, url, maxText);
      } catch {}
    }
    return null;
  }

  static _npmSpec(url) {
    const m = /npmjs\.\w+\/package\/([@a-zA-Z0-9._~-]+(?:\/[@a-zA-Z0-9._~-]+)?)/i.exec(url);
    return m ? m[1] : null;
  }

  static _pypiSpec(url) {
    const m = /pypi\.org\/project\/([a-zA-Z0-9._-]+)/i.exec(url);
    return m ? m[1] : null;
  }

  static async _fetchJson(apiUrl) {
    const resp = await fetch(apiUrl, {
      headers: browserHeaders('application/json'),
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    return resp.json();
  }

  static async _npmFallback(spec, pageUrl, maxText) {
    const pkg = encodeURIComponent(spec); // '@vierratale/ai' -> %40vierratale%2Fai
    const data = await this._fetchJson(`https://registry.npmjs.org/${pkg}`);
    const version =
      (data['dist-tags'] && (data['dist-tags'].latest || data['dist-tags'].beta)) ||
      Object.keys(data.versions || {})[0];
    const meta = (data.versions && data.versions[version]) || {};
    const deps = meta.dependencies || data.dependencies || {};
    const lines = [
      `${data.name} (npm package)`,
      `Latest version: ${version}`,
      meta.description || data.description || '',
      `License: ${meta.license || data.license || 'N/A'}`,
      `Dependencies: ${Object.keys(deps).length}`,
      '',
    ];
    const readme = String(data.readme || '').trim();
    if (readme) lines.push(readme.slice(0, maxText));
    return {
      url: pageUrl,
      title: `${data.name} · npm`,
      text: lines.filter(Boolean).join('\n').slice(0, maxText),
    };
  }

  static async _pypiFallback(spec, pageUrl, maxText) {
    const data = await this._fetchJson(`https://pypi.org/pypi/${encodeURIComponent(spec)}/json`);
    const info = data.info || {};
    const lines = [
      `${info.name} (PyPI package)`,
      `Version: ${info.version}`,
      info.summary || '',
      `Requires Python: ${info.requires_python || 'N/A'}`,
      `License: ${info.license || 'N/A'}`,
      `Home: ${info.home_page || info.project_url || 'N/A'}`,
      '',
    ];
    const desc = String(info.description || '').trim();
    if (desc) lines.push(desc.slice(0, maxText));
    return {
      url: pageUrl,
      title: `${info.name} · PyPI`,
      text: lines.filter(Boolean).join('\n').slice(0, maxText),
    };
  }

  // --- extraction -------------------------------------------------------- //

  static _extractAssets(html, baseUrl) {
    const found = [];
    const seen = new Set();
    const refs = [];
    const hrefRe = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = hrefRe.exec(html)) !== null) refs.push([m[1], 'a']);
    const srcRe = /<(?:img|source|video|audio|embed|iframe)[^>]+src=["']([^"']+)["'][^>]*>/gi;
    while ((m = srcRe.exec(html)) !== null) refs.push([m[1], 'src']);
    const dataRe = /<(?:a|source)[^>]+data-(?:file|download|src)=["']([^"']+)["'][^>]*>/gi;
    while ((m = dataRe.exec(html)) !== null) refs.push([m[1], 'data']);

    for (const [raw, attr] of refs) {
      const resolved = this._resolveAssetUrl(raw, baseUrl);
      if (!resolved || seen.has(resolved)) continue;
      const rel = attr === 'a' || attr === 'data' ? raw : raw;
      if (rel.startsWith('tel:') || rel.startsWith('mailto:') || rel.startsWith('javascript:')) continue;
      const type = detectAssetType(resolved.pathname);
      if (!type) continue;
      if (resolved.pathname.endsWith('.html') || resolved.pathname.endsWith('.htm')) continue;
      seen.add(resolved.href);
      found.push({
        url: resolved.href,
        name: this._assetName(resolved, type),
        type,
      });
      if (found.length >= 30) break;
    }
    return found.sort((x, y) => x.type.localeCompare(y.type));
  }

  static _resolveAssetUrl(raw, baseUrl) {
    try {
      const href = String(raw || '').trim().split('#')[0];
      if (!href || /^data:/i.test(href)) return null;
      const url = new URL(href, baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url;
    } catch {
      return null;
    }
  }

  static _assetName(url, type) {
    if (!url) return `download.${type}`;
    const path = url.pathname.split('/').filter(Boolean);
    let name = path.length ? decodeURIComponent(path[path.length - 1]) : '';
    if (!name || type === 'unknown') name = `${url.hostname.replace(/[^a-z0-9.-]/gi, '_')}.${type}`;
    if (!name.includes('.')) name = `${name}.${type}`;
    return name.slice(0, 120);
  }

  static _extractTitle(html) {
    const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
    return m ? this._stripEntities(m[1].trim()) : '';
  }

  static _extractText(html) {
    // Drop comments and tag-blocks that add no readable value.
    let s = String(html || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|head|iframe|form|nav|footer|aside|template|object)[^>]*>[\s\S]*?<\/\1>/gi, ' ');

    // Force spacing around block-level elements so words don't merge.
    s = s.replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|blockquote|pre|table)>/gi, '\n');
    s = s.replace(/<(br|li|tr)[^>]*>/gi, '\n');

    // Remove remaining tags.
    s = s.replace(/<[^>]+>/g, ' ');

    // Collapse entities.
    s = this._stripEntities(s);

    // Collapse whitespace and trim lines.
    return s
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\u00a0/g, ' ')
      .trim();
  }

  static _stripTags(text) {
    return this._stripEntities(text);
  }

  static _stripEntities(text) {
    const map = {
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
      '&#39;': "'", '&#039;': "'", '&apos;': "'", '&nbsp;': ' ',
      '&ndash;': '–', '&mdash;': '—', '&hellip;': '...', '&copy;': '©',
      '&#x27;': "'", '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”',
    };
    return String(text)
      .replace(/<[^>]*>/g, '')
      .replace(/&[a-zA-Z0-9#]+;/g, (m) => map[m] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}