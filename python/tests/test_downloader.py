import os
import tarfile
import tempfile
import threading
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from vierrataleai.utils.downloader import Downloader, _clean_name
from vierrataleai.utils.websearch import WebSearch
from vierrataleai.utils.webfetch import WebFetch


class HttpDirServer:
    def __init__(self, root):
        self.root = root
        handler = lambda *a, **k: SimpleHTTPRequestHandler(*a, directory=root, **k)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def make_fixture():
    root = tempfile.mkdtemp(prefix="vwpy-")
    os.makedirs(os.path.join(root, "sub"), exist_ok=True)
    with open(os.path.join(root, "readme.txt"), "w") as fh:
        fh.write("Hello downloader\n")
    with open(os.path.join(root, "sub", "data.json"), "w") as fh:
        fh.write('{"ok":true}\n')
    src = tempfile.mkdtemp(prefix="vwpy-src-")
    with open(os.path.join(src, "inner.txt"), "w") as fh:
        fh.write("archive payload")
    tarpath = os.path.join(src, "a.tar.gz")
    with tarfile.open(tarpath, "w:gz") as tf:
        tf.add(os.path.join(src, "inner.txt"), arcname="inner.txt")
    with open(tarpath, "rb") as fh:
        os.makedirs(os.path.join(root, "archives"), exist_ok=True)
        with open(os.path.join(root, "archives", "a.tar.gz"), "wb") as out:
            out.write(fh.read())
    return root, src


class DownloaderTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root, cls.src = make_fixture()
        cls.server = HttpDirServer(cls.root)

    @classmethod
    def tearDownClass(cls):
        cls.server.close()
        for path in (cls.root, cls.src):
            import shutil
            shutil.rmtree(path, ignore_errors=True)

    def test_download_file(self):
        base = self.server.base
        tmp = tempfile.mkdtemp(prefix="vwpy-out-")
        try:
            res = Downloader.download(f"{base}/readme.txt", dir=tmp)
            self.assertEqual(res["kind"], "file")
            self.assertTrue(os.path.exists(res["path"]))
            with open(res["path"]) as fh:
                self.assertIn("Hello downloader", fh.read())
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_download_folder_listing(self):
        base = self.server.base
        tmp = tempfile.mkdtemp(prefix="vwpy-out-")
        try:
            res = Downloader.download(f"{base}/", dir=tmp)
            self.assertEqual(res["kind"], "folder")
            found = []
            for dirpath, _dirs, fnames in os.walk(res["path"]):
                for f in fnames:
                    found.append(f)
            self.assertIn("readme.txt", found)
            self.assertIn("data.json", found)
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_download_extract_archive(self):
        base = self.server.base
        tmp = tempfile.mkdtemp(prefix="vwpy-out-")
        try:
            res = Downloader.download(f"{base}/archives/a.tar.gz", dir=tmp)
            self.assertEqual(res["kind"], "archive")
            self.assertTrue(res.get("extracted"))
            inner = os.path.join(res["extracted"], "inner.txt")
            self.assertTrue(os.path.exists(inner), f"expected {inner}")
            with open(inner) as fh:
                self.assertIn("archive payload", fh.read())
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_clean_name(self):
        self.assertEqual(_clean_name('a/b:c*?"<>|'), "a_b_c______")
        self.assertEqual(_clean_name("..hidden"), "hidden")
        self.assertEqual(_clean_name(""), "download")


class WebSearchTestCase(unittest.TestCase):
    def test_parse_google(self):
        html = (
            '<div id="search"><div class="g">'
            '<a class="By2jHp" href="/url?q=https%3A%2F%2Fvierratale.ai%2F&sa=U">'
            "<h3>VierrataleAI Home</h3></a>"
            '<div class="VwiC3b">A friendly terminal AI.</div></div></div>'
        )
        results = WebSearch._parse_google(html, 5)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["title"], "VierrataleAI Home")
        self.assertEqual(results[0]["url"], "https://vierratale.ai/")
        self.assertIn("friendly terminal AI", results[0]["snippet"])

    def test_parse_google_wall_empty(self):
        self.assertEqual(WebSearch._parse_google("<html>enablejs</html>", 5), [])
        self.assertEqual(WebSearch._parse_google("<script>captcha</script>", 5), [])


class WebFetchAssetsTestCase(unittest.TestCase):
    def test_extract_assets(self):
        html = (
            "<a href='/files/report.pdf'>Report</a>"
            "<a href='https://example.com/data.zip'>zip</a>"
            "<a href='/page.html'>page</a>"
            "<img src='/img/hero.png' />"
            "<source src='/v/clip.mp4' />"
            "<a href='mailto:x@y.z'>mail</a>"
            "<a href='x.tar.gz'>gzip</a>"
        )
        assets = WebFetch._extract_assets(html, "https://example.com/docs/index.html")
        urls = {a["url"] for a in assets}
        self.assertIn("https://example.com/img/hero.png", urls)
        self.assertIn("https://example.com/files/report.pdf", urls)
        self.assertIn("https://example.com/data.zip", urls)
        self.assertIn("https://example.com/docs/x.tar.gz", urls)
        png = next(a for a in assets if "hero.png" in a["url"])
        self.assertEqual(png["type"], "png")
        self.assertEqual(png["name"], "hero.png")
        self.assertNotIn("https://example.com/page.html", urls)
        self.assertNotIn("mailto:x@y.z", urls)


if __name__ == "__main__":
    unittest.main()