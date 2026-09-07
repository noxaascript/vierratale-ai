import { createInterface } from 'readline';
import { Branding } from './branding.js';
import { columnWidth, centerPad } from './chatbox.js';

const C = Branding.colors;
const MAX_POPUP = 9;

const visible = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '').length;

function padRight(text, width) {
  const t = String(text ?? '');
  return t + ' '.repeat(Math.max(0, width - visible(t)));
}

/**
 * Raw-mode bottom-anchored line editor. Draws a fixed input bar on the last
 * terminal row and, when the draft starts with "/", a popup box listing
 * matching slash commands above it. Falls back to plain line reading when
 * stdin is not a TTY (piped input, tests).
 */
export class LineEditor {
  constructor({
    prompt = '',
    commands = [],
    onLine = () => {},
    onExit = () => {},
    stream = process.stdin,
    write = (s) => process.stdout.write(s),
    dims = () => ({ columns: process.stdout.columns || 96, rows: process.stdout.rows || 24 }),
  } = {}) {
    this.prompt = prompt;
    this.commands = commands;
    this.onLine = onLine;
    this.onExit = onExit;
    this.stream = stream;
    this.write = write;
    this.dims = dims;

    this.buffer = [];
    this.cursor = 0;
    this.viewOffset = 0;
    this.history = [];
    this.histIndex = -1;
    this.popup = null; // { matches, selected } | null
    this.questionText = null;
    this.busy = false;
    this._pending = null;
    this._pendingResolve = null;
    this.pendingLines = [];
    this.started = false;
    this._fallback = null;
    this._lastLine = '';
  }

  _cols() {
    return Math.max(20, this.dims().columns || 96);
  }

  _rows() {
    return Math.max(8, this.dims().rows || 24);
  }

  get isTTY() {
    return !!(this.stream && this.stream.isTTY);
  }

  // Rows the editor reserves at the bottom of the terminal.
  reservedRows() {
    if (!this.isTTY) return 0;
    return this.popup ? this._popupH() : 1;
  }

  _popupH() {
    const n = this.popup ? Math.min(this.popup.matches.length, MAX_POPUP) : 0;
    const h = Math.max(1, n) + 2;
    return Math.min(h, Math.max(2, this._rows() - 1));
  }

  _text() {
    return this.buffer.join('');
  }

  start() {
    if (this.started) return this;
    this.started = true;
    if (this.isTTY) {
      this._raw = true;
      this.stream.setRawMode(true);
      this.stream.resume();
      this.stream.on('data', (chunk) => this._feed(String(chunk)));
      this._onResize = () => this.draw();
      process.stdout.on('resize', this._onResize);
    } else {
      this._fallback = createInterface({ input: this.stream, output: process.stdout, terminal: false });
      this._fallback.on('line', (line) => {
        if (this._pendingResolve) {
          const r = this._pendingResolve;
          this._pendingResolve = null;
          this._pending = null;
          r(line);
        } else if (line !== undefined) {
          this.pendingLines.push(line);
        }
      });
      this._fallback.on('close', () => {
        this._pendingResolve?.(null);
        this._pendingResolve = null;
        this._pending = null;
      });
      process.stdout.write(this.prompt);
    }
    this.draw();
    return this;
  }

  stop() {
    if (this._raw) {
      try {
        this.stream.setRawMode(false);
      } catch { /* noop */ }
      this.stream.removeAllListeners('data');
      this._raw = false;
    }
    if (this._onResize) {
      process.stdout.removeListener('resize', this._onResize);
      this._onResize = null;
    }
    this._fallback?.close();
    this._fallback = null;
  }

  // Resolves any pending read with null and restores the terminal.
  exit() {
    if (this._pendingResolve) {
      const r = this._pendingResolve;
      this._pendingResolve = null;
      this._pending = null;
      r(null);
    }
    this.stop();
  }

  readLine() {
    if (this.pendingLines.length) {
      const line = this.pendingLines.shift();
      this._recordHistory(line);
      return Promise.resolve(line);
    }
    if (this._pending) return this._pending;
    this._pending = new Promise((resolve) => {
      this._pendingResolve = resolve;
    });
    return this._pending;
  }

  question(msg) {
    this.questionText = String(msg ?? '');
    this.buffer = [];
    this.cursor = 0;
    this.popup = null;
    this.draw();
    return this.readLine();
  }

  setBusy(flag) {
    this.busy = !!flag;
  }

  // ----- internal state manipulation -----

  _recordHistory(line) {
    if (line && line !== this.history[this.history.length - 1]) {
      this.history.push(line);
      if (this.history.length > 200) this.history.shift();
    }
    this.histIndex = -1;
  }

  _resolve(line) {
    this._recordHistory(line);
    this.questionText = null;
    this.buffer = [];
    this.cursor = 0;
    this.viewOffset = 0;
    this.popup = null;
    if (this._pendingResolve) {
      const r = this._pendingResolve;
      this._pendingResolve = null;
      this._pending = null;
      r(line);
    } else if (line !== undefined) {
      this.pendingLines.push(line);
    }
  }

  _matches(text) {
    const token = text.startsWith('/') ? text.slice(1) : '';
    const base = token.trim().split(/ +/)[0] || '';
    return this.commands.filter((c) => c.name.startsWith(base));
  }

  _syncPopup() {
    const s = this._text();
    if (!s.startsWith('/')) {
      this.popup = null;
      return;
    }
    const words = s.slice(1).split(/ +/);
    const base = words[0] || '';
    if (words.length >= 2 && this.commands.some((c) => c.name === base)) {
      this.popup = null;
      return;
    }
    const matches = this._matches(s);
    const sel = this.popup ? Math.min(this.popup.selected, Math.max(0, matches.length - 1)) : -1;
    this.popup = { matches, selected: matches.length ? sel : -1 };
  }

  _acceptPopup(submit) {
    const { matches } = this.popup;
    const m = matches.length ? matches[this.popup.selected >= 0 ? this.popup.selected : 0] : null;
    if (!m) {
      this.popup = null;
      if (submit) this._resolve(this._text());
      return;
    }
    if (m.args && submit) {
      // Needs arguments: fill the command and keep editing.
      this.buffer = `/${m.name} `.split('');
      this.cursor = this.buffer.length;
      this.viewOffset = 0;
      this.popup = null;
    } else {
      this.popup = null;
      this._resolve(`/${m.name}`);
    }
  }

  _submit() {
    if (this.busy) {
      // Streaming: stash the line, deliver it right after the busy phase.
      const line = this._text();
      this._recordHistory(line);
      this.buffer = [];
      this.cursor = 0;
      this.popup = null;
      this.pendingLines.push(line);
      return;
    }
    if (this.popup) {
      this._acceptPopup(true);
      return;
    }
    this._resolve(this._text());
  }

  // ----- key handling -----

  _feed(chunk) {
    const code = [...String(chunk)];
    let i = 0;
    while (i < code.length) {
      const c = code[i].charCodeAt(0);
      if (c === 27) {
        const esc = this._escape(code, i);
        i = esc.next;
        this._key(esc.key);
      } else if (c === 13 || c === 10) {
        this._submit();
        i++;
      } else if (c === 3) {
        this._ctrlC();
        i++;
      } else if (c === 4) {
        this._ctrlD();
        i++;
      } else if (c === 9) {
        this._tab();
        i++;
      } else if (c === 127) {
        this._backspace();
        i++;
      } else if (c < 32) {
        i++;
      } else {
        this._insert(code[i]);
        i++;
      }
    }
    this.draw();
  }

  _escape(code, i) {
    if (code[i + 1] !== '[') return { next: i + 1, key: 'esc' };
    let j = i + 2;
    let param = '';
    while (j < code.length && /[0-9;]/.test(code[j])) {
      param += code[j];
      j++;
    }
    const fin = code[j] || '';
    const next = j + 1;
    if (fin === 'A') return { next, key: 'up' };
    if (fin === 'B') return { next, key: 'down' };
    if (fin === 'C') return { next, key: 'right' };
    if (fin === 'D') return { next, key: 'left' };
    if (fin === 'H' || param === '1' || param === '7') return { next, key: 'home' };
    if (fin === 'F' || param === '4' || param === '8') return { next, key: 'end' };
    if (param === '3') return { next, key: 'delete' };
    if (param === 'Z') return { next, key: 'shift-tab' };
    if (param === '1;5' && fin === 'C') return { next, key: 'ctrl-right' };
    if (param === '1;5' && fin === 'D') return { next, key: 'ctrl-left' };
    return { next, key: 'ignore' };
  }

  _insert(ch) {
    this.buffer.splice(this.cursor, 0, ch);
    this.cursor++;
    this._syncPopup();
  }

  _backspace() {
    if (this.cursor > 0) {
      this.buffer.splice(this.cursor - 1, 1);
      this.cursor--;
      this._syncPopup();
    }
  }

  _tab() {
    if (this.popup) {
      const { matches } = this.popup;
      if (matches.length) {
        this.popup.selected = Math.min(matches.length - 1, this.popup.selected + 1);
      }
      return;
    }
    if (this._text().startsWith('/')) {
      this._syncPopup();
      if (this.popup && this.popup.matches.length) this.popup.selected = Math.min(1, this.popup.matches.length - 1);
      return;
    }
    this.buffer.splice(this.cursor, 0, ' ', ' ');
    this.cursor += 2;
  }

  _ctrlC() {
    if (this.popup) {
      this.popup = null;
    } else {
      this.onExit();
    }
  }

  _ctrlD() {
    if (!this._text()) this.onExit();
  }

  _key(key) {
    switch (key) {
      case 'up':
        if (this.popup && this.popup.matches.length) {
          this.popup.selected = Math.max(0, this.popup.selected - 1);
        } else {
          this._hist(-1);
        }
        break;
      case 'down':
        if (this.popup && this.popup.matches.length) {
          this.popup.selected = Math.min(this.popup.matches.length - 1, this.popup.selected + 1);
        } else {
          this._hist(1);
        }
        break;
      case 'shift-tab':
        if (this.popup && this.popup.matches.length) {
          this.popup.selected = Math.max(0, this.popup.selected - 1);
        }
        break;
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case 'right':
        this.cursor = Math.min(this.buffer.length, this.cursor + 1);
        break;
      case 'ctrl-left':
        this._wordJump(-1);
        break;
      case 'ctrl-right':
        this._wordJump(1);
        break;
      case 'home':
        this.cursor = 0;
        break;
      case 'end':
        this.cursor = this.buffer.length;
        break;
      case 'delete':
        if (this.cursor < this.buffer.length) this.buffer.splice(this.cursor, 1);
        this._syncPopup();
        break;
      case 'esc':
        this.popup = null;
        break;
      default:
        break;
    }
  }

  _wordJump(dir) {
    if (dir < 0) {
      while (this.cursor > 0 && this.buffer[this.cursor - 1] === ' ') this.cursor--;
      while (this.cursor > 0 && this.buffer[this.cursor - 1] !== ' ') this.cursor--;
    } else {
      while (this.cursor < this.buffer.length && this.buffer[this.cursor] === ' ') this.cursor++;
      while (this.cursor < this.buffer.length && this.buffer[this.cursor] !== ' ') this.cursor++;
    }
  }

  _hist(dir) {
    if (!this.history.length) return;
    if (this.histIndex === -1) {
      this._lastLine = this._text();
      this.histIndex = this.history.length;
    }
    this.histIndex = Math.min(this.history.length, Math.max(0, this.histIndex + dir));
    if (this.histIndex === this.history.length) {
      this.buffer = this._lastLine.split('');
    } else {
      this.buffer = this.history[this.histIndex].split('');
    }
    this.cursor = this.buffer.length;
  }

  // ----- drawing -----

  _inputPrefix() {
    if (this.questionText !== null) {
      return `  ${C.warning}${this.questionText} (y/N)${C.reset} ${C.dim}${C.bold}${C.primary}${Branding.USER_PROMPT}${C.reset} ${C.dim}›${C.reset} `;
    }
    return `${this.prompt} `;
  }

  draw() {
    if (!this.isTTY) return;
    const R = this._rows();
    const cols = this._cols();
    const col = columnWidth(cols);
    const pad = centerPad(col, cols);
    const prevH = this._lastPopupH || 1;
    const curH = this.popup ? this._popupH() : 1;
    const clearTop = Math.max(1, R - Math.max(prevH, curH) + 1);
    let out = '';
    for (let r = clearTop; r <= R; r++) out += `\x1b[${r};1H\x1b[2K`;
    this._lastPopupH = curH;

    if (this.popup) {
      const boxH = this._popupH();
      const listRows = Math.min(this.popup.matches.length, MAX_POPUP);
      const box = Math.max(8, col);
      const inner = Math.max(1, box - 8);
      const top = R - boxH + 1;

      const head = `  ${C.primary}╭─${C.reset} ${C.bold}${C.accent}Commands${C.reset}${C.primary} `;
      const fill = Math.max(0, box - visible(head) - 1);
      out += `\x1b[${top};1H\x1b[2K${pad}${head}${'─'.repeat(fill)}╮${C.reset}`;

      let li = top + 1;
      for (let i = 0; i < listRows; i++) {
        const m = this.popup.matches[i];
        const selected = i === this.popup.selected;
        const name = `${C.bold}${selected ? C.accent : C.primary}/${m.name}${C.reset}`;
        const args = m.args ? ` ${C.dim}${m.args}${C.reset}` : '';
        const desc = m.desc ? `  ${C.dim}${m.desc}${C.reset}` : '';
        const body = ` ${' '.repeat(selected ? 0 : 3)}${selected ? '›' : '·'} ${name}${args}${desc}`;
        out += `\x1b[${li};1H\x1b[2K${pad}  ${C.primary}│${C.reset} ${selected ? C.accent + C.bold : ''}${padRight(body, inner)}${selected ? C.reset : ''} ${C.primary}│${C.reset}`;
        li++;
      }
      if (listRows === 0) {
        out += `\x1b[${li};1H\x1b[2K${pad}  ${C.primary}│${C.reset} ${C.dim}${padRight(' (no matching commands)', inner)}${C.reset} ${C.primary}│${C.reset}`;
        li++;
      }
      const hint = listRows ? '↑↓  Tab pick   Enter run   Esc close' : 'Esc close';
      const foot = `  ${C.primary}╰${'─'.repeat(Math.max(0, box - 6))}╯${C.reset}`;
      out += `\x1b[${li};1H\x1b[2K${pad}${foot}${C.dim} ${hint}${C.reset}`;
    }

    // Input bar on the last row.
    const max = Math.max(1, cols - visible(this._inputPrefix()) - 1);
    let off = this.viewOffset;
    if (this.cursor < off) off = this.cursor;
    if (this.cursor > off + max - 1) off = this.cursor - max + 1;
    this.viewOffset = off;

    const shown = this._text().slice(off, off + max);
    out += `\x1b[${R};1H\x1b[2K${pad}${this._inputPrefix()}${shown}`;
    const cursorCol = visible(pad + this._inputPrefix()) + (this.cursor - off) + 1;
    out += `\x1b[${R};${Math.min(cursorCol, cols)}H`;
    this.write(out);
  }
}