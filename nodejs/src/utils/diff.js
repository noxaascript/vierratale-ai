// Gather the local git working-tree changes as compact model context.
//
// Used by the code-diff feature: when a turn is auto-routed to the coding
// model, the current `git status` + diff are attached to the conversation so
// the model "shares" the files it is being asked about.
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, statSync } from 'fs';
import { extname, isAbsolute, join } from 'path';

const execFileP = promisify(execFile);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.gz', '.bz2',
  '.7z', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.ico',
  '.o', '.a', '.pyc', '.wasm', '.mp4', '.mov', '.mp3', '.wav',
]);

async function run(cwd, args, timeout = 8000) {
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

function inlinedUntracked(path, cwd, maxChars) {
  const ext = extname(path).toLowerCase();
  if (BINARY_EXT.has(ext)) return '(binary)';
  const full = isAbsolute(path) ? path : join(cwd, path);
  try {
    if (statSync(full).isDirectory()) return null;
    const text = readFileSync(full, 'utf8');
    if (text.length <= maxChars) return text.trimEnd();
    return text.slice(0, maxChars).trimEnd() + '\n… (file truncated)';
  } catch {
    return null;
  }
}

export async function gitChanges(
  cwd = '.',
  maxChars = 6000,
  maxUntrackedFiles = 2,
  maxUntrackedChars = 1200
) {
  const status = await run(cwd, ['status', '--porcelain']);
  if (!status || !status.trim()) return null;

  const lines = status.trim().split('\n');
  const untracked = lines
    .filter((ln) => ln.startsWith('??'))
    .map((ln) => ln.slice(3).trim())
    .filter((p) => !p.endsWith('/'));

  const [statUnstaged, statStaged, diffUnstaged, diffStaged] = await Promise.all([
    run(cwd, ['diff', '--stat']),
    run(cwd, ['diff', '--cached', '--stat']),
    run(cwd, ['diff']),
    run(cwd, ['diff', '--cached']),
  ]);
  const stat = [statUnstaged, statStaged].filter(Boolean).join('\n').trim();
  const diffBody = [diffUnstaged, diffStaged].filter(Boolean).join('\n').trim();

  const parts = [
    'CODE TASK — the local git working tree was shared with you.',
    '',
    'Changed files:',
    ...lines.slice(0, 25).map((ln) => `- ${ln}`),
  ];

  if (untracked.length) {
    parts.push('', 'Untracked (new) files:');
    let shown = 0;
    for (const path of untracked) {
      if (shown >= maxUntrackedFiles) {
        parts.push(`- ${path} (content not inlined; use the read_file tool)`);
        continue;
      }
      const inlined = inlinedUntracked(path, cwd, maxUntrackedChars);
      if (inlined === null) parts.push(`- ${path}`);
      else if (inlined === '(binary)') parts.push(`- ${path} (binary)`);
      else {
        parts.push(`- ${path}:\n${inlined}`);
        shown += 1;
      }
    }
  }

  if (stat) parts.push('', 'Change summary:', stat);
  if (diffBody) parts.push('', 'Diff:', diffBody);

  let block = parts.join('\n');
  if (block.length > maxChars) {
    block = block.slice(0, maxChars).trimEnd() + '\n… (shared diff truncated)';
  }
  return block;
}