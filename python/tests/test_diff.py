import os
import subprocess
import tempfile
import unittest

from vierrataleai.utils.diff import git_changes


def _init_repo(d):
    subprocess.run(["git", "init", "-q", d], check=True)
    subprocess.run(["git", "-C", d, "config", "user.email", "t@t"], check=True)
    subprocess.run(["git", "-C", d, "config", "user.name", "t"], check=True)


class DiffTest(unittest.TestCase):
    def test_not_a_git_repo_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(git_changes(d))

    def test_clean_repo_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            _init_repo(d)
            with open(os.path.join(d, "a.py"), "w") as f:
                f.write("print(1)\n")
            subprocess.run(["git", "-C", d, "add", "a.py"], check=True)
            subprocess.run(["git", "-C", d, "commit", "-qm", "init"], check=True)
            self.assertIsNone(git_changes(d))

    def test_modified_file_is_shared(self):
        with tempfile.TemporaryDirectory() as d:
            _init_repo(d)
            with open(os.path.join(d, "a.py"), "w") as f:
                f.write("print(1)\n")
            subprocess.run(["git", "-C", d, "add", "a.py"], check=True)
            subprocess.run(["git", "-C", d, "commit", "-qm", "init"], check=True)
            with open(os.path.join(d, "a.py"), "w") as f:
                f.write("print(2)\n")
            block = git_changes(d)
            self.assertIsNotNone(block)
            self.assertIn("a.py", block)
            self.assertIn("print(2)", block)
            self.assertIn("Diff:", block)

    def test_untracked_file_content_is_inlined(self):
        with tempfile.TemporaryDirectory() as d:
            _init_repo(d)
            with open(os.path.join(d, "new.txt"), "w") as f:
                f.write("fresh content\n")
            block = git_changes(d)
            self.assertIsNotNone(block)
            self.assertIn("new.txt", block)
            self.assertIn("fresh content", block)


if __name__ == "__main__":
    unittest.main()