import { spawn } from 'child_process';
import { dirname, resolve, sep } from 'path';

const ALLOWED_BINS = new Set([
  'mkdir', 'touch', 'ls', 'pwd', 'cat', 'cp', 'mv', 'rm',
  'npm', 'npx', 'node', 'python', 'python3', 'git', 'echo', 'printf',
  'apt', 'apt-get', 'pkg',
]);

// Package-manager commands never run interactively (no TTY), so auto-append a
// confirm flag to mutating subcommands instead of letting apt/pkg block on a
// prompt. pkg is the Termux/Android wrapper, apt/apt-get the Linux ones.
const INSTALL_MANAGERS = new Set(['apt', 'apt-get', 'pkg']);
const INSTALL_SUBCOMMANDS = new Set(['install', 'upgrade', 'remove', 'autoremove', 'purge']);
const INSTALL_CONFIRM_FLAGS = /^-y$|^--yes$|^-dy$|^--assume-yes$/i;

const SHELL_META = /[;&|<>`$]|\$\{|\(\)|\|\||&&/;

// Bins whose *path arguments* must stay inside the workspace. Reads like `ls`
// are unrestricted on purpose; writes/deletes are contained.
const PATH_CONTAINED_BINS = new Set(['mkdir', 'touch', 'cat', 'cp', 'mv', 'rm']);

const MAX_CAPTURE = 200 * 1024;

export function toolResult(overrides = {}) {
  return {
    success: false,
    command: '',
    stdout: '',
    stderr: '',
    exitCode: 0,
    cwd: '',
    timedOut: false,
    ...overrides,
  };
}

// Tokenizer for a single command line. Supports single/double quotes and
// backslash escaping so arguments with spaces are handled without a shell.
export function parseCommandLine(line) {
  const argv = [];
  let buf = null;
  let quote = null;
  const flush = () => {
    if (buf !== null) {
      argv.push(buf);
      buf = null;
    }
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === '\\' && quote === '"') {
        if (i + 1 < line.length) buf += line[++i];
        else buf += c;
      } else {
        buf += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      if (buf === null) buf = '';
      quote = c;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      flush();
      continue;
    }
    if (c === '\\') {
      if (buf === null) buf = '';
      if (i + 1 < line.length) buf += line[++i];
      else buf += c;
      continue;
    }
    if (buf === null) buf = '';
    buf += c;
  }
  flush();
  return argv;
}

export function isAllowedBin(bin) {
  if (!/^[A-Za-z0-9._-]+$/.test(bin || '')) return false;
  return ALLOWED_BINS.has(bin);
}

export class SafeCommandExecutor {
  constructor({ cwd, timeoutMs } = {}) {
    this.cwd = resolve(cwd || process.cwd());
    this.timeoutMs = timeoutMs || 60000;
  }

  // Validate a command line and normalize it to an argv array, or throw with a
  // human-readable reason.
  validate(argv) {
    if (!argv.length) {
      throw new Error('Empty command — nothing to run.');
    }
    const bin = argv[0];
    if (!isAllowedBin(bin)) {
      throw new Error(`Command "${bin}" is not on the allowed list. Use one of: ${[...ALLOWED_BINS].join(', ')}.`);
    }
    const args = argv.slice(1);

    for (const a of args) {
      if (SHELL_META.test(a)) {
        throw new Error(`Shell operators and variable syntax are not allowed in arguments: ${JSON.stringify(a)}`);
      }
    }

    if ((bin === 'node' || bin === 'python' || bin === 'python3') && args.includes('-e') || args.includes('-c')) {
      throw new Error(`Inline code (-e/-c) is disabled for ${bin}. Run a file inside the workspace instead (e.g. ${bin} script.js).`);
    }
    if (bin === 'git' && args.includes('clean')) {
      throw new Error('`git clean` is disabled by the safety policy.');
    }
    if (bin === 'rm') {
      this._checkRm(args);
    }
    if (PATH_CONTAINED_BINS.has(bin)) {
      this._checkPaths(bin, args);
    }
    if (INSTALL_MANAGERS.has(bin)) {
      const subIdx = argv.findIndex((a) => INSTALL_SUBCOMMANDS.has(a));
      if (subIdx !== -1 && !argv.some((a) => INSTALL_CONFIRM_FLAGS.test(a))) {
        argv.splice(subIdx + 1, 0, '-y');
      }
    }
    return argv;
  }

  _resolve(argvIdxArg) {
    const base = resolve(this.cwd);
    const target = resolve(base, argvIdxArg);
    const outside = target !== base && !target.startsWith(base + sep);
    return { base, target, outside };
  }

  _isHomeish(p) {
    return p === '~' || p.startsWith('~/');
  }

  _checkRm(args) {
    const targets = args.filter((a) => !a.startsWith('-'));
    if (!targets.length) {
      throw new Error('`rm` needs a target path.');
    }
    for (const t of targets) {
      if (this._isHomeish(t)) {
        throw new Error(`Refusing to remove ${t} — that path is outside the workspace.`);
      }
      if (t === '*' || t.includes('*')) {
        throw new Error('Wildcards are not expanded (commands run without a shell). Give an explicit path for `rm`.');
      }
      const { base, target, outside } = this._resolve(t);
      if (outside || target === base) {
        throw new Error(`Refusing to remove ${t} — it resolves outside the workspace (${base}).`);
      }
    }
  }

  _checkPaths(bin, args) {
    for (const a of args) {
      if (a.startsWith('-') || a === '--') continue;
      if (this._isHomeish(a)) {
        throw new Error(`Refusing to use ${a} — home-directory paths are outside the workspace.`);
      }
      if (!this._looksLikePath(a)) continue;
      const { base, target, outside } = this._resolve(a);
      if (outside) {
        throw new Error(`${bin}: refusing to touch ${a} — it resolves outside the workspace (${base}).`);
      }
    }
  }

  // Avoid treating plain words (e.g. a file NAME in `npm install foo`) as
  // paths. Only flags, or tokens that contain a path separator or a known
  // relative prefix, are checked.
  _looksLikePath(a) {
    if (a.includes('/') || a.includes('\\') || a.startsWith('.') || a === '..') return true;
    if (/\.[A-Za-z0-9]{1,8}$/.test(a)) return true;
    return false;
  }

  runCommand(commandLine) {
    if (typeof commandLine !== 'string' || !commandLine.trim()) {
      return Promise.resolve(toolResult({
        success: false,
        command: String(commandLine || ''),
        stderr: 'Empty or invalid command.',
        cwd: this.cwd,
      }));
    }
    let argv;
    try {
      argv = this.validate(parseCommandLine(commandLine));
    } catch (err) {
      return Promise.resolve(toolResult({
        success: false,
        command: commandLine,
        stderr: err.message,
        cwd: this.cwd,
      }));
    }
    return this.run(argv, commandLine);
  }

  run(argv, display = argv.join(' ')) {
    return new Promise((resolvePromise) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let childExitCode = 1;

      let child;
      try {
        child = spawn(argv[0], argv.slice(1), { cwd: this.cwd, shell: false });
      } catch (err) {
        return resolvePromise(toolResult({
          success: false,
          command: display,
          stderr: err.message,
          cwd: this.cwd,
        }));
      }

      const finish = (code, dueToTimeout) => {
        if (settled) return;
        settled = true;
        let out = stdout;
        let errOut = stderr;
        if (out.length > MAX_CAPTURE) out = out.slice(-MAX_CAPTURE) + '\n…[truncated]';
        if (errOut.length > MAX_CAPTURE) errOut = errOut.slice(-MAX_CAPTURE) + '\n…[truncated]';
        resolvePromise(toolResult({
          success: code === 0 && !dueToTimeout,
          command: display,
          stdout: out,
          stderr: errOut,
          exitCode: dueToTimeout ? 124 : code,
          cwd: this.cwd,
          timedOut: !!dueToTimeout,
        }));
      };

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch {}
      }, this.timeoutMs);

      child.stdout.on('data', (d) => {
        if (stdout.length < MAX_CAPTURE * 2) stdout += d.toString();
      });
      child.stderr.on('data', (d) => {
        if (stderr.length < MAX_CAPTURE * 2) stderr += d.toString();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        stderr = err.message;
        finish(127, false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(timedOut ? 124 : (code == null ? 1 : code), timedOut);
      });
    });
  }
}