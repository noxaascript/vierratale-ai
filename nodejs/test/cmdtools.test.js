import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createFile, createDirectory, readFile, listDirectory, deleteFile,
  dispatchTool, makeExecutor,
} from '../src/cmd/tools.js';

function makeCwd() {
  return mkdtempSync(join(tmpdir(), 'vierra-tools-'));
}

test('tools: create/read/list/delete roundtrip', () => {
  const dir = makeCwd();
  try {
    const c = createFile(dir, 'a.txt', 'hello world');
    assert.equal(c.success, true, c.stderr);
    assert.match(c.stdout, /a\.txt \(11 bytes\)/);

    const r = readFile(dir, 'a.txt');
    assert.equal(r.success, true, r.stderr);
    assert.equal(r.stdout, 'hello world');

    const l = listDirectory(dir, '.');
    assert.equal(l.success, true, l.stderr);
    assert.match(l.stdout, /a\.txt/);

    const d = deleteFile(dir, 'a.txt');
    assert.equal(d.success, true, d.stderr);
    assert.equal(readFile(dir, 'a.txt').success, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools: create_directory recursive + nested create_file creates parents', () => {
  const dir = makeCwd();
  try {
    const d = createDirectory(dir, 'x/y/z');
    assert.equal(d.success, true, d.stderr);
    assert.ok(existsSync(join(dir, 'x', 'y', 'z')));

    const c = createFile(dir, 'nested/f.txt', 'data');
    assert.equal(c.success, true, c.stderr);
    assert.equal(readFileSync(join(dir, 'nested', 'f.txt'), 'utf-8'), 'data');
    assert.match(listDirectory(dir, 'nested').stdout, /f\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools: path traversal is refused and things stay inside workspace', () => {
  const dir = makeCwd();
  try {
    assert.equal(createFile(dir, '../evil.txt').success, false);
    assert.equal(createFile(dir, '/etc/evil.txt').success, false);
    assert.equal(readFile(dir, '../../etc/passwd').success, false);
    assert.equal(deleteFile(dir, '..').success, false);
    assert.equal(deleteFile(dir, '../outside').success, false);
    assert.equal(existsSync(join(dir, '..', 'evil.txt')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools: workspace-root guards', () => {
  const dir = makeCwd();
  try {
    const root = createDirectory(dir, '.');
    assert.equal(root.success, true);
    const f = createFile(dir, '.');
    assert.equal(f.success, false, 'create_file at workspace root should be refused');
    const d = deleteFile(dir, '.');
    assert.equal(d.success, false, 'delete_file on workspace root should be refused');
    assert.ok(existsSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools: dispatchTool routes run_command and rejects unknown tools', async () => {
  const dir = makeCwd();
  try {
    const ex = makeExecutor({ cwd: dir });
    const mk = await dispatchTool(ex, { name: 'run_command', params: { command: 'mkdir -p z' } });
    assert.equal(mk.success, true, mk.stderr);
    assert.ok(existsSync(join(dir, 'z')));

    const bad = dispatchTool(ex, { name: 'explode', params: {} });
    assert.equal(bad.success, false);
    assert.match(bad.stderr, /Unknown tool/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools: todo tools add/update/list/clear a .todos.json', async () => {
  const dir = makeCwd();
  try {
    const ex = makeExecutor({ cwd: dir });
    let r = dispatchTool(ex, { name: 'todo_add', params: { text: 'first task' } });
    assert.equal(r.success, true, r.stderr);
    r = dispatchTool(ex, { name: 'todo_add', params: { text: 'second task' } });
    assert.equal(r.success, true, r.stderr);
    r = dispatchTool(ex, { name: 'todo_list', params: {} });
    assert.equal(r.success, true, r.stderr);
    assert.match(r.stdout, /first task/);
    assert.match(r.stdout, /second task/);
    r = dispatchTool(ex, { name: 'todo_update', params: { index: 1, done: true } });
    assert.equal(r.success, true, r.stderr);
    assert.match(r.stdout, /\[x\] first task/);
    r = dispatchTool(ex, { name: 'todo_update', params: { index: 99, done: true } });
    assert.equal(r.success, false);
    assert.match(r.stderr, /No todo #99/);
    const saved = JSON.parse(readFileSync(join(dir, '.todos.json'), 'utf-8'));
    assert.equal(saved.length, 2);
    assert.equal(saved[0].done, true);
    r = dispatchTool(ex, { name: 'todo_clear', params: {} });
    assert.equal(r.success, true, r.stderr);
    assert.match(r.stdout, /no todos yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});