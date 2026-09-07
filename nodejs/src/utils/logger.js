import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { Config } from '../config.js';

const MAX_LINE = 2000;

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateStamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function timeStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function cap(text) {
  const s = String(text ?? '');
  return s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}…` : s;
}

// Automatic activity logger. Writes one timestamped file per day into the
// config directory (logs/). A no-op until init() is called, so tests and
// library consumers never accidentally write into the real logs folder.
class Logger {
  constructor() {
    this.dir = null;
    this.file = null;
    this._initialized = false;
  }

  init(opts = {}) {
    if (this._initialized) return this;
    this.dir = opts.baseDir ? join(opts.baseDir, 'logs') : join(Config.getConfigDir(), 'logs');
    mkdirSync(this.dir, { recursive: true });
    this.file = join(this.dir, `vierrataleai-${dateStamp(new Date())}.log`);
    this._initialized = true;
    return this;
  }

  log(event, message = '') {
    if (!this._initialized) return '';
    const line = `${timeStamp(new Date())} [${event}] ${cap(message)}`;
    try {
      appendFileSync(this.file, line + '\n');
    } catch {}
    return line;
  }

  getPath() {
    return this.file;
  }

  tail(count = 30) {
    if (!this._initialized || !existsSync(this.file)) return [];
    try {
      return readFileSync(this.file, 'utf-8').split('\n').filter(Boolean).slice(-count);
    } catch {
      return [];
    }
  }
}

export { Logger };
export const logger = new Logger();