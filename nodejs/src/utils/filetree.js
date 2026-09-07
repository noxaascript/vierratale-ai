import { readdirSync } from 'fs';
import { join } from 'path';

// Directories that are never worth expanding in a workspace tree.
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.cache']);

// Render a compact box-drawing tree of a directory. Returns an array of lines
// starting with "." for the workspace root. Bounded so huge folders (node_modules,
// caches, download dirs) can never flood a chat with thousands of lines.
export function renderFileTree(rootDir, { maxDepth = 4, maxEntries = 150 } = {}) {
  const root = rootDir || process.cwd();
  const lines = ['.'];
  let entries = 0;

  const walk = (dir, depth, prefix) => {
    if (entries >= maxEntries) return;
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    names = names
      .filter((e) => !SKIP_DIRS.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    for (let i = 0; i < names.length; i++) {
      if (entries >= maxEntries) return;
      const e = names[i];
      const last = i === names.length - 1;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${e.name}`);
      entries++;
      if (e.isDirectory() && depth < maxDepth) {
        walk(join(dir, e.name), depth + 1, `${prefix}${last ? '    ' : '│   '}`);
      }
    }
  };

  walk(root, 0, '');
  if (entries >= maxEntries) lines.push(`… showing first ${entries} entries`);
  return lines;
}