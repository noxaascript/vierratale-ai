import json
import os
import shutil
import tempfile
import unittest

from vierrataleai.cmd.tools import (
    create_file, create_directory, read_file, list_directory, delete_file,
    dispatch_tool, make_executor,
)


class ToolsTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="vierra-tools-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def test_create_read_list_delete(self):
        c = create_file(self.dir, "a.txt", "hello world")
        self.assertTrue(c["success"], c["stderr"])
        self.assertIn("a.txt (11 bytes)", c["stdout"])
        r = read_file(self.dir, "a.txt")
        self.assertTrue(r["success"], r["stderr"])
        self.assertEqual(r["stdout"], "hello world")
        l = list_directory(self.dir, ".")
        self.assertIn("a.txt", l["stdout"])
        d = delete_file(self.dir, "a.txt")
        self.assertTrue(d["success"], d["stderr"])
        self.assertFalse(read_file(self.dir, "a.txt")["success"])

    def test_nested_directory_and_file(self):
        d = create_directory(self.dir, "x/y/z")
        self.assertTrue(d["success"], d["stderr"])
        self.assertTrue(os.path.isdir(os.path.join(self.dir, "x", "y", "z")))
        c = create_file(self.dir, "nested/f.txt", "data")
        self.assertTrue(c["success"], c["stderr"])
        with open(os.path.join(self.dir, "nested", "f.txt")) as fh:
            self.assertEqual(fh.read(), "data")
        self.assertIn("f.txt", list_directory(self.dir, "nested")["stdout"])

    def test_path_traversal_blocked(self):
        self.assertFalse(create_file(self.dir, "../evil.txt")["success"])
        self.assertFalse(create_file(self.dir, "/etc/evil.txt")["success"])
        self.assertFalse(read_file(self.dir, "../../etc/passwd")["success"])
        self.assertFalse(delete_file(self.dir, "..")["success"])
        self.assertFalse(delete_file(self.dir, "../outside")["success"])
        self.assertFalse(os.path.exists(os.path.join(self.dir, "..", "evil.txt")))

    def test_workspace_root_guards(self):
        self.assertTrue(create_directory(self.dir, ".")["success"])
        self.assertFalse(create_file(self.dir, ".")["success"])
        self.assertFalse(delete_file(self.dir, ".")["success"])
        self.assertTrue(os.path.exists(self.dir))

    def test_dispatch_tool_routes_and_rejects_unknown(self):
        ex = make_executor(cwd=self.dir)
        mk = dispatch_tool(ex, {"name": "run_command", "params": {"command": "mkdir -p z"}})
        self.assertTrue(mk["success"], mk["stderr"])
        self.assertTrue(os.path.isdir(os.path.join(self.dir, "z")))
        bad = dispatch_tool(ex, {"name": "explode", "params": {}})
        self.assertFalse(bad["success"])
        self.assertIn("Unknown tool", bad["stderr"])

    def test_todo_tools(self):
        ex = make_executor(cwd=self.dir)
        r = dispatch_tool(ex, {"name": "todo_add", "params": {"text": "first task"}})
        self.assertTrue(r["success"], r["stderr"])
        r = dispatch_tool(ex, {"name": "todo_add", "params": {"text": "second task"}})
        self.assertTrue(r["success"], r["stderr"])
        r = dispatch_tool(ex, {"name": "todo_list", "params": {}})
        self.assertTrue(r["success"], r["stderr"])
        self.assertIn("first task", r["stdout"])
        self.assertIn("second task", r["stdout"])
        r = dispatch_tool(ex, {"name": "todo_update", "params": {"index": 1, "done": True}})
        self.assertTrue(r["success"], r["stderr"])
        self.assertIn("[x] first task", r["stdout"])
        r = dispatch_tool(ex, {"name": "todo_update", "params": {"index": 99, "done": True}})
        self.assertFalse(r["success"])
        self.assertIn("No todo #99", r["stderr"])
        with open(os.path.join(self.dir, ".todos.json")) as fh:
            saved = json.load(fh)
        self.assertEqual(len(saved), 2)
        self.assertTrue(saved[0]["done"])
        r = dispatch_tool(ex, {"name": "todo_clear", "params": {}})
        self.assertTrue(r["success"], r["stderr"])
        self.assertIn("no todos yet", r["stdout"])