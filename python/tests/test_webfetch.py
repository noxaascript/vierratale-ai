import os
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from vierrataleai.utils.webfetch import WebFetch


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = urllib.parse.urlsplit(self.path).path
        if p == "/json":
            self._send(200, "application/json; charset=utf-8",
                       b'{"user": {"name": "Vierratale", "tags": ["ai", "cli"]}, "items": [1, 2, 3], "online": true}')
        elif p == "/plain":
            self._send(200, "text/plain; charset=utf-8", b"Hello plain text world\nSecond line here.")
        elif p == "/md":
            self._send(200, "text/markdown; charset=utf-8", b"# Heading\n\nSome *bold* text and a [link](https://example.com).")
        elif p == "/feed":
            body = ('<?xml version="1.0"?>\n'
                    '<feed xmlns="http://www.w3.org/2005/Atom"><title>My Feed</title>\n'
                    '<entry><title>Hello Atom</title><link href="https://example.com/a.html"/><summary>An atom summary.</summary></entry>\n'
                    '<entry><title>Second Post</title><link href="https://example.com/b.html"/><summary>More detail.</summary></entry>\n'
                    '</feed>').encode("utf-8")
            self._send(200, "application/atom+xml; charset=utf-8", body)
        elif p == "/rss":
            body = ('<?xml version="1.0"?>\n'
                    '<rss version="2.0"><channel><title>My RSS</title>\n'
                    '<item><title>RSS Item</title><link>https://example.com/r1</link><description>Rss description body.</description></item>\n'
                    '</channel></rss>').encode("utf-8")
            self._send(200, "application/rss+xml; charset=utf-8", body)
        elif p == "/sitemap":
            body = ('<?xml version="1.0"?>\n'
                    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                    '<url><loc>https://example.com/</loc></url>\n'
                    '<url><sm:loc xmlns:sm="http://x">https://example.com/deep</sm:loc></url>\n'
                    '</urlset>').encode("utf-8")
            self._send(200, "application/xml; charset=utf-8", body)
        elif p == "/pdf":
            self._send(200, "application/pdf", b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF")
        elif p == "/latin":
            body = bytes("<html><head><meta charset=\"windows-1252\"><title>Latin</title></head>"
                         "<body><p>caf\xe9 \x97 \x99</p></body></html>", "latin1")
            self._send(200, "text/html", body)
        elif p == "/latinhdr":
            body = bytes("<html><body><p>na\xefve r\xe9sum\xe9</p></body></html>", "latin1")
            self._send(200, "text/html; charset=windows-1252", body)
        elif p == "/spa":
            body = ('<!doctype html><html><head><title>Widget Store</title></head><body>\n'
                    '<p>Welcome to the store</p>\n'
                    '<script id="__NEXT_DATA__" type="application/json">'
                    '{"props":{"pageProps":{"productTitle":"Diamond Widget v3","price":1299}}}</script>\n'
                    '</body></html>').encode("utf-8")
            self._send(200, "text/html", body)
        elif p == "/links":
            body = ('<!doctype html><html><head><title>Directory</title></head><body>\n'
                    '<p>Index</p>\n'
                    '<a href="/about"><b>About Us</b></a>\n'
                    '<a href="https://example.com/pricing">Pricing</a>\n'
                    '<a href="https://example.com/contact">Contact</a>\n'
                    '<a href="mailto:x@y.z">Mail</a>\n'
                    '<a href="#top">Top</a>\n'
                    '</body></html>').encode("utf-8")
            self._send(200, "text/html", body)
        elif p == "/wall":
            self._send(403, "text/html",
                       b"<!doctype html><html><body>Just a moment... checking your browser before accessing this site. Attention required!</body></html>")
        elif p == "/redir":
            self.send_response(302)
            self.send_header("Location", "/plain")
            self.end_headers()
        else:
            self._send(404, "text/plain", b"nope")


class _Server:
    def __init__(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.thread = __import__("threading").Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class WebFetchTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = _Server()
        cls.url = lambda cls, p: cls.server.base + p

    @classmethod
    def tearDownClass(cls):
        cls.server.close()

    def test_json_flattens(self):
        r = WebFetch.fetch(self.url("/json"))
        self.assertIn("user.name: Vierratale", r["text"])
        self.assertIn("items (3)", r["text"])
        self.assertIn("tags[0]: ai", r["text"])
        self.assertEqual(r["assets"], [])

    def test_plain_text(self):
        r = WebFetch.fetch(self.url("/plain"))
        self.assertIn("Hello plain text world", r["text"])
        self.assertIn("Second line here.", r["text"])

    def test_markdown(self):
        r = WebFetch.fetch(self.url("/md"))
        self.assertIn("# Heading", r["text"])

    def test_atom_feed(self):
        r = WebFetch.fetch(self.url("/feed"))
        self.assertIn("My Feed", r["text"])
        self.assertIn("Hello Atom", r["text"])
        self.assertIn("https://example.com/a.html", r["text"])
        self.assertIn("An atom summary", r["text"])

    def test_rss_feed(self):
        r = WebFetch.fetch(self.url("/rss"))
        self.assertIn("My RSS", r["text"])
        self.assertIn("RSS Item", r["text"])
        self.assertIn("Rss description body", r["text"])

    def test_sitemap(self):
        r = WebFetch.fetch(self.url("/sitemap"))
        self.assertIn("Sitemap", r["text"])
        self.assertIn("* https://example.com/", r["text"])
        self.assertIn("* https://example.com/deep", r["text"])

    def test_pdf_becomes_asset(self):
        r = WebFetch.fetch(self.url("/pdf"))
        self.assertIn("download_url", r["text"])
        self.assertEqual(len(r["assets"]), 1)
        self.assertEqual(r["assets"][0]["type"], "pdf")

    def test_meta_charset_decode(self):
        r = WebFetch.fetch(self.url("/latin"))
        self.assertIn("café", r["text"])

    def test_header_charset_decode(self):
        r = WebFetch.fetch(self.url("/latinhdr"))
        self.assertIn("naïve résumé", r["text"])

    def test_spa_embedded_json(self):
        r = WebFetch.fetch(self.url("/spa"))
        self.assertIn("Diamond Widget v3", r["text"])
        self.assertIn("productTitle", r["text"])

    def test_thin_page_lists_links(self):
        r = WebFetch.fetch(self.url("/links"))
        self.assertIn("[Links on page]", r["text"])
        self.assertIn("https://example.com/pricing", r["text"])
        self.assertIn("About Us", r["text"])
        self.assertNotRegex(r["text"], r"mailto:")

    def test_wall_rejected(self):
        with self.assertRaises(Exception) as ctx:
            WebFetch.fetch(self.url("/wall"))
        self.assertIn("blocked", str(ctx.exception).lower())

    def test_redirect_resolves(self):
        r = WebFetch.fetch(self.url("/redir"))
        self.assertTrue(r["url"].endswith("/plain"))
        self.assertIn("Hello plain text world", r["text"])

    def test_classify(self):
        self.assertEqual(WebFetch._classify("https://x/y.pdf", "application/pdf", ""), "pdf")
        self.assertEqual(WebFetch._classify("https://x/", "application/json", ""), "json")
        self.assertEqual(WebFetch._classify("https://x/", "", '<?xml version="1.0"?><root/>'), "xml")
        self.assertEqual(WebFetch._classify("https://x/", "text/html", "<html></html>"), "html")
        self.assertEqual(WebFetch._classify("https://x/", "", '{"a":1}'), "json")
        self.assertEqual(WebFetch._classify("https://x/", "image/jpeg", "weird bytes"), "binary")


if __name__ == "__main__":
    unittest.main()