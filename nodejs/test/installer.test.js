import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readlinkSync, existsSync, writeFileSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Installer } from '../src/installer.js';

const INSTALLED = ['qwen3:0.6b', 'gemma3:1b', 'llama3.2:1b', 'qwen2.5-coder:1.5b'];

test('installer: exact installed model is used as-is', () => {
  const r = Installer.chooseModel(INSTALLED, 'gemma3:1b');
  assert.equal(r.model, 'gemma3:1b');
  assert.equal(r.substituted, false);
  assert.equal(r.reason, null);
});

test('installer: same-family sibling substitutes qwen2.5:1.5b', () => {
  const r = Installer.chooseModel(INSTALLED, 'qwen2.5:1.5b');
  assert.equal(r.model, 'qwen2.5-coder:1.5b');
  assert.equal(r.substituted, true);
  assert.match(r.reason, /same family/);
});

test('installer: same-family sibling carries across size gaps and variant suffixes', () => {
  const r = Installer.chooseModel(INSTALLED, 'qwen2.5-coder:14b');
  assert.equal(r.model, 'qwen2.5-coder:1.5b');
  assert.equal(Installer.chooseModel(INSTALLED, 'qwen2.5-instruct:3b').model, 'qwen2.5-coder:1.5b');
});

test('installer: no match returns model null (caller falls back to download)', () => {
  const r = Installer.chooseModel(INSTALLED, 'mistral:7b');
  assert.equal(r.model, null);
  assert.equal(r.substituted, true);
});

test('installer: empty installed list never matches', () => {
  const r = Installer.chooseModel([], 'gemma3:1b');
  assert.equal(r.model, null);
});

function withBinDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vrtl-bin-'));
  const oldBin = process.env.XDG_BIN_HOME;
  const oldPath = process.env.PATH;
  try {
    process.env.XDG_BIN_HOME = dir;
    process.env.PATH = `${dir}:${oldPath}`;
    return fn(dir);
  } finally {
    if (oldBin === undefined) delete process.env.XDG_BIN_HOME;
    else process.env.XDG_BIN_HOME = oldBin;
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('installer: installAppCommand creates a live launcher in an on-PATH dir', () =>
  withBinDir((dir) => {
    const cmd = Installer.installAppCommand();
    assert.equal(typeof cmd, 'string');
    assert.equal(cmd, join(dir, 'vierrataleai'));
    assert.ok(existsSync(cmd));
    assert.equal(readlinkSync(cmd), process.argv[1]);
    // The short alias is linked to the same bin.
    const alias = join(dir, 'vierratale');
    assert.ok(existsSync(alias));
    assert.equal(readlinkSync(alias), process.argv[1]);
    assert.equal(Installer.isOnPath(dir), true);
    const bogus = mkdtempSync(join(tmpdir(), 'vrtl-notpath-'));
    try {
      assert.equal(Installer.isOnPath(bogus), false);
    } finally {
      rmSync(bogus, { recursive: true, force: true });
    }
  }));

test('installer: installAppCommand refreshes stale launchers in place', () =>
  withBinDir((dir) => {
    const launcher = join(dir, 'vierrataleai');
    const alias = join(dir, 'vierratale');
    writeFileSync(launcher, '#!/bin/sh\n# stale\n');
    writeFileSync(alias, '#!/bin/sh\n# stale\n');
    Installer.installAppCommand();
    assert.ok(existsSync(launcher));
    assert.equal(readlinkSync(launcher), process.argv[1]);
    assert.ok(lstatSync(launcher).isSymbolicLink());
    assert.ok(existsSync(alias));
    assert.equal(readlinkSync(alias), process.argv[1]);
    assert.ok(lstatSync(alias).isSymbolicLink());
  }));