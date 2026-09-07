import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Config } from '../src/config.js';
import {
  looksLikeOperationRequest, parseToolPlan, heuristicPlan,
  normalizeToolCall, runWithTools, planOnce,
  lastBuiltWebFolder, webRefineRequest, parseWebConfigFromFolder, applyWebRefineHints,
} from '../src/cmd/agent.js';

// Deterministic config so tests never read the user's real config.
process.env.VIERRATALE_MODEL = 'VRTL-2.fast';
process.env.VIERRATALE_ENGINE_HOST = 'http://127.0.0.1:11434';

function makeCwd() {
  return mkdtempSync(join(tmpdir(), 'vierra-agent-'));
}

// Fake provider: `complete` returns a canned tool-plan; `stream` the final reply.
function makeFakeProvider({ plan, completeError }) {
  return {
    name: 'fake',
    async complete() {
      if (completeError) throw completeError;
      return plan;
    },
    async *stream() {
      yield 'Selesai: test/index.js sudah dibuat.';
    },
  };
}

test('agent detection: Indonesian operation requests are recognized', () => {
  for (const q of [
    'buat folder test',
    'buat file index.js',
    'tulis file readme.txt',
    'hayu hapus file test.txt',
    'lihat isi folder',
    'jalankan npm install express',
    'khakkan npm install',
    'buat project react sederhana',
    'run python script.py',
    'git status',
    'make me a web and pack it into a folder',
    'buat website sederhana dalam folder',
    'build a site and taruh ke folder demo',
  ]) {
    assert.equal(looksLikeOperationRequest(q), true, q);
  }
  for (const q of ['apa itu javascript?', 'musim apa sekarang?', 'who is wiie?', 'ceritakan tentang kamu']) {
    assert.equal(looksLikeOperationRequest(q), false, q);
  }
});

test('agent: heuristic plan handles common requests without the model', () => {
  assert.deepEqual(heuristicPlan('buat folder demo-x'), [{ name: 'create_directory', params: { path: 'demo-x' } }]);
  assert.deepEqual(heuristicPlan('buat file index.js'), [{ name: 'create_file', params: { path: 'index.js', content: '' } }]);
  assert.deepEqual(heuristicPlan('buat folder test lalu buat index.js didalamnya'), [
    { name: 'create_directory', params: { path: 'test' } },
    { name: 'create_file', params: { path: 'test/index.js', content: '' } },
  ]);
  assert.deepEqual(heuristicPlan('hapus file test.txt'), [{ name: 'delete_file', params: { path: 'test.txt' } }]);
  assert.deepEqual(heuristicPlan('lihat isi folder'), [{ name: 'list_directory', params: { path: '.' } }]);
  assert.deepEqual(heuristicPlan('pwd'), [{ name: 'run_command', params: { command: 'pwd' } }]);
  assert.deepEqual(heuristicPlan('npm install express'), [{ name: 'run_command', params: { command: 'npm install express' } }]);
  assert.equal(heuristicPlan('buat project react sederhana').length, 7);
});

test('agent: heuristic plans system package installs via apt/pkg', () => {
  for (const q of ['install curl', 'pasang wget', 'install the package jq', 'pkg install lsof htop']) {
    const plan = heuristicPlan(q);
    assert.equal(plan.length, 1, q);
    assert.equal(plan[0].name, 'run_command');
    assert.match(plan[0].params.command, /^(pkg|apt(-get)?) install /, q);
  }
  // npm install still routes to npm, never to the system manager.
  assert.deepEqual(heuristicPlan('npm install express'), [{ name: 'run_command', params: { command: 'npm install express' } }]);
  // Ambiguous or non-package phrases are ignored.
  assert.deepEqual(heuristicPlan('install the project into a folder'), []);
  assert.deepEqual(heuristicPlan('install node modules'), []);
});

test('agent: web scaffold heuristic builds a runnable folder', () => {
  const plan = heuristicPlan('make me a web using html,css and javascript and pack it into a folder');
  assert.equal(plan.length, 5);
  assert.equal(plan[0].name, 'create_directory');
  assert.equal(plan[0].params.path, 'webapp');
  assert.equal(plan[1].params.path, 'webapp/index.html');
  assert.match(plan[1].params.content, /<!doctype html>/i);
  assert.equal(plan[2].params.path, 'webapp/style.css');
  assert.equal(plan[3].params.path, 'webapp/script.js');
  assert.equal(plan[4].params.path, 'webapp/app.py');
  assert.match(plan[4].params.content, /SimpleHTTPRequestHandler/);

  const named = heuristicPlan('buat website sederhana bernama demo-web dalam folder');
  assert.equal(named[0].params.path, 'demo-web');
  assert.equal(named[4].params.path, 'demo-web/app.py');
});

test('agent: web scaffold is designed around the requested subject', () => {
  const q = 'make me a website about gemini, use html combine css, and logics python and javascript';
  const plan = heuristicPlan(q);
  assert.equal(plan.length, 5);
  assert.equal(plan[0].name, 'create_directory');
  assert.equal(plan[0].params.path, 'gemini');
  assert.equal(plan[1].params.path, 'gemini/index.html');
  assert.match(plan[1].params.content, /Welcome to Gemini/);
  assert.match(plan[1].params.content, /about gemini/i);
  assert.doesNotMatch(plan[1].params.content, /Hello from/);
  assert.equal(plan[2].params.path, 'gemini/style.css');
  assert.match(plan[2].params.content, /\.card-grid/);
  assert.equal(plan[3].params.path, 'gemini/script.js');
  assert.match(plan[3].params.content, /fetch\('\/api\/info'/);
  assert.equal(plan[4].params.path, 'gemini/app.py');
  assert.match(plan[4].params.content, /SimpleHTTPRequestHandler/);
  assert.match(plan[4].params.content, /\/api\/contact/);
  assert.doesNotMatch(plan[1].params.content, /<script[^>]*src="https?:/);
});

test('agent: node websites scaffold a node server instead of python', () => {
  const plan = heuristicPlan('make a website about coffee, use html css and node');
  assert.equal(plan.length, 6);
  const paths = plan.map((p) => p.params.path);
  assert.ok(paths.includes('coffee/index.html'));
  assert.ok(paths.includes('coffee/style.css'));
  assert.ok(paths.includes('coffee/script.js'));
  assert.ok(paths.includes('coffee/package.json'));
  assert.ok(paths.includes('coffee/server.js'));
  assert.ok(!paths.includes('coffee/app.py'));
  const server = plan.find((p) => p.params.path === 'coffee/server.js');
  assert.match(server.params.content, /http\.createServer/);
});

test('agent: react websites scaffold a full TypeScript (TSX) project', () => {
  const plan = heuristicPlan('make a react website about gemini');
  const paths = plan.map((p) => p.params.path);
  assert.equal(plan.length, 8);
  assert.ok(paths.includes('gemini/package.json'));
  assert.ok(paths.includes('gemini/tsconfig.json'));
  assert.ok(paths.includes('gemini/vite.config.ts'));
  assert.ok(paths.includes('gemini/index.html'));
  assert.ok(paths.includes('gemini/src/main.tsx'));
  assert.ok(paths.includes('gemini/src/App.tsx'));
  assert.ok(paths.includes('gemini/src/styles.css'));
  const app = plan.find((p) => p.params.path === 'gemini/src/App.tsx').params.content;
  assert.match(app, /Welcome to/);
  assert.match(app, /Gemini/);
  assert.doesNotMatch(app, /__TITLE__|__TOPIC__/);
  const idx = plan.find((p) => p.params.path === 'gemini/index.html').params.content;
  assert.doesNotMatch(idx, /__TITLE__/);
  assert.match(idx, /Gemini/);
});

test('agent: react project scaffold emits a runnable TSX project', () => {
  const plan = heuristicPlan('buat project react sederhana');
  assert.equal(plan.length, 7);
  assert.equal(plan[0].name, 'create_file');
  assert.ok(plan.some((p) => p.name === 'create_file' && /src\/App\.tsx$/.test(p.params.path)));
});

test('agent: project scaffolds emit runnable tool calls (name included)', () => {
  for (const q of ['buat project react sederhana', 'buat project node app', 'buat project python app']) {
    const plan = heuristicPlan(q);
    assert.ok(plan.length >= 1, q);
    for (const item of plan) {
      assert.equal(typeof item.name, 'string', q);
      assert.ok(item.name.length > 0, q);
      assert.equal(typeof item.params.path, 'string', q);
    }
  }
  assert.equal(heuristicPlan('buat project react sederhana')[1].name, 'create_file');
});

test('agent: stylish subject is captured (never a generic webapp)', () => {
  const plan = heuristicPlan('make me a stylish-ai website');
  assert.equal(plan.length, 5);
  assert.equal(plan[0].name, 'create_directory');
  assert.equal(plan[0].params.path, 'stylish-ai');
  const idx = plan.find((p) => p.params.path === 'stylish-ai/index.html').params.content;
  assert.match(idx, /Welcome to Stylish Ai/);
  assert.doesNotMatch(idx, /Welcome to Webapp/);
});

test('agent: palette and light style are applied from the prompt', () => {
  const blue = heuristicPlan('make a dark premium blue website about analytics');
  const blueCss = blue.find((p) => p.params.path === 'analytics/style.css').params.content;
  assert.match(blueCss, /--accent: #2563eb;/);

  const light = heuristicPlan('make a clean light website about coffee');
  const lightHtml = light.find((p) => p.params.path === 'coffee/index.html').params.content;
  assert.match(lightHtml, /<html lang="en" data-theme="light">/);
  const lightCss = light.find((p) => p.params.path === 'coffee/style.css').params.content;
  assert.match(lightCss, /rgba\(124, 58, 237, 0\.12\)/);
});

test('agent: planOnce applies the AI design config for website requests', async () => {
  const cfg = JSON.stringify({
    name: 'Stylish Ai',
    folder: 'stylish-ai',
    topic: 'stylish AI',
    description: 'A bold, modern showcase for a stylish AI studio.',
    style: 'dark',
    accent: '#0ea5e9',
    accent2: '#22d3ee',
    sections: ['about', 'features', 'gallery', 'stats', 'contact'],
  });
  let gotPrompt = '';
  const designer = {
    name: 'fake',
    async complete(msgs, opts) {
      gotPrompt = (opts && opts.system_prompt) || '';
      return cfg;
    },
  };
  const plan = await planOnce(designer, [], 'make me a stylish-ai website');
  assert.equal(plan[0].name, 'create_directory');
  assert.equal(plan[0].params.path, 'stylish-ai');
  const html = plan.find((p) => p.params.path === 'stylish-ai/index.html').params.content;
  const css = plan.find((p) => p.params.path === 'stylish-ai/style.css').params.content;
  assert.match(html, /Welcome to Stylish Ai/);
  assert.match(html, /A bold, modern showcase for a stylish AI studio\./);
  assert.match(css, /--accent: #0ea5e9;/);
  assert.match(gotPrompt, /You are a web designer/);
});

test('agent: planOnce falls back to the heuristic design when the AI config is unusable', async () => {
  const plan = await planOnce({ name: 'fake', async complete() { return 'sorry, no json here'; } }, [], 'make me a stylish-ai website');
  assert.equal(plan[0].name, 'create_directory');
  assert.equal(plan[0].params.path, 'stylish-ai');
  const html = plan.find((p) => p.params.path === 'stylish-ai/index.html').params.content;
  assert.match(html, /Welcome to Stylish Ai/);
});

test('agent: heuristic web folder does not fire on non-web requests', () => {
  assert.deepEqual(heuristicPlan('buat folder demo'), [{ name: 'create_directory', params: { path: 'demo' } }]);
  assert.deepEqual(heuristicPlan('buat file index.js'), [{ name: 'create_file', params: { path: 'index.js', content: '' } }]);
});

test('agent: planOnce falls back to the heuristic when the model is too slow', async () => {
  process.env.VIERRATALE_PLAN_TIMEOUT_MS = '200';
  Config.load();
  const slow = { name: 'slow', complete: () => new Promise(() => {}) };
  const plan = await planOnce(slow, [], 'buat file hello.js', { heuristicFirst: false });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].name, 'create_file');
  assert.equal(plan[0].params.path, 'hello.js');
  delete process.env.VIERRATALE_PLAN_TIMEOUT_MS;
  Config.load();
});

test('agent: heuristic fast path never touches the model', async () => {
  let called = false;
  const exploding = { name: 'explode', complete: async () => { called = true; throw new Error('model must not be called'); } };
  const plan = await planOnce(exploding, [], 'make me a folder named quick-x');
  assert.deepEqual(plan, [{ name: 'create_directory', params: { path: 'quick-x' } }]);
  assert.equal(called, false, 'model plan round was skipped entirely');
});

test('agent: parseToolPlan tolerates fences and prose', () => {
  const plain = parseToolPlan('[{"name":"create_directory","path":"test"}]');
  assert.equal(plain.length, 1);
  assert.equal(plain[0].name, 'create_directory');

  const fenced = parseToolPlan('Berikut rencananya:\n```json\n[{"name":"create_file","path":"a.js","content":"x"}]\n```\nSelesai.');
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0].name, 'create_file');

  const single = parseToolPlan('{"name":"run_command","command":"mkdir -p z"}');
  assert.equal(single.length, 1);
  assert.equal(single[0].params.command, 'mkdir -p z');

  assert.deepEqual(parseToolPlan('NONE'), []);
  assert.deepEqual(parseToolPlan('maaf tidak butuh tool'), []);
  assert.deepEqual(parseToolPlan('{"name":"untrusted","command":"x"}'), []);
});

test('agent: normalizeToolCall only accepts known tools with valid params', () => {
  assert.deepEqual(
    normalizeToolCall({ name: 'create_file', path: 'x.js', content: 'hi' }),
    { name: 'create_file', params: { path: 'x.js', content: 'hi' } },
  );
  assert.equal(normalizeToolCall({ name: 'create_file' }), null);
  assert.equal(normalizeToolCall({ name: 'run_command', command: 42 }), null);
  assert.equal(normalizeToolCall({ name: 'sudo', command: 'rm -rf /' }), null);
});

test('DEMO: AI creates a directory and a file (model-supplied plan)', async () => {
  const dir = makeCwd();
  try {
    const provider = makeFakeProvider({
      plan: JSON.stringify([
        { name: 'create_directory', path: 'test' },
        { name: 'create_file', path: 'test/index.js', content: 'console.log("halo")' },
      ]),
    });
    const out = await runWithTools({
      provider,
      messages: [],
      requestText: 'buat folder test lalu buat index.js didalamnya',
      cwd: dir,
      heuristicFirst: false,
    });
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].result.success, true, out.results[0].result.stderr);
    assert.ok(existsSync(join(dir, 'test')));
    assert.equal(readFileSync(join(dir, 'test', 'index.js'), 'utf-8'), 'console.log("halo")');
    assert.equal(out.results[1].result.success, true, out.results[1].result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent: heuristic fallback runs when the model plan is unusable', async () => {
  const dir = makeCwd();
  try {
    const provider = makeFakeProvider({ plan: 'Maaf, saya tidak bisa menjalankan tool. Tolong lakukan manual.' });
    const out = await runWithTools({
      provider,
      messages: [],
      requestText: 'buat folder demo-heuristic',
      cwd: dir,
      heuristicFirst: false,
    });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].name, 'create_directory');
    assert.equal(out.results[0].result.success, true);
    assert.ok(existsSync(join(dir, 'demo-heuristic')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent: non-operation requests are ignored by runWithTools', async () => {
  const dir = makeCwd();
  try {
    const provider = makeFakeProvider({ plan: JSON.stringify([{ name: 'create_file', path: 'x.js', content: '' }]) });
    const out = await runWithTools({ provider, messages: [], requestText: 'apa itu javascript?', cwd: dir });
    assert.equal(out, false);
    assert.equal(existsSync(join(dir, 'x.js')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent: shows a file tree after creating folders/files', async () => {
  const dir = makeCwd();
  try {
    const notices = [];
    const chatUI = {
      notices,
      notify(t) { notices.push(t); },
      setStatus() {},
      setThinking() {},
      render() {},
    };
    const provider = makeFakeProvider({
      plan: JSON.stringify([
        { name: 'create_directory', path: 'demo' },
        { name: 'create_file', path: 'demo/halo.txt', content: 'hello' },
      ]),
    });
    const out = await runWithTools({
      provider, messages: [], requestText: 'buat folder demo lalu buat file halo.txt didalamnya',
      cwd: dir, heuristicFirst: false, chatUI,
    });
    assert.equal(out.results.length, 2);
    // ✓ create_directory + ✓ create_file + the tree itself
    assert.equal(notices.length, 3, JSON.stringify(notices));
    const tree = notices[notices.length - 1];
    assert.match(tree, /demo/);
    assert.match(tree, /halo\.txt/);
    assert.match(tree, /[├└]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent: broken model (plan error) falls back to the heuristic instead of hanging', async () => {
  const dir = makeCwd();
  try {
    const provider = makeFakeProvider({
      completeError: new Error('[ERR-0002] model "VRTL-6.pro" is not installed on the engine. Install it or switch models.'),
    });
    const out = await runWithTools({ provider, messages: [], requestText: 'buat folder test-error', cwd: dir, heuristicFirst: false });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].name, 'create_directory');
    assert.equal(out.results[0].result.success, true);
    assert.equal(existsSync(join(dir, 'test-error')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent: config commandTimeoutMs default is 60000', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'vierra-cfg-'));
  const prev = process.env.VIERRATALE_CONFIG_DIR;
  delete process.env.VIERRATALE_COMMAND_TIMEOUT_MS;
  process.env.VIERRATALE_CONFIG_DIR = tmpDir;
  try {
    // Fresh Config instance reads a (necessarily empty) config dir, so it must
    // fall back to the built-in 60000 default rather than any user file.
    Config._config = null;
    assert.equal(Config.get('commandTimeoutMs'), 60000);
  } finally {
    if (prev === undefined) delete process.env.VIERRATALE_CONFIG_DIR;
    else process.env.VIERRATALE_CONFIG_DIR = prev;
    Config._config = null;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

const BUILT_SITE_MSG = {
  role: 'user',
  hidden: true,
  content: JSON.stringify([
    { tool: 'create_directory', params: { path: 'stylish-ai' } },
    { tool: 'create_file', params: { path: 'stylish-ai/index.html' } },
    { tool: 'create_file', params: { path: 'stylish-ai/style.css' } },
  ]),
};

test('refine: lastBuiltWebFolder finds the site from prior tool results', () => {
  assert.equal(lastBuiltWebFolder([BUILT_SITE_MSG]), 'stylish-ai');
  assert.equal(lastBuiltWebFolder([]), null);
  const later = [{ role: 'user', content: 'hi' }, BUILT_SITE_MSG, { role: 'user', content: 'then built gemini/index.html' }];
  assert.equal(lastBuiltWebFolder(later), 'gemini');
});

test('refine: webRefineRequest gates change phrasing against a real site', () => {
  assert.equal(webRefineRequest('make it blue', [BUILT_SITE_MSG]), 'stylish-ai');
  assert.equal(webRefineRequest('change the title to acme corp', [BUILT_SITE_MSG]), 'stylish-ai');
  assert.equal(webRefineRequest('add a gallery section', [BUILT_SITE_MSG]), 'stylish-ai');
  assert.equal(webRefineRequest('switch to light theme', [BUILT_SITE_MSG]), 'stylish-ai');
  assert.equal(webRefineRequest('apa itu javascript?', [BUILT_SITE_MSG]), null);
  assert.equal(webRefineRequest('what color is the site?', [BUILT_SITE_MSG]), null);
  assert.equal(webRefineRequest('make me a website about cats', [BUILT_SITE_MSG]), null);
  assert.equal(webRefineRequest('buat folder testing', [BUILT_SITE_MSG]), null);
  assert.equal(webRefineRequest('remove gallery section', [BUILT_SITE_MSG]), 'stylish-ai');
  assert.equal(webRefineRequest('drop the contact section', [BUILT_SITE_MSG]), 'stylish-ai');
  assert.equal(webRefineRequest('make it blue', []), null);
  assert.equal(webRefineRequest('the site is awesome', [BUILT_SITE_MSG]), null);
  assert.equal(webRefineRequest('make it simple', [BUILT_SITE_MSG]), 'stylish-ai');
});

test('refine: parseWebConfigFromFolder re-derives config from built files', () => {
  const dir = makeCwd();
  try {
    const plan = heuristicPlan('make me a stylish-ai website');
    for (const call of plan) {
      if (call.name === 'create_directory') {
        mkdirSync(join(dir, call.params.path), { recursive: true });
      } else if (call.name === 'create_file') {
        mkdirSync(join(dir, call.params.path.split('/')[0]), { recursive: true });
        writeFileSync(join(dir, call.params.path), call.params.content);
      }
    }
    const cfg = parseWebConfigFromFolder(dir, 'stylish-ai');
    assert.equal(cfg.name, 'Stylish Ai');
    assert.equal(cfg.folder, 'stylish-ai');
    assert.equal(cfg.style, 'dark');
    assert.equal(cfg.accent, '#7c3aed');
    assert.equal(cfg.description, '');
    assert.deepEqual(cfg.sections, ['about', 'features', 'gallery', 'stats', 'contact']);
    assert.equal(parseWebConfigFromFolder(dir, 'nope'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refine: applyWebRefineHints maps colours, themes, sections and titles', () => {
  const base = {
    name: 'Stylish Ai', folder: 'stylish-ai', topic: '', description: '', style: 'dark',
    accent: '#7c3aed', accent2: '#06b6d4', sections: ['about', 'features', 'gallery', 'stats', 'contact'],
  };
  const blue = applyWebRefineHints('make it blue', base);
  assert.equal(blue.accent, '#2563eb');
  assert.equal(blue.accent2, '#06b6d4');
  assert.equal(blue.style, 'dark');

  const light = applyWebRefineHints('switch to light theme', base);
  assert.equal(light.style, 'light');

  const minimal = applyWebRefineHints('make it minimal', base);
  assert.equal(minimal.style, 'minimal');

  const addG = applyWebRefineHints('add a gallery section', base);
  assert.deepEqual(addG.sections, ['about', 'features', 'gallery', 'stats', 'contact']);

  const drop = applyWebRefineHints('remove gallery and contact sections', base);
  assert.deepEqual(drop.sections, ['about', 'features', 'stats']);

  const title = applyWebRefineHints('change the title to acme corp', base);
  assert.equal(title.name, 'acme corp');
});

test('refine: runWithTools re-renders the built site in place', async () => {
  const dir = makeCwd();
  try {
    const plan = heuristicPlan('make me a stylish-ai website');
    for (const call of plan) {
      if (call.name === 'create_directory') continue;
      if (call.name !== 'create_file') continue;
      mkdirSync(join(dir, call.params.path.split('/')[0]), { recursive: true });
      writeFileSync(join(dir, call.params.path), call.params.content);
    }
    const provider = makeFakeProvider({
      plan: JSON.stringify({ name: 'Stylish Ai', description: 'A modern AI studio with calm cyan energy.' }),
    });
    const out = await runWithTools({
      provider,
      messages: [{ role: 'user', content: 'make me a stylish-ai website' }, BUILT_SITE_MSG],
      requestText: 'switch to light theme, make it cyan, remove gallery section',
      cwd: dir,
    });
    assert.ok(out.results.length >= 4, 'refine should write files');
    const idx = readFileSync(join(dir, 'stylish-ai', 'index.html'), 'utf-8');
    const css = readFileSync(join(dir, 'stylish-ai', 'style.css'), 'utf-8');
    assert.ok(idx.includes('Welcome to Stylish Ai'));
    assert.ok(idx.includes('A modern AI studio with calm cyan energy.'));
    assert.ok(idx.includes('data-theme="light"'));
    assert.ok(!idx.includes('<section id="gallery"'));
    assert.ok(css.includes('--accent: #0891b2;'));
    assert.ok(!css.includes('--accent: #7c3aed;'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------

test('agent: normalizeToolCall accepts the todo tools', () => {
  assert.deepEqual(normalizeToolCall({ name: 'todo_add', text: 'x' }), { name: 'todo_add', params: { text: 'x' } });
  assert.deepEqual(normalizeToolCall({ name: 'todo_list' }), { name: 'todo_list', params: {} });
  assert.deepEqual(normalizeToolCall({ name: 'todo_clear' }), { name: 'todo_clear', params: {} });
  assert.deepEqual(
    normalizeToolCall({ name: 'todo_update', index: 3, done: true }),
    { name: 'todo_update', params: { index: 3, done: true, text: undefined } },
  );
  assert.deepEqual(
    normalizeToolCall({ name: 'todo_update', index: '4', text: 'rewrite' }),
    { name: 'todo_update', params: { index: 4, done: undefined, text: 'rewrite' } },
  );
  assert.equal(normalizeToolCall({ name: 'todo_add', text: '' }), null);
  assert.equal(normalizeToolCall({ name: 'todo_update', index: 'abc' }), null);
});

test('agent: todos run via a model plan and persist to .todos.json', async () => {
  const dir = makeCwd();
  try {
    const provider = makeFakeProvider({
      plan: JSON.stringify([
        { name: 'todo_add', text: 'setup project' },
        { name: 'todo_add', text: 'write code' },
        { name: 'todo_update', index: 1, done: true },
        { name: 'todo_list' },
      ]),
    });
    const out = await runWithTools({
      provider,
      messages: [],
      requestText: 'buat project todos-demo',
      cwd: dir,
      heuristicFirst: false,
    });
    assert.equal(out.results.length, 4);
    for (const r of out.results) assert.equal(r.result.success, true, r.result.stderr);
    const todos = JSON.parse(readFileSync(join(dir, '.todos.json'), 'utf-8'));
    assert.equal(todos.length, 2);
    assert.equal(todos[0].text, 'setup project');
    assert.equal(todos[0].done, true);
    assert.equal(todos[1].text, 'write code');
    assert.equal(todos[1].done, false);
    assert.match(out.results[3].result.stdout, /write code/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Auto error fixing
// ---------------------------------------------------------------------------

test('agent: auto error fixing retries a failed step with a corrected plan', async () => {
  const dir = makeCwd();
  try {
    const plans = [
      JSON.stringify([{ name: 'run_command', command: 'cat missing.txt' }]),
      JSON.stringify([{ name: 'create_file', path: 'recovered.txt', content: 'fixed' }]),
    ];
    let calls = 0;
    const provider = {
      name: 'fake',
      async complete() {
        calls++;
        return plans[Math.min(calls - 1, plans.length - 1)];
      },
      async *stream() {
        yield 'done';
      },
    };
    const out = await runWithTools({
      provider,
      messages: [],
      requestText: 'buat file fix.txt',
      cwd: dir,
      heuristicFirst: false,
    });
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].result.success, false);
    assert.equal(out.results[1].name, 'create_file');
    assert.equal(out.results[1].result.success, true, out.results[1].result.stderr);
    assert.ok(existsSync(join(dir, 'recovered.txt')));
    assert.equal(calls, 2, 'one failed plan + one auto-fix plan');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent: auto error fixing is bounded when the model cannot fix it', async () => {
  const dir = makeCwd();
  try {
    let calls = 0;
    const provider = {
      name: 'fake',
      async complete() {
        calls++;
        return JSON.stringify([{ name: 'run_command', command: 'cat missing.txt' }]);
      },
      async *stream() {
        yield 'done';
      },
    };
    const out = await runWithTools({
      provider,
      messages: [],
      requestText: 'buat file fixb.txt',
      cwd: dir,
      heuristicFirst: false,
    });
    // 3 planning rounds, each: 1 failing call + 1 failing auto-fix attempt = 6
    // executions, and 6 model calls total (3 plans + 3 fix requests).
    assert.equal(calls, 6);
    assert.equal(out.results.length, 6);
    assert.ok(out.results.every((r) => r.result.success === false));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});