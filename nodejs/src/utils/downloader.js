import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { browserHeaders, isBlockedBody } from './webfetch.js';

const execFileAsync = promisify(execFile);

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; // 500MB cap

const ARCHIVE_EXT = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|gz|bz2|7z|rar|xz)$/i;

const MIME_EXT = {
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/octet-stream': 'bin',
};

function stripInvalidFilenameChars(name) {
  // eslint-disable-next-line no-control-regex
  return String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim()
    .slice(0, 200) || 'download';
}

function baseNameFromUrl(url) {
  try {
    const u = new URL(url);
    const name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return name || (u.hostname || 'download').replace(/^www\./, '');
  } catch {
    return 'download';
  }
}

function fileNameFromHeaders(url, contentType) {
  const base = baseNameFromUrl(url);
  if (contentType) {
    const ct = contentType.split(';')[0].trim().toLowerCase();
    const ext = MIME_EXT[ct];
    if (ext && !base.toLowerCase().endsWith(`.${ext}`)) {
      return `${stripInvalidFilenameChars(base)}.${ext}`;
    }
  }
  return stripInvalidFilenameChars(base);
}

function isArchiveUrl(url) {
  return ARCHIVE_EXT.test(String(url).split('?')[0]);
}

function isDirectoryListing(html) {
  const s = String(html || '').slice(0, 20000).toLowerCase();
  const hasLinks = /<a href=/i.test(s);
  if (!hasLinks) return false;
  return (
    /<a[^>]+href=[^>]*>\s*\.\.[\s<]/.test(s) ||
    /(?:index of \/|directory listing for|parent directory)/.test(s) ||
    /<h1>.*listing.*<\/h1>/.test(s)
  );
}

function joinUrl(base, rel) {
  try {
    return new URL(rel, base).toString();
  } catch {
    return null;
  }
}

function sameDomain(a, b) {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

function isGithubRepoUrl(url) {
  return /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/i.test(url);
}

export class Downloader {
  static async fetchStream(url, { timeout = 30000, headers = {} } = {}) {
    const resp = await fetch(url, {
      headers: { ...browserHeaders('*/*'), ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp;
  }

  // Stream a raw body to a file. Returns metadata.
  static async downloadFile(url, { dir = process.cwd(), filename, timeout = 30000, onProgress } = {}) {
    mkdirSync(dir, { recursive: true });
    const resp = await this.fetchStream(url, { timeout });
    const contentType = resp.headers.get('content-type') || '';
    const finalUrl = resp.url || url;
    const name = filename || fileNameFromHeaders(finalUrl, contentType);
    const dest = join(dir, stripInvalidFilenameChars(name));

    const reader = resp.body.getReader();
    const stream = createWriteStream(dest);
    let received = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_DOWNLOAD_BYTES) {
          throw new Error(`Download exceeded ${MAX_DOWNLOAD_BYTES} byte cap`);
        }
        await new Promise((resolve, reject) => stream.write(value, (err) => (err ? reject(err) : resolve())));
      }
    } catch (err) {
      await new Promise((resolve) => stream.close(resolve));
      rmSync(dest, { force: true });
      throw err;
    }
    await new Promise((resolve) => stream.end(resolve));
    if (onProgress) onProgress(received, received);
    return { ok: true, path: dest, size: received, contentType, url: finalUrl, name };
  }

  static async extractArchive(archivePath, destDir) {
    const file = String(archivePath).toLowerCase();
    mkdirSync(destDir, { recursive: true });
    if (file.endsWith('.zip')) {
      await execFileAsync('unzip', ['-o', archivePath, '-d', destDir]);
    } else if (file.endsWith('.tar.gz') || file.endsWith('.tgz') || file.endsWith('.tar.bz2') ||
               file.endsWith('.tbz2') || file.endsWith('.tar.xz') || file.endsWith('.txz') || file.endsWith('.tar')) {
      await execFileAsync('tar', ['-xf', archivePath, '-C', destDir]);
    } else if (file.endsWith('.7z')) {
      await execFileAsync('7z', ['x', archivePath, `-o${destDir}`, '-y']);
    } else if (file.endsWith('.rar')) {
      await execFileAsync('unrar', ['x', archivePath, destDir]);
    } else {
      throw new Error(`Cannot extract that archive: ${archivePath}`);
    }
  }

  // Zip a folder. destZip must end in .zip or .tar.gz.
  static async zipFolder(srcDir, destZip) {
    mkdirSync(srcDir, { recursive: true });
    const lower = destZip.toLowerCase();
    const absZip = join(process.cwd(), destZip);
    if (lower.endsWith('.zip')) {
      await execFileAsync('zip', ['-r', absZip, '.'], { cwd: srcDir });
    } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      await execFileAsync('tar', ['-czf', absZip, '-C', srcDir, '.']);
    } else {
      throw new Error('Destination must end in .zip or .tar.gz');
    }
    const { statSync } = await import('fs');
    return { ok: true, path: absZip, size: statSync(absZip).size };
  }

  static async download(url, { dir = process.cwd(), filename, timeout = 30000, onProgress, extract = true } = {}) {
    const resp = await this.fetchStream(url, { timeout });
    const contentType = resp.headers.get('content-type') || '';
    const finalUrl = resp.url || url;
    const isHtml = /text\/html|application\/xhtml/i.test(contentType);
    const isPlain = /text\/plain|text\/markdown|application\/json|\+json|text\/csv/i.test(contentType);

    // We must peek the body once. For HTML we buffer it (capped); otherwise
    // stream it to disk directly.
    if (isHtml || isPlain) {
      const buf = Buffer.from(await resp.arrayBuffer());
      const html = buf.toString('utf8');
      if (typeof onProgress === 'function') onProgress(buf.length, buf.length);

      if (isHtml && isBlockedBody(html)) {
        throw new Error('Download blocked by anti-bot protection.');
      }

      // github repo URL -> grab the repo zip and extract it (its HTML page
      // would otherwise just be saved as a file).
      if (isGithubRepoUrl(finalUrl)) {
        return this._downloadGithub(finalUrl, { dir, filename, onProgress });
      }

      // HTML directory listing -> recursive folder download.
      if (isHtml && isDirectoryListing(html)) {
        return this._downloadListing(finalUrl, html, { dir, filename, onProgress });
      }

      // Otherwise save plain text / html as a file.
      const kind = 'file';
      const name = filename || fileNameFromHeaders(finalUrl, contentType);
      const dest = join(dir, stripInvalidFilenameChars(name));
      mkdirSync(dir, { recursive: true });
      writeFileSync(dest, html, 'utf8');
      return { ok: true, path: dest, size: buf.length, kind, url: finalUrl, name };
    }

    // Binary / archive: stream to disk.
    const result = await this.downloadFile(finalUrl, { dir, filename, timeout, onProgress });
    let kind = 'file';
    if (isArchiveUrl(result.name) || /application\/(zip|x-zip|x-tar|gzip)|multipart\/x-zip/i.test(result.contentType)) {
      kind = 'archive';
      if (extract) {
        const extractDir = result.path.replace(/\.(zip|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar|7z|rar)$/i, '');
        await this.extractArchive(result.path, extractDir);
        return { ...result, kind, extracted: extractDir };
      }
    }
    return { ...result, kind };
  }

  static async _downloadListing(url, html, { dir, filename, onProgress }) {
    const name = filename || stripInvalidFilenameChars(baseNameFromUrl(url));
    const folderDir = join(dir, name);
    mkdirSync(folderDir, { recursive: true });
    const links = this._listingLinks(url, html);
    let count = 0;
    for (const { href } of links) {
      const resolved = joinUrl(url, href);
      if (!resolved) continue;
      if (!sameDomain(url, resolved)) continue;
      const isSubdir = href.endsWith('/') || /^[^.?]+\/$/.test(href);
      try {
        if (isSubdir) {
          const subDir = join(folderDir, stripInvalidFilenameChars(baseNameFromUrl(resolved)));
          const subHtml = await this._peekHtml(resolved);
          if (subHtml && isDirectoryListing(subHtml)) {
            await this._downloadListingIntoSelf(resolved, subHtml, subDir, onProgress, count);
            count++;
          }
        } else {
          const fileName = stripInvalidFilenameChars(baseNameFromUrl(resolved));
          await this.downloadFile(resolved, { dir: folderDir, filename: fileName, onProgress });
          count++;
        }
      } catch (err) {
        // ignore individual link failures during a folder crawl
      }
    }
    if (typeof onProgress === 'function') onProgress(count, count);
    return { ok: true, path: folderDir, kind: 'folder', url, name };
  }

  static async _peekHtml(url) {
    try {
      const resp = await this.fetchStream(url, { timeout: 15000 });
      const contentType = resp.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml/i.test(contentType)) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      return buf.toString('utf8').slice(0, 20000);
    } catch {
      return null;
    }
  }

  static async _downloadListingIntoSelf(url, html, folderDir, onProgress, count) {
    mkdirSync(folderDir, { recursive: true });
    const links = this._listingLinks(url, html);
    for (const { href } of links) {
      const resolved = joinUrl(url, href);
      if (!resolved || !sameDomain(url, resolved)) continue;
      const isSubdir = href.endsWith('/') || /^[^.?]+\/$/.test(href);
      try {
        if (isSubdir) {
          const subDir = join(folderDir, stripInvalidFilenameChars(baseNameFromUrl(resolved)));
          const subHtml = await this._peekHtml(resolved);
          if (subHtml && isDirectoryListing(subHtml)) {
            await this._downloadListingIntoSelf(resolved, subHtml, subDir, onProgress, count);
          }
        } else {
          const fileName = stripInvalidFilenameChars(baseNameFromUrl(resolved));
          await this.downloadFile(resolved, { dir: folderDir, filename: fileName, onProgress });
        }
      } catch {
        // ignore individual link failures during a folder crawl
      }
    }
  }

  static _listingLinks(baseUrl, html) {
    const out = [];
    const re = /<a[^>]+href\s*=\s*"([^"]+)"[^>]*>(.*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      if (!href) continue;
      if (href.startsWith('#') || href.startsWith('?') || href.startsWith('javascript:')) continue;
      if (href.startsWith('..') || href === '/' || href === '../') continue;
      out.push({ href });
    }
    return out;
  }

  static async _downloadGithub(url, { dir, filename, onProgress }) {
    const zipUrl = await this.githubZipUrl(url);
    const name = filename || `${baseNameFromUrl(url) || 'repo'}`;
    const destDir = join(dir, stripInvalidFilenameChars(name));
    mkdirSync(destDir, { recursive: true });
    const tmpArchive = join(tmpdir(), `github-${Date.now()}.zip`);
    try {
      await this.downloadFile(zipUrl, { dir: tmpdir(), filename: tmpArchive.split('/').pop(), timeout: 60000, onProgress });
      await this.extractArchive(tmpArchive, destDir);
    } finally {
      try { rmSync(tmpArchive, { force: true }); } catch {}
    }
    return { ok: true, path: destDir, kind: 'folder', url, name };
  }

  static async githubZipUrl(url) {
    try {
      const u = new URL(url);
      const path = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      const owner = path[0];
      const repo = path[1];
      if (path[2] === 'tree' && path[3]) {
        const branch = path.slice(3).join('/');
        return `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`;
      }
      if (path[2] === 'archive' && path[3] && path[4]) {
        return `https://codeload.github.com/${owner}/${repo}/zip/${path.slice(3).join('/')}`;
      }
      const branch = await this.defaultGitHubBranch(owner, repo);
      return `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`;
    } catch {
      return `${String(url).replace(/\/+$/, '')}.zip`;
    }
  }

  static async defaultGitHubBranch(owner, repo) {
    try {
      const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { 'User-Agent': 'vierrataleai-downloader', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return 'main';
      const data = await resp.json();
      return data.default_branch || 'main';
    } catch {
      return 'main';
    }
  }
}