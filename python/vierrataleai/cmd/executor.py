import os
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

ALLOWED_BINS = {
    "mkdir", "touch", "ls", "pwd", "cat", "cp", "mv", "rm",
    "npm", "npx", "node", "python", "python3", "git", "echo", "printf",
    "apt", "apt-get", "pkg",
}

# Package-manager commands never run interactively (no TTY), so auto-append a
# confirm flag to mutating subcommands instead of letting apt/pkg block on a
# prompt. pkg is the Termux/Android wrapper, apt/apt-get the Linux ones.
INSTALL_MANAGERS = {"apt", "apt-get", "pkg"}
INSTALL_SUBCOMMANDS = {"install", "upgrade", "remove", "autoremove", "purge"}
INSTALL_CONFIRM_FLAGS = ("-y", "--yes", "-dy", "--assume-yes")

SHELL_META = re.compile(r"[;&|<>`$]|\$\{|\(\)|\|\||&&")
MAX_CAPTURE = 200 * 1024


def tool_result(**overrides: Any) -> Dict[str, Any]:
    r: Dict[str, Any] = {
        "success": False,
        "command": "",
        "stdout": "",
        "stderr": "",
        "exit_code": 0,
        "cwd": "",
        "timed_out": False,
    }
    r.update(overrides)
    return r


def is_allowed_bin(b: str) -> bool:
    return re.fullmatch(r"[A-Za-z0-9._-]+", b or "") is not None and b in ALLOWED_BINS


def parse_command_line(line: str) -> List[str]:
    try:
        return shlex.split(line)
    except ValueError:
        raise ValueError(f"Unterminated quote in command: {line!r}")


def _is_homeish(p: str) -> bool:
    return p == "~" or p.startswith("~/") or p.startswith("~\\") or p.startswith("~/")


class SafeCommandExecutor:
    def __init__(self, cwd: Optional[Union[str, Path]] = None, timeout_ms: Optional[int] = None):
        self.cwd = str(Path(cwd or Path.cwd()).resolve())
        self.timeout_ms = timeout_ms or 60_000

    # ------------------------------------------------------------------ #
    # Validation helpers
    # ------------------------------------------------------------------ #

    def _resolve(self, arg: str) -> Path:
        base = Path(self.cwd).resolve()
        if os.path.isabs(arg):
            return Path(arg).resolve()
        return (base / arg).resolve()

    def _looks_like_path(self, arg: str) -> bool:
        if "/" in arg or "\\" in arg or arg.startswith(".") or arg == "..":
            return True
        return bool(re.search(r"\.[A-Za-z0-9]{1,8}$", arg))

    def validate(self, argv: List[str]) -> List[str]:
        if not argv:
            raise ValueError("Empty command — nothing to run.")
        bin_name = argv[0]
        if not is_allowed_bin(bin_name):
            raise ValueError(
                f'Command "{bin_name}" is not on the allowed list. '
                f"Use one of: {', '.join(sorted(ALLOWED_BINS))}."
            )
        args = argv[1:]
        for a in args:
            if SHELL_META.search(a):
                raise ValueError(
                    f"Shell operators and variable syntax are not allowed in arguments: {a!r}"
                )

        if bin_name in ("node", "python", "python3") and ("-e" in args or "-c" in args):
            raise ValueError(
                f"Inline code (-e/-c) is disabled for {bin_name}. "
                "Run a file inside the workspace instead."
            )
        if bin_name == "git" and "clean" in args:
            raise ValueError("`git clean` is disabled by the safety policy.")
        if bin_name == "rm":
            self._check_rm(args)
        if bin_name in {"mkdir", "touch", "cat", "cp", "mv", "rm"}:
            self._check_paths(bin_name, args)
        if bin_name in INSTALL_MANAGERS:
            sub_idx = next((i for i, a in enumerate(argv) if a in INSTALL_SUBCOMMANDS), -1)
            if sub_idx != -1 and not any(a in INSTALL_CONFIRM_FLAGS for a in argv):
                argv.insert(sub_idx + 1, "-y")
        return argv

    # ------------------------------------------------------------------ #

    def _check_rm(self, args: List[str]) -> None:
        targets = [a for a in args if not a.startswith("-")]
        if not targets:
            raise ValueError("`rm` needs a target path.")
        for t in targets:
            if _is_homeish(t):
                raise ValueError(f"Refusing to remove {t} — that path is outside the workspace.")
            if t == "*" or "*" in t:
                raise ValueError(
                    "Wildcards are not expanded (commands run without a shell). "
                    "Give an explicit path for `rm`."
                )
            p = self._resolve(t)
            base = Path(self.cwd).resolve()
            outside = (p != base) and not str(p).startswith(str(base) + os.sep)
            if outside or p == base:
                raise ValueError(
                    f"Refusing to remove {t} — it resolves outside the workspace ({base})."
                )

    def _check_paths(self, bin_name: str, args: List[str]) -> None:
        base = Path(self.cwd).resolve()
        for a in args:
            if a.startswith("-") or a == "--":
                continue
            if _is_homeish(a):
                raise ValueError(
                    f"Refusing to use {a} — home-directory paths are outside the workspace."
                )
            if not self._looks_like_path(a):
                continue
            p = self._resolve(a)
            outside = (p != base) and not str(p).startswith(str(base) + os.sep)
            if outside:
                raise ValueError(
                    f"{bin_name}: refusing to touch {a} — it resolves outside the workspace ({base})."
                )

    # ------------------------------------------------------------------ #
    # Run
    # ------------------------------------------------------------------ #

    def run_command(self, command_line: str) -> Dict[str, Any]:
        command_line = str(command_line or "").strip()
        if not command_line:
            return tool_result(
                command=command_line,
                stderr="Empty or invalid command.",
                cwd=self.cwd,
            )
        try:
            argv = self.validate(parse_command_line(command_line))
        except Exception as exc:
            return tool_result(command=command_line, stderr=str(exc), cwd=self.cwd)
        return self.run(argv, command_line)

    def run(self, argv: List[str], display: Optional[str] = None) -> Dict[str, Any]:
        display = display or " ".join(argv)
        try:
            result = subprocess.run(
                argv,
                cwd=self.cwd,
                capture_output=True,
                timeout=self.timeout_ms / 1000,
                text=True,
                encoding="utf-8",
                errors="replace",
                shell=False,
            )
            stdout = result.stdout or ""
            stderr = result.stderr or ""
            timed_out = False
        except subprocess.TimeoutExpired:
            stdout = ""
            stderr = ""
            timed_out = True
            return tool_result(
                command=display,
                exit_code=124,
                timed_out=True,
                cwd=self.cwd,
            )
        except Exception as exc:
            return tool_result(
                command=display,
                stderr=str(exc),
                exit_code=127,
                cwd=self.cwd,
            )
        if len(stdout) > MAX_CAPTURE:
            stdout = stdout[-MAX_CAPTURE:] + "\n…[truncated]"
        if len(stderr) > MAX_CAPTURE:
            stderr = stderr[-MAX_CAPTURE:] + "\n…[truncated]"
        code = result.returncode
        return tool_result(
            command=display,
            stdout=stdout,
            stderr=stderr,
            exit_code=code,
            success=(code == 0),
            cwd=self.cwd,
            timed_out=timed_out,
        )
