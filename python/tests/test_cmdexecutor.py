import os
import re
import shutil
import tempfile
import unittest

from vierrataleai.cmd.executor import SafeCommandExecutor, parse_command_line


class ExecutorTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="vierra-exec-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.exe = SafeCommandExecutor(cwd=self.dir)

    def test_mkdir_p_creates_nested(self):
        r = self.exe.run_command("mkdir -p a/b/c")
        self.assertTrue(r["success"], r["stderr"])
        self.assertEqual(r["exit_code"], 0)
        self.assertTrue(os.path.isdir(os.path.join(self.dir, "a", "b", "c")))

    def test_capture_stdout_stderr_exit(self):
        good = self.exe.run_command("echo hello world")
        self.assertTrue(good["success"])
        self.assertRegex(good["stdout"].strip(), r"^hello world$")
        bad = self.exe.run_command("cat does-not-exist.txt")
        self.assertFalse(bad["success"])
        self.assertEqual(bad["exit_code"], 1)
        self.assertTrue(bad["stderr"].strip())
        fail_path = os.path.join(self.dir, "fail.py")
        with open(fail_path, "w") as f:
            f.write("import sys\nsys.exit(9)\n")
        fail = self.exe.run_command("python fail.py")
        self.assertEqual(fail["exit_code"], 9)
        self.assertFalse(fail["success"])

    def test_quoted_args(self):
        r = self.exe.run_command('touch "hello world.txt"')
        self.assertTrue(r["success"], r["stderr"])
        self.assertTrue(os.path.exists(os.path.join(self.dir, "hello world.txt")))
        self.assertEqual(parse_command_line('touch "a b" c'), ["touch", "a b", "c"])

    def test_pwd_is_cwd(self):
        r = self.exe.run_command("pwd")
        self.assertEqual(r["stdout"].strip(), self.dir)

    def test_block_disallowed_bins(self):
        for cmd in ["sudo rm -rf /", 'sh -c "ls"', "./script.sh", "curl http://x", "chmod 777 a.txt"]:
            r = self.exe.run_command(cmd)
            self.assertFalse(r["success"], cmd)
            self.assertRegex(r["stderr"], r"not on the allowed list")

    def test_block_destructive_rm(self):
        for cmd in ["rm -rf /tmp", "rm -rf ..", "rm -rf ~", "rm -rf /", "rm -rf *", "rm -rf ../../x"]:
            r = self.exe.run_command(cmd)
            self.assertFalse(r["success"], cmd)
            self.assertTrue(re.search(r"Refusing to remove|wildcards are not expanded", r["stderr"], re.I), r["stderr"])

    def test_block_traversal(self):
        for cmd in ["cat ../../../etc/passwd", "cat /etc/passwd", "touch ../evil.txt", "cp /etc/hostname x.txt"]:
            r = self.exe.run_command(cmd)
            self.assertFalse(r["success"], cmd)
            self.assertRegex(r["stderr"], r"outside the workspace")
        self.assertTrue(self.exe.run_command("mkdir -p sub")["success"])
        inner = self.exe.run_command("touch sub/file.txt")
        self.assertTrue(inner["success"], inner["stderr"])

    def test_block_shell_ops_and_inline(self):
        for cmd in ['ls && echo x', "ls; echo x", "echo one | wc -c", 'echo "> out"', 'node -e "console.log(1)"', "python3 -c 'print(1)'"]:
            r = self.exe.run_command(cmd)
            self.assertFalse(r["success"], cmd)

    def test_pkg_apt_install_autoadds_yes(self):
        self.assertEqual(self.exe.validate(["pkg", "install", "curl", "wget"]), ["pkg", "install", "-y", "curl", "wget"])
        self.assertEqual(self.exe.validate(["apt", "install", "jq"]), ["apt", "install", "-y", "jq"])
        self.assertEqual(self.exe.validate(["apt-get", "install", "git"]), ["apt-get", "install", "-y", "git"])
        self.assertEqual(self.exe.validate(["pkg", "remove", "curl"]), ["pkg", "remove", "-y", "curl"])
        self.assertEqual(self.exe.validate(["apt", "install", "--yes", "jq"]), ["apt", "install", "--yes", "jq"])
        self.assertEqual(self.exe.validate(["pkg", "search", "curl"]), ["pkg", "search", "curl"])
        self.assertEqual(self.exe.validate(["pkg", "show", "curl"]), ["pkg", "show", "curl"])

    def test_timeout(self):
        ex = SafeCommandExecutor(cwd=self.dir, timeout_ms=250)
        r = ex.run(["node", "-e", "setTimeout(()=>{}, 5000)"], "node slow")
        self.assertTrue(r["timed_out"])
        self.assertEqual(r["exit_code"], 124)
        self.assertFalse(r["success"])

    def test_ls_captures_output(self):
        for name in ("a.txt", "b.txt"):
            with open(os.path.join(self.dir, name), "w") as fh:
                fh.write("x")
        r = self.exe.run_command("ls")
        self.assertRegex(r["stdout"], r"a\.txt")
        self.assertRegex(r["stdout"], r"b\.txt")