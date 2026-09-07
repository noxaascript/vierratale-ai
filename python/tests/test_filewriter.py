import os
import shutil
import tempfile
import unittest
from pathlib import Path

from vierrataleai.utils.filewriter import FileWriter


class FileWriterParseTest(unittest.TestCase):
    def test_parses_file_blocks(self):
        text = "\n".join([
            "Here is your project:",
            "",
            "FILE: src/app.py",
            "```python",
            "print('hi')",
            "```",
            "",
            "FILE: config.json",
            "```json",
            '{"name": "app"}',
            "```",
        ])
        parsed = FileWriter.parse(text)

        self.assertEqual(len(parsed["files"]), 2)
        self.assertEqual(parsed["files"][0]["path"], "src/app.py")
        self.assertEqual(parsed["files"][0]["language"], "python")
        self.assertEqual(parsed["files"][0]["content"], "print('hi')")
        self.assertEqual(parsed["files"][1]["path"], "config.json")
        self.assertEqual(parsed["files"][1]["content"], '{"name": "app"}')

    def test_ignores_fences_without_file_header(self):
        parsed = FileWriter.parse("```json\n{}\n```")
        self.assertEqual(parsed["files"], [])

    def test_parses_folder_lines(self):
        parsed = FileWriter.parse("FOLDER: assets\nFOLDER: src/components")
        self.assertEqual(parsed["folders"], ["assets", "src/components"])


class FileWriterWriteTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._cwd = os.getcwd()
        self._tmp = tempfile.mkdtemp(prefix="filewriter-")
        os.chdir(self._tmp)

    def tearDown(self):
        os.chdir(self._cwd)
        shutil.rmtree(self._tmp, ignore_errors=True)

    async def test_writes_files_and_nested_folders(self):
        results = await FileWriter.write(
            folders=["src/components"],
            files=[{
                "path": "src/components/Button.py",
                "content": "class Button: pass",
            }],
        )
        self.assertEqual(results[0]["status"], "created")
        self.assertEqual(results[1]["status"], "written")
        self.assertEqual(
            Path(self._tmp, "src/components/Button.py").read_text(),
            "class Button: pass",
        )
        self.assertTrue(Path(self._tmp, "src/components").is_dir())

    def test_refuses_outside_working_dir(self):
        for bad in ("../evil.txt", "/tmp/evil.txt"):
            with self.assertRaises(ValueError, msg=bad):
                FileWriter.resolve_target(bad)

    async def test_skips_existing_without_overwrite(self):
        Path(self._tmp, "a.txt").write_text("old")
        results = await FileWriter.write(files=[{"path": "a.txt", "content": "new"}])
        self.assertEqual(results[0]["status"], "skipped")
        self.assertEqual(Path(self._tmp, "a.txt").read_text(), "old")

    async def test_overwrites_when_allowed(self):
        Path(self._tmp, "a.txt").write_text("old")
        results = await FileWriter.write(
            files=[{"path": "a.txt", "content": "new"}], overwrite=True
        )
        self.assertEqual(results[0]["status"], "written")
        self.assertEqual(Path(self._tmp, "a.txt").read_text(), "new")

    async def test_confirm_can_decline_overwrite(self):
        Path(self._tmp, "a.txt").write_text("old")

        async def decline(_msg):
            return False

        results = await FileWriter.write(
            files=[{"path": "a.txt", "content": "new"}], confirm=decline
        )
        self.assertEqual(results[0]["status"], "skipped")
        self.assertEqual(Path(self._tmp, "a.txt").read_text(), "old")

    async def test_confirm_accept_overwrites_without_overwrite_flag(self):
        Path(self._tmp, "a.txt").write_text("old")

        async def accept(_msg):
            return True

        results = await FileWriter.write(
            files=[{"path": "a.txt", "content": "new"}], confirm=accept
        )
        self.assertEqual(results[0]["status"], "written")
        self.assertEqual(Path(self._tmp, "a.txt").read_text(), "new")


if __name__ == "__main__":
    unittest.main()