import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gitChanges } from '../src/utils/diff.js';

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vierra-diff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  return dir;
}

test('diff: not a git repo returns null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vierra-diff-'));
  try {
    assert.equal(await gitChanges(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diff: clean repo returns null', async (t) => {
  const dir = makeRepo(t);
  writeFileSync(join(dir, 'a.py'), 'print(1)\n');
  execFileSync('git', ['-C', dir, 'add', 'a.py']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
  assert.equal(await gitChanges(dir), null);
});

test('diff: modified + untracked files are shared', async (t) => {
  const dir = makeRepo(t);
  writeFileSync(join(dir, 'a.py'), 'print(1)\n');
  execFileSync('git', ['-C', dir, 'add', 'a.py']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
  writeFileSync(join(dir, 'a.py'), 'print(2)\n');
  writeFileSync(join(dir, 'new.txt'), 'fresh content\n');
  const block = await gitChanges(dir);
  assert.ok(block);
  assert.ok(block.includes('a.py'));
  assert.ok(block.includes('print(2)'));
  assert.ok(block.includes('new.txt'));
  assert.ok(block.includes('fresh content'));
});