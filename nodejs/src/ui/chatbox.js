import { Branding } from './branding.js';

const C = Branding.colors;

const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

function padRight(text, width) {
  const t = String(text ?? '');
  return t + ' '.repeat(Math.max(0, width - visible(t)));
}

function wrapLines(text, width) {
  const out = [];
  const src = String(text ?? '');
  for (const raw of src.split('\n')) {
    if (!raw.trim()) {
      out.push('');
      continue;
    }
    const words = raw.split(/\s+/).filter(Boolean);
    let cur = '';
    for (const word of words) {
      if (word.length >= width) {
        if (cur) {
          out.push(cur);
          cur = '';
        }
        for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
        continue;
      }
      const next = cur ? `${cur} ${word}` : word;
      if (visible(next) > width) {
        if (cur) out.push(cur);
        cur = word;
      } else {
        cur = next;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function hardWrap(text, width) {
  const out = [];
  const src = String(text ?? '').replace(/\t/g, '  ');
  for (const raw of src.split('\n')) {
    if (visible(raw) <= width) {
      out.push(raw);
    } else {
      for (let i = 0; i < raw.length; i += width) out.push(raw.slice(i, i + width));
    }
  }
  return out;
}

// Column geometry: true-full width, then a centered column like opencode.
export function columnWidth(termWidth) {
  const w = termWidth && termWidth > 44 ? termWidth : 96;
  return Math.max(40, Math.min(100, w - 8));
}

export function centerPad(col, termWidth) {
  const w = termWidth && termWidth > 44 ? termWidth : 96;
  const pad = Math.max(0, Math.floor((w - col) / 2));
  return ' '.repeat(pad);
}

function highlight(text) {
  return String(text)
    .replace(/\*\*([^*]+)\*\*/g, `${C.bold}$1${C.reset}`)
    .replace(/`([^`]+)`/g, `${C.accent}$1${C.reset}`);
}

function splitBlocks(text) {
  const blocks = [];
  const re = /```([\w./+-]*)[^\n]*\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(String(text)))) {
    if (m.index > last) blocks.push({ code: false, text: text.slice(last, m.index) });
    blocks.push({ code: true, lang: m[1] || 'code', content: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) blocks.push({ code: false, text: text.slice(last) });
  return blocks;
}

export class FrameThrottle {
  constructor(render, min = 40) {
    this.render = render;
    this.min = min;
    this.last = 0;
  }

  schedule() {
    const now = performance.now();
    if (now - this.last >= this.min) {
      this.last = now;
      this.render();
    }
  }

  flush() {
    this.render();
  }
}

export class ChatUI {
  constructor({ model = '', engine = '' } = {}) {
    this.model = model;
    this.engine = engine;
    this.status = '';
    this.notices = [];
    this.streaming = null;
    this.thinking = false;
    this.compositor = null;
  }

  setCompositor(fn) {
    this.compositor = fn;
  }

  width() {
    const w = process.stdout.columns;
    return w && w > 44 ? w : 96;
  }

  setModel(model, engine) {
    this.model = model;
    this.engine = engine;
  }

  setStatus(text) {
    this.status = String(text ?? '');
  }

  setThinking(flag) {
    this.thinking = !!flag;
    this.streaming = null;
  }

  setStreaming(text) {
    this.streaming = String(text ?? '');
    this.thinking = false;
  }

  notify(text) {
    if (text) this.notices.push(String(text));
  }

  clearNotices() {
    this.notices = [];
  }

  _codeBox(lang, content, w) {
    const out = [];
    const c = C.success;
    // The box lives inside the centered column and carries its own 4-space
    // indent, so draw it at (w - 4) to stay inside the column.
    const box = Math.max(8, w - 4);
    const inner = Math.max(1, box - 8);
    const head = `    ${c}╭─${C.reset} ${C.bold}${c}${lang || 'code'}${C.reset}${c} `;
    const fill = Math.max(0, box - visible(head) - 1);
    out.push(`${head}${'─'.repeat(fill)}╮${C.reset}`);
    const lines = hardWrap(content, inner);
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (!lines.length) lines.push('');
    for (const line of lines) {
      out.push(`    ${c}│${C.reset} ${padRight(line, inner)} ${c}│${C.reset}`);
    }
    out.push(`    ${c}╰${'─'.repeat(Math.max(0, box - 6))}╯${C.reset}`);
    return out;
  }

  _contentRows(content, w) {
    const rows = [];
    const width = Math.max(20, w - 4);
    const blocks = splitBlocks(content);
    for (const b of blocks) {
      if (b.code) {
        rows.push(...this._codeBox(b.lang, b.content, w));
      } else {
        const lines = wrapLines(b.text, width);
        if (lines.length === 0) lines.push('');
        for (const line of lines) {
          rows.push(line.trim() === '' ? '' : `    ${highlight(line)}`);
        }
      }
    }
    return rows;
  }

  _centered(row) {
    return `${centerPad(columnWidth(process.stdout.columns), process.stdout.columns)}${row}`;
  }

  // Banner drawn as part of the full clear+draw cycle so it can never be
  // wiped by a later render (the old showBanner() was erased instantly).
  _bannerRows(col) {
    const out = [];
    // Center the art as a BLOCK: pad every line to the widest one, then use a
    // single shared left indent so the llama's rows stay glued together.
    const art = Branding.BANNER.split('\n').map((l) => l.trimEnd());
    const artW = Math.max(...art.map((l) => visible(l)));
    const padL = Math.max(0, Math.floor((col - artW) / 2));
    for (const line of art) {
      out.push(`${' '.repeat(padL)}${C.primary}${line}${C.reset}`);
    }
    const center = (s) => {
      const p = Math.max(0, Math.floor((col - visible(s)) / 2));
      return `${' '.repeat(p)}${s}`;
    };
    out.push(center(`${C.bold}${C.accent}▸ ${Branding.APP_NAME} · ${this.model} · ${this.engine}${C.reset}`));
    out.push('');
    const box = Math.max(24, col - 6);
    const padR = (s) => s + ' '.repeat(Math.max(1, box - visible(s)));
    // Border is `  ┌` + (box+2) dashes + `┐` = box+6 wide, matching every row.
    const borderLine = `  ${C.primary}┌${'─'.repeat(box + 2)}┐${C.reset}`;
    out.push(center(borderLine));
    out.push(center(`  ${C.primary}│${C.reset} ${padR('  ' + C.bold + C.primary + 'Model' + C.reset)} ${C.primary}│${C.reset}`));
    out.push(center(`  ${C.primary}│${C.reset} ${padR('   ' + C.accent + this.model + C.reset)} ${C.primary}│${C.reset}`));
    out.push(center(`  ${C.primary}│${C.reset} ${padR('  ' + C.bold + C.primary + 'Engine' + C.reset)} ${C.primary}│${C.reset}`));
    out.push(center(`  ${C.primary}│${C.reset} ${padR('   ' + C.accent + this.engine + C.reset)} ${C.primary}│${C.reset}`));
    out.push(center(`  ${C.primary}└${'─'.repeat(box + 2)}┘${C.reset}`));
    out.push('');
    out.push(center(`${C.dim}Type /help for commands · /quit to exit${C.reset}`));
    out.push('');
    return out;
  }

  render(messages) {
    const w = this.width();
    const col = columnWidth(w);
    const out = [];
    out.push(`\x1b[2J\x1b[H`);
    // Banner (opencode style header) at the top of the centered column.
    out.push(...this._bannerRows(col));
    if (this.status) out.push(this._centered(`  ${C.dim}${this.status}${C.reset}`));
    out.push('');

    for (const m of messages || []) {
      if (!m || m.hidden || !m.content) continue;
      const title = m.role === 'user' ? 'You' : Branding.AI_PROMPT;
      const color = m.role === 'user' ? C.accent : C.primary;
      out.push(this._centered(`  ${C.bold}${color}${title}${C.reset}`));
      for (const row of this._contentRows(m.content, col)) {
        out.push(this._centered(row));
      }
      out.push('');
    }

    if (this.thinking) {
      out.push(this._centered(`  ${C.bold}${C.primary}${Branding.AI_PROMPT}${C.reset}`));
      out.push(this._centered(`    ${C.dim}···${C.reset}`));
      out.push('');
    } else if (this.streaming !== null) {
      out.push(this._centered(`  ${C.bold}${C.primary}${Branding.AI_PROMPT}${C.reset}`));
      const rows = this._contentRows(this.streaming, col);
      for (const r of rows.length ? rows : ['    ']) out.push(this._centered(r));
      out.push('');
    }

    for (const n of this.notices) {
      for (const line of wrapLines(n, col - 4)) out.push(this._centered(`  ${C.dim}${line}${C.reset}`));
    }
    if (this.notices.length) out.push('');

    // Keep the latest content pinned to the bottom of the terminal so streaming
    // never re-scrolls through older messages (which caused a flash).
    const isTty = process.stdout.isTTY && process.stdout.rows > 8;
    const rows = isTty ? process.stdout.rows : 999;
    const reserved = this.compositor ? Math.max(0, this.compositor.reservedRows()) : 0;
    const available = Math.max(3, rows - reserved);
    const lines = out.join('\n').split('\n').slice(1);
    const body = lines.length > available ? lines.slice(lines.length - available) : lines;
    process.stdout.write('\x1b[2J\x1b[H' + body.join('\n') + '\n');
    if (this.compositor) this.compositor.draw();
  }
}