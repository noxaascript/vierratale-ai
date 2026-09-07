import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Logger } from '../src/utils/logger.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'vtrl-log-'));
}

test('logger: writes timestamped entries into logs/ under the base dir', () => {
  const dir = tmpDir();
  const L = new Logger();
  L.init({ baseDir: dir });
  L.log('EVENT', 'hello world');
  const file = L.getPath();
  assert.ok(file && file.endsWith('.log'));
  assert.ok(existsSync(file));
  const raw = readFileSync(file, 'utf-8');
  assert.match(raw, /\[EVENT\] hello world/);
  rmSync(dir, { recursive: true, force: true });
});

test('logger: tail returns the last entries', () => {
  const dir = tmpDir();
  const L = new Logger();
  L.init({ baseDir: dir });
  L.log('A', 'one');
  L.log('B', 'two');
  const tail = L.tail(5);
  assert.equal(tail.length, 2);
  assert.match(tail[1], /\[B\] two/);
  rmSync(dir, { recursive: true, force: true });
});

test('logger: long entries are capped', () => {
  const dir = tmpDir();
  const L = new Logger();
  L.init({ baseDir: dir });
  L.log('BIG', 'x'.repeat(5000));
  const last = readFileSync(L.getPath(), 'utf-8').split('\n').filter(Boolean).at(-1);
  assert.ok(last.length < 3000);
  rmSync(dir, { recursive: true, force: true });
});

test('logger: no-op until init() so tests never write to the real config dir', () => {
  const L = new Logger();
  assert.equal(L.log('X', 'should be ignored'), '');
  assert.equal(L.getPath(), null);
  assert.deepEqual(L.tail(5), []);
});