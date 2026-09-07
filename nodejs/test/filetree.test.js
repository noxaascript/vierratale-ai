import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderFileTree } from '../src/utils/filetree.js';

test('filetree: renders nested structure with box-drawing connectors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vierra-tree-'));
  try {
    mkdirSync(join(dir, 'demo', 'src'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'halo.txt'), 'hello');
    writeFileSync(join(dir, 'demo', 'src', 'main.js'), 'x');
    const lines = renderFileTree(dir);
    assert.equal(lines[0], '.');
    assert.ok(lines.some((l) => l.includes('demo')), JSON.stringify(lines));
    assert.ok(lines.some((l) => l.includes('halo.txt')), JSON.stringify(lines));
    assert.ok(lines.some((l) => l.includes('main.js')), JSON.stringify(lines));
    assert.ok(lines.some((l) => /\u251c|\u2514/.test(l) && /\u2500/.test(l)), JSON.stringify(lines));
    // Directories sort before files at the same level.
    const demoIdx = lines.findIndex((l) => l.includes('demo'));
    const haloIdx = lines.findIndex((l) => l.includes('halo.txt'));
    assert.ok(demoIdx !== -1 && haloIdx !== -1 && demoIdx < haloIdx, JSON.stringify(lines));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('filetree: caps the number of rendered entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vierra-tree-cap-'));
  try {
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `f${i}.txt`), '');
    const lines = renderFileTree(dir, { maxEntries: 10 });
    assert.ok(lines.length < 20, JSON.stringify(lines));
    assert.ok(lines.some((l) => l.includes('showing first')), JSON.stringify(lines));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});