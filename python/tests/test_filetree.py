import os
import shutil
import tempfile
import unittest

from vierrataleai.utils.filetree import render_file_tree


class FileTreeTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="vierra-tree-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def test_renders_nested_structure(self):
        os.makedirs(os.path.join(self.dir, "demo", "src"))
        self._write("demo/halo.txt", "hello")
        self._write("demo/src/main.js", "x")
        lines = render_file_tree(self.dir)
        self.assertEqual(lines[0], ".")
        text = "\n".join(lines)
        self.assertIn("demo", text)
        self.assertIn("halo.txt", text)
        self.assertIn("main.js", text)
        self.assertTrue(any("\u251c" in l or "\u2514" in l for l in lines), lines)
        self.assertLess(lines.index(next(l for l in lines if "demo" in l)),
                        lines.index(next(l for l in lines if "halo.txt" in l)))

    def test_caps_total_entries(self):
        for i in range(30):
            self._write(f"f{i}.txt", "")
        lines = render_file_tree(self.dir, max_entries=10)
        self.assertLess(len(lines), 20)
        self.assertTrue(any("showing first" in l for l in lines), lines)

    def _write(self, rel, content):
        path = os.path.join(self.dir, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)