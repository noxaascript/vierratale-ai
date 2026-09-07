import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Downloader } from '../src/utils/downloader.js';
import { WebSearch } from '../src/utils/websearch.js';
import { WebFetch } from '../src/utils/webfetch.js';

const ROOT = mkdtempSync(join(os.tmpdir(), 'vw-dl-root-'));
mkdirSync(join(ROOT, 'sub'), { recursive: true });
writeFileSync(join(ROOT, 'readme.txt'), 'Hello downloader\n');
writeFileSync(join(ROOT, 'sub', 'data.json'), '{"ok":true}\n');

let server;
let base;

function startServer() {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const p = join(ROOT, decodeURIComponent(url.pathname)).replace(/\/+$/, '');
      if (!p.startsWith(ROOT)) {
        res.writeHead(404);
        res.end('nope');
        return;
      }
      try {
        if (statSync(p).isDirectory()) {
          const rows = readdirSync(p).map((i) => {
            const isDir = statSync(join(p, i)).isDirectory();
            return `<a href="${i}${isDir ? '/' : ''}">${i}${isDir ? '/' : ''}</a>`;
          });
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><head><title>Directory listing for /</title></head><body><pre>${rows.join('\n')}</pre></body></html>`);
          return;
        }
        res.writeHead(200);
        res.end(readFileSync(p));
      } catch {
        res.writeHead(404);
        res.end('nope');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

test('downloader: download a raw file', async () => {
  await startServer();
  const dest = mkdtempSync(join(os.tmpdir(), 'vw-f-'));
  const res = await Downloader.download(`${base}/readme.txt`, { dir: dest });
  assert.equal(res.kind, 'file');
  assert.ok(res.path.endsWith('readme.txt'));
  assert.match(readFileSync(res.path, 'utf8'), /Hello downloader/);
  rmSync(dest, { recursive: true });
});

test('downloader: download an HTML folder listing recursively', async () => {
  const dest = mkdtempSync(join(os.tmpdir(), 'vw-dir-'));
  const out = await Downloader.download(`${base}/`, { dir: dest });
  assert.equal(out.kind, 'folder');
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const fp = join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else files.push(fp);
    }
  })(out.path);
  assert.ok(files.some((f) => f.endsWith('readme.txt')));
  assert.ok(files.some((f) => f.includes('sub') && f.endsWith('data.json')));
  const data = readFileSync(files.find((f) => f.includes('sub') && f.endsWith('data.json')), 'utf8');
  assert.match(data, /"ok":true/);
  rmSync(dest, { recursive: true });
});

after(() => {
  server?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

test('downloader: download + extract an archive', async () => {
  const zdir = mkdtempSync(join(os.tmpdir(), 'vw-src-'));
  writeFileSync(join(zdir, 'inner.txt'), 'archive payload');
  execFileSync('tar', ['-czf', 'a.tar.gz', 'inner.txt'], { cwd: zdir });
  const tarBytes = readFileSync(join(zdir, 'a.tar.gz'));
  writeFileSync(join(ROOT, 'a.tar.gz'), tarBytes);

  const dest = mkdtempSync(join(os.tmpdir(), 'vw-z-'));
  const out = await Downloader.download(`${base}/a.tar.gz`, { dir: dest });
  assert.ok(out.extracted, 'expect an extracted dir');
  assert.match(readFileSync(join(out.extracted, 'inner.txt'), 'utf8'), /archive payload/);
  rmSync(dest, { recursive: true });
  rmSync(zdir, { recursive: true });
});

test('downloader: github repo produces a codeload zip URL (branch-aware)', { timeout: 20000 }, async () => {
  const url = await Downloader.githubZipUrl('https://github.com/octocat/Hello-World');
  assert.match(url, /codeload\.github\.com\/octocat\/Hello-World\/zip\/refs\/heads\/master$/);
});

test('websearch: google parser extracts title/url/snippet', () => {
  const html = `<div id="search">
<div class="g"><a class="By2jHp" href="/url?q=https%3A%2F%2Fvierratale.ai%2F&sa=U"><h3>VierrataleAI Home</h3></a><div class="VwiC3b">A friendly terminal AI.</div></div>
</div>`;
  const results = WebSearch._parseGoogle(html, 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'VierrataleAI Home');
  assert.equal(results[0].url, 'https://vierratale.ai/');
  assert.match(results[0].snippet, /friendly terminal AI/);
});

test('websearch: google parser ignores wall/empty pages', () => {
  assert.equal(WebSearch._parseGoogle('<html>enablejs</html>', 5).length, 0);
  assert.equal(WebSearch._parseGoogle('<script>captcha</script>', 5).length, 0);
});

test('websearch: ddg parser survives modern markup', () => {
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example</a>
<a class="result__snippet">The domain for example</a></div>`;
  const results = WebSearch._parseDuckDuckGo(html, 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.com');
});

test('webfetch: extracts downloadable assets from a page', () => {
  const html = `
<a href='/files/report.pdf'>Report</a>
<a href='https://example.com/data.zip'>zip</a>
<a href='/page.html'>page</a>
<img src='/img/hero.png' />
<source src='/v/clip.mp4' />
<a href='mailto:x@y.z'>mail</a>
<a href='x.tar.gz'>gzip</a>
`;
  const assets = WebFetch._extractAssets(html, 'https://example.com/docs/index.html');
  const urls = new Set(assets.map((a) => a.url));
  assert.ok(urls.has('https://example.com/img/hero.png'));
  assert.ok(urls.has('https://example.com/files/report.pdf'));
  assert.ok(urls.has('https://example.com/data.zip'));
  assert.ok(urls.has('https://example.com/docs/x.tar.gz'));
  const png = assets.find((a) => a.url.includes('hero.png'));
  assert.equal(png.type, 'png');
  assert.equal(png.name, 'hero.png');
  assert.ok(!urls.has('https://example.com/page.html'));
  assert.ok(!urls.has('mailto:x@y.z'));
});