import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Config } from './config.js';

const ROOT = join(Config.getConfigDir(), 'sessions');
const ACTIVE_FILE = join(ROOT, '.active');
const MIGRATED_FLAG = join(ROOT, '.migrated');
const MAX_MESSAGES = 20;

const sanitize = (name) =>
  String(name || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'default';

const pathFor = (name) => join(ROOT, `${sanitize(name)}.json`);
const backupPathFor = (name) => join(ROOT, `${sanitize(name)}.bak.json`);

const autoName = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `session-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds())}`;
};

function ensureDir() {
  if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true });
}

function migrateLegacy() {
  // One-time move of the old single history.json into a session named "default".
  // The .migrated flag guarantees the legacy file can never resurrect a deleted
  // "default" session on later runs.
  try {
    const legacy = join(Config.getConfigDir(), 'history.json');
    if (existsSync(legacy) && !existsSync(MIGRATED_FLAG)) {
      if (!existsSync(pathFor('default'))) {
        const data = JSON.parse(readFileSync(legacy, 'utf-8') || '[]');
        if (Array.isArray(data) && data.length) {
          writeFileSync(pathFor('default'), JSON.stringify(data.slice(-MAX_MESSAGES), null, 2));
        }
      }
      writeFileSync(MIGRATED_FLAG, new Date().toISOString());
    }
  } catch {}
}

export const Session = {
  activeName() {
    ensureDir();
    migrateLegacy();
    try {
      if (existsSync(ACTIVE_FILE)) {
        const name = readFileSync(ACTIVE_FILE, 'utf-8').trim();
        if (name && existsSync(pathFor(name))) return name;
      }
    } catch {}
    if (!existsSync(pathFor('default'))) writeFileSync(pathFor('default'), '[]');
    writeFileSync(ACTIVE_FILE, 'default');
    return 'default';
  },

  list() {
    ensureDir();
    migrateLegacy();
    const out = [];
    const active = this.activeName();
    for (const f of readdirSync(ROOT)) {
      if (!f.endsWith('.json')) continue;
      const name = f.slice(0, -5);
      try {
        const msgs = JSON.parse(readFileSync(join(ROOT, f), 'utf-8') || '[]');
        const first = msgs.find((m) => m.role === 'user');
        out.push({
          name,
          count: msgs.length,
          preview: first ? String(first.content).slice(0, 60) : '(empty)',
          updated: statSync(join(ROOT, f)).mtimeMs,
          active: name === active,
        });
      } catch {}
    }
    out.sort((a, b) => b.updated - a.updated);
    return out;
  },

  create(name) {
    ensureDir();
    const safe = sanitize(name || autoName());
    writeFileSync(pathFor(safe), '[]');
    writeFileSync(ACTIVE_FILE, safe);
    return safe;
  },

  open(name) {
    const sessions = this.list();
    let target = name;
    if (/^#\d+$/.test(name)) {
      const idx = parseInt(name.slice(1), 10);
      const s = sessions[idx - 1];
      if (!s) return null;
      target = s.name;
    }
    const safe = sanitize(target);
    if (!existsSync(pathFor(safe))) return null;
    writeFileSync(ACTIVE_FILE, safe);
    return safe;
  },

  remove(name) {
    const sessions = this.list();
    let target = name;
    if (/^#\d+$/.test(name)) {
      const idx = parseInt(name.slice(1), 10);
      const s = sessions[idx - 1];
      if (!s) return null;
      target = s.name;
    }
    const safe = sanitize(target);
    const file = pathFor(safe);
    if (!existsSync(file)) return null;
    if (safe === this.activeName()) {
      const others = sessions.filter((s) => s.name !== safe);
      if (others.length) {
        writeFileSync(ACTIVE_FILE, others[0].name);
      } else {
        writeFileSync(ACTIVE_FILE, this.create(null));
      }
    }
    try { unlinkSync(file); } catch {}
    return safe;
  },

  load() {
    return this.loadActive();
  },

  loadActive() {
    try {
      const path = pathFor(this.activeName());
      if (existsSync(path)) {
        const data = JSON.parse(readFileSync(path, 'utf-8') || '[]');
        if (Array.isArray(data)) return data.slice(-MAX_MESSAGES);
      }
    } catch {}
    return [];
  },

  save(messages) {
    try {
      ensureDir();
      writeFileSync(pathFor(this.activeName()), JSON.stringify(messages.slice(-MAX_MESSAGES), null, 2));
    } catch {}
  },

  // Snapshot the active session to a timestamped .bak.json before it is
  // replaced or cleared, so a fresh-start or /new never loses the old talk.
  autoBackup() {
    try {
      ensureDir();
      const name = this.activeName();
      const src = pathFor(name);
      if (!existsSync(src)) return null;
      const msgs = JSON.parse(readFileSync(src, 'utf-8') || '[]');
      if (!Array.isArray(msgs) || msgs.length === 0) return null;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = backupPathFor(`${name}.${stamp}`);
      writeFileSync(dest, JSON.stringify(msgs, null, 2));
      return `${name}.${stamp}.bak.json`;
    } catch { return null; }
  },

  backup() {
    return this.autoBackup();
  },

  // List .bak.json recovery copies for the sessions UI.
  listBackups() {
    ensureDir();
    const out = [];
    for (const f of readdirSync(ROOT)) {
      if (!f.endsWith('.bak.json')) continue;
      const name = f.slice(0, -'.bak.json'.length);
      try {
        out.push({ name, file: f, updated: statSync(join(ROOT, f)).mtimeMs });
      } catch {}
    }
    out.sort((a, b) => b.updated - a.updated);
    return out;
  },

  // Restore a backup: copy the .bak.json content back into a normal session file
  // (creating <name>-restored if the original still exists) and switch to it.
  restoreBackup(file) {
    try {
      ensureDir();
      let fname = String(file || '').trim();
      if (!fname.endsWith('.bak.json')) {
        if (!fname.endsWith('.json')) fname += '.bak.json';
      }
      const safe = sanitize(fname.replace(/\.bak\.json$/, ''));
      const src = backupPathFor(safe);
      if (!existsSync(src)) return null;
      const msgs = JSON.parse(readFileSync(src, 'utf-8') || '[]');
      if (!Array.isArray(msgs)) return null;
      const base = sanitize(safe.replace(/\.\d{4}-\d{2}-\d{2}T[\d-]+$/, ''));
      let target = base;
      if (existsSync(pathFor(target))) target = `${base}-restored`;
      writeFileSync(pathFor(target), JSON.stringify(msgs.slice(-MAX_MESSAGES), null, 2));
      writeFileSync(ACTIVE_FILE, target);
      return target;
    } catch { return null; }
  },

  clear() {
    try {
      ensureDir();
      writeFileSync(pathFor(this.activeName()), '[]');
    } catch {}
  },

  hasHistory() {
    return this.loadActive().length > 0;
  },
};