import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { Config } from '../config.js';
import { logger } from '../utils/logger.js';
import { renderFileTree } from '../utils/filetree.js';
import { makeExecutor, dispatchTool, TOOL_EXECUTORS, pickPackageManager } from './tools.js';

const MAX_PLANNING_ROUNDS = 3;
const MAX_STEPS = 8;

const TOOL_PLAN_PROMPT = `You can run commands and touch files on the user's machine inside the current workspace to satisfy their request.

Reply with EXACTLY ONE JSON array of the tool calls needed to do the job, in order. Each element is one JSON object:

{"name":"run_command","command":"mkdir -p test"}
{"name":"create_file","path":"test/index.js","content":"console.log('hi')"}
{"name":"create_directory","path":"src"}
{"name":"read_file","path":"package.json"}
{"name":"list_directory","path":"."}
{"name":"delete_file","path":"old.txt"}
{"name":"download_url","url":"https://example.com/file.zip","dir":"downloads"}
{"name":"todo_add","text":"install dependencies"}
{"name":"todo_list"}
{"name":"todo_update","index":1,"done":true}
{"name":"todo_clear"}

Rules:
- run_command runs WITHOUT a shell. Allowed commands: mkdir touch ls pwd cat cp mv rm npm npx node python python3 git echo printf apt apt-get pkg.
- run_command supports arguments with spaces (quote them). No shell operators (&& | > ; etc.), no wildcards for rm, no inline -e/-c code for node/python, no paths outside the workspace.
- To create a file containing code or text, ALWAYS use create_file (never echo/cat > …). Pass the full content in "content".
- Prefer create_file over redirecting output.
- If you need to create a folder first, plan create_directory before create_file inside it.
- To download a file, web asset, archive or folder listing from the web, use download_url with the full URL. dir is optional (defaults to ~/Downloads).
- To install a system package the user asked for, use run_command with pkg (Termux/Android) or apt/apt-get (Linux), e.g. {"name":"run_command","command":"pkg install -y curl wget"}. The -y/--yes confirm flag is added automatically — never use && or sudo.
- For multi-step work, track your progress with todo_add/todo_list/todo_update (e.g. todo_add for each remaining subtask, todo_update to mark steps done).
- Code you create must be runnable. For Python servers bind to 127.0.0.1, read PORT from the environment (default 8000), and fall back to a free port (port 0) when the default is taken. HTML/CSS/JS must be self-contained and reference each other by relative filename.
- If NO tools are needed, reply exactly: NONE
- Output the JSON array only — no prose, no markdown fences unless the array is inside them.`;

const TOOL_RESULTS_PROMPT = (resultsJson) => `The tools below were ALREADY executed in the workspace. Their results:

${resultsJson}

Give the user a short, natural reply (in the user's own language) telling them what happened. Keep the whole reply under 40 words. Do NOT tell them to run the commands yourself. If they asked for a file containing code and files were created with content, you may also emit FILE: blocks if more files are still required.`;

// Auto error fixing: shown to the model when a tool call fails so it can emit
// a corrected plan instead of giving up. Bounded by MAX_AUTO_FIXES per run.
const MAX_AUTO_FIXES = 3;

const TOOL_FIX_PROMPT = (call, result) => `A tool call made while working in the workspace FAILED. Fix the problem so the original request can complete.

Failed tool call:
${JSON.stringify(call, null, 2)}

Failure:
${JSON.stringify({ success: false, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }, null, 2)}

Emit a NEW tool plan (a JSON array of tool calls) that corrects the failure — for example re-create the file with the error fixed, run a command to repair it, or download/read what is missing. If your previous plan skipped a required step (like creating a parent folder), include it. Use todo tools to track remaining subtasks if useful. Reply with exactly one JSON array, or the single word NONE if no tool call can fix this.`;

// ---------------------------------------------------------------------------
// Request detection
// ---------------------------------------------------------------------------

const OP_PATTERNS = [
  /\b(buat|create|make|new|touch)\b[^.!?\n]{0,40}\b(folder|dir|directory)\b/i,
  /\b(buat|create|make|new|touch|tulis|write)\b[^.!?\n]{0,40}\b(file|berkas)\b/i,
  /\b(hapus|delete|delete!|remove|rm|buang)\b/i,
  /\b(lihat|tampilkan|show|list|ls|buka|isi)\b[^.!?\n]{0,30}\b(folder|dir|directory|isi)\b/i,
  /\b(pwd|where am i|direktori|folder sekarang|folder kerja)\b/i,
  /\b(ganti nama|rename|ren|pindah|move|mv)\b/i,
  /\b(copy|duplicate|salin|cp)\b/i,
  /\b(npm|yarn|pnpm)\s+(install|i|add|run|start|dev|test|build|init|create)\b/i,
  /\b(jalankan|run|execute|exec)\b[^.!?\n]{0,20}\b(npm|node|python|git)\b/i,
  /\bgit\s+(status|add|commit|push|pull|clone|init|log|diff|remote)\b/i,
  /\b(buat|create|make|generate)\b[^.!?\n]{0,40}\b(project|proyek|app|aplikasi|web|website|site|situs|webpage|halaman)\b/i,
  /\b(pack|kemas|satukan|taruh|simpan)\b[^.!?\n]{0,50}\b(folder|dir|directory)\b/i,
  /\b(download|unduh|ambil|grab|save)\b[^.!?\n]{0,80}\b(file|gambar|image|pdf|zip|video|audio|musik|music|data|foto|photo|dokumen|document|asset|berkas|lampiran)\b/i,
  /\b(download|unduh|save|simpan)\b[^.!?\n]{0,30}\b(itu|semua|ini|all|ininya|those|dari page|dari halaman|from the page|from that page)\b/i,
  /\bhttps?:\/\/[^\s]+\.(pdf|zip|tar|gz|7z|rar|docx?|xlsx?|pptx?|mp[34]|wav|ogg|csv|json|png|jpe?g|gif|webp|svg)\b/i,
];

export function looksLikeOperationRequest(text) {
  return OP_PATTERNS.some((re) => re.test(String(text || '')));
}

// ---------------------------------------------------------------------------
// Tool-plan parsing (tolerant of fences/prose around the JSON)
// ---------------------------------------------------------------------------

export function normalizeToolCall(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') return null;
  const name = raw.name;
  if (!TOOL_EXECUTORS[name]) return null;
  let params;
  if (name === 'run_command') {
    if (typeof raw.command !== 'string') return null;
    params = { command: raw.command };
  } else if (name === 'create_file') {
    if (typeof raw.path !== 'string' || raw.path.trim() === '') return null;
    params = { path: raw.path, content: typeof raw.content === 'string' ? raw.content : String(raw.content ?? '') };
  } else if (name === 'create_directory' || name === 'read_file' || name === 'delete_file' || name === 'list_directory') {
    if (typeof raw.path !== 'string') return null;
    params = { path: raw.path };
  } else if (name === 'download_url') {
    if (typeof raw.url !== 'string' || raw.url.trim() === '') return null;
    params = { url: raw.url, dir: typeof raw.dir === 'string' && raw.dir.trim() ? raw.dir.trim() : undefined };
  } else if (name === 'todo_add') {
    if (typeof raw.text !== 'string' || raw.text.trim() === '') return null;
    params = { text: raw.text };
  } else if (name === 'todo_update') {
    if (!Number.isInteger(raw.index) && !/^\d+$/.test(String(raw.index ?? ''))) return null;
    params = {
      index: Number(raw.index),
      done: typeof raw.done === 'boolean' ? raw.done : undefined,
      text: typeof raw.text === 'string' && raw.text.trim() ? raw.text : undefined,
    };
  } else if (name === 'todo_list' || name === 'todo_clear') {
    params = {};
  } else {
    return null;
  }
  return { name, params };
}

export function parseToolPlan(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (/^\s*NONE\b/i.test(t)) return [];

  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : t;

  const arrM = candidate.match(/\[[\s\S]*\]/);
  const objM = candidate.match(/\{[\s\S]*\}/);
  let parsed = null;
  if (arrM) {
    try { parsed = JSON.parse(arrM[0]); } catch {}
  }
  if (!parsed && objM) {
    try { parsed = [JSON.parse(objM[0])]; } catch {}
  }
  if (!Array.isArray(parsed)) return [];

  const out = [];
  for (const item of parsed) {
    const norm = normalizeToolCall(item);
    if (norm) out.push(norm);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heuristic fallback plan (used when the model emits no usable tool plan).
// Handles the common Indonesian/English requests without the model.
// ---------------------------------------------------------------------------

const TOKEN = '[A-Za-z0-9_.\\-]+';
const FILLERS = 'lalu|dan|didalamnya|di dalamnya|dengan|untuk|baru|dulu|ya|please|then|and|inside|new';

function namedToken(text, regex) {
  const m = text.match(regex);
  if (!m) return null;
  const t = m[m.length - 1].trim();
  if (!t || new RegExp(`^(${FILLERS})$`, 'i').test(t)) return null;
  return t;
}

function codeNamedFile(text) {
  const m = String(text || '').match(/([\w.-]+\.(?:html?|css|js|jsx|ts|tsx|json|md|txt|py|php|rb|go|yaml|yml|sh|csv|sql))/i);
  return m ? m[1] : null;
}

export function heuristicPlan(requestText) {
  const text = String(requestText || '');
  const lower = text.toLowerCase();

  const cp = /\b(copy|duplicate|salin|duplikat)\b[^.!?\n]*?([A-Za-z0-9_.\/-]+)\.([A-Za-z0-9]+)[^.!?\n]*?\b(ke|menjadi|jadi|as|to)\b\s+([A-Za-z0-9_.\/-]+)\.([A-Za-z0-9]+)/i;
  let m = cp.exec(text);
  if (m) {
    return [{ name: 'run_command', params: { command: `cp ${m[2]}.${m[3]} ${m[4]}.${m[5]}` } }];
  }

  const mv = /\b(ganti nama|rename|ren|pindah|move|mv)\b[^.!?\n]*?([A-Za-z0-9_.\/-]+)\s*(ke|menjadi|jadi|as|to)\s*([A-Za-z0-9_.\/-]+)/i;
  m = mv.exec(text);
  if (m && /\.[A-Za-z0-9]+$/.test(m[2]) && /\.[A-Za-z0-9]+$/.test(m[4])) {
    return [{ name: 'run_command', params: { command: `mv ${m[2]} ${m[4]}` } }];
  }

  m = /\b(hapus|delete|remove|rm|buang)\b\s+(?:the\s+|file\s+)?([A-Za-z0-9_.\/-]+)/i.exec(text);
  if (m && !new RegExp(`^(?:${FILLERS})$`).test(m[2])) {
    return [{ name: 'delete_file', params: { path: m[2] } }];
  }

  m = /\b(git\s+(?:status|log|diff|remote\s+-v|status\s+-\w*))\b/i.exec(text);
  if (m) {
    return [{ name: 'run_command', params: { command: m[1] } }];
  }

  const dlUrl = /\b(download|unduh|ambil|grab|save|simpan)\b[^.!?\n]{0,60}(https?:\/\/[^\s<>"']+)/i.exec(text)
    || /(https?:\/\/[^\s<>"']+\.(?:pdf|zip|tar|gz|7z|rar|docx?|xlsx?|mp[34]|wav|png|jpe?g|gif|webp|svg|json|csv))(?:\s|$)/i.exec(text);
  if (dlUrl) {
    return [{ name: 'download_url', params: { url: dlUrl[dlUrl[2] ? 2 : 1], dir: undefined } }];
  }

  m = /\b(npm|yarn|pnpm)(\s+\S+)*/i.exec(text);
  if (/\b(jalankan|run|execute|install|pasang)\b[^.!?\n]{0,25}\bnpm\b|\bnpm\s+(install|i|add|run|start|dev|test|build|init|create)\b/i.test(text) && m) {
    const tail = m[0].trim();
    return [{ name: 'run_command', params: { command: tail } }];
  }

  // System package installs: explicit "pkg/apt install …" and generic
  // "install <pkg>" requests ("pasang curl", "install wget").
  const pkgInstall = /\b(pkg|apt-get|apt)\s+(install|i|add)\s+(.+)$/i.exec(text);
  if (pkgInstall) {
    const pkgs = pkgInstall[3].trim().split(/\s+/).slice(0, 8).filter((p) => /^[a-z0-9][a-z0-9.+_~-]*$/i.test(p));
    if (pkgs.length) return [{ name: 'run_command', params: { command: `${pkgInstall[1]} install ${pkgs.join(' ')}` } }];
  }
  const INSTALL_BLOCKED = new Set(['project', 'proyek', 'folder', 'direktori', 'file', 'berkas', 'code', 'kode', 'dependencies', 'dependensi', 'app', 'aplikasi', 'gui', 'the', 'a', 'an', 'for', 'to', 'in', 'on', 'from', 'with', 'and', 'dan', 'lalu', 'semua', 'ini', 'itu', 'now', 'please', 'tolong']);
  const genericInstall = /\b(install|pasang|installkan|menginstall|menginstal|set\s*up|setup)\b/i.exec(text);
  const devInstallSpeak = /node modules|modules|dependenc\w*|package\.json|requirements(\.txt)?|virtualenv|pip\b|cargo\b|go get\b/gi;
  if (genericInstall && !/\b(npm|yarn|pnpm|npx|bun|pip|pip3|uv|conda|apt|pkg)\b/i.test(text) && !devInstallSpeak.test(text)) {
    const target = text.match(/\b(install|pasang|installkan|menginstall|menginstal|set\s*up|setup)\b\s+(?:(the|a|an|package|paket|tool|alat|program|utility|latest)\s+)?([a-z0-9][a-z0-9.+_~-]{1,63})\b/i);
    if (target && !INSTALL_BLOCKED.has(target[3].toLowerCase())) {
      const manager = pickPackageManager();
      return [{ name: 'run_command', params: { command: `${manager} install ${target[3]}` } }];
    }
  }

  m = /\b(jalankan|run|execute|exec|kerjakan)\b\s+(node|python3?)\b\s*([A-Za-z0-9_.\/-]+(?:\.[A-Za-z0-9]+)?)?/i.exec(text);
  if (m) {
    const cmd = `${m[2]} ${m[3] || ''}`.trim();
    return [{ name: 'run_command', params: { command: cmd } }];
  }

  m = /\b(jalankan|run|execute|exec)\b\s+(git)\b\s+([a-z]+(?:\s+\S+)*)/i.exec(text);
  if (m) {
    return [{ name: 'run_command', params: { command: `${m[2]} ${m[3]}` } }];
  }

  if (/\b(project|proyek|aplikasi|app)\b/i.test(text) && /\b(buat|create|make|generate)\b/i.test(text)) {
    const files = scaffoldFiles(text.toLowerCase());
    if (files.length) return files;
  }

  const webScaffold = webFolderPlan(text, folderPlanName(text));
  if (webScaffold.length) return webScaffold;

  if (/\b(pwd|where am i)\b/i.test(text) || /\b(direktori|folder sekarang|folder kerja)\b/i.test(text)) {
    return [{ name: 'run_command', params: { command: 'pwd' } }];
  }

  const stripQualifier = (s) =>
    String(s || '').replace(/^(named|called|bernama|berjudul|dengan nama|menjadi|as|to)\s*/i, '').trim() || null;
  const folderName = stripQualifier(namedToken(text, /\b(buat|create|make|new)\b[^.!?\n]{0,30}(?<![A-Za-z0-9_-])\b(folder|dir|directory)\b\s+(?:(?:named|called|bernama|berjudul|dengan nama|as|to)\s+)?([A-Za-z0-9_.\-]+)/i)) ||
    stripQualifier(namedToken(text, /\b(folder|dir|directory)\b\s+(?:(?:named|called|bernama|berjudul|dengan nama|as|to)\s+)?([A-Za-z0-9_.\-]+)[\s\S]{0,10}$/i));
  const fileName = codeNamedFile(text) || stripQualifier(namedToken(text, /\b(buat|create|make|new|touch)\b[^.!?\n]{0,30}(?<![A-Za-z0-9_-])\b(file|berkas)\b\s+(\d?[A-Za-z0-9_.\-]+)/i));

  if (fileName || folderName) {
    const plan = [];
    if (folderName) plan.push({ name: 'create_directory', params: { path: folderName } });
    if (fileName) {
      const inside = /\b(di\s+dalamnya|didalamnya|di dalam|inside|dalam)\b/i.test(text);
      let content = '';
      if (/\.(txt|md|markdown|csv|json)$/i.test(fileName)) {
        const says = text.match(/\b(says?|said|berisi|isinya|bertuliskan)\s+["']?([^"'.!?\n]{1,120})["']?/i);
        if (says) content = says[2].trim() + '\n';
      }
      plan.push({ name: 'create_file', params: { path: folderName && inside ? `${folderName}/${fileName}` : fileName, content } });
    }
    return plan;
  }

  if (/\b(lihat|tampilkan|show|list|ls|buka|isi)\b/i.test(text)) {
    let pathArg = null;
    const pathMatch = text.match(/\b(src|test|public|dist|node_modules)\b/i);
    if (pathMatch) pathArg = pathMatch[1];
    return [{ name: 'list_directory', params: { path: pathArg || '.' } }];
  }

  return [];
}

function scaffoldFiles(lower) {
  const type = lower.match(/\b(react|node|nodejs|python|py|next|vue|vite)\b/);
  const kind = type ? type[1] : null;
  const named = namedToken(lower, new RegExp(`\\b(project|proyek|app)\\b\\s+(?:sederhana|simple|baru|dengan|menggunakan)?\\s*(${TOKEN})`, 'i'));
  const base = (named || '').replace(/[^a-z0-9._-]/gi, '').replace(/[\/\\]/g, '-' );
  const files = [];
  const file = (path, content) => ({ name: 'create_file', params: { path, content } });

  if (kind === 'react' || kind === 'vue' || kind === 'vite') {
    const appName = base || 'my-app';
    if (kind === 'vue') {
      files.push(file(`${appName}/package.json`, '{\n  "name": "' + appName + '",\n  "version": "1.0.0",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build"\n  },\n  "dependencies": {\n    "vue": "^3.5.0"\n  },\n  "devDependencies": {\n    "@vitejs/plugin-vue": "^5.1.0",\n    "vite": "^5.4.8"\n  }\n}\n'));
      files.push(file(`${appName}/index.html`, '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>' + titleCase(appName.replace(/[-_]+/g, ' ')) + '</title>\n</head>\n<body>\n  <div id="app"></div>\n  <script type="module" src="/src/main.js"></script>\n</body>\n</html>\n'));
      files.push(file(`${appName}/src/main.js`, "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')\n"));
      files.push(file(`${appName}/src/App.vue`, '<template>\n  <div class="app">\n    <h1>Welcome to Vue</h1>\n    <p>Built with Vue 3 + Vite.</p>\n  </div>\n</template>\n'));
    } else {
      files.push(...tsxUrl(appName, titleCase(appName.replace(/[-_]+/g, ' ')), ''));
    }
    return files;
  }

  if (kind === 'python' || kind === 'py') {
    return [file((base ? base + '/' : '') + 'app.py', 'print("hello")\n')];
  }

  if (kind === 'node' || kind === 'nodejs') {
    files.push(file((base ? base + '/' : '') + 'package.json', '{\n  "name": "' + (base || 'my-app') + '",\n  "version": "1.0.0",\n  "type": "module",\n  "main": "index.js",\n  "scripts": {\n    "start": "node index.js"\n  }\n}\n'));
    files.push(file((base ? base + '/' : '') + 'index.js', "console.log('Hello from " + (base || 'Node') + "')\n"));
    return files;
  }

  if (named) {
    return [{ name: 'create_directory', params: { path: named } }];
  }
  return [];
}

function folderPlanName(text) {
  const m = /\b(?:folder|dir|directory|into|inside|bernama|named)\b\s+(?:a\s+|the\s+|an\s+|new\s+|baru\s+)?([A-Za-z0-9_.-]+)/i.exec(text);
  const name = m ? m[1] : '';
  if (/^(a|an|the|new|baru|folder|dir|directory|into|inside|named|bernama)$/i.test(name)) return '';
  return name;
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const sanitize = (name) =>
  String(name || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'webapp';

function titleCase(s) {
  const stop = new Set(['a', 'an', 'the', 'of', 'for', 'in', 'on', 'to', 'from', 'with', 'and', 'or', 'at', 'into', 'about']);
  return String(s || '')
    .split(/[_-\s]+/)
    .filter(Boolean)
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (i > 0 && stop.has(lw)) return lw;
      return lw.charAt(0).toUpperCase() + lw.slice(1);
    })
    .join(' ');
}

const TOPIC_STOP = new Set(['a', 'an', 'the', 'my', 'our', 'your', 'his', 'her', 'its', 'new', 'sebuah']);

function webTopicName(text) {
  const raw = String(text || '');
  const m =
    raw.match(/\b(?:tentang|mengenai|about)\s+([A-Za-z0-9][A-Za-z0-9 _-]{0,23})/i) ||
    raw.match(/\b(?:bernama|berjudul|dengan nama|named|called)\s+([A-Za-z0-9][A-Za-z0-9 _-]{0,23})/i) ||
    raw.match(/\b(?:buat|create|make|generate|bikin)\b[^.!?\n]{0,24}(?:(?:me|saya|aku)\s+)?(?:a|an|sebuah|satu)\s+([A-Za-z0-9][A-Za-z0-9 _-]{0,23})(?=\s+(?:web\s*(?:app|page|site)?|website|situs|webpage|halaman)\b)/i);
  if (!m) return '';
  const first = m[1].trim().split(/\s+/)[0].toLowerCase();
  if (TOPIC_STOP.has(first)) return '';
  return m[1].trim().slice(0, 24);
}

function webStack(text) {
  const t = String(text || '');
  const node = /\bnode(js)?\b|express/i.test(t);
  const tsx = /\breact\b|\btsx\b|\btypescript\b|\bts\b/i.test(t);
  return { node, python: !node, js: true, tsx };
}

const WEB_SECTIONS = ['about', 'features', 'gallery', 'stats', 'contact'];

const WEB_SECTION_LABELS = {
  about: 'About',
  features: 'Features',
  gallery: 'Gallery',
  stats: 'Stats',
  contact: 'Contact',
};

const PALETTES = {
  purple: { accent: '#7c3aed', accent2: '#06b6d4' },
  blue: { accent: '#2563eb', accent2: '#06b6d4' },
  cyan: { accent: '#0891b2', accent2: '#38bdf8' },
  green: { accent: '#059669', accent2: '#34d399' },
  amber: { accent: '#d97706', accent2: '#f59e0b' },
  rose: { accent: '#e11d48', accent2: '#fb7185' },
  pink: { accent: '#db2777', accent2: '#a855f7' },
  orange: { accent: '#ea580c', accent2: '#fbbf24' },
  slate: { accent: '#64748b', accent2: '#94a3b8' },
};

function webStyleName(text) {
  const t = String(text || '');
  if (/\b(minimal|simpl(?:e|istic|ify))\b/i.test(t) && !/\b(dark|gelap)\b/i.test(t)) return 'minimal';
  if (/\b(light|terang|bright|clean|pastel|white)\b/i.test(t) && !/\b(dark|gelap)\b/i.test(t)) return 'light';
  return 'dark';
}

function webPalette(text) {
  const t = String(text || '').toLowerCase();
  const order = [
    [/purple|violet|ungu/, 'purple'],
    [/blue|biru/, 'blue'],
    [/cyan|teal/, 'cyan'],
    [/green|emerald|hijau/, 'green'],
    [/gold|amber|yellow|kuning/, 'amber'],
    [/red|rose|merah/, 'rose'],
    [/pink/, 'pink'],
    [/orange|oranye/, 'orange'],
    [/gray|grey|slate|abu/, 'slate'],
  ];
  for (const [re, key] of order) if (re.test(t)) return PALETTES[key];
  const hex = t.match(/#([0-9a-f]{6})\b/i);
  if (hex) return { accent: '#' + hex[1].toLowerCase(), accent2: '#06b6d4' };
  return PALETTES.purple;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Renders the stylesheet from a design config while keeping the default output
// byte-identical when the defaults are used.
function webCss(cfg = {}) {
  const { accent = '#7c3aed', accent2 = '#06b6d4', style = 'dark' } = cfg;
  const a = (hexToRgb(accent) || [124, 58, 237]).join(', ');
  const b = (hexToRgb(accent2) || [6, 182, 212]).join(', ');
  const lightA = style === 'minimal' ? 0.06 : 0.12;
  const lightB = style === 'minimal' ? 0.05 : 0.1;
  return WEB_CSS
    .replace('--accent: #7c3aed;', `--accent: ${accent};`)
    .replace('--accent-2: #06b6d4;', `--accent-2: ${accent2};`)
    .replaceAll('rgba(124, 58, 237, 0.35)', `rgba(${a}, 0.35)`)
    .replaceAll('rgba(6, 182, 212, 0.25)', `rgba(${b}, 0.25)`)
    .replaceAll('rgba(6, 182, 212, 0.08)', `rgba(${b}, 0.08)`)
    .replaceAll('rgba(124, 58, 237, 0.12)', `rgba(${a}, ${lightA})`)
    .replaceAll('rgba(6, 182, 212, 0.1)', `rgba(${b}, ${lightB})`);
}

// Cheap, reliable design config derived directly from the request text.
// Used when the AI model is unavailable or fails to return a JSON config.
function probeWebConfig(text, folderName) {
  const topic = webTopicName(text);
  const folder = folderName || folderPlanName(text) || sanitize(topic || 'webapp');
  const nameBase = topic || (folder === 'webapp' ? 'Webapp' : folder.replace(/[_]+/g, ' '));
  const palette = webPalette(text);
  return {
    name: titleCase(nameBase),
    folder,
    topic,
    description: '',
    style: webStyleName(text),
    accent: palette.accent,
    accent2: palette.accent2,
    sections: [...WEB_SECTIONS],
  };
}

const WEB_CONFIG_PROMPT = `You are a web designer. The user asked to build a website. Reply with ONLY a compact JSON object (no markdown fences, no commentary) in exactly this shape:

{"name":"SiteTitle","description":"one upbeat sentence for the hero","accent":"#7c3aed","accent2":"#06b6d4"}

Rules:
- name: short site title, max 40 chars, no quote or angle-bracket characters.
- description: one friendly sentence describing the site for the hero, max 160 chars, and it must not contain any double-quote, angle-bracket, ampersand or backslash characters.
- accent and accent2: 6-digit hex colors that work together. Use the colors the user names when they name any.
Honour any name, style and colors the user gives in their request. Keep it short - the JSON only, under 120 words in total.`;

function normalizeWebConfig(raw, fallback) {
  let obj = null;
  const cleaned = String(raw || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { obj = JSON.parse(cleaned.slice(start, end + 1)); } catch { obj = null; }
  }
  const str = (v, len) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, len) : '');
  const rawSections = Array.isArray(obj && obj.sections)
    ? [...new Set(obj.sections.map((s) => String(s)).filter((s) => WEB_SECTIONS.includes(s)))]
    : [];
  return {
    name: str(obj && obj.name, 40) || fallback.name,
    folder: sanitize(str(obj && obj.folder, 40) || fallback.folder),
    topic: str(obj && obj.topic, 40) || fallback.topic,
    description: str(obj && obj.description, 160) || '',
    style: ['dark', 'light', 'minimal'].includes(obj && obj.style) ? obj.style : fallback.style,
    accent: hexToRgb(obj && obj.accent) ? String(obj.accent).toLowerCase() : fallback.accent,
    accent2: hexToRgb(obj && obj.accent2) ? String(obj.accent2).toLowerCase() : fallback.accent2,
    sections: rawSections.length ? rawSections : fallback.sections,
  };
}

// Runs a short, bounded request to the design model. Resolves with the raw
// reply, or rejects when the provider is missing, the request errors or the
// 15s budget is exceeded. Callers fall back to heuristics when it rejects.
function completeWebConfig(provider, messages, requestText, systemPrompt) {
  const call = provider && typeof provider.complete === 'function' ? provider.complete.bind(provider) : null;
  if (!call) return Promise.reject(new Error('no design provider'));
  const history = messages && messages.length ? messages.slice(-6) : [{ role: 'user', content: requestText }];
  const planTimeoutMs = Number(Config.get('planTimeoutMs')) || 120000;
  const timeoutMs = Math.min(planTimeoutMs, 15000);
  const controller = new AbortController();
  let timer;
  const request = call([...history, { role: 'user', content: requestText }], {
    model: Config.getEffectiveModel(provider.name),
    system_prompt: systemPrompt,
    maxTokens: 150,
    signal: controller.signal,
  });
  return Promise.race([
    request,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort();
        reject(Object.assign(new Error('web AI design config timed out'), { name: 'DeadlineError' }));
      }, timeoutMs);
    }),
  ]).then(
    (raw) => { clearTimeout(timer); return raw; },
    (err) => { clearTimeout(timer); return Promise.reject(err); }
  );
}

// Asks the model for the site's design config (name, subject, palette, style,
// description, sections). Returns null when the provider is missing or the
// answer is unusable, so callers can fall back to probeWebConfig().
async function webDesignConfig(provider, messages, requestText) {
  if (!provider || typeof provider.complete !== 'function') return null;
  try {
    const raw = await completeWebConfig(provider, messages, requestText, WEB_CONFIG_PROMPT);
    return normalizeWebConfig(raw, probeWebConfig(requestText));
  } catch (err) {
    logger.log('PLAN', `web AI design config unavailable (${err && err.message ? err.message : 'error'}); using heuristic design`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Refine-after-build: the user tweaks the site they already got
// (colours, theme, title, sections...) and we re-render it in place.
// ---------------------------------------------------------------------------

function webRefinePrompt(base) {
  return `You are a web designer editing an existing website. Current site: name = "${base.name}", theme = ${base.style}, accent color = ${base.accent}, accent2 = ${base.accent2}. The user asked to change this site. Reply with ONLY a JSON object (no markdown fences, no commentary) that contains ONLY the keys that should change, from this set:
{"name":"SiteTitle","description":"one upbeat sentence for the hero","accent":"#7c3aed","accent2":"#06b6d4"}
Rules:
- name: short site title, max 40 chars, no quote or angle-bracket characters.
- description: one friendly sentence for the hero, max 160 chars, and it must not contain any double-quote, angle-bracket, ampersand or backslash characters.
- accent and accent2: 6-digit hex colors that work together.
Honour only what the user asks to change; leave everything else exactly as-is. Keep it short - the JSON only, under 120 words in total.`;
}

// Finds the most recent website folder referenced by any earlier message in
// the session (e.g. the TOOL_RESULTS_PROMPT rows written after a web build).
function lastBuiltWebFolder(messages) {
  const re = /([A-Za-z0-9_.-]+\/index\.html)/g;
  let last = null;
  for (const m of messages || []) {
    let content = '';
    if (typeof m === 'string') content = m;
    else if (m && typeof m.content === 'string') content = m.content;
    else if (m && m.content && typeof m.content === 'object') content = JSON.stringify(m.content);
    const matches = [...String(content).matchAll(re)];
    if (matches.length) last = matches[matches.length - 1][1];
  }
  return last ? String(last).replace(/\/index\.html$/i, '').replace(/\\/g, '/') : null;
}

const WEB_REFINE_CHANGE_VERB = /\b(make|set|switch|change|turn|convert|update|re-?color|re-?style|re-?design|add|remove|delete|drop|hide|use|apply|adjust|repaint|restyle|recolor|redesign)\b/i;
const WEB_REFINE_TARGET = /\b(it|this|the site|the website|the web\s*site|the web\s*page|the page|the design|the layout|the title|the name|the brand|the background|the theme|the colou?rs?|the accen?t|the text|the home(?:page)?|my site|my website|our site|our website)\b|\b(section|page|theme|mode|colou?r|palette|accent|style|title|name|background|font|dark|light|minimal|blue|red|green|purple|orange|yellow|pink|cyan|teal|indigo|violet|silver|gold|slate|gray|grey|black|white|neon)\b/i;
const WEB_REFINE_QUESTION = /^\s*(what|which|whose|does|did|is|are|was|were|how\s+(many|much|do|fast|long)|why|when|where|can\s+you\s+(tell|describe|show|explain))\b/i;
// Fresh website / folder / file / project builds belong to the normal plan path.
const WEB_REFINE_FRESH_BUILD = /\b(buat|create|make|generate|new|touch)\b[^.!?\n]{0,40}\b(folder|dir|directory|file|berkas|project|proyek|app|aplikasi|web\s*(app|page|site)?|website|site|situs|webpage|halaman)\b/i;

// Returns the folder of the last built website when `text` reads like a
// change request aimed at it, otherwise null.
function webRefineRequest(text, messages) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (WEB_REFINE_QUESTION.test(t)) return null;
  if (WEB_REFINE_FRESH_BUILD.test(t)) return null;
  if (!WEB_REFINE_CHANGE_VERB.test(t)) return null;
  if (!WEB_REFINE_TARGET.test(t)) return null;
  const folder = lastBuiltWebFolder(messages);
  return folder || null;
}

// Re-derives the design config of an already-built site straight off disk.
function parseWebConfigFromFolder(cwd, folder) {
  const dir = join(cwd || '.', folder);
  const read = (file) => {
    try { return readFileSync(join(dir, file), 'utf8'); } catch { return ''; }
  };
  const html = read('index.html');
  if (!html) return null;
  const css = read('style.css');
  const dec = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const titleM = /<title>([^<]*)<\/title>/i.exec(html);
  const name = dec(titleM ? titleM[1] : '').trim().slice(0, 40) || titleCase(sanitize(folder));
  const heroM = /<p class="hero-sub">(.*?)<\/p>/s.exec(html);
  let description = '';
  if (heroM) {
    const d = dec(heroM[1]);
    if (!/^Everything you need to know about /i.test(d) && !/^A beautifully designed page/i.test(d)) description = d.slice(0, 200);
  }
  const style = html.includes('data-theme="light"') ? 'light' : 'dark';
  const sections = WEB_SECTIONS.filter((id) => html.includes(`id="${id}"`));
  const accentM = /--accent:\s*#([0-9a-fA-F]{6})\b/.exec(css);
  const accent2M = /--accent-2:\s*#([0-9a-fA-F]{6})\b/.exec(css);
  const backend = read('src/App.tsx') || read('tsconfig.json') ? 'tsx'
    : read('server.js') || read('package.json') ? 'node'
    : 'python';
  return {
    name, folder, topic: '', description, style,
    accent: accentM ? '#' + accentM[1].toLowerCase() : '#7c3aed',
    accent2: accent2M ? '#' + accent2M[1].toLowerCase() : '#06b6d4',
    sections: sections.length ? sections : [...WEB_SECTIONS],
    backend,
  };
}

const WEB_COLOR_HINTS = [
  [/purple|violet|ungu/, 'purple'],
  [/blue|biru|azure/, 'blue'],
  [/cyan|teal/, 'cyan'],
  [/green|emerald|hijau|lime/, 'green'],
  [/gold|amber|yellow|kuning/, 'amber'],
  [/red|rose|merah|maroon|crimson/, 'rose'],
  [/pink/, 'pink'],
  [/orange|oranye/, 'orange'],
  [/gray|grey|slate|abu|silver|black|white/, 'slate'],
];

function paletteFromText(text, fallbackAccent2) {
  const t = String(text || '').toLowerCase();
  for (const [re, key] of WEB_COLOR_HINTS) if (re.test(t)) return { accent: PALETTES[key].accent, accent2: PALETTES[key].accent2 };
  const hex = /#([0-9a-f]{6})\b/i.exec(t);
  if (hex) return { accent: '#' + hex[1].toLowerCase(), accent2: fallbackAccent2 };
  return null;
}

const WEB_SECTION_ALIASES = {
  about: ['about', 'about us', 'overview', 'intro', 'pengenalan', 'kenalan', 'tentang'],
  features: ['features', 'services', 'feature', 'fitur', 'keunggulan'],
  gallery: ['gallery', 'portfolio', 'portofolio', 'galeri', 'photos', 'images'],
  stats: ['stats', 'statistics', 'statistik', 'angka', 'numbers', 'metrics'],
  contact: ['contact', 'kontak', 'hubungi', 'reach'],
};

// Applies the deterministic, prompt-derived edit hints on top of the current
// site config (baseline from disk).
function applyWebRefineHints(text, base) {
  const t = String(text || '');
  const cfg = { ...base, topic: base.topic || '' };

  const pal = paletteFromText(t, cfg.accent2);
  if (pal) { cfg.accent = pal.accent; cfg.accent2 = pal.accent2; }

  const hasStyle = /\b(light|dark|minimal|bright|clean|pastel|white|terang|gelap|simpl(e|istic|ify)|night|midnight)\b/i.test(t);
  if (hasStyle) cfg.style = webStyleName(t);

  const qm = /(?:change|rename|set|update|make)\b[^.!?\n]{0,30}\b(?:the\s+)?(?:title|name|brand)\b[^.!?\n]{0,24}\b(?:to|as|:|be|into)\b[^.!?\n]{0,6}"([^"]{1,40})"/i.exec(t);
  const um = /(?:change|rename|set|update|make)\b[^.!?\n]{0,30}\b(?:the\s+)?(?:title|name|brand)\b[^.!?\n]{0,24}\b(?:to|as|:|be|into)\b[^.!?\n]{0,2}\b([A-Za-z0-9][\w &!'-]{1,40})\b/i.exec(t);
  const titleMatch = qm || um;
  if (titleMatch) {
    let nm = titleMatch[1].trim().replace(/[.!?\n]+$/g, '').trim();
    if (nm) cfg.name = nm.slice(0, 40);
  }

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const adds = [];
  const rems = [];
  const addSw = /\b(add|include|insert|put|bring|with|plus|and)\b/i;
  const remSw = /\b(remove|delete|drop|hide|cut|without|lose|minus)\b/i;
  for (const [id, names] of Object.entries(WEB_SECTION_ALIASES)) {
    for (const name of names) {
      const re = new RegExp(`\\b${esc(name)}\\b`, 'gi');
      for (const m of String(t).matchAll(re)) {
        const before = t.slice(Math.max(0, m.index - 26), m.index);
        const after = t.slice(m.index + m[0].length, m.index + m[0].length + 12);
        if (remSw.test(before) || remSw.test(after)) { if (!rems.includes(id)) rems.push(id); }
        else if (addSw.test(before) || addSw.test(after)) { if (!adds.includes(id)) adds.push(id); }
      }
    }
  }
  for (const id of adds) if (!cfg.sections.includes(id)) cfg.sections = [...cfg.sections, id];
  for (const id of rems) cfg.sections = cfg.sections.filter((s) => s !== id);
  return cfg;
}

// Re-renders an already-built site in place from the refined config. Returns
// null when there is no previous site to refine.
async function webRefine(provider, messages, requestText, cwd) {
  const folder = webRefineRequest(requestText, messages);
  if (!folder) return null;
  const base = parseWebConfigFromFolder(cwd, folder);
  if (!base) return null;
  let cfg = applyWebRefineHints(requestText, base);
  let raw = '';
  try {
    raw = await completeWebConfig(provider, messages, requestText, webRefinePrompt(base));
  } catch { raw = ''; }
  if (raw) {
    const got = normalizeWebConfig(raw, cfg);
    cfg = {
      ...cfg,
      name: got.name && got.name !== cfg.name ? got.name : cfg.name,
      description: got.description || cfg.description,
      accent: got.accent && got.accent !== cfg.accent ? got.accent : cfg.accent,
      accent2: got.accent2 && got.accent2 !== cfg.accent2 ? got.accent2 : cfg.accent2,
    };
    logger.log('PLAN', 'web refine (AI design config)');
  } else {
    logger.log('PLAN', 'web refine (heuristic design)');
  }
  const hint = webStack(requestText);
  const tsx = hint.tsx;
  const stack = { tsx, js: true, node: tsx ? false : hint.node || base.backend === 'node', python: false };
  stack.python = !tsx && !stack.node;
  logger.log('PLAN', `plan: web refine ${folder}`);
  return renderWebPlan(cfg, requestText, stack);
}

// True when a plan looks like an actual generated website (an index.html inside
// a folder plus at least one web file: stylesheet, backend or TSX config).
function isWebSitePlan(plan) {
  if (!Array.isArray(plan) || !plan.length) return false;
  const files = plan
    .filter((c) => c && c.name === 'create_file' && c.params && typeof c.params.path === 'string')
    .map((c) => String(c.params.path).replace(/\\/g, '/'));
  if (!files.some((p) => /\/index\.html$/i.test(p))) return false;
  return files.some((p) => /(?:^|\/)(?:style\.css|app\.py|tsconfig\.json|server\.js|src\/styles\.css)$/i.test(p));
}

const WEB_CSS = `:root {
  --bg: #0b1020;
  --bg-soft: #121a33;
  --card: #151d3a;
  --text: #e7ecf8;
  --muted: #94a3c8;
  --accent: #7c3aed;
  --accent-2: #06b6d4;
  --border: rgba(255, 255, 255, 0.08);
  --radius: 16px;
  --shadow: 0 18px 45px rgba(0, 0, 0, 0.35);
  --nav-h: 3.8rem;
}
html[data-theme="light"] {
  --bg: #f4f6fb;
  --bg-soft: #e7ecf6;
  --card: #ffffff;
  --text: #16213a;
  --muted: #5a6a8f;
  --border: rgba(22, 33, 58, 0.12);
  --shadow: 0 18px 45px rgba(22, 33, 58, 0.12);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background:
    radial-gradient(1200px 600px at 80% -10%, rgba(124, 58, 237, 0.35), transparent 60%),
    radial-gradient(900px 500px at 10% 0%, rgba(6, 182, 212, 0.25), transparent 55%),
    var(--bg);
  color: var(--text);
  line-height: 1.6;
}
html[data-theme="light"] body {
  background:
    radial-gradient(1200px 600px at 80% -10%, rgba(124, 58, 237, 0.12), transparent 60%),
    radial-gradient(900px 500px at 10% 0%, rgba(6, 182, 212, 0.1), transparent 55%),
    var(--bg);
}
::selection { background: var(--accent); color: #fff; }
a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 3px solid var(--accent-2); outline-offset: 2px;
}
.container { width: min(1080px, 92%); margin: 0 auto; }
h1, h2, h3 { line-height: 1.15; margin: 0 0 0.5em; }
h2 { font-size: clamp(1.6rem, 3vw, 2.2rem); }
section { scroll-margin-top: var(--nav-h); }
.site-header {
  position: sticky; top: 0; z-index: 50;
  background: rgba(11, 16, 32, 0.75);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  transition: box-shadow 0.25s ease;
}
html[data-theme="light"] .site-header { background: rgba(244, 246, 251, 0.8); }
.site-header.scrolled { box-shadow: 0 6px 22px rgba(0, 0, 0, 0.3); }
html[data-theme="light"] .site-header.scrolled { box-shadow: 0 6px 22px rgba(22, 33, 58, 0.12); }
.nav { display: flex; align-items: center; justify-content: space-between; padding: 0.8rem 0; }
.brand {
  font-size: 1.15rem; font-weight: 800; color: var(--text);
  text-decoration: none; letter-spacing: -0.02em;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.nav-links { display: flex; align-items: center; gap: 1.3rem; list-style: none; margin: 0; padding: 0; }
.nav-links li { display: flex; }
.nav-links a { color: var(--muted); text-decoration: none; font-weight: 600; transition: color 0.2s; }
.nav-links a:hover { color: var(--text); }
.nav-toggle { display: none; background: none; border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 0.4rem 0.7rem; cursor: pointer; }
.theme-toggle {
  background: rgba(255, 255, 255, 0.06); color: var(--text);
  border: 1px solid var(--border); border-radius: 999px;
  padding: 0.35rem 0.8rem; font: inherit; font-size: 0.8rem; font-weight: 700;
  cursor: pointer; transition: background 0.2s, box-shadow 0.2s;
}
.theme-toggle:hover { background: rgba(255, 255, 255, 0.14); }
html[data-theme="light"] .theme-toggle { background: rgba(22, 33, 58, 0.06); }
html[data-theme="light"] .theme-toggle:hover { background: rgba(22, 33, 58, 0.12); }
.hero { padding: clamp(3.5rem, 9vw, 7rem) 0 3.5rem; text-align: center; }
.hero-eyebrow {
  display: inline-flex; gap: 0.5rem; font-size: 0.8rem; font-weight: 600;
  color: var(--accent-2); letter-spacing: 0.08em; text-transform: uppercase;
  border: 1px solid var(--border); padding: 0.35rem 0.8rem; border-radius: 999px;
  background: rgba(6, 182, 212, 0.08);
}
.hero h1 {
  font-size: clamp(2.4rem, 6vw, 4.2rem); letter-spacing: -0.03em; margin: 0.8rem 0;
  background: linear-gradient(100deg, #fff 20%, #c4b5fd 50%, #67e8f9 80%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
html[data-theme="light"] .hero h1 {
  background: linear-gradient(100deg, #16213a 20%, #7c3aed 50%, #06b6d4 80%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.hero-sub { color: var(--muted); font-size: clamp(1rem, 2vw, 1.2rem); max-width: 620px; margin: 0 auto 1.8rem; }
.hero-actions { display: flex; gap: 0.9rem; justify-content: center; flex-wrap: wrap; }
.btn {
  display: inline-block; padding: 0.75rem 1.4rem; border-radius: 12px;
  font-weight: 700; text-decoration: none; transition: transform 0.15s, box-shadow 0.15s;
}
.btn:hover { transform: translateY(-2px); }
.btn-primary {
  color: #fff; background: linear-gradient(90deg, var(--accent), var(--accent-2));
  box-shadow: 0 8px 24px rgba(124, 58, 237, 0.35);
}
.btn-ghost { color: var(--text); border: 1px solid var(--border); background: rgba(255, 255, 255, 0.04); }
html[data-theme="light"] .btn-ghost { background: rgba(22, 33, 58, 0.04); }
.section { padding: clamp(2.5rem, 6vw, 4.5rem) 0; }
.section.alt { background: var(--bg-soft); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 2.5rem; align-items: center; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.2rem; margin-top: 1.5rem; }
.card, .stat-card {
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 1.4rem; box-shadow: var(--shadow);
}
.card h3 { margin-top: 0.2rem; }
.card .num, .stat-card strong {
  color: transparent; background: linear-gradient(90deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text; background-clip: text;
}
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1.2rem; margin-top: 1.5rem; }
.stat-card strong { font-size: 2rem; display: block; }
.stat-card span { color: var(--muted); font-size: 0.9rem; }
.gallery-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-top: 1.5rem; }
.tile {
  aspect-ratio: 16 / 10; border-radius: var(--radius); border: 1px solid var(--border);
  display: flex; align-items: flex-end; padding: 1rem;
  color: #fff; font-weight: 800; letter-spacing: 0.02em;
  background:
    linear-gradient(135deg, rgba(124, 58, 237, 0.9), rgba(6, 182, 212, 0.75)),
    radial-gradient(circle at 25% 25%, rgba(255, 255, 255, 0.4), transparent 45%);
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}
.tile.t2 { background: linear-gradient(135deg, rgba(6, 182, 212, 0.9), rgba(34, 211, 238, 0.7)); }
.tile.t3 { background: linear-gradient(135deg, rgba(217, 70, 239, 0.9), rgba(124, 58, 237, 0.7)); }
.tile.t4 { background: linear-gradient(135deg, rgba(16, 185, 129, 0.9), rgba(6, 182, 212, 0.7)); }
.tile:hover { transform: translateY(-6px); box-shadow: var(--shadow); }
.muted { color: var(--muted); }
code {
  background: rgba(255, 255, 255, 0.08); border: 1px solid var(--border);
  padding: 0.1rem 0.45rem; border-radius: 6px; font-size: 0.9em;
}
html[data-theme="light"] code { background: rgba(22, 33, 58, 0.06); }
.form-wrap { max-width: 560px; }
label { display: block; font-weight: 600; margin: 0.9rem 0 0.35rem; }
input, textarea {
  width: 100%; padding: 0.7rem 0.9rem; border-radius: 10px;
  border: 1px solid var(--border); background: rgba(255, 255, 255, 0.05);
  color: var(--text); font: inherit;
}
input:focus, textarea:focus { outline: 2px solid var(--accent); border-color: transparent; }
.form-status { margin-top: 0.8rem; font-weight: 600; }
.form-status.ok { color: #34d399; }
.form-status.err { color: #f87171; }
.site-footer {
  border-top: 1px solid var(--border); padding: 1.6rem 0; text-align: center;
  color: var(--muted); font-size: 0.9rem;
}
#back-to-top {
  position: fixed; right: 1.2rem; bottom: 1.2rem; z-index: 60;
  border: 1px solid var(--border); background: var(--card); color: var(--text);
  border-radius: 999px; padding: 0.7rem 1rem; font: inherit; font-weight: 800; cursor: pointer;
  opacity: 0; pointer-events: none; transform: translateY(8px);
  transition: opacity 0.25s ease, transform 0.25s ease, box-shadow 0.25s ease;
}
#back-to-top.show { opacity: 1; pointer-events: auto; transform: none; }
#back-to-top:hover { box-shadow: var(--shadow); }
.reveal { opacity: 0; transform: translateY(18px); transition: opacity 0.6s ease, transform 0.6s ease; }
.reveal.visible { opacity: 1; transform: none; }
@media (max-width: 760px) {
  .grid-2 { grid-template-columns: 1fr; }
  .nav-links {
    display: none; flex-direction: column; gap: 0.8rem;
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 1rem; position: absolute; right: 4%; top: 3.6rem; min-width: 200px;
  }
  .nav-links.open { display: flex; }
  .nav-links li { width: 100%; }
  .nav-toggle { display: block; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .reveal, .tile, #back-to-top, .site-header { transition: none; }
  .reveal { opacity: 1; transform: none; }
}
`;

const WEB_JS = `(function () {
  'use strict';
  var root = document.documentElement;
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  var themeBtn = document.getElementById('theme-toggle');
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('theme'); } catch (err) {}
  var prefersLight = false;
  if (typeof window.matchMedia === 'function') {
    prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  }
  var theme = savedTheme || (prefersLight ? 'light' : 'dark');
  root.setAttribute('data-theme', theme);
  if (themeBtn) {
    themeBtn.textContent = theme === 'light' ? 'Dark' : 'Light';
    themeBtn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      themeBtn.textContent = next === 'light' ? 'Dark' : 'Light';
      try { localStorage.setItem('theme', next); } catch (err) {}
    });
  }

  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && revealEls.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('visible'); });
  }

  var headerEl = document.querySelector('.site-header');
  var topBtn = document.getElementById('back-to-top');
  function onScroll() {
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    if (headerEl) headerEl.classList.toggle('scrolled', y > 10);
    if (topBtn) topBtn.classList.toggle('show', y > 400);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  if (topBtn) {
    topBtn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  var visit = document.getElementById('stat-visits');
  var nameEl = document.getElementById('stat-name');
  if (visit && nameEl && typeof fetch === 'function') {
    fetch('/api/info')
      .then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); })
      .then(function (data) {
        visit.textContent = data.visits;
        nameEl.textContent = data.name;
      })
      .catch(function () { visit.textContent = 'offline'; });
  }

  var form = document.getElementById('contact-form');
  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var status = document.getElementById('form-status');
      var body = {
        name: form.elements.name ? form.elements.name.value : '',
        message: form.elements.message ? form.elements.message.value : ''
      };
      var finish = function (ok, text) {
        status.textContent = text;
        status.className = 'form-status ' + (ok ? 'ok' : 'err');
        if (ok) form.reset();
      };
      if (typeof fetch === 'function') {
        fetch('/api/contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
          .then(function (res) { return res.json(); })
          .then(function (data) { finish(Boolean(data.ok), data.ok ? 'Message sent, thank you!' : 'Could not send.'); })
          .catch(function () { finish(false, 'Backend unreachable - message not sent.'); });
      } else {
        finish(true, 'Thanks for your message! (static demo)');
      }
    });
  }
})();
`;

const WEB_APP_PY = `import errno
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8000"))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

VISITS_FILE = os.path.join(BASE_DIR, "visits.json")
MESSAGES_FILE = os.path.join(BASE_DIR, "messages.json")


def load_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def save_json(path: str, value) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(value, fh, indent=2)


def site_name() -> str:
    return os.path.basename(BASE_DIR)


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/info":
            visits = int(load_json(VISITS_FILE, 0)) + 1
            save_json(VISITS_FILE, visits)
            self._send_json({
                "name": site_name(),
                "visits": visits,
                "features": ["About", "Live data", "Responsive design"],
            })
            return
        if self.path == "/api/visit":
            visits = int(load_json(VISITS_FILE, 0)) + 1
            save_json(VISITS_FILE, visits)
            self._send_json({"visits": visits})
            return
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._send_json({"ok": False, "error": "invalid JSON"}, 400)
            return
        if self.path == "/api/contact":
            messages = load_json(MESSAGES_FILE, [])
            messages.append({
                "name": payload.get("name", ""),
                "message": payload.get("message", ""),
            })
            save_json(MESSAGES_FILE, messages)
            self._send_json({"ok": True, "saved": len(messages)})
            return
        self._send_json({"ok": False, "error": "unknown endpoint"}, 404)


if __name__ == "__main__":
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as err:
        if err.errno != errno.EADDRINUSE:
            raise
        print(f"Port {PORT} is already in use - picking a free port instead.")
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(f"Serving {site_name()} on http://127.0.0.1:{httpd.server_address[1]}")
    httpd.serve_forever()
`;

const WEB_SERVER_JS = `import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, extname, sep } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = os.path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8080', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let visits = 0;

function safePath(p) {
  const full = join(__dirname, decodeURIComponent(p).replace(/^[\\\\/]+/, ''));
  if (full !== __dirname && !full.startsWith(__dirname + sep)) return null;
  return full;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function sendJson(res, payload, status) {
  send(res, status || 200, 'application/json; charset=utf-8', JSON.stringify(payload));
}

function readMessages() {
  try { return JSON.parse(readFileSync(join(__dirname, 'messages.json'), 'utf-8')); } catch { return []; }
}

function siteName() {
  return os.path.basename(__dirname);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  if (path === '/api/info') {
    visits += 1;
    sendJson(res, { name: siteName(), visits, features: ['About', 'Live data', 'Responsive design'] });
    return;
  }
  if (path === '/api/visit') {
    visits += 1;
    sendJson(res, { visits });
    return;
  }
  if (req.method === 'POST' && path === '/api/contact') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const messages = readMessages();
        messages.push(JSON.parse(body));
        writeFileSync(join(__dirname, 'messages.json'), JSON.stringify(messages, null, 2));
        sendJson(res, { ok: true });
      } catch {
        sendJson(res, { ok: false }, 400);
      }
    });
    return;
  }

  const full = safePath(path === '/' || path === '' ? '/index.html' : path);
  if (!full) { send(res, 404, 'text/plain; charset=utf-8', 'Not found'); return; }
  try {
    const buf = readFileSync(full);
    send(res, 200, MIME[extname(full)] || 'application/octet-stream', buf);
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Port ' + PORT + ' is already in use - picking a free port instead.');
    server.listen(0);
    return;
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Serving on http://127.0.0.1:' + server.address().port);
});
`;

const TSX_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
`;

const TSX_VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
});
`;

const TSX_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="__TITLE__ - a React + TypeScript website generated automatically." />
    <title>__TITLE__</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const TSX_MAIN_TSX = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
`;

const TSX_APP_TSX = `import { useEffect, useState, type FormEvent } from 'react';

type SiteInfo = { name: string; visits: number };

const APP_NAME = '__TITLE__';

const features = [
  { title: 'About', body: 'A clear, friendly introduction to __TOPIC__ and everything it covers, in a fast single-page app built with React and TypeScript.' },
  { title: 'Live', body: 'The UI is fully component-driven TSX, so any part of the page can update instantly without a full reload.' },
  { title: 'Responsive', body: 'Fluid grids, accessible markup and a strictly typed codebase make __TOPIC__ easy to extend and maintain.' },
];

export default function App() {
  const [info, setInfo] = useState<SiteInfo | null>(null);
  const [sync, setSync] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    fetch('/api/info')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SiteInfo | null) => {
        setInfo(data);
        setSync(data ? 'Live API request succeeded.' : 'Backend offline - showing defaults.');
      })
      .catch(() => setSync('Backend offline - showing defaults.'));
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload = {
      name: String(data.get('name') || ''),
      message: String(data.get('message') || ''),
    };
    if (typeof fetch === 'function') {
      fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then((res) => res.json())
        .then((res) => setSync(res.ok ? 'Message sent, thank you!' : 'Could not send the message.'))
        .catch(() => setSync('Backend unreachable - message not sent.'));
    } else {
      setSync('Thanks for your message! (static demo)');
    }
    event.currentTarget.reset();
  };

  return (
    <div className="shell">
      <header className="site-header">
        <nav className="nav container">
          <a className="brand" href="#top">{APP_NAME}</a>
          <button
            className="nav-toggle"
            type="button"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menu
          </button>
          <ul className={'nav-links' + (menuOpen ? ' open' : '')}>
            <li><a href="#about">About</a></li>
            <li><a href="#features">Features</a></li>
            <li><a href="#stats">Stats</a></li>
            <li><a href="#contact">Contact</a></li>
          </ul>
        </nav>
      </header>

      <main id="top">
        <section className="hero">
          <div className="container">
            <p className="hero-eyebrow">React 18 &middot; TypeScript &middot; Vite &middot; CSS</p>
            <h1>Welcome to {APP_NAME}</h1>
            <p className="hero-sub">A modern, typed single-page app about __TOPIC__, generated automatically and designed as clean, reusable TSX components.</p>
            <div className="hero-actions">
              <a className="btn btn-primary" href="#about">Explore {APP_NAME}</a>
              <a className="btn btn-ghost" href="#contact">Get in touch</a>
            </div>
          </div>
        </section>

        <section id="about" className="section">
          <div className="container">
            <h2>About __TOPIC__</h2>
            <p>This React + TypeScript (TSX) site was generated automatically from a single request. The UI lives in typed components inside src/, the design system lives in src/styles.css, and you can start editing right away.</p>
            <p>Run <code>npm install</code> then <code>npm run dev</code> to launch the Vite dev server. Type errors are checked on every save.</p>
          </div>
        </section>

        <section id="features" className="section alt">
          <div className="container">
            <h2>Features</h2>
            <div className="card-grid">
              {features.map((feature, index) => (
                <article className="card reveal" key={feature.title}>
                  <span className="num">0{index + 1}</span>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="stats" className="section">
          <div className="container">
            <h2>Live stats</h2>
            <div className="stat-grid">
              <div className="stat-card"><strong>{info ? info.visits : '...'}</strong><span>site visitors</span></div>
              <div className="stat-card"><strong>{info ? info.name : APP_NAME}</strong><span>current topic</span></div>
              <div className="stat-card"><strong>7</strong><span>generated files</span></div>
            </div>
            <p className="muted">{sync || 'Connecting to the backend API...'}</p>
          </div>
        </section>

        <section id="contact" className="section alt">
          <div className="container form-wrap">
            <h2>Contact</h2>
            <p className="muted">The form below posts to /api/contact when a backend is connected.</p>
            <form onSubmit={submit}>
              <label htmlFor="name">Your name</label>
              <input id="name" name="name" type="text" required />
              <label htmlFor="message">Message</label>
              <textarea id="message" name="message" rows={4} required></textarea>
              <button className="btn btn-primary" type="submit">Send message</button>
              {sync ? <p className="form-status" role="status">{sync}</p> : null}
            </form>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container">
          <p>{new Date().getFullYear()} &copy; {APP_NAME}. Crafted automatically by VierrataleAI.</p>
        </div>
      </footer>
    </div>
  );
}
`;

function tsxUrl(folder, title, topic, css = WEB_CSS) {
  return [
    { name: 'create_file', params: { path: `${folder}/package.json`, content: JSON.stringify({
      name: folder,
      private: true,
      version: '1.0.0',
      type: 'module',
      scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
      devDependencies: {
        '@types/react': '^18.3.10',
        '@types/react-dom': '^18.3.0',
        '@vitejs/plugin-react': '^4.3.1',
        typescript: '^5.6.2',
        vite: '^5.4.8',
      },
    }, null, 2) + '\n' } },
    { name: 'create_file', params: { path: `${folder}/tsconfig.json`, content: TSX_TSCONFIG } },
    { name: 'create_file', params: { path: `${folder}/vite.config.ts`, content: TSX_VITE_CONFIG } },
    { name: 'create_file', params: { path: `${folder}/index.html`, content: TSX_INDEX_HTML.replaceAll('__TITLE__', title) } },
    { name: 'create_file', params: { path: `${folder}/src/main.tsx`, content: TSX_MAIN_TSX } },
    { name: 'create_file', params: { path: `${folder}/src/App.tsx`, content: TSX_APP_TSX.replaceAll('__TITLE__', title).replaceAll('__TOPIC__', topic) } },
    { name: 'create_file', params: { path: `${folder}/src/styles.css`, content: css } },
  ];
}

function webIndexHtml({ title, topic, description, stack, style, sections }) {
  const backend = stack.node ? 'Node.js' : 'Python';
  const subject = topic || title;
  const has = (id) => !sections || sections.length === 0 || sections.includes(id);
  const navItems = WEB_SECTIONS.filter((id) => has(id))
    .map((id) => `<li><a href="#${id}">${WEB_SECTION_LABELS[id]}</a></li>`)
    .join('\n        ');
  const heroSub = description || (topic
    ? `Everything you need to know about ${topic} - made automatically, styled beautifully, and brought to life by a ${backend} backend.`
    : `A beautifully designed page made automatically - styled with CSS, made interactive with JavaScript, and powered by a ${backend} backend.`);
  const aboutPara = description
    ? `${description} Built automatically from a single request - no manual typing - and fully self-contained: HTML for structure, CSS for the design, JavaScript for the interaction and a ${backend} server for the logic.`
    : topic
      ? `This is a dedicated page for ${topic}. It was generated automatically from a single request - no manual typing, no copy-paste - and it is fully self-contained: HTML for structure, CSS for the design, JavaScript for the interaction and a ${backend} server for the logic.`
      : `This site was generated automatically from a single request. It is fully self-contained: HTML for structure, CSS for the design, JavaScript for the interaction and a ${backend} server for the logic.`;
  const features = [
    { t: 'About', d: `A clear, friendly introduction to ${subject} and everything it covers, laid out on one responsive page.` },
    { t: 'Live', d: `The page never reloads - JavaScript talks to a ${backend} API for live stats and message handling.` },
    { t: 'Responsive', d: `Fluid grids, a touch-friendly menu and accessible markup make ${subject} work on any screen size.` },
  ]
    .map((f, i) => `<article class="card reveal"><span class="num">0${i + 1}</span><h3>${f.t}</h3><p>${f.d}</p></article>`)
    .join('\n        ');

  const heroSection = `    <section class="hero">
      <div class="container">
        <p class="hero-eyebrow">HTML &middot; CSS &middot; JavaScript &middot; ${backend}</p>
        <h1>Welcome to ${title}</h1>
        <p class="hero-sub">${heroSub}</p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="#about">Explore ${title}</a>
          <a class="btn btn-ghost" href="#contact">Get in touch</a>
        </div>
      </div>
    </section>`;

  const aboutSection = `    <section id="about" class="section">
      <div class="container grid-2">
        <div>
          <h2>About ${subject}</h2>
          <p>${aboutPara}</p>
          <p>Open the folder and run the server below - the whole page, including live stats, the contact form and the gallery, works out of the box.</p>
        </div>
        <div class="card-grid">
          <div class="card reveal"><span class="num">01</span><h3>Structure</h3><p>Semantic HTML with clear sections: hero, about, features, gallery, stats and contact.</p></div>
          <div class="card reveal"><span class="num">02</span><h3>Design</h3><p>A modern dark theme with gradients, a glass header, cards, gradient tiles and smooth reveal animations.</p></div>
          <div class="card reveal"><span class="num">03</span><h3>Logic</h3><p>${backend} backend serves the files and exposes an API used by the JavaScript frontend.</p></div>
        </div>
      </div>
    </section>`;

  const featuresSection = `    <section id="features" class="section alt">
      <div class="container">
        <h2>Features</h2>
        <div class="card-grid">
        ${features}
        </div>
      </div>
    </section>`;

  const gallerySection = `    <section id="gallery" class="section">
      <div class="container">
        <h2>Gallery</h2>
        <p class="muted">A splash of color - pure CSS gradients, no images to download.</p>
        <div class="gallery-grid">
          <div class="tile">Card 01</div>
          <div class="tile t2">Card 02</div>
          <div class="tile t3">Card 03</div>
          <div class="tile t4">Card 04</div>
        </div>
      </div>
    </section>`;

  const statsSection = `    <section id="stats" class="section">
      <div class="container">
        <h2>Live stats</h2>
        <div class="stat-grid">
          <div class="stat-card"><strong id="stat-visits">-</strong><span>site visitors</span></div>
          <div class="stat-card"><strong id="stat-name">${title}</strong><span>current topic</span></div>
          <div class="stat-card"><strong>4</strong><span>generated files</span></div>
        </div>
        <p class="muted">Numbers are served live by the ${backend} backend at /api/info - one request per page load.</p>
      </div>
    </section>`;

  const contactSection = `    <section id="contact" class="section alt">
      <div class="container form-wrap">
        <h2>Contact</h2>
        <p class="muted">Send a message - the ${backend} backend saves it to messages.json.</p>
        <form id="contact-form" novalidate>
          <label for="name">Your name</label>
          <input id="name" name="name" type="text" required>
          <label for="message">Message</label>
          <textarea id="message" name="message" rows="4" required></textarea>
          <button class="btn btn-primary" type="submit">Send message</button>
          <p class="form-status" id="form-status" role="status"></p>
        </form>
      </div>
    </section>`;

  const body = [heroSection, has('about') ? aboutSection : '', has('features') ? featuresSection : '', has('gallery') ? gallerySection : '', has('stats') ? statsSection : '', has('contact') ? contactSection : ''].filter(Boolean);

  return `<!doctype html>
<html lang="en"${style && style !== 'dark' ? ' data-theme="light"' : ''}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${title} - a designed website built with HTML, CSS, JavaScript and ${backend}.">
  <title>${title}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="site-header">
    <nav class="nav container">
      <a class="brand" href="#top">${title}</a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-label="Toggle navigation">Menu</button>
      <ul class="nav-links">
        ${navItems}
        <li><button class="theme-toggle" id="theme-toggle" type="button" aria-label="Toggle color theme">Theme</button></li>
      </ul>
    </nav>
  </header>

  <main id="top">
${body.join('\n\n')}
  </main>

  <button id="back-to-top" type="button" aria-label="Back to top">Top</button>

  <footer class="site-footer">
    <div class="container">
      <p><span id="year">2026</span> &copy; ${title}. Crafted automatically by VierrataleAI.</p>
    </div>
  </footer>

  <script src="script.js"></script>
</body>
</html>
`;
}

function renderWebPlan(config, text, stack = webStack(text)) {
  const safeTitle = escapeHtml(config.name);
  const safeTopic = config.topic ? escapeHtml(titleCase(config.topic)) : '';
  const safeDesc = config.description ? escapeHtml(config.description) : '';
  const css = webCss(config);

  if (stack.tsx) {
    return [
      { name: 'create_directory', params: { path: config.folder } },
      ...tsxUrl(config.folder, safeTitle, safeTopic || safeTitle, css),
    ];
  }

  const indexContent = webIndexHtml({ title: safeTitle, topic: safeTopic, description: safeDesc, stack, style: config.style, sections: config.sections });
  const plan = [
    { name: 'create_directory', params: { path: config.folder } },
    { name: 'create_file', params: { path: `${config.folder}/index.html`, content: indexContent } },
    { name: 'create_file', params: { path: `${config.folder}/style.css`, content: css } },
  ];
  if (stack.js) {
    plan.push({ name: 'create_file', params: { path: `${config.folder}/script.js`, content: WEB_JS } });
  }
  if (stack.node) {
    plan.push({ name: 'create_file', params: { path: `${config.folder}/package.json`, content: JSON.stringify({ name: config.folder, version: '1.0.0', type: 'module', main: 'server.js', scripts: { start: 'node server.js' } }, null, 2) + '\n' } });
    plan.push({ name: 'create_file', params: { path: `${config.folder}/server.js`, content: WEB_SERVER_JS } });
  } else {
    plan.push({ name: 'create_file', params: { path: `${config.folder}/app.py`, content: WEB_APP_PY } });
  }
  return plan;
}

function webSitePlan(text, folderName, config = null) {
  return renderWebPlan(config || probeWebConfig(text, folderName), text);
}

function webFolderPlan(text, folderName) {
  const makesWeb = /\b(buat|create|make|generate)\b[^.!?\n]{0,40}\b(web\s*(app|page|site)?|website|situs|webpage|halaman)\b/i.test(text) ||
    /\b(web\s*app|website|situs|webpage)\b[^.!?\n]{0,40}\b(pack|kemas|satukan|folder|dir|directory)\b/i.test(text);
  if (!makesWeb) return [];
  return webSitePlan(text, folderName);
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export async function planOnce(provider, messages, requestText, options = {}) {
  // Fast path: if the request matches a confident heuristic (folder/file/command),
  // use it directly and skip the slow model-plan round entirely.
  if (options.heuristicFirst !== false) {
    const fast = heuristicPlan(requestText);
    if (fast.length) {
      if (isWebSitePlan(fast)) {
        const cfg = await webDesignConfig(provider, messages, requestText);
        if (cfg) {
          const explicit = folderPlanName(requestText);
          if (explicit) cfg.folder = explicit;
          logger.log('PLAN', 'plan: web site (AI design config)');
          return webSitePlan(requestText, cfg.folder, cfg);
        }
        logger.log('PLAN', 'plan: web site (heuristic design)');
      } else {
        logger.log('PLAN', 'plan: heuristic (fast path)');
      }
      return fast;
    }
  }
  const planTimeoutMs = options.planTimeoutMs ?? Config.get('planTimeoutMs');
  const history = (messages && messages.length ? messages.slice(-6) : [{ role: 'user', content: requestText }]);
  const controller = new AbortController();
  let text = '';
  let timer;
  try {
    text = await Promise.race([
      provider.complete([...history, { role: 'user', content: requestText }], {
        model: Config.getEffectiveModel(provider.name),
        system_prompt: TOOL_PLAN_PROMPT,
        maxTokens: 400,
        signal: controller.signal,
      }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          if (!controller.signal.aborted) controller.abort();
          reject(Object.assign(new Error(`model plan exceeded ${planTimeoutMs}ms`), { name: 'DeadlineError' }));
        }, planTimeoutMs);
      }),
    ]);
  } catch (err) {
    logger.log('PLAN', `model plan aborted after ${planTimeoutMs}ms${err && err.message ? ` (${err.message})` : ''}`);
  } finally {
    clearTimeout(timer);
  }
  const plan = parseToolPlan(text);
  if (plan.length) return plan;
  const heuristic = heuristicPlan(requestText);
  if (heuristic.length) logger.log('PLAN', 'plan fallback: heuristic');
  return heuristic;
}

async function executeToolCall({ executor, call, chatUI, messages, cwd }) {
  const label = call.name === 'run_command' ? call.params.command
    : call.name === 'download_url' ? `download_url(${call.params.url})`
    : (call.name === 'todo_add' || call.name === 'todo_update')
      ? `${call.name}(${JSON.stringify(call.params ?? {})})`
      : `${call.name}(${call.params.path})`;
  if (chatUI) {
    chatUI.setStatus(`Running: ${label}`);
    chatUI.setThinking(true);
    chatUI.render(messages);
  }
  const result = await dispatchTool(executor, call);
  logger.log('EXEC', `${label} -> ${result.exitCode}${result.timedOut ? ' [timeout]' : ''}`);
  if (result.success) {
    if (chatUI) chatUI.notify(`\u2713 ${label}`);
    if (result.stdout.trim()) logger.log('EXEC', `${label} stdout: ${result.stdout.trim().slice(0, 500)}`);
    if (result.stderr.trim()) logger.log('WARN', `${label} stderr: ${result.stderr.trim().slice(0, 500)}`);
    if (call.name === 'create_file' && /\.py$/i.test(call.params.path)) {
      const check = spawnSync('python3', [
        '-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())',
        join(cwd || '.', call.params.path),
      ], { encoding: 'utf-8', timeout: 30000 });
      if (check.status === 1) {
        const detail = (check.stderr || '').trim().split('\n').slice(-2).join(' ');
        if (chatUI) chatUI.notify(`\u2717 python check failed: ${call.params.path} (${detail})`);
        logger.log('WARN', `${label} failed python syntax check: ${detail}`);
      }
    }
  } else {
    if (chatUI) chatUI.notify(`\u2717 ${label}: ${(result.stderr || 'failed').trim().slice(0, 300)}`);
    logger.log('ERROR', `${label} failed: ${(result.stderr || result.stdout || 'exit ' + result.exitCode).trim().slice(0, 500)}`);
  }
  return { label, result };
}

// Ask the model for a corrected tool plan after a failed call. Returns []
// when the model emits nothing usable. Does NOT mutate the session messages.
async function planAutoFix(provider, messages, requestText, call, result) {
  const history = (messages && messages.length ? messages.slice(-6) : [{ role: 'user', content: String(requestText || '') }]);
  const deadline = Config.get('planTimeoutMs');
  const controller = new AbortController();
  let text = '';
  let timer;
  try {
    text = await Promise.race([
      provider.complete([...history, { role: 'user', content: TOOL_FIX_PROMPT(call, result) }], {
        model: Config.getEffectiveModel(provider.name),
        system_prompt: TOOL_PLAN_PROMPT,
        maxTokens: 400,
        signal: controller.signal,
      }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          if (!controller.signal.aborted) controller.abort();
          reject(Object.assign(new Error(`auto-fix exceeded ${deadline}ms`), { name: 'DeadlineError' }));
        }, deadline);
      }),
    ]);
  } catch (err) {
    logger.log('FIX', `auto-fix plan failed: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
  const plan = parseToolPlan(text);
  if (plan.length) logger.log('FIX', `auto-fix plan: ${plan.map((p) => p.name).join(', ')}`);
  return plan;
}

export async function runWithTools({
  provider,
  messages,
  requestText,
  systemPrompt,
  chatUI,
  cwd,
  timeoutMs,
  heuristicFirst = true,
} = {}) {
  const refinedFolder = webRefineRequest(requestText, messages);
  const isOp = !refinedFolder && looksLikeOperationRequest(requestText);
  if (!refinedFolder && !isOp) return false;

  const executor = makeExecutor({ cwd, timeoutMs });
  const results = [];
  const plannedByModel = [];
  let autoFixes = 0;

  for (let round = 0; round < MAX_PLANNING_ROUNDS; round++) {
    let plan;
    if (!isOp && round === 0) {
      plan = (await webRefine(provider, messages, requestText, cwd)) || [];
    } else {
      plan = await planOnce(provider, messages, requestText, { heuristicFirst });
    }
    if (!plan.length) break;
    plannedByModel.push(plan);

    const steps = Math.min(plan.length, MAX_STEPS - results.length);
    let allOk = true;
    for (const call of plan.slice(0, steps)) {
      const { result } = await executeToolCall({ executor, call, chatUI, messages, cwd });
      results.push({ name: call.name, params: call.params, result });
      if (!result.success) allOk = false;
      if (result.timedOut && !result.success) break;

      if (!result.success && autoFixes < MAX_AUTO_FIXES && results.length < MAX_STEPS) {
        autoFixes++;
        if (chatUI) chatUI.setStatus('Auto-fixing failed step…');
        const fixPlan = await planAutoFix(provider, messages, requestText, call, result);
        const fixSteps = Math.min(fixPlan.length, MAX_STEPS - results.length);
        let fixedOk = fixPlan.length > 0;
        for (const fcall of fixPlan.slice(0, fixSteps)) {
          const f = await executeToolCall({ executor, call: fcall, chatUI, messages, cwd });
          results.push({ name: fcall.name, params: fcall.params, result: f.result });
          if (!f.result.success) { fixedOk = false; break; }
        }
        if (fixedOk && chatUI) chatUI.notify('Auto-fixed after failure.');
        if (fixedOk) allOk = true;
      }
    }
    if (allOk || !results.length || round >= MAX_PLANNING_ROUNDS - 1) break;
  }

  if (results.length) {
    const madeFiles = results.some((r) => (r.name === 'create_file' || r.name === 'create_directory') && r.result.success);
    if (madeFiles) {
      const treeText = renderFileTree(cwd || process.cwd()).join('\n');
      logger.log('TREE', treeText.slice(0, 2500));
      if (chatUI) chatUI.notify(treeText);
    }
    if (chatUI) {
      chatUI.setStatus('');
      chatUI.setThinking(true);
      chatUI.render(messages);
    }
  }
  return { results, plannedByModel };
}

export { TOOL_PLAN_PROMPT, TOOL_RESULTS_PROMPT, lastBuiltWebFolder, webRefineRequest, parseWebConfigFromFolder, applyWebRefineHints };