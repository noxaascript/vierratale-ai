import json
import os
import tempfile
import unittest
from pathlib import Path

_home = tempfile.mkdtemp(prefix="vrtl-session-test-")
os.environ["HOME"] = _home

from vierrataleai import session


def _config_dir() -> Path:
    return Path(_home) / ".config" / "vierrataleai"


class SessionTests(unittest.TestCase):
    def test_01_legacy_history_migration(self):
        _config_dir().mkdir(parents=True, exist_ok=True)
        legacy = _config_dir() / "history.json"
        legacy.write_text(json.dumps([
            {"role": "user", "content": "old question"},
            {"role": "assistant", "content": "old answer"},
        ]))
        migrated = next((s for s in session.list_sessions() if s["name"] == "default"), None)
        self.assertIsNotNone(migrated)
        self.assertEqual(migrated["count"], 2)
        self.assertIn("old question", migrated["preview"])

    def test_02_create_auto_name_and_active(self):
        name = session.create(None)
        self.assertRegex(name, r"session-\d{8}-\d{6}")
        self.assertEqual(session.load(), [])
        self.assertEqual(session.active_name(), name)

    def test_03_save_load_active_only(self):
        session.create("first")
        session.save([{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi"}])
        self.assertEqual(len(session.load()), 2)
        session.create("second")
        self.assertEqual(session.load(), [])
        session.save([{"role": "user", "content": "new line"}])
        self.assertEqual(len(session.load()), 1)

    def test_04_list_markers_and_preview(self):
        items = session.list_sessions()
        self.assertGreaterEqual(len(items), 2)
        second = next((s for s in items if s["name"] == "second"), None)
        first = next((s for s in items if s["name"] == "first"), None)
        self.assertIsNotNone(second)
        self.assertTrue(second["active"])
        self.assertIsNotNone(first)
        self.assertFalse(first["active"])
        self.assertEqual(first["count"], 2)
        self.assertIn("hello", first["preview"])

    def test_05_open_by_index_and_name(self):
        expected = session.list_sessions()[1]["name"]
        self.assertEqual(session.open_session("#2"), expected)
        self.assertEqual(session.active_name(), expected)
        self.assertEqual(session.open_session("first"), "first")
        self.assertEqual(session.load()[0]["content"], "hello")

    def test_06_open_unknown(self):
        self.assertIsNone(session.open_session("does-not-exist"))
        self.assertIsNone(session.open_session("#99"))

    def test_07_remove_non_active(self):
        session.open_session("second")
        session.remove("first")
        self.assertEqual(session.active_name(), "second")
        self.assertNotIn("first", [s["name"] for s in session.list_sessions()])

    def test_08_remove_active_switches(self):
        session.open_session("second")
        removed = session.remove("second")
        self.assertEqual(removed, "second")
        self.assertNotEqual(session.active_name(), "second")

    def test_09_remove_last_creates_new(self):
        session.create("only")
        for item in session.list_sessions():
            session.remove(item["name"])
        items = session.list_sessions()
        self.assertEqual(len(items), 1)
        self.assertTrue(items[0]["active"])
        self.assertEqual(session.load(), [])

    def test_10_clear(self):
        session.create("clear-test")
        session.save([{"role": "user", "content": "x"}])
        self.assertEqual(len(session.load()), 1)
        session.clear()
        self.assertEqual(session.load(), [])

    def test_11_sessions_dir_exists(self):
        self.assertTrue((_config_dir() / "sessions").exists())


# Establish an active session before any test so "default" is only ever
# created through the legacy migration in test_01.
session.create("fresh")

if __name__ == "__main__":
    unittest.main()