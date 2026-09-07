import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { logger } from '../src/utils/logger.js';
import { writeFilesFromResponse } from '../src/cli.js';

let work, configDir, logPath, originalCwd;

before(() => {
  originalCwd = process.cwd();
  work = mkdtempSync(path.join(tmpdir(), 'vierra-int-'));
  configDir = mkdtempSync(path.join(tmpdir(), 'vierra-cfg-'));
  logger.init({ baseDir: configDir });
  logPath = logger.getPath();
  process.chdir(work);
});

after(() => {
  process.chdir(originalCwd);
  rmSync(work, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runScenario(response, requestText, preexisting = []) {
  for (const f of readdirSync(work)) rmSync(path.join(work, f), { recursive: true, force: true });
  for (const f of preexisting) writeFileSync(path.join(work, f), 'old');
  writeFileSync(logPath, '');
  const notices = [];
  await writeFilesFromResponse(response, () => Promise.resolve(false), requestText, (m) => notices.push(m));
  await sleep(250);
  const disk = readdirSync(work);
  const logText = await stableLog();
  return {
    disk,
    notices,
    events: [...logText.matchAll(/^[0-9]{4}.*?\[(\w+)\]/gm)].map((m) => m[1]),
    log: logText,
  };
}

async function stableLog() {
  let prev = null;
  for (let i = 0; i < 15; i++) {
    let cur = '';
    try {
      cur = readFileSync(logPath, 'utf8');
    } catch {
      cur = '';
    }
    if (prev !== null && cur === prev) return cur;
    prev = cur;
    await sleep(200);
  }
  return prev;
}

test('integration: clean python web+route request writes app.py cleanly, no warnings', async () => {
  const resp = '```python\nfrom flask import Flask\napp = Flask(__name__)\n\n@app.route("/")\ndef home():\n    return "<h1>Hi</h1>"\n```';
  const r = await runScenario(resp, 'make a web with html and python route them all');
  assert.deepEqual(r.disk.sort(), ['app.py']);
  assert.equal(existsSync(path.join(work, 'app.py')), true);
  assert.ok(!r.notices.some((m) => /junk|Heads up/i.test(m)), `notices: ${r.notices}`);
  assert.ok(!r.notices.some((m) => /couldn't compile/i.test(m)), `notices: ${r.notices}`);
  assert.ok(r.events.includes('FILE'), r.events);
  assert.ok(!r.events.includes('WARN'), r.events);
  assert.ok(!r.events.includes('ERROR'), r.events);
});

test('integration: junk placeholder reply still saved but WARN + user warning', async () => {
  const resp = '```python\ndef generate_web_project(file_name="web_project.py"):\n  f.write("[0] # This is a Python web project file.")\n  f.write(\'<script src="https://code.google.com/add-on/script/google-chrome-extension.js">\')\n```';
  const r = await runScenario(resp, 'make a web with python');
  assert.ok(r.disk.includes('app.py'), r.disk);
  assert.ok(r.notices.some((m) => /Heads up/.test(m)), r.notices);
  assert.ok(r.events.includes('WARN'), r.events);
  assert.ok(r.log.includes('[WARN] possible junk content saved to app.py'));
});

test('integration: truncated reply mid-string is caught by compile check', async () => {
  const resp = '```python\ndef broken():\n  f.write("[0] never closed\n  return 1\n```';
  const r = await runScenario(resp, 'write a python script');
  assert.ok(r.disk.includes('script.py'), r.disk); // fenced => saved
  assert.ok(r.notices.some((m) => /couldn't compile/i.test(m)), r.notices);
  assert.ok(r.events.includes('ERROR'), r.events);
});

test('integration: multi-file project with FOLDER: + FILE: blocks', async () => {
  const resp =
    'FOLDER: site\n' +
    'FILE: site/index.html\n' +
    '```html\n<h1>Hi</h1>\n```\n' +
    'FILE: site/style.css\n' +
    '```css\nbody { color: red; }\n```\n' +
    'FILE: site/app.py\n' +
    '```python\nfrom flask import Flask\napp = Flask(__name__)\n```\n';
  const r = await runScenario(resp, 'make a website');
  assert.deepEqual(r.disk.sort(), ['site'], r.disk);
  assert.equal(existsSync(path.join(work, 'site/index.html')), true);
  assert.equal(existsSync(path.join(work, 'site/style.css')), true);
  assert.equal(existsSync(path.join(work, 'site/app.py')), true);
  assert.ok(r.events.filter((e) => e === 'FILE').length >= 4, r.events); // folder + 3 files, no skips
});

test('integration: unclosed fence extracts cleanly to the reply end', async () => {
  const resp = 'Here you go:\n```python\nprint("hi")\n';
  const r = await runScenario(resp, 'write a python script');
  assert.ok(r.disk.includes('script.py'), r.disk);
  const content = readFileSync(path.join(work, 'script.py'), 'utf8');
  assert.equal(content.includes('Here you go'), false);
  assert.equal(content.includes('```'), false);
  assert.ok(r.log.includes('[FILE] wrote file script.py'));
});

test('integration: prose-only reply to a file request saves nothing and warns', async () => {
  const resp = 'Sure! To summarize, python is a great language because...';
  const r = await runScenario(resp, 'write me a python script how to sort a list');
  assert.deepEqual(r.disk, [], r.disk);
  assert.ok(r.notices.some((m) => /without any code blocks/.test(m)), r.notices);
  assert.deepEqual(r.events, [], r.events); // nothing logged (no write attempt, no notify log)
});

test('integration: story request to a .txt saves prose', async () => {
  const resp = 'Long ago, in a land far away...';
  const r = await runScenario(resp, 'tell me a story about timun mas and save it to a file');
  assert.ok(r.disk.includes('timun-mas.txt'), r.disk);
  assert.ok(r.log.includes('[FILE] wrote file timun-mas.txt'), r.log);
});

test('integration: existing file is skipped with a logged reason', async () => {
  const resp = '```python\nprint("hi")\n```';
  const r = await runScenario(resp, 'write a python script', ['script.py']);
  assert.ok(r.notices.some((m) => /Skipped/.test(m)), r.notices);
  assert.ok(r.log.includes('[FILE] skipped file script.py'), r.log);
});

test('integration: plain question (no file markers) saves nothing and logs nothing', async () => {
  const r = await runScenario('Python is a programming language designed by Guido van Rossum.', 'what is python');
  assert.deepEqual(r.disk, []);
  assert.deepEqual(r.notices, []);
  assert.deepEqual(r.events, []);
});

test('integration: truncated trailing FILE: block is rescued, not silently dropped', async () => {
  const resp =
    'FILE: site/index.html\n' +
    '```html\n<h1>Hi</h1>\n```\n' +
    'FILE: site/app.py\n' +
    '```python\nfrom flask import Flask\napp = Flask(__name__)\n';
  const r = await runScenario(resp, 'make a website');
  assert.ok(existsSync(path.join(work, 'site/index.html')), r.disk);
  assert.ok(existsSync(path.join(work, 'site/app.py')), r.disk);
  const app = readFileSync(path.join(work, 'site/app.py'), 'utf8');
  assert.equal(app.includes('```'), false);
  assert.equal(app.includes('from flask'), true);
  assert.ok(r.events.filter((e) => e === 'FILE').length >= 2, r.events);
});

test('integration: single truncated FILE: block (nothing written) is rescued via rescue path', async () => {
  const resp = 'FILE: script.py\n```python\nfrom flask import Flask\napp = Flask(__name__)\n';
  const r = await runScenario(resp, 'write a python script');
  assert.ok(r.disk.includes('script.py'), r.disk);
  const content = readFileSync(path.join(work, 'script.py'), 'utf8');
  assert.equal(content.includes('```'), false);
  assert.ok(r.log.includes('(rescued truncated block)'), r.log);
});

test('integration: multi-block reply without FILE: headers warns that only block 1 was saved', async () => {
  const resp =
    '```html\n<h1>Hi</h1>\n<main>Page</main>\n```\n' +
    '```css\nbody { color: red; }\n```\n';
  const r = await runScenario(resp, 'make me an html page with css styling');
  assert.ok(r.disk.includes('index.html'), r.disk);
  assert.ok(r.notices.some((m) => /only index.html was saved/.test(m)), r.notices);
  assert.ok(r.events.includes('WARN'), r.events);
  assert.ok(r.log.includes('[WARN] multi-block reply: saved only index.html'), r.log);
});

test('integration: solo code block reply is saved even with minimal prose', async () => {
  const resp = '```python\nfrom flask import Flask\napp = Flask(__name__)\n\n@app.route("/")\ndef h():\n    return "ok"\n```\nHere is your file.';
  const r = await runScenario(resp, 'help me build a flask api');
  assert.ok(r.disk.includes('app.py'), r.disk);
  assert.ok(r.events.includes('FILE'), r.events);
});