import { execFile } from 'child_process';
import { promisify } from 'util';
import { Config } from './config.js';
import { Catalog } from './catalog.js';
import { Engine } from './engine.js';
import { ProviderFactory } from './providers/index.js';
import { Branding } from './ui/branding.js';
import { Terminal } from './ui/terminal.js';
import { loadSystemPrompt } from './ui/banner.js';
import { LineEditor } from './ui/input.js';
import { WebSearch } from './utils/websearch.js';
import { WebFetch } from './utils/webfetch.js';
import { Downloader } from './utils/downloader.js';
import { FileWriter } from './utils/filewriter.js';
import { detectIntent, extractSearchTopic, looksLikeStoryRequest } from './utils/intents.js';
import { trySolveMath } from './utils/math.js';
import { Session } from './session.js';
import { ChatUI, FrameThrottle } from './ui/chatbox.js';
import { logger } from './utils/logger.js';
import { runWithTools, TOOL_RESULTS_PROMPT, looksLikeOperationRequest } from './cmd/agent.js';
import { loadTodos, addTodo, updateTodo, clearTodos, saveTodos, formatTodos, todosFile } from './cmd/todos.js';

function parseArgs(args) {
  const parsed = { provider: null, model: null, clear: false, version: false, help: false, install: false };
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--provider' || arg === '-p') parsed.provider = args[++i];
    else if (arg === '--model' || arg === '-m') parsed.model = args[++i];
    else if (arg === '--clear') parsed.clear = true;
    else if (arg === '--version' || arg === '-v') parsed.version = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--install' || arg === '--setup' || arg === 'install') parsed.install = true;
  }
  return parsed;
}

function showHelp() {
  console.log(`
${Branding.APP_NAME} ${Branding.VERSION}
Usage: vierrataleai [options]

Options:
  --provider, -p <name>   Provider: cortex, openai (default: auto-detect)
  --model, -m <name>      Model: e.g. VTL-2.7-Flash/3.5-Reason/6.0-Reason
  --clear                 (deprecated: screen is always cleared on start)
  --install, --setup      Install engine + model + a "vierrataleai" command, then run
  --version, -v           Show version
  --help, -h              Show this help

Missing dependencies (engine + model) are installed automatically on start.

Commands (in chat):
  /help                   Show commands
  /model [name]           Switch model
  /provider [name]        Switch provider
  /models                 List available models
  /search <query>         Search the web and summarize with AI
  /fetch <url>            Open a link and summarize its content
  /download <url>         Download a file, folder listing or archive
  /todos                  List the todo list (add <text> | done/undone <n> | clear)
  /log [n|path]           Show the last n log entries (default 30), or the log file path
  /clear                  Clear screen
  /new                    Start a new empty session (keeps old ones)
  /sessions               List saved sessions
  /session new [name]     Create and switch to a session
  /session open <name|#>  Resume a session (e.g. /session open #2)
  /session delete <name|#>  Delete a session
  /session backup [name|#]  Back up a session to a .bak.json (auto on fresh start)
  /session backups        List session backups
  /session restore <n|#>  Restore a backup into a session
  /quit                   Exit
`);
}

export const SLASH_COMMANDS = [
  { name: 'help', desc: 'Show all commands' },
  { name: 'clear', desc: 'Clear the screen' },
  { name: 'new', desc: 'Start a new empty conversation' },
  { name: 'model', args: '[name]', desc: 'Switch model' },
  { name: 'provider', args: '[name]', desc: 'Switch provider' },
  { name: 'models', desc: 'List available models' },
  { name: 'search', args: '<query>', desc: 'Search the web and summarize' },
  { name: 'fetch', args: '<url>', desc: 'Open a link and summarize' },
  { name: 'download', args: '<url>', desc: 'Download a file / folder / archive' },
  { name: 'system', desc: 'Show or set the system prompt' },
  { name: 'todos', args: '[add <text> | done <n> | undone <n> | clear]', desc: 'Manage the todo list' },
  { name: 'sessions', desc: 'List saved sessions' },
  { name: 'session', args: 'new | open | delete | backup | restore', desc: 'Manage sessions' },
  { name: 'log', args: '[n | path]', desc: 'Show recent log entries' },
  { name: 'quit', desc: 'Exit' },
];

const FILE_VERBS =
  'write|save|make|create|generate|build|code|design|implement|produce|add|store|put|give me|show me|make me|help me|need|want|have';
const FILE_NOUNS =
  'file|folder|directory|txt|json|md|markdown|text file|document|html|css|js|javascript|script|page|webpage|website|code|project|config|app|application|api|bot|game|tool|crawler|scraper';
const KNOWLEDGE_MARKERS =
  /\b(how|why|what is|what are|what's|whats|explain|learn|teach me|meaning|means|used for|tutorial|why is|what does|is it|does it)\b/i;
const CONCRETE_FILE_ASK = new RegExp(
  `\\b(?:create|make|write|save|generate|build|produce)\\b[^.!?\\n]{0,60}\\b(?:${FILE_NOUNS})\\b`,
  'i'
);
const FILE_ASK_STRONG = new RegExp(
  `\\b(?:${FILE_VERBS})\\b[^.!?]{0,80}\\b(?:${FILE_NOUNS})\\b`,
  'i'
);
const FILE_ASK_SENTENCE = new RegExp(
  `\\b(?:${FILE_VERBS})\\b[^.!?\\n]{0,160}\\b(?:${FILE_NOUNS})\\b`,
  'i'
);

// Attached as a hidden user message to file requests so small local models
// reliably emit complete FILE: blocks with closed fences instead of free-style
// prose that gets truncated or never closes its code fences.
const FILE_BLOCK_PROMPT = `If the user asked you to create a file or project with code, output your whole answer as one or more file blocks — nothing else:

FILE: path/to/file.ext
${'```'}language
<complete, working code>
${'```'}

Rules:
- One FILE: header at the start of each file, immediately followed by its fenced code block.
- Always close every fence with ${'```'}.
- Write real, complete code on the first try — no placeholders, no "[0]", no Lorem ipsum, no "This is a basic example" filler, no fabricated external script URLs.
- If the request mentions serving or routing the files (e.g. a python web server, flask, routes), also write the server file (like app.py) that serves them.`;

function looksLikeFileRequest(text) {
  const s = String(text || '');
  if (KNOWLEDGE_MARKERS.test(s) && !CONCRETE_FILE_ASK.test(s)) return false;
  if (FILE_ASK_STRONG.test(s)) return true;
  return FILE_ASK_SENTENCE.test(s);
}

const CODE_FILE_RE = /([\w.-]+\.(?:html?|css|json|jsx|tsx|mjs|cjs|ts|js|md|markdown|txt|py|php|rb|go|java|c|cpp|h|sh|bat|yml|yaml|xml|sql|svg|csv|env))/i;

function requestedFileName(text) {
  const m = String(text || '').match(CODE_FILE_RE);
  if (m) return m[1];
  const lower = String(text || '').toLowerCase();
  if (/\b(python|py)\b/.test(lower) && /\b(html?|css|javascript|js|website|webpage|web|route)\b/.test(lower)) return 'app.py';
  if (/\b(python|py)\b/.test(lower)) return 'script.py';
  if (/\b(flask|django|fastapi|streamlit)\b/.test(lower)) return 'app.py';
  if (/\b(bash|zsh|shell)\b/.test(lower)) return 'script.sh';
  if (/\b(javascript|js|script)\b/.test(lower)) return 'script.js';
  if (/\b(typescript|ts)\b/.test(lower)) return 'script.ts';
  if (/\bjson\b/.test(lower)) return 'output.json';
  if (/\b(markdown|md)\b/.test(lower)) return 'output.md';
  if (/\b(html?|webpage|website|page)\b/.test(lower)) return 'index.html';
  if (/\bcss\b/.test(lower)) return 'style.css';
  if (/\bapp\b/.test(lower)) return 'app.py';
  if (/\b(yaml|yml)\b/.test(lower)) return 'output.yml';
  if (/\bcsv\b/.test(lower)) return 'output.csv';
  if (/\bsql\b/.test(lower)) return 'output.sql';
  return null;
}

function extractFallbackFile(response, requestText) {
  const lines = String(response || '').split('\n');
  const headerIdx = lines.findIndex((l) => /^FILE:\s*.+$/i.test(l));
  if (headerIdx !== -1) {
    const path = lines[headerIdx].replace(/^FILE:\s*/i, '').trim();
    const content = lines
      .slice(headerIdx + 1)
      .map((l) => (/^```/.test(l.trim()) ? '' : l))
      .join('\n')
      .trim();
    return { path, content };
  }
  const fenced = String(response || '').match(/```([\w./+-]*)[^\n]*\n?([\s\S]*?)(?:```|$)/);
  const content = fenced ? fenced[2].trim() : String(response || '').replace(/^FILE:\s*\S+\s*$/gim, '').trim();
  const path = requestedFileName(requestText) || languageFileName(fenced ? fenced[1] : null) || storyFileName(requestText);
  return { path, content };
}

function storyFileName(text) {
  const topic = extractSearchTopic(text);
  let raw = (topic || 'story')
    .toLowerCase()
    .replace(/\s+and\s+(?:write|save|make|create|generate|build|give|put)\b.*$/i, '')
    .replace(/\s+(?:in|into|to)\s+.*?(?:file|txt|json|md|csv)\b.*$/i, '')
    .replace(/\s+for\s+me\s*$/i, '')
    .trim();
  const slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'story'}.txt`;
}

function responseWantsFile(response) {
  return /^(?:FILE|FOLDER):\s*\S/im.test(String(response || ''));
}

function languageFileName(lang) {
  const map = {
    html: 'index.html', htm: 'index.html', xml: 'index.html',
    css: 'style.css', js: 'script.js', javascript: 'script.js',
    ts: 'script.ts', json: 'output.json', md: 'output.md',
    markdown: 'output.md', py: 'script.py', python: 'script.py',
    txt: 'output.txt', sh: 'script.sh', bash: 'script.sh',
    yaml: 'output.yml', yml: 'output.yml', csv: 'output.csv',
    svg: 'output.svg', sql: 'output.sql', go: 'main.go',
    java: 'Main.java', rb: 'script.rb', php: 'script.php',
    c: 'main.c', cpp: 'main.cpp', h: 'main.h',
  };
  return map[String(lang || '').toLowerCase()] || null;
}

// True when the reply is basically "just code": one or more substantial
// fenced code blocks and very little surrounding prose.
function responseIsSoloCode(response) {
  const text = String(response || '');
  const blocks = [...text.matchAll(/```[\w./+-]*[^\n]*\n?([\s\S]*?)(?:```|$)/g)];
  if (!blocks.length) return false;
  const totalCode = blocks.reduce((n, b) => n + b[1].length, 0);
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/\s+/g, ' ').trim();
  return totalCode >= 50 && prose.length <= 60;
}

// Prose-only replies are fine for story requests (.txt), but a file/code
// request with no fenced block and no FILE: header must not be saved as code.
function fallbackHasUsefulCode(response, requestText) {
  const hasCode = /```[\w./+-]*/m.test(String(response || '')) || responseWantsFile(response);
  return looksLikeStoryRequest(requestText) || hasCode;
}

// After a .py file is saved, compile-check it so truncated or broken replies
// never sit on disk silently. Returns a promise so callers can await the check
// before surfacing results (the test previously raced a fire-and-forget exec).
async function validateWrittenCode(fileName, notify) {
  if (!/\.py$/i.test(fileName)) return;
  try {
    await promisify(execFile)(
      'python3',
      ['-c', 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")', fileName]
    );
  } catch (err) {
    const msg = `Saved ${fileName}, but Python couldn't compile it (the reply may have been cut short).`;
    notify(msg);
    logger.log('ERROR', `invalid python saved to ${fileName}`);
  }
}

// Small local models often emit recognizable placeholder/sample scaffolding
// (token artifacts like "[0]", fabricated external script URLs, "this is a
// basic example" text) that compiles but is not real, useful code. Detect
// the telltale signs so the user is warned instead of silently saving junk.
function looksLikeJunkCode(content, fileName) {
  const text = String(content || '');
  return /(code\.google\.com|chrome-extension|Lorem ipsum|placeholder text|\b[0-9]+\b\s*#\s*(This is|Python)|\bnot real code\b|\bcopy[-\s]?paste\b)/i.test(text);
}

// Runs the junk check after a successful write and warns + logs if flagged.
function warnIfJunkCode(fileName, content, notify) {
  if (!looksLikeJunkCode(content, fileName)) return;
  const msg = `Heads up: ${fileName} looks like placeholder/sample content (the local model may be too weak for real code). Check it, or try importing from a stronger engine or model.`;
  notify(msg);
  logger.log('WARN', `possible junk content saved to ${fileName}`);
}

// Like FileWriter.parse, but tolerant of an unclosed trailing fence (the
// model often truncates) so truncated FILE: blocks can still be rescued.
function extractFileBlocks(response) {
  const blocks = [];
  const lines = String(response || '').split('\n');
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const m = /^FILE:\s*(.+)\s*$/i.exec(lines[i]);
    if (m) {
      let j = i + 1;
      while (j < n && lines[j].trim() === '') j++;
      const fence = /^```([\w./+-]*)/.exec(lines[j] || '');
      if (fence) {
        const content = [];
        let k = j + 1;
        while (k < n && !/^```/.test(lines[k])) {
          content.push(lines[k]);
          k++;
        }
        blocks.push({ path: m[1].trim(), language: fence[1], content: content.join('\n').trim() });
        i = Math.max(k, j + 1);
        continue;
      }
    }
    i++;
  }
  return blocks;
}

async function writeFilesFromResponse(response, confirm, requestText, notify) {
  const { files, folders } = FileWriter.parse(response);
  const contentByPath = new Map(files.map((f) => [f.path, f.content]));
  const results = await FileWriter.write({ files, folders, overwrite: false, confirm });
  let wroteAny = false;
  for (const r of results) {
    const label = r.kind === 'folder' ? 'folder' : 'file';
    if (r.status === 'written' || r.status === 'created') {
      wroteAny = true;
      notify(`Wrote ${label}: ${r.path}`);
      logger.log('FILE', `wrote ${label} ${r.path}${r.target ? ` (${r.target})` : ''}`);
      await validateWrittenCode(r.path, notify);
      warnIfJunkCode(r.path, contentByPath.get(r.path) || '', notify);
    } else if (r.status === 'skipped') {
      notify(`Skipped ${label}: ${r.path} (${r.error})`);
      logger.log('FILE', `skipped ${label} ${r.path}${r.target ? ` (${r.target})` : ''}: ${r.error}`);
    } else {
      notify(`Failed to write ${label}: ${r.path} (${r.error})`);
      logger.log('ERROR', `failed writing ${label} ${r.path}: ${r.error}`);
    }
  }

  // Rescue FILE: blocks the parser dropped because their trailing fence was
  // truncated (the model truncates often); otherwise data is lost silently.
  const handledPaths = new Set(results.filter((x) => x.kind === 'file').map((x) => x.path));
  for (const b of extractFileBlocks(response)) {
    if (handledPaths.has(b.path) || !b.content.trim()) continue;
    const rescue = await FileWriter.write({
      files: [{ path: b.path, content: b.content }],
      overwrite: false,
      confirm,
    });
    const r0 = rescue[0];
    if (r0.status === 'written') {
      wroteAny = true;
      notify(`Wrote file: ${b.path} (recovered from truncated reply)`);
      logger.log('FILE', `wrote file ${b.path} (rescued truncated block)${r0.target ? ` at ${r0.target}` : ''}`);
      await validateWrittenCode(b.path, notify);
      warnIfJunkCode(b.path, b.content, notify);
    } else if (r0.status === 'skipped') {
      notify(`Skipped file: ${b.path} (${r0.error})`);
    } else {
      notify(`Failed to write file: ${b.path} (${r0.error})`);
      logger.log('ERROR', `failed writing file ${b.path}: ${r0.error}`);
    }
  }

  if (!wroteAny && response && (
    responseWantsFile(response) ||
    responseIsSoloCode(response) ||
    looksLikeFileRequest(requestText) ||
    looksLikeStoryRequest(requestText)
  )) {
    const { path: name, content } = extractFallbackFile(response, requestText);
    if (!fallbackHasUsefulCode(response, requestText)) {
      notify('The model replied without any code blocks — nothing was saved. Try again.');
      return;
    }
    if (!content.trim()) {
      notify('The model returned no code — nothing was saved. Try again.');
      return;
    }
    let fallback;
    try {
      fallback = await FileWriter.write({
        files: [{ path: name, content }],
        overwrite: false,
        confirm,
      });
    } catch (err) {
      notify(`Failed to write file: ${name} (${err.message})`);
      return;
    }
    const res = fallback[0];
    if (res.status === 'written') {
      notify(`Wrote file: ${name}`);
      logger.log('FILE', `wrote file ${name}${res.target ? ` (${res.target})` : ''}`);
      await validateWrittenCode(name, notify);
      warnIfJunkCode(name, content, notify);
      const fenceCount = [...String(response).matchAll(/```[\w./+-]*[^\n]*\n?([\s\S]*?)(?:```|$)/g)].length;
      if (fenceCount > 1) {
        notify(`Note: the reply contained ${fenceCount} code blocks but only ${name} was saved. Ask me to save the others (one FILE: request per file).`);
        logger.log('WARN', `multi-block reply: saved only ${name} of ${fenceCount} code blocks`);
      }
    } else if (res.status === 'skipped') {
      notify(`Skipped file: ${name} (${res.error})`);
      logger.log('FILE', `skipped file ${name}${res.target ? ` (${res.target})` : ''}: ${res.error}`);
    } else {
      notify(`Failed to write file: ${name} (${res.error})`);
      logger.log('ERROR', `failed writing file ${name}: ${res.error}`);
    }
  }
}

async function answerWithSearch(messages, provider, query, systemPrompt, confirm, requestText, chatUI) {
  chatUI.clearNotices();
  chatUI.setStatus(`Searching the web for "${query}"…`);
  chatUI.render(messages);
  const results = await WebSearch.search(query);

  let userContent;
  if (results.length > 0) {
    chatUI.setStatus('');
    chatUI.notify(`Found ${results.length} web result${results.length === 1 ? '' : 's'} for "${query}"`);
    const searchContext = results.map((r, i) =>
      `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
    ).join('\n\n');
    userContent = `Web search results for "${query}":\n\n${searchContext}\n\nAnswer based on these results.${looksLikeStoryRequest(requestText) ? ' If this is a famous story, folk tale, legend, or myth, tell the real, well-known version fully and save it to a .txt file too.' : ''}`;
  } else {
    chatUI.setStatus('');
    chatUI.notify('No web results — answering from my own knowledge.');
    userContent = query;
  }

  messages.push({ role: 'user', content: userContent, hidden: true });
  Session.save(messages);

  chatUI.setThinking(true);
  chatUI.render(messages);
  let response = '';
  const frame = new FrameThrottle(() => chatUI.render(messages));
  try {
    for await (const chunk of provider.stream(messages, {
      model: Config.getEffectiveModel(provider.name),
      systemPrompt,
      maxTokens: 600,
    })) {
      response += chunk;
      chatUI.setStreaming(response);
      frame.schedule();
    }
  } catch (err) {
    chatUI.notify(err.message || 'Stream error');
    logger.log('ERROR', err.message || 'Stream error');
  }
  frame.flush();
  if (response) {
    messages.push({ role: 'assistant', content: response });
    logger.log('AI', response);
    chatUI.setStreaming(null);
    await writeFilesFromResponse(response, confirm, requestText, (msg) => chatUI.notify(msg));
  }
  chatUI.render(messages);
  Session.save(messages);
}

function extractUrlFromText(text) {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0] : null;
}

async function answerWithFetch(messages, provider, url, systemPrompt, confirm, chatUI, requestText = '') {
  chatUI.clearNotices();
  chatUI.setStatus(`Opening ${url}…`);
  chatUI.render(messages);
  let page;
  try {
    page = await WebFetch.fetch(url);
  } catch (err) {
    chatUI.setStatus('');
    chatUI.notify(err.message || 'Could not fetch the link.');
    logger.log('ERROR', err.message || 'Could not fetch the link.');
    chatUI.render(messages);
    return;
  }

  chatUI.setStatus('');
  const assets = page.assets || [];
  chatUI.notify(`Opened: ${page.title || page.url}${assets.length ? ` · ${assets.length} download ready` : ''}`);
  const content = page.text.trim();
  if (!content) {
    chatUI.notify('Nothing readable found on that page.');
    chatUI.render(messages);
    return;
  }

  let assetBlock = '';
  if (assets.length > 0) {
    assetBlock =
      `\n\nDownloadable files found on the page:\n${assets
        .map((a, i) => `${i + 1}. [${a.type}] ${a.name} — ${a.url}`)
        .join('\n')}` +
      '\n\nIf the user asks to download any of these, tell them it is saved at ~/Downloads and actually download each one with the download_url tool.';
  }

  messages.push({
    role: 'user',
    content: `Here is the content fetched from the URL "${page.url}" (${page.title || 'no title'}):\n\n${content}${assetBlock}\n\nPlease summarize and answer based on this content. Be concise.`,
    hidden: true,
  });
  Session.save(messages);

  chatUI.setThinking(true);
  chatUI.render(messages);
  let response = '';
  const frame = new FrameThrottle(() => chatUI.render(messages));
  try {
    for await (const chunk of provider.stream(messages, {
      model: Config.getEffectiveModel(provider.name),
      systemPrompt,
      maxTokens: 600,
    })) {
      response += chunk;
      chatUI.setStreaming(response);
      frame.schedule();
    }
  } catch (err) {
    chatUI.notify(err.message || 'Stream error');
    logger.log('ERROR', err.message || 'Stream error');
  }
  frame.flush();
  if (response) {
    messages.push({ role: 'assistant', content: response });
    logger.log('AI', response);
    chatUI.setStreaming(null);
    await writeFilesFromResponse(response, confirm, requestText, (msg) => chatUI.notify(msg));
  }
  chatUI.render(messages);
  Session.save(messages);
}

async function answerWithDownload(messages, provider, url, systemPrompt, confirm, chatUI, requestText = '') {
  chatUI.clearNotices();
  chatUI.setStatus(`Downloading ${url}…`);
  chatUI.render(messages);
  let result;
  try {
    result = await Downloader.download(url, { dir: Config.downloadDir, onProgress: (received, total) => {
      chatUI.setStatus(`Downloading ${url}… ${received}${total ? `/${total}` : ''} items`);
    } });
  } catch (err) {
    chatUI.setStatus('');
    chatUI.notify(err.message || 'Could not download the link.');
    logger.log('ERROR', err.message || 'Could not download the link.');
    chatUI.render(messages);
    return;
  }
  chatUI.setStatus('');
  const kind = result.kind || 'file';
  const location = result.path;
  const note = result.extracted ? '\n(contents extracted into that folder)' : '';
  chatUI.notify(`${kind[0].toUpperCase() + kind.slice(1)} downloaded → ${location}${note}`);
  logger.log('FILE', `downloaded ${kind} ${url} -> ${location}`);

  const summaryContent = `The user downloaded ${kind} from "${url}". Saved to: ${location}${result.extracted ? `, extracted to ${result.extracted}` : ''} (${result.size ?? 0} bytes).`;
  messages.push({ role: 'user', content: summaryContent, hidden: true });
  Session.save(messages);

  chatUI.setThinking(true);
  chatUI.render(messages);
  let response = '';
  const frame = new FrameThrottle(() => chatUI.render(messages));
  try {
    for await (const chunk of provider.stream(messages, {
      model: Config.getEffectiveModel(provider.name),
      systemPrompt,
      maxTokens: 300,
    })) {
      response += chunk;
      chatUI.setStreaming(response);
      frame.schedule();
    }
  } catch (err) {
    chatUI.notify(err.message || 'Stream error');
    logger.log('ERROR', err.message || 'Stream error');
  }
  frame.flush();
  if (response) {
    messages.push({ role: 'assistant', content: response });
    logger.log('AI', response);
    chatUI.setStreaming(null);
    await writeFilesFromResponse(response, confirm, requestText, (msg) => chatUI.notify(msg));
  }
  chatUI.render(messages);
  Session.save(messages);
}

async function chat(provider, systemPrompt) {
  // Fresh start every launch: we never resume silently. The old active session
  // is auto-backup'd (if it has messages) and stays on disk, reachable later
  // via /sessions and /session open.
  Session.autoBackup();
  Session.create(null);
  let messages = Session.loadActive();
  const sessionName = Session.activeName();
  let exited = false;
  const chatUI = new ChatUI({
    model: Config.getEffectiveModel(provider.name),
    engine: provider.displayName,
  });
  logger.log('SESSION', `started provider=${provider.name} model=${Config.getEffectiveModel(provider.name)} session=${sessionName}`);

  if (messages.length > 0) {
    chatUI.notify(`Fresh session "${sessionName}" (${messages.filter((m) => m.role === 'user').length} previous message(s) carried). Use /sessions to open an old one.`);
  } else {
    chatUI.notify(`Hello! I am VierrataleAI (session "${sessionName}"). Type /help for commands, or just start chatting.`);
  }

  const editor = new LineEditor({
    prompt: `${Branding.colors.bold}${Branding.colors.primary}${Branding.USER_PROMPT}${Branding.colors.reset} ${Branding.colors.dim}›${Branding.colors.reset}`,
    commands: SLASH_COMMANDS,
    onExit: () => hadExit(),
  });
  chatUI.setCompositor(editor);
  editor.start();

  const hadExit = () => {
    if (!exited) {
      exited = true;
      editor.exit();
    }
  };

  const readLine = () => editor.readLine();

  const askConfirm = async (msg) => {
    const ans = await editor.question(msg);
    if (ans === null || ans === undefined) return false;
    const a = String(ans).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  };

  chatUI.render(messages);

  while (!exited) {
    let input;
    try {
      input = await readLine();
    } catch {
      break;
    }

    if (input === undefined || input === null) break;

    const trimmed = input.trim();
    if (!trimmed) continue;

    const cmd = trimmed.toLowerCase();

    if (!cmd.startsWith('/')) logger.log('USER', trimmed);

    if (cmd === '/quit' || cmd === '/exit' || cmd === '/q') {
      chatUI.setStatus('');
      console.log('  Goodbye!');
      logger.log('SESSION', 'ended');
      hadExit();
      break;
    }

    if (cmd === '/clear') {
      chatUI.clearNotices();
      chatUI.setStatus('');
      chatUI.render(messages);
      continue;
    }

    if (cmd === '/log' || cmd.startsWith('/log ')) {
      const rest = cmd === '/log' ? '' : cmd.slice(5).trim();
      chatUI.clearNotices();
      if (rest === 'path' || rest === 'file') {
        chatUI.notify(`Log file: ${logger.getPath()}`);
      } else if (/^\d+$/.test(rest)) {
        const lines = logger.tail(Math.max(1, Math.min(200, parseInt(rest, 10))));
        chatUI.notify(lines.length ? lines.join('\n') : 'No log entries yet.');
      } else {
        const lines = logger.tail(30);
        chatUI.notify(lines.length ? lines.join('\n') : 'No log entries yet.');
      }
      chatUI.render(messages);
      continue;
    }

    if (cmd === '/help') {
      chatUI.clearNotices();
      chatUI.notify(
        `Commands:\n  /search <query> · /fetch <url> · /model [name] · /provider [name]\n  /models · /todos · /log [n|path] · /new · /sessions · /session new|open|delete|backup|restore\n  /clear · /help · /quit`
      );
      chatUI.render(messages);
      continue;
    }

    if (cmd === '/new') {
      Session.autoBackup();
      const name = Session.create(null);
      messages = Session.loadActive();
      chatUI.clearNotices();
      chatUI.notify(`Started a new conversation (session: "${name}"). All messages cleared — old ones are preserved, use /sessions to return.`);
      chatUI.render(messages);
      continue;
    }

    if (cmd === '/sessions') {
      chatUI.clearNotices();
      const list = Session.list();
      if (!list.length) {
        chatUI.notify('No sessions yet.');
      } else {
        list.forEach((s, i) => {
          chatUI.notify(`${i + 1}. ${s.name}${s.active ? ' (current)' : ''} — ${s.count} msg${s.count === 1 ? '' : 's'} — ${s.preview}`);
        });
        chatUI.notify('Open with /session open <name|#> · delete with /session delete <name|#>');
      }
      chatUI.render(messages);
      continue;
    }

    if (cmd.startsWith('/session ')) {
      const parts = trimmed.split(/\s+/);
      const sub = parts[1];
      chatUI.clearNotices();
      if (sub === 'new') {
        const name = parts.length > 2 ? trimmed.slice(parts[0].length + parts[1].length + 1).trim() : null;
        const created = Session.create(name || null);
        messages = Session.loadActive();
        chatUI.notify(`Session "${created}" created and active.`);
        chatUI.render(messages);
      } else if (sub === 'open') {
        const target = parts.slice(2).join(' ') || null;
        if (!target) {
          chatUI.notify('Usage: /session open <name|#index> — see /sessions.');
        } else {
          const opened = Session.open(target);
          if (!opened) {
            chatUI.notify(`Session "${target}" not found. Use /sessions to list.`);
          } else {
            messages = Session.loadActive();
            chatUI.notify(`Resumed session "${opened}" (${messages.filter((m) => m.role === 'user').length} previous message(s)).`);
          }
        }
        chatUI.render(messages);
      } else if (sub === 'delete') {
        const target = parts.slice(2).join(' ') || null;
        if (!target) {
          chatUI.notify('Usage: /session delete <name|#> — see /sessions.');
        } else {
          const removed = Session.remove(target);
          if (!removed) {
            chatUI.notify(`Session "${target}" not found. Use /sessions to list.`);
          } else {
            if (Session.activeName() === removed) {
              messages = Session.loadActive();
              chatUI.notify(`Session "${removed}" deleted. Active session is now "${Session.activeName()}".`);
            } else {
              chatUI.notify(`Session "${removed}" deleted.`);
            }
          }
        }
        chatUI.render(messages);
      } else if (sub === 'backup') {
        const target = parts.slice(2).join(' ') || null;
        if (target) {
          const prevActive = Session.activeName();
          const opened = Session.open(target);
          if (!opened) {
            chatUI.notify(`Session "${target}" not found. Use /sessions to list.`);
          } else {
            const saved = Session.autoBackup();
            Session.open(prevActive);
            if (saved) chatUI.notify(`Backed up session "${opened}" → ${saved}. Restore with /session restore.`);
            else chatUI.notify(`Session "${opened}" is empty; nothing to back up.`);
          }
        } else {
          const saved = Session.autoBackup();
          if (saved) chatUI.notify(`Backed up current session → ${saved}. Restore with /session restore.`);
          else chatUI.notify('No messages to back up.');
        }
        chatUI.render(messages);
      } else if (sub === 'backups') {
        const list = Session.listBackups();
        chatUI.clearNotices();
        if (!list.length) {
          chatUI.notify('No session backups found yet. They are created automatically on every fresh start.');
        } else {
          chatUI.notify(`Session backups (${list.length}):`);
          list.slice(0, 20).forEach((b, i) => chatUI.notify(`${i + 1}. ${b.name}`));
          chatUI.notify('Restore one with /session restore <name>');
        }
        chatUI.render(messages);
      } else if (sub === 'restore') {
        const target = parts.slice(2).join(' ') || null;
        if (!target) {
          const list = Session.listBackups();
          if (list.length) {
            chatUI.clearNotices();
            chatUI.notify(`Latest backups (${list.length}):`);
            list.slice(0, 10).forEach((b, i) => chatUI.notify(`${i + 1}. ${b.name}`));
            chatUI.notify('Usage: /session restore <backup-name|#index>');
          } else {
            chatUI.notify('No backups found. Usage: /session restore <backup-name|#>');
          }
        } else {
          let t = target;
          if (/^#\d+$/.test(t)) {
            const list = Session.listBackups();
            const idx = parseInt(t.slice(1), 10);
            const b = list[idx - 1];
            if (!b) {
              chatUI.notify(`Backup #${t.slice(1)} not found.`);
              chatUI.render(messages);
              continue;
            }
            t = b.name;
          }
          const restored = Session.restoreBackup(t);
          if (!restored) {
            chatUI.notify(`Backup "${target}" not found. Use /session backups to list.`);
          } else {
            messages = Session.loadActive();
            chatUI.notify(`Restored backup into session "${restored}".`);
          }
        }
        chatUI.render(messages);
      } else {
        chatUI.notify('Usage: /session new [name] · /session open <name|#> · /session delete <name|#> · /session backup [name|#] · /session backups · /session restore <name|#>');
        chatUI.render(messages);
      }
      continue;
    }

    if (cmd === '/models') {
      const models = provider.isLocal
        ? Catalog.getLocalModels()
        : Catalog.getCloudModels();
      const installedSet = new Set();
      if (provider.isLocal) {
        for (const m of await Engine.getInstalledModels(Config.get('engineHost'))) {
          installedSet.add(m);
        }
      }
      chatUI.clearNotices();
      for (const m of models) {
        const info = Catalog.getModelInfo(m);
        const current = m === Config.getEffectiveModel(provider.name) ? ' (active)' : '';
        if (provider.isLocal) {
          const have = installedSet.has(info.realModel);
          chatUI.notify(`${m}${have ? ' ✓' : ' (not downloaded)'}${current} - ${info.tier}`);
        } else {
          chatUI.notify(`${m}${current} - ${info.tier}`);
        }
      }
      if (provider.isLocal) {
        const extras = [...installedSet].filter(
          (m) => !Catalog.getModelInfo(m) && m !== Config.getEffectiveModel(provider.name)
        );
        if (extras.length) {
          chatUI.notify(`  (+${extras.length} additional engine models available)`);
        }
      }
      chatUI.render(messages);
      continue;
    }

    if (cmd.startsWith('/model ')) {
      const modelName = cmd.split(' ')[1];
      if (modelName) {
        const canonical = Catalog.normalize(modelName);
        const current = Config.getEffectiveModel(provider.name);
        const info = Catalog.getModelInfo(canonical);
        const applyModel = (model) => {
          Config.save({ model });
          Config.setProviderModel(provider.name, model);
          chatUI.setModel(model, provider.displayName);
        };
        if (provider.isLocal && Catalog.isCloudModel(canonical)) {
          chatUI.notify(`Cannot use cloud model "${canonical}" on ${provider.displayName} (local). Use /model VTL-2.7-Flash instead.`);
        } else if (!info) {
          if (provider.isLocal) {
            const switched = await ensureRawLocalModel(modelName, (m) => chatUI.notify(m));
            if (switched.ok) {
              applyModel(switched.model);
              chatUI.notify(`Model: ${switched.model}${switched.reason ? ` — ${switched.reason}` : ''}`);
            } else {
              chatUI.notify(`Model "${modelName}" is not available. Current: ${current}`);
            }
          } else {
            chatUI.notify(`Unknown model: ${modelName}`);
          }
        } else if (info.isLocal) {
          const switched = await ensureLocalModel(canonical, (m) => chatUI.notify(m));
          if (switched.ok) {
            applyModel(switched.model);
            chatUI.notify(`Model: ${switched.model}${switched.reason ? ` — ${switched.reason}` : ''}`);
          } else {
            chatUI.notify(`Could not switch to "${canonical}": ${switched.reason}. Current: ${current}`);
          }
        } else {
          applyModel(canonical);
          chatUI.notify(`Model: ${canonical}`);
        }
      }
      chatUI.render(messages);
      continue;
    }

    if (cmd === '/model') {
      chatUI.clearNotices();
      chatUI.notify(`Current model: ${Config.getEffectiveModel(provider.name)}`);
      chatUI.render(messages);
      continue;
    }

    if (cmd.startsWith('/provider ')) {
      const prov = cmd.split(' ')[1];
      if (['cortex', 'openai', 'anthropic', 'gemini'].includes(prov)) {
        Config.save({ provider: prov });
        const next = ProviderFactory.create(prov);
        if (next && await next.isAvailable()) {
          provider = next;
          chatUI.notify(`Provider: ${prov}`);
        } else {
          chatUI.notify(`Provider saved, but ${prov} is not available right now. Will apply on restart.`);
        }
        if (provider.isLocal && Catalog.isCloudModel(Config.getEffectiveModel(provider.name))) {
          const fallback = Catalog.getDefaultModel();
          Config.save({ model: fallback });
          Config.setProviderModel(provider.name, fallback);
          chatUI.setModel(fallback, provider.displayName);
          chatUI.notify(`Cloud model can't run on ${provider.displayName}; switched to ${fallback}.`);
        }
      } else {
        chatUI.notify(`Unknown provider: ${prov}`);
      }
      chatUI.render(messages);
      continue;
    }

    if (cmd === '/provider') {
      chatUI.clearNotices();
      chatUI.notify(`Current provider: ${provider.name}`);
      chatUI.render(messages);
      continue;
    }

    if (cmd.startsWith('/system')) {
      const prompt = trimmed.slice(7).trim();
      chatUI.clearNotices();
      if (prompt.toLowerCase() === 'reset') {
        Config.save({ systemPrompt: '' });
        systemPrompt = loadSystemPrompt();
        chatUI.notify('System prompt reset to default.');
      } else if (prompt) {
        Config.save({ systemPrompt: prompt });
        systemPrompt = prompt;
        chatUI.notify('System prompt updated.');
      } else {
        chatUI.notify(`Current system prompt: ${systemPrompt}`);
      }
      chatUI.render(messages);
      continue;
    }

    if (cmd.startsWith('/search ')) {
      const query = trimmed.slice(8).trim();
      if (!query) {
        chatUI.notify('Usage: /search <query>');
        chatUI.render(messages);
        continue;
      }
      chatUI.clearNotices();
      chatUI.setStatus('');
      messages.push({ role: 'user', content: trimmed });
      logger.log('USER', trimmed);
      await answerWithSearch(messages, provider, query, systemPrompt, askConfirm, trimmed, chatUI);
      continue;
    }

    if (cmd.startsWith('/fetch ') || cmd === '/fetch') {
      const urlPart = trimmed.slice(6).trim().split(/\s+/)[0];
      if (!urlPart) {
        chatUI.notify('Usage: /fetch <url>');
        chatUI.render(messages);
        continue;
      }
      chatUI.clearNotices();
      chatUI.setStatus('');
      messages.push({ role: 'user', content: trimmed });
      logger.log('USER', trimmed);
      await answerWithFetch(messages, provider, urlPart, systemPrompt, askConfirm, chatUI, trimmed);
      continue;
    }

    if (cmd.startsWith('/download ') || cmd === '/download') {
      const urlPart = trimmed.slice(10).trim().split(/\s+/)[0];
      if (!urlPart) {
        chatUI.notify('Usage: /download <url>');
        chatUI.render(messages);
        continue;
      }
      chatUI.clearNotices();
      chatUI.setStatus('');
      messages.push({ role: 'user', content: trimmed });
      logger.log('USER', trimmed);
      await answerWithDownload(messages, provider, urlPart, systemPrompt, askConfirm, chatUI, trimmed);
      continue;
    }

    if (cmd === '/todos' || cmd.startsWith('/todos ')) {
      handleTodosCommand(trimmed, chatUI, messages, process.cwd());
      continue;
    }

    const intent = detectIntent(trimmed);
    if (intent.type === 'self') {
      const model = Config.getEffectiveModel(provider.name);
      const info = Catalog.getModelInfo(model);
      chatUI.clearNotices();
      chatUI.notify(
        `I'm running on ${model} via the ${provider.displayName} engine.`
      );
      chatUI.render(messages);
      continue;
    }

    if (intent.type === 'greeting') {
      messages.push({ role: 'user', content: trimmed });
      const reply = 'Hello! How can I help you today?';
      messages.push({ role: 'assistant', content: reply });
      logger.log('AI', reply);
      Session.save(messages);
      chatUI.clearNotices();
      chatUI.render(messages);
      continue;
    }

    // Deterministic math: answer arithmetic ourselves (the tiny engine often
    // hallucinates), so we never send a pure math ask to the model.
    if (!looksLikeOperationRequest(trimmed)) {
      const mathAnswer = trySolveMath(trimmed);
      if (mathAnswer) {
        messages.push({ role: 'user', content: trimmed });
        messages.push({ role: 'assistant', content: mathAnswer });
        logger.log('AI', mathAnswer);
        Session.save(messages);
        chatUI.clearNotices();
        chatUI.render(messages);
        continue;
      }
    }

    if (intent.type === 'knowledge') {
      const topic = extractSearchTopic(trimmed) || trimmed;
      chatUI.setStatus('');
      messages.push({ role: 'user', content: trimmed });
      await answerWithSearch(messages, provider, topic, systemPrompt, askConfirm, trimmed, chatUI);
      continue;
    }

    // Operation requests: plan and run sandboxed tools (create folders/files, etc.).
    if (looksLikeOperationRequest(trimmed)) {
      chatUI.clearNotices();
      const cwd = process.cwd();
      const timeoutMs = Config.get('commandTimeoutMs');
      const done = await answerWithTools(messages, provider, trimmed, systemPrompt, askConfirm, chatUI, cwd, timeoutMs);
      if (done) continue;
    }

    // Refine the last built website (colours, theme, title, sections...).
    // runWithTools() decides whether it really is a refine request; otherwise
    // answerWithTools() returns false and normal chat below takes over.
    if (
      /[\s\S]*\b(make|switch|change|turn|set|use|add|remove|delete|drop|recolor|restyle|redesign|update|apply|repaint|adjust|rename)\b[\s\S]*\b(it|site|website|page|theme|mode|color|colour|title|name|section|accent|background|style|design)\b[\s\S]*/i.test(trimmed)
    ) {
      chatUI.clearNotices();
      const done = await answerWithTools(messages, provider, trimmed, systemPrompt, askConfirm, chatUI, process.cwd(), Config.get('commandTimeoutMs'));
      if (done) continue;
    }

    // If the message contains a bare URL, open it automatically and ask the AI to summarize.
    if (/https?:\/\/\S+/i.test(trimmed)) {
      const url = extractUrlFromText(trimmed);
      if (url) {
        chatUI.clearNotices();
        chatUI.setStatus('');
        messages.push({ role: 'user', content: trimmed });
        await answerWithFetch(messages, provider, url, systemPrompt, askConfirm, chatUI, trimmed);
        continue;
      }
    }

    messages.push({ role: 'user', content: trimmed });
    if (looksLikeFileRequest(trimmed)) {
      messages.push({ role: 'user', content: FILE_BLOCK_PROMPT, hidden: true });
    }
    Session.save(messages);

    chatUI.setThinking(true);
    chatUI.render(messages);
    let response = '';
    const frame = new FrameThrottle(() => chatUI.render(messages));
    try {
      for await (const chunk of provider.stream(messages, {
        model: Config.getEffectiveModel(provider.name),
        systemPrompt,
        maxTokens: 600,
      })) {
        response += chunk;
        chatUI.setStreaming(response);
        frame.schedule();
      }
    } catch (err) {
      chatUI.notify(err.message || 'Stream error');
      logger.log('ERROR', err.message || 'Stream error');
    }
    frame.flush();
    if (response) {
      messages.push({ role: 'assistant', content: response });
      logger.log('AI', response);
      chatUI.setStreaming(null);
      await writeFilesFromResponse(response, askConfirm, trimmed, (msg) => chatUI.notify(msg));
    }
    chatUI.render(messages);
    Session.save(messages);
  }
}

async function ensureLocalModel(modelName, notify) {
  const info = Catalog.getModelInfo(modelName);
  if (!info) return ensureRawLocalModel(modelName, notify);
  if (!info.isLocal) return { ok: false, model: null, reason: `${modelName} is not a local model` };
  return ensureRawLocalModel(info.realModel, notify);
}

// Ensure a local engine model is usable, returning the actual model that
// should be used. Preference: exact match, then an installed same-family
// sibling, then a fresh download, then any installed model. Switching never
// dead-ends while at least one local model exists.
async function ensureRawLocalModel(realModel, notify) {
  const host = Config.get('engineHost');
  const resolved = await Engine.resolveModel(host, realModel);
  if (resolved.model) {
    return { ok: true, model: resolved.model, reason: resolved.reason };
  }
  if (notify) notify(`Downloading ${realModel}… (this can take a while)`);
  const pulled = await Engine.pullModel(host, realModel);
  if (pulled) {
    if (notify) notify(`Model ${realModel} ready.`);
    return { ok: true, model: realModel, reason: null };
  }
  if (notify) notify(`Could not download ${realModel}.`);
  const first = await Engine.firstInstalled(host);
  if (first) {
    return { ok: true, model: first, reason: `Could not download ${realModel}; using installed ${first}` };
  }
  return { ok: false, model: null, reason: `Could not download model: ${realModel}` };
}

export { looksLikeFileRequest, requestedFileName, extractFallbackFile, storyFileName, responseWantsFile, responseIsSoloCode, languageFileName, fallbackHasUsefulCode, validateWrittenCode, looksLikeJunkCode, warnIfJunkCode, writeFilesFromResponse }; 
// Command/tool layer: asks the model to plan filesystem/shell operations,
// executes them with the sandboxed executor, then streams the final answer.
function handleTodosCommand(trimmed, chatUI, messages, cwd) {
  chatUI.clearNotices();
  const rest = trimmed.slice('/todos'.length).trim();
  let out;
  if (!rest) {
    out = `Todos (${todosFile(cwd)}):\n${formatTodos(loadTodos(cwd))}`;
  } else if (/^add\s+/i.test(rest)) {
    const err = addTodo(cwd, rest.replace(/^add\s+/i, '').trim());
    out = err && err.error ? err.error : `Todos (${todosFile(cwd)}):\n${formatTodos(loadTodos(cwd))}`;
  } else if (/^done\s+\d+$/i.test(rest)) {
    const err = updateTodo(cwd, parseInt(rest.replace(/^done\s+/i, ''), 10), { done: true });
    out = err && err.error ? err.error : `Todos (${todosFile(cwd)}):\n${formatTodos(loadTodos(cwd))}`;
  } else if (/^undone\s+\d+$/i.test(rest)) {
    const err = updateTodo(cwd, parseInt(rest.replace(/^undone\s+/i, ''), 10), { done: false });
    out = err && err.error ? err.error : `Todos (${todosFile(cwd)}):\n${formatTodos(loadTodos(cwd))}`;
  } else if (/^remove\s+\d+$/i.test(rest)) {
    const n = parseInt(rest.replace(/^remove\s+/i, ''), 10);
    const todos = loadTodos(cwd);
    if (!Number.isInteger(n - 1) || n - 1 < 0 || n - 1 >= todos.length) {
      out = `No todo #${n}.`;
    } else {
      const next = todos.filter((_, i) => i !== n - 1);
      saveTodos(cwd, next);
      out = `Todos (${todosFile(cwd)}):\n${formatTodos(loadTodos(cwd))}`;
    }
  } else if (/^clear$/i.test(rest)) {
    clearTodos(cwd);
    out = `Todos cleared (${todosFile(cwd)}). (no todos yet)`;
  } else if (/^\d+$/.test(rest)) {
    const n = parseInt(rest, 10);
    const todos = loadTodos(cwd);
    const err = (Number.isInteger(n - 1) && n - 1 >= 0 && n - 1 < todos.length)
      ? updateTodo(cwd, n, { done: !todos[n - 1].done })
      : { error: `No todo #${n}.` };
    out = err && err.error ? err.error : `Todos (${todosFile(cwd)}):\n${formatTodos(loadTodos(cwd))}`;
  } else {
    out = 'Usage: /todos [add <text> | done <n> | undone <n> | remove <n> | <n> (toggle) | clear]';
  }
  chatUI.notify(out);
  logger.log('CMD', `todos: ${rest || '(list)'}`);
  chatUI.render(messages);
}

async function answerWithTools(messages, provider, requestText, systemPrompt, confirm, chatUI, cwd, timeoutMs) {
  let results = [];
  try {
    const out = await runWithTools({
      provider,
      messages,
      requestText,
      systemPrompt,
      chatUI,
      cwd,
      timeoutMs,
    });
    results = out.results;
  } catch (err) {
    chatUI.notify(err.message || 'Tool error');
    logger.log('ERROR', err.message || 'Tool error');
    chatUI.render(messages);
    return true;
  }
  if (!results.length) return false;

  messages.push({ role: 'user', content: requestText });
  const resultRows = results.map((r) => {
    const res = r.result;
    return {
      tool: r.name,
      params: r.name === 'run_command' ? { command: res.command } : { path: r.params.path },
      success: res.success,
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
    };
  });
  messages.push({ role: 'user', content: TOOL_RESULTS_PROMPT(JSON.stringify(resultRows, null, 2)), hidden: true });
  Session.save(messages);

  chatUI.setThinking(true);
  chatUI.render(messages);
  let response = '';
  const frame = new FrameThrottle(() => chatUI.render(messages));
  try {
    for await (const chunk of provider.stream(messages, {
      model: Config.getEffectiveModel(provider.name),
      systemPrompt,
      maxTokens: 220,
    })) {
      response += chunk;
      chatUI.setStreaming(response);
      frame.schedule();
    }
  } catch (err) {
    chatUI.notify(err.message || 'Stream error');
    logger.log('ERROR', err.message || 'Stream error');
  }
  frame.flush();
  if (response) {
    messages.push({ role: 'assistant', content: response });
    logger.log('AI', response);
    chatUI.setStreaming(null);
    if (/```/.test(response) || /FILE:/i.test(response)) {
      await writeFilesFromResponse(response, confirm, requestText, (msg) => chatUI.notify(msg));
    }
  }
  chatUI.render(messages);
  Session.save(messages);
  return true;
}
export async function run() {
  const args = parseArgs(process.argv);

  if (args.version) {
    console.log(`${Branding.APP_NAME} ${Branding.VERSION}`);
    return;
  }

  if (args.help) {
    showHelp();
    return;
  }

  Config.load();
  if (args.provider) Config.save({ provider: args.provider });
  if (args.model) Config.save({ model: Catalog.normalize(args.model) });

  await Terminal.showProgress(
    ['Checking engine', 'Installing dependencies', 'Downloading model', 'Optimizing'],
    () => Engine.ensure()
  );

  const provider = await ProviderFactory.autoDetect();
  if (!provider) {
    logger.init();
    logger.log('ERROR', 'no provider available');
    Terminal.printError('No AI engine available. Please install or configure a provider.');
    process.exit(1);
  }

  const chosenModel = Config.getEffectiveModel(provider.name);
  if (provider.isLocal && Catalog.isCloudModel(chosenModel)) {
    const fallback = Catalog.getDefaultModel();
    Config.save({ model: fallback });
    Config.setProviderModel(provider.name, fallback);
    await ensureLocalModel(fallback);
    logger.init();
    logger.log('WARN', `cloud model "${chosenModel}" cannot run on local provider ${provider.name}; switched to ${fallback}`);
    Terminal.printInfo(`"${chosenModel}" is a cloud model and can't run on ${provider.displayName}. Switched to ${fallback}.`);
  }

  logger.init();
  logger.log('APP', `started provider=${provider.name} model=${Config.getEffectiveModel(provider.name)}`);

  Config.save({ provider: provider.name });

  if (provider.isLocal) await ensureLocalModel(Config.get('model'));

  if (provider.warmup) provider.warmup();

  // Always clear the screen at startup: everything above the CLI is removed so
  // the banner + conversation start on a clean slate. The banner itself is
  // drawn inside ChatUI.render(), so it can't be erased by the first render.
  Terminal.clear();

  const systemPrompt = loadSystemPrompt();
  await chat(provider, systemPrompt);
  process.exit(0);
}
