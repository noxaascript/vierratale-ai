import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path

from vierrataleai.installer import (
    _is_on_path,
    _resolve_from_list,
    app_command_path,
    install_app_command,
)


class ModelResolveTest(unittest.TestCase):
    INSTALLED = ["qwen3:0.6b", "gemma3:1b", "llama3.2:1b", "qwen2.5-coder:1.5b"]

    def test_exact_installed_model_used_as_is(self):
        r = _resolve_from_list(self.INSTALLED, "gemma3:1b")
        self.assertEqual(r["model"], "gemma3:1b")
        self.assertFalse(r["substituted"])
        self.assertIsNone(r["reason"])

    def test_same_family_sibling_substitutes(self):
        r = _resolve_from_list(self.INSTALLED, "qwen2.5:1.5b")
        self.assertEqual(r["model"], "qwen2.5-coder:1.5b")
        self.assertTrue(r["substituted"])
        self.assertIn("same family", r["reason"])

    def test_variant_suffix_matches_family(self):
        r = _resolve_from_list(self.INSTALLED, "qwen2.5-instruct:3b")
        self.assertEqual(r["model"], "qwen2.5-coder:1.5b")

    def test_no_match_returns_none_model(self):
        r = _resolve_from_list(self.INSTALLED, "mistral:7b")
        self.assertIsNone(r["model"])
        self.assertTrue(r["substituted"])

    def test_empty_installed_never_matches(self):
        self.assertIsNone(_resolve_from_list([], "gemma3:1b")["model"])


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self._old_bin = os.environ.get("XDG_BIN_HOME")
        self._old_path = os.environ.get("PATH")
        self._dir = tempfile.mkdtemp(prefix="vrtl-bin-")
        os.environ["XDG_BIN_HOME"] = self._dir
        os.environ["PATH"] = self._dir + os.pathsep + (self._old_path or "")

    def tearDown(self):
        if self._old_bin is None:
            os.environ.pop("XDG_BIN_HOME", None)
        else:
            os.environ["XDG_BIN_HOME"] = self._old_bin
        if self._old_path is None:
            os.environ.pop("PATH", None)
        else:
            os.environ["PATH"] = self._old_path
        shutil.rmtree(self._dir, ignore_errors=True)

    def test_creates_launcher_in_on_path_dir(self):
        self.assertEqual(app_command_path().parent, Path(self._dir))
        cmd = install_app_command()
        self.assertIsNotNone(cmd)
        target = Path(cmd)
        self.assertTrue(target.exists())
        self.assertTrue(target.stat().st_mode & stat.S_IEXEC)
        self.assertTrue(_is_on_path(target.parent))
        # The short alias is created alongside and points at the same python.
        alias = target.parent / "vierratale"
        self.assertTrue(alias.exists())
        self.assertTrue(alias.stat().st_mode & stat.S_IEXEC)
        self.assertIn("exec " + sys.executable, alias.read_text())

    def test_replaces_stale_launchers(self):
        target = app_command_path()
        target.write_text("#!/bin/sh\n# stale\n")
        alias = target.parent / "vierratale"
        alias.write_text("#!/bin/sh\n# stale\n")
        install_app_command()
        self.assertNotIn("# stale", target.read_text())
        self.assertIn("exec " + sys.executable, target.read_text())
        self.assertNotIn("# stale", alias.read_text())
        self.assertIn("exec " + sys.executable, alias.read_text())

    def test_not_on_path_detection(self):
        bogus = Path(tempfile.mkdtemp(prefix="vrtl-notpath-"))
        try:
            self.assertFalse(_is_on_path(bogus))
        finally:
            shutil.rmtree(bogus, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()