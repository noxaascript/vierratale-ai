import asyncio
import http.server
import json
import os
import threading
import unittest


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.server.received = (self.path, body)
        payload = json.dumps({"error": f"model '{body.get('model')}' not found"}).encode()
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class EngineErrorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.server.received = None
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_cortex_404_model_not_found_gives_guidance(self):
        os.environ["VIERRATALE_ENGINE_HOST"] = f"http://127.0.0.1:{self.port}"
        os.environ["VIERRATALE_MODEL"] = "VRTL-7.cloud-mini"

        from vierrataleai.providers.cortex import CortexProvider
        from vierrataleai import config
        from vierrataleai.catalog import get_real_model
        config.load()

        self.assertEqual(get_real_model("VRTL-7.cloud-mini"), "gpt-4o-mini")

        provider = CortexProvider()

        async def collect():
            gen = provider.stream([{"role": "user", "content": "hi"}])
            chunks = []
            async for chunk in gen:
                chunks.append(chunk)
            return chunks

        with self.assertRaises(RuntimeError) as ctx:
            asyncio.run(collect())

        path, body = self.server.received
        self.assertEqual(path, "/api/chat")
        self.assertEqual(body["model"], "gpt-4o-mini")

        msg = ctx.exception.args[0]
        self.assertTrue(msg.startswith("[ERR-0002]"), msg)
        self.assertIn("not installed", msg)
        self.assertIn("gpt-4o-mini", msg)
        self.assertIn("VRTL-6.pro", msg)
        self.assertFalse(msg.startswith("http://"), "must not leak the engine URL")
        self.assertNotIn(str(self.port), msg)


if __name__ == "__main__":
    unittest.main()