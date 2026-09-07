import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileWriter } from '../src/utils/filewriter.js';

async function withTempDir(fn) {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'filewriter-'));
  process.chdir(dir);
  try {
    await fn(dir);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('filewriter: parses FILE: blocks', () => {
  const { files } = FileWriter.parse([
    'Here is your project:',
    '',
    'FILE: src/app.js',
    '```js',
    "console.log('hi');",
    '```',
    '',
    'FILE: README.md',
    '```',
    '# Project',
    '```',
  ].join('\n'));

  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'src/app.js');
  assert.equal(files[0].language, 'js');
  assert.equal(files[0].content, "console.log('hi');");
  assert.equal(files[1].path, 'README.md');
  assert.equal(files[1].content, '# Project');
});

test('filewriter: ignores code fences without a FILE: header', () => {
  const { files } = FileWriter.parse('```js\nlet x = 1;\n```');
  assert.equal(files.length, 0);
});

test('filewriter: parses FOLDER: lines', () => {
  const { folders } = FileWriter.parse('FOLDER: assets\ndist\nFOLDER: src/components');
  assert.deepEqual(folders, ['assets', 'src/components']);
});

test('filewriter: writes files and nested folders', async () => {
  await withTempDir(async (dir) => {
    const out = await FileWriter.write({
      folders: ['src/components'],
      files: [{
        path: 'src/components/Button.js',
        content: 'export default Button;',
      }],
    });
    assert.equal(out[0].status, 'created');
    assert.equal(out[1].status, 'written');
    assert.equal(readFileSync(join(dir, 'src/components/Button.js'), 'utf-8'), 'export default Button;');
    assert.ok(statSync(join(dir, 'src/components')).isDirectory());
  });
});

test('filewriter: refuses to write outside the working directory', () => {
  assert.throws(() => FileWriter.resolveTarget('../evil.txt'), /outside the working directory/);
  assert.throws(() => FileWriter.resolveTarget('/tmp/evil.txt'), /outside the working directory/);
});

test('filewriter: skips existing files without overwrite', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'a.txt'), 'old');
    const out = await FileWriter.write({ files: [{ path: 'a.txt', content: 'new' }] });
    assert.equal(out[0].status, 'skipped');
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf-8'), 'old');
  });
});

test('filewriter: overwrites when allowed', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'a.txt'), 'old');
    const out = await FileWriter.write({ files: [{ path: 'a.txt', content: 'new' }], overwrite: true });
    assert.equal(out[0].status, 'written');
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf-8'), 'new');
  });
});

test('filewriter: confirm callback can decline overwrite', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'a.txt'), 'old');
    const out = await FileWriter.write({
      files: [{ path: 'a.txt', content: 'new' }],
      confirm: async () => false,
    });
    assert.equal(out[0].status, 'skipped');
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf-8'), 'old');
  });
});

test('filewriter: confirm callback accepts overwrite even without overwrite flag', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'a.txt'), 'old');
    const out = await FileWriter.write({
      files: [{ path: 'a.txt', content: 'new' }],
      confirm: async () => true,
    });
    assert.equal(out[0].status, 'written');
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf-8'), 'new');
  });
});