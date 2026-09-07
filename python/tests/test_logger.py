import shutil
import tempfile
import unittest
from pathlib import Path

from vierrataleai.utils.logger import Logger, logger


class LoggerTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="vtrl-log-"))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_writes_timestamped_entries_under_logs(self):
        L = Logger()
        L.init(base_dir=self.dir)
        L.log("EVENT", "hello world")
        self.assertIsNotNone(L.file)
        self.assertTrue(L.file.exists())
        raw = L.file.read_text(encoding="utf-8")
        self.assertIn("[EVENT] hello world", raw)

    def test_tail_returns_last_entries(self):
        L = Logger()
        L.init(base_dir=self.dir)
        L.log("A", "one")
        L.log("B", "two")
        tail = L.tail(5)
        self.assertEqual(len(tail), 2)
        self.assertIn("[B] two", tail[1])

    def test_long_entries_are_capped(self):
        L = Logger()
        L.init(base_dir=self.dir)
        L.log("BIG", "x" * 5000)
        last = L.file.read_text(encoding="utf-8").splitlines()[-1]
        self.assertLess(len(last), 3000)

    def test_noop_until_init(self):
        L = Logger()
        self.assertEqual(L.log("X", "should be ignored"), "")
        self.assertEqual(L.get_path(), "")
        self.assertEqual(L.tail(5), [])

    def test_shared_singleton_is_a_logger(self):
        self.assertIsInstance(logger, Logger)


if __name__ == "__main__":
    unittest.main()