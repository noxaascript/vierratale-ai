import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SafeCommandExecutor, parseCommandLine } from '../src/cmd/executor.js';

function makeCwd() {
  return mkdtempSync(join(tmpdir(), 'vierra-exec-'));
}

async function inDir(run) {
  const dir = makeCwd();
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('executor: mkdir -p creates nested dirs and reports success', () => inDir(async (dir) => {
  const ex = new SafeCommandExecutor({ cwd: dir });
  const r = await ex.runCommand('mkdir -p a/b/c');
  assert.equal(r.success, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.cwd, dir);
  assert.ok(existsSync(join(dir, 'a', 'b', 'c')));
}));

test('executor: capture stdout/stderr/exit code', () => inDir(async (dir) => {
  const ex = new SafeCommandExecutor({ cwd: dir });
  const good = await ex.runCommand('echo hello world');
  assert.equal(good.success, true);
  assert.match(good.stdout.trim(), /^hello world$/);

  const bad = await ex.runCommand('cat does-not-exist.txt');
  assert.equal(bad.success, false);
  assert.equal(bad.stderr.trim().length > 0, true);
  assert.equal(bad.exitCode, 1);

  writeFileSync(join(dir, 'fail.js'), 'process.exit(9);');
  const fail = await ex.runCommand('node fail.js');
  assert.equal(fail.exitCode, 9);
  assert.equal(fail.success, false);
}));

test('executor: quoted args with spaces are handled', () => inDir(async (dir) => {
  const ex = new SafeCommandExecutor({ cwd: dir });
  const r = await ex.runCommand('touch "hello world.txt"');
  assert.equal(r.success, true, r.stderr);
  assert.ok(existsSync(join(dir, 'hello world.txt')));
  assert.deepEqual(parseCommandLine('touch "a b" c'), ['touch', 'a b', 'c']);
}));

test('executor: works inside the configured cwd (pwd check)', () => inDir(async (dir) => {
  const ex = new SafeCommandExecutor({ cwd: dir });
  const r = await ex.runCommand('pwd');
  assert.equal(r.stdout.trim(), dir);
}));

test('executor: blocks disallowed binaries', () => inDir(async (dir) => {
  const ex = new SafeCommandExecutor({ cwd: dir });
  for (const cmd of ['sudo rm -rf /', 'sh -c "ls"', './script.sh', 'curl http://x', 'chmod 777 a.txt']) {
    const r = await ex.runCommand(cmd);
    assert.equal(r.success, false, cmd);
    assert.match(r.stderr, /not on the allowed list/);
  }
}));

test('executor: blocks destructive rm outside workspace and wildcards', () => inDir(async (dir) => {
  const ex = new SafeCommandExecutor({ cwd: dir });
  for (const cmd of ['rm -rf /tmp', 'rm -rf ..', 'rm -rf ~', 'rm -rf /', 'rm -rf *', 'rm -rf ../../x']) {
    const r = await ex.runCommand(cmd);
    assert.equal(r.success, false, cmd);
    assert.match(r.stderr, /Refusing to remove|wildcards are not expanded/i);
  }
}));

test('executor: blocks path traversal in file commands', () => inDir(async (dir) => {
  const ex = new SafeCommandExecutor({ cwd: dir });
  for (const cmd of ['cat ../../../etc/passwd', 'cat /etc/passwd', 'touch ../evil.txt', 'cp /etc/hostname x.txt']) {
    const r = await ex.runCommand(cmd);
    assert.equal(r.success, false, cmd);
    assert.match(r.stderr, /outside the workspace/);
  }
  const mk = await ex.runCommand('mkdir -p sub');
  assert.equal(mk.success, true, mk.stderr);
  const inner = await ex.runCommand('touch sub/file.txt');
  assert.equal(inner.success, true, inner.stderr);
}));

test('executor: blocks shell operators and inline -e/-c code', () => inDir(async (dir) => {
  const ex = new SafeCommandExecutor({ cwd: dir });
  for (const cmd of ['ls && echo x', 'ls; echo x', 'echo one | wc -c', 'echo "> out"', 'node -e "console.log(1)"', "python3 -c 'print(1)'"]) {
    const r = await ex.runCommand(cmd);
    assert.equal(r.success, false, cmd);
  }
}));

test('executor: pkg/apt install auto-appends the -y confirm flag', () => {
  const ex = new SafeCommandExecutor({ cwd: '.', timeoutMs: 1000 });
  assert.deepEqual(ex.validate(['pkg', 'install', 'curl', 'wget']), ['pkg', 'install', '-y', 'curl', 'wget']);
  assert.deepEqual(ex.validate(['apt', 'install', 'jq']), ['apt', 'install', '-y', 'jq']);
  assert.deepEqual(ex.validate(['apt-get', 'install', 'git']), ['apt-get', 'install', '-y', 'git']);
  assert.deepEqual(ex.validate(['pkg', 'remove', 'curl']), ['pkg', 'remove', '-y', 'curl']);
  // Already-confirmed and non-mutating invocations stay untouched
  assert.deepEqual(ex.validate(['apt', 'install', '--yes', 'jq']), ['apt', 'install', '--yes', 'jq']);
  assert.deepEqual(ex.validate(['pkg', 'search', 'curl']), ['pkg', 'search', 'curl']);
  assert.deepEqual(ex.validate(['pkg', 'show', 'curl']), ['pkg', 'show', 'curl']);
});

test('executor: timeouts kill long-running commands (exit 124)', () => inDir(async (dir) => {
  const ex = new SafeCommandExecutor({ cwd: dir, timeoutMs: 250 });
  const r = await ex.run(['node', '-e', 'setTimeout(()=>{}, 5000)'], 'node slow');
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, 124);
  assert.equal(r.success, false);
}));

test('executor: ls captures output', () => inDir(async (dir) => {
  writeFileSync(join(dir, 'a.txt'), 'x');
  writeFileSync(join(dir, 'b.txt'), 'y');
  const ex = new SafeCommandExecutor({ cwd: dir });
  const r = await ex.runCommand('ls');
  assert.equal(r.success, true);
  assert.match(r.stdout, /a\.txt/);
  assert.match(r.stdout, /b\.txt/);
}));