import { accessSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, X_OK } from 'fs';
import { delimiter, join, resolve, sep } from 'path';
import { toolResult, SafeCommandExecutor } from './executor.js';
import { Downloader } from '../utils/downloader.js';
import { Config } from '../config.js';
import { loadTodos, addTodo, updateTodo, clearTodos, formatTodos } from './todos.js';

// Resolve a path relative to the workspace and require it to stay inside.
// Throws if the path escapes the workspace (or hits the workspace root for
// destructive operations).
export function resolveWithin(cwd, p, { allowRoot = false } = {}) {
  const base = resolve(cwd);
  const target = resolve(base, String(p || ''));
  const rootOrEscape = target === base || !target.startsWith(base + sep);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Refusing to access a path outside the workspace: ${p}`);
  }
  if (!allowRoot && target === base && String(p || '') !== '.' && String(p || '') !== '') {
    throw new Error('Refusing to use the workspace root as a file path.');
  }
  return target;
}

function ok({ command, stdout = '', cwd }) {
  return toolResult({ success: true, command, stdout, stderr: '', exitCode: 0, cwd });
}

function fail({ command, stderr, exitCode = 1, cwd }) {
  return toolResult({ success: false, command, stdout: '', stderr, exitCode, cwd });
}

export function createFile(cwd, path, content = '') {
  if (!path || typeof path !== 'string' || path.trim() === '') {
    return fail({ command: 'create_file', stderr: 'Missing file path.', cwd });
  }
  try {
    const target = resolveWithin(cwd, path);
    const dir = resolve(target, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, String(content ?? ''));
    return ok({ command: `create_file("${path}")`, stdout: `created ${path} (${String(content ?? '').length} bytes)`, cwd });
  } catch (err) {
    return fail({ command: `create_file("${path}")`, stderr: err.message, cwd });
  }
}

export function createDirectory(cwd, path) {
  if (!path || typeof path !== 'string' || path.trim() === '') {
    return fail({ command: 'create_directory', stderr: 'Missing directory path.', cwd });
  }
  try {
    const target = resolveWithin(cwd, path, { allowRoot: true });
    if (target === resolve(cwd)) {
      return ok({ command: `create_directory("${path}")`, stdout: `already at workspace root`, cwd });
    }
    mkdirSync(target, { recursive: true });
    return ok({ command: `create_directory("${path}")`, stdout: `created directory ${path}`, cwd });
  } catch (err) {
    return fail({ command: `create_directory("${path}")`, stderr: err.message, cwd });
  }
}

export function readFile(cwd, path) {
  if (!path || typeof path !== 'string' || path.trim() === '') {
    return fail({ command: 'read_file', stderr: 'Missing file path.', cwd });
  }
  try {
    const target = resolveWithin(cwd, path);
    const content = readFileSync(target, 'utf-8');
    return ok({ command: `read_file("${path}")`, stdout: content, cwd });
  } catch (err) {
    return fail({ command: `read_file("${path}")`, stderr: err.message, cwd });
  }
}

export function listDirectory(cwd, path = '.') {
  try {
    const target = resolveWithin(cwd, path, { allowRoot: true });
    const entries = readdirSync(target, { withFileTypes: true });
    const list = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join('\n');
    return ok({ command: `list_directory("${path}")`, stdout: list || '(empty)', cwd });
  } catch (err) {
    return fail({ command: `list_directory("${path}")`, stderr: err.message, cwd });
  }
}

export function deleteFile(cwd, path) {
  if (!path || typeof path !== 'string' || path.trim() === '') {
    return fail({ command: 'delete_file', stderr: 'Missing path.', cwd });
  }
  try {
    const target = resolveWithin(cwd, path);
    if (resolve(cwd) === target) {
      return fail({ command: `delete_file("${path}")`, stderr: 'Refusing to delete the workspace root.', cwd });
    }
    if (!existsSync(target)) {
      return fail({ command: `delete_file("${path}")`, stderr: `No such file or directory: ${path}`, exitCode: 1, cwd });
    }
    rmSync(target, { recursive: true, force: true });
    return ok({ command: `delete_file("${path}")`, stdout: `removed ${path}`, cwd });
  } catch (err) {
    return fail({ command: `delete_file("${path}")`, stderr: err.message, cwd });
  }
}

// Pick the package manager to use for installing system packages: pkg is the
// Termux/Android wrapper, everywhere else apt/apt-get.
export function pickPackageManager() {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const available = (bin) => dirs.some((dir) => {
    try {
      accessSync(join(dir, bin), X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (available('pkg')) return 'pkg';
  if (available('apt-get')) return 'apt-get';
  return 'apt';
}

export async function downloadUrl(cwd, url, dir) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
    return fail({ command: 'download_url', stderr: 'Invalid URL. Provide a valid http(s) address.', cwd });
  }
  const targetDir = dir ? resolveWithin(cwd, dir, { allowRoot: true }) : Config.get('downloadDir');
  try {
    const res = await Downloader.download(url.trim(), { dir: targetDir });
    const kind = res.kind || 'file';
    const note = res.extracted ? '\n(contents extracted into that folder)' : '';
    return ok({
      command: `download_url("${url}")`,
      stdout: `downloaded ${kind} → ${res.path}${note}`,
      cwd,
    });
  } catch (err) {
    return fail({ command: 'download_url', stderr: err.message, cwd });
  }
}

export function todoAdd(cwd, text) {
  const err = addTodo(cwd, text);
  if (err && err.error) return fail({ command: `todo_add("${text}")`, stderr: err.error, cwd });
  return ok({ command: `todo_add("${text}")`, stdout: formatTodos(loadTodos(cwd)), cwd });
}

export function todoList(cwd) {
  try {
    return ok({ command: 'todo_list', stdout: formatTodos(loadTodos(cwd)), cwd });
  } catch (err) {
    return fail({ command: 'todo_list', stderr: err.message, cwd });
  }
}

export function todoUpdate(cwd, index, done, text) {
  const err = updateTodo(cwd, index, { done, text });
  if (err && err.error) return fail({ command: `todo_update(${index})`, stderr: err.error, cwd });
  return ok({ command: `todo_update(${index})`, stdout: formatTodos(loadTodos(cwd)), cwd });
}

export function todoClear(cwd) {
  try {
    clearTodos(cwd);
    return ok({ command: 'todo_clear', stdout: '(no todos yet)', cwd });
  } catch (err) {
    return fail({ command: 'todo_clear', stderr: err.message, cwd });
  }
}

// Structured tool registry shared with the agent loop.
export const TOOL_EXECUTORS = {
  run_command: (executor, params) => executor.runCommand(params.command),
  create_file: (executor, params) => createFile(executor.cwd, params.path, params.content),
  create_directory: (executor, params) => createDirectory(executor.cwd, params.path),
  read_file: (executor, params) => readFile(executor.cwd, params.path),
  list_directory: (executor, params) => listDirectory(executor.cwd, params.path || '.'),
  delete_file: (executor, params) => deleteFile(executor.cwd, params.path),
  download_url: (executor, params) => downloadUrl(executor.cwd, params.url, params.dir),
  todo_add: (executor, params) => todoAdd(executor.cwd, params ? params.text : undefined),
  todo_list: (executor, params) => todoList(executor.cwd),
  todo_update: (executor, params) => todoUpdate(executor.cwd, params ? params.index : undefined, params ? params.done : undefined, params ? params.text : undefined),
  todo_clear: (executor, params) => todoClear(executor.cwd),
};

export function makeExecutor({ cwd, timeoutMs } = {}) {
  return new SafeCommandExecutor({ cwd, timeoutMs });
}

export function dispatchTool(executor, call) {
  const fn = TOOL_EXECUTORS[call && call.name];
  if (!fn) {
    return toolResult({
      success: false,
      command: `${call && call.name ? call.name : '(unknown tool)'}`,
      stderr: `Unknown tool ${call && call.name}.`,
      cwd: executor.cwd,
    });
  }
  return fn(executor, call.params || {});
}