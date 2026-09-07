import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { dirname, resolve, sep } from 'path';

const FILE_RE = /^FILE:\s*(.+?)\s*$/i;
const FOLDER_RE = /^FOLDER:\s*(.+?)\s*$/i;

export class FileWriter {
  static parse(text) {
    const files = [];
    const folders = [];
    const lines = String(text || '').split('\n');
    let i = 0;
    while (i < lines.length) {
      let m = FILE_RE.exec(lines[i]);
      if (m) {
        const path = m[1].trim();
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && lines[j].startsWith('```')) {
          const start = j + 1;
          let end = start;
          while (end < lines.length && !lines[end].startsWith('```')) end++;
          if (end < lines.length) {
            files.push({
              path,
              language: lines[j].slice(3).trim(),
              content: lines.slice(start, end).join('\n'),
            });
            i = end + 1;
            continue;
          }
        }
      }
      m = FOLDER_RE.exec(lines[i]);
      if (m) {
        folders.push(m[1].trim());
      }
      i++;
    }
    return { files, folders };
  }

  static resolveTarget(path) {
    const base = resolve(process.cwd());
    const target = resolve(base, path);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`Refusing to write outside the working directory: ${path}`);
    }
    return target;
  }

  static async write({ files = [], folders = [], overwrite = false, confirm } = {}) {
    const results = [];

    for (const p of folders) {
      try {
        mkdirSync(this.resolveTarget(p), { recursive: true });
        results.push({ kind: 'folder', path: p, target: this.resolveTarget(p), status: 'created' });
      } catch (err) {
        results.push({ kind: 'folder', path: p, status: 'error', error: err.message });
      }
    }

    for (const f of files) {
      let target;
      try {
        target = this.resolveTarget(f.path);
      } catch (err) {
        results.push({ kind: 'file', path: f.path, status: 'error', error: err.message });
        continue;
      }
      if (existsSync(target) && statSync(target).isDirectory()) {
        results.push({ kind: 'file', path: f.path, target, status: 'error', error: 'Target is a directory' });
        continue;
      }
      if (existsSync(target) && confirm) {
        const ok = await confirm(`Overwrite ${f.path}?`);
        if (!ok) {
          results.push({ kind: 'file', path: f.path, target, status: 'skipped', error: 'Declined' });
          continue;
        }
      } else if (existsSync(target) && !overwrite) {
        results.push({ kind: 'file', path: f.path, target, status: 'skipped', error: 'File already exists' });
        continue;
      }
      try {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.content, 'utf-8');
        results.push({ kind: 'file', path: f.path, target, status: 'written' });
      } catch (err) {
        results.push({ kind: 'file', path: f.path, target, status: 'error', error: err.message });
      }
    }

    return results;
  }
}