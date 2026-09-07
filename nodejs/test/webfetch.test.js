import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebFetch } from '../src/utils/webfetch.js';

let server;
let base;

function send(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

function startServer() {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const p = url.pathname;
      if (p === '/json') {
        send(res, 200, 'application/json; charset=utf-8',
          JSON.stringify({ user: { name: 'Vierratale', tags: ['ai', 'cli'] }, items: [1, 2, 3], online: true }));
      } else if (p === '/plain') {
        send(res, 200, 'text/plain; charset=utf-8', 'Hello plain text world\nSecond line here.');
      } else if (p === '/md') {
        send(res, 200, 'text/markdown; charset=utf-8', '# Heading\n\nSome *bold* text and a [link](https://example.com).');
      } else if (p === '/feed') {
        send(res, 200, 'application/atom+xml; charset=utf-8', `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>My Feed</title>
<entry><title>Hello Atom</title><link href="https://example.com/a.html"/><summary>An atom summary.</summary></entry>
<entry><title>Second Post</title><link href="https://example.com/b.html"/><summary>More detail.</summary></entry>
</feed>`);
      } else if (p === '/rss') {
        send(res, 200, 'application/rss+xml; charset=utf-8', `<?xml version="1.0"?>
<rss version="2.0"><channel><title>My RSS</title>
<item><title>RSS Item</title><link>https://example.com/r1</link><description>Rss description body.</description></item>
</channel></rss>`);
      } else if (p === '/sitemap') {
        send(res, 200, 'application/xml; charset=utf-8', `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/</loc></url>
<url><sm:loc xmlns:sm="http://x">https://example.com/deep</sm:loc></url>
</urlset>`);
      } else if (p === '/pdf') {
        send(res, 200, 'application/pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF'));
      } else if (p === '/latin') {
        send(res, 200, 'text/html', Buffer.from('<html><head><meta charset="windows-1252"><title>Latin</title></head><body><p>caf\xe9 \x97 \x99</p></body></html>', 'latin1'));
      } else if (p === '/latinhdr') {
        send(res, 200, 'text/html; charset=windows-1252', Buffer.from('<html><body><p>na\xefve r\xe9sum\xe9</p></body></html>', 'latin1'));
      } else if (p === '/spa') {
        send(res, 200, 'text/html', `<!doctype html><html><head><title>Widget Store</title></head><body>
<p>Welcome to the store</p>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"productTitle":"Diamond Widget v3","price":1299}}}</script>
</body></html>`);
      } else if (p === '/links') {
        send(res, 200, 'text/html', `<!doctype html><html><head><title>Directory</title></head><body>
<p>Index</p>
<a href="/about"><b>About Us</b></a>
<a href="https://example.com/pricing">Pricing</a>
<a href="https://example.com/contact">Contact</a>
<a href="mailto:x@y.z">Mail</a>
<a href="#top">Top</a>
</body></html>`);
      } else if (p === '/wall') {
        send(res, 403, 'text/html', '<!doctype html><html><body>Just a moment... checking your browser before accessing this site. Attention required!</body></html>');
      } else if (p === '/redir') {
        res.writeHead(302, { Location: '/plain' });
        res.end();
      } else {
        send(res, 404, 'text/plain', 'nope');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

test('webfetch: json endpoints flatten into readable fields', async () => {
  await startServer();
  const r = await WebFetch.fetch(`${base}/json`);
  assert.match(r.text, /user\.name: Vierratale/);
  assert.match(r.text, /items \(3\)/);
  assert.match(r.text, /tags\[0\]: ai/);
  assert.equal(r.assets.length, 0);
});

test('webfetch: plain text returns as-is', async () => {
  const r = await WebFetch.fetch(`${base}/plain`);
  assert.match(r.text, /Hello plain text world/);
  assert.match(r.text, /Second line here\./);
});

test('webfetch: markdown returns as-is', async () => {
  const r = await WebFetch.fetch(`${base}/md`);
  assert.match(r.text, /# Heading/);
});

test('webfetch: atom feed lists entries', async () => {
  const r = await WebFetch.fetch(`${base}/feed`);
  assert.match(r.text, /My Feed/);
  assert.match(r.text, /Hello Atom/);
  assert.match(r.text, /https:\/\/example\.com\/a\.html/);
  assert.match(r.text, /An atom summary/);
});

test('webfetch: rss feed lists entries', async () => {
  const r = await WebFetch.fetch(`${base}/rss`);
  assert.match(r.text, /My RSS/);
  assert.match(r.text, /RSS Item/);
  assert.match(r.text, /Rss description body/);
});

test('webfetch: sitemap lists urls (incl. namespaced)', async () => {
  const r = await WebFetch.fetch(`${base}/sitemap`);
  assert.match(r.text, /Sitemap/);
  assert.match(r.text, /\* https:\/\/example\.com\//);
  assert.match(r.text, /\* https:\/\/example\.com\/deep/);
});

test('webfetch: pdf becomes a downloadable asset, not garbage text', async () => {
  const r = await WebFetch.fetch(`${base}/pdf`);
  assert.match(r.text, /download_url/);
  assert.equal(r.assets.length, 1);
  assert.equal(r.assets[0].type, 'pdf');
});

test('webfetch: decodes meta-declared charset', async () => {
  const r = await WebFetch.fetch(`${base}/latin`);
  assert.match(r.text, /café/);
});

test('webfetch: decodes charset from content-type header', async () => {
  const r = await WebFetch.fetch(`${base}/latinhdr`);
  assert.match(r.text, /naïve résumé/);
});

test('webfetch: extracts embedded Next.js JSON from SPAs', async () => {
  const r = await WebFetch.fetch(`${base}/spa`);
  assert.match(r.text, /Diamond Widget v3/);
  assert.match(r.text, /productTitle/);
});

test('webfetch: thin pages list their links', async () => {
  const r = await WebFetch.fetch(`${base}/links`);
  assert.match(r.text, /\[Links on page\]/);
  assert.match(r.text, /https:\/\/example\.com\/pricing/);
  assert.match(r.text, /About Us/);
  assert.ok(!/mailto:/i.test(r.text), 'mailto links should be skipped');
});

test('webfetch: walls are detected and rejected', async () => {
  await assert.rejects(WebFetch.fetch(`${base}/wall`), /blocked/i);
});

test('webfetch: redirects resolve to the final url', async () => {
  const r = await WebFetch.fetch(`${base}/redir`);
  assert.ok(r.url.endsWith('/plain'));
  assert.match(r.text, /Hello plain text world/);
});

test('webfetch: classify handles content types and bodies', () => {
  assert.equal(WebFetch._classify('https://x/y.pdf', 'application/pdf', ''), 'pdf');
  assert.equal(WebFetch._classify('https://x/', 'application/json', ''), 'json');
  assert.equal(WebFetch._classify('https://x/', '', '<?xml version="1.0"?><root/>'), 'xml');
  assert.equal(WebFetch._classify('https://x/', 'text/html', '<html></html>'), 'html');
  assert.equal(WebFetch._classify('https://x/', '', '{"a":1}'), 'json');
  assert.equal(WebFetch._classify('https://x/', 'image/png', 'PNG garbage'), 'binary');
});

after(() => {
  server?.close();
});