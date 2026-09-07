import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const FILE_NAME = '.todos.json';

export function todosFile(cwd) {
  return join(cwd || '.', FILE_NAME);
}

export function loadTodos(cwd) {
  try {
    const data = JSON.parse(readFileSync(todosFile(cwd), 'utf-8'));
    if (!Array.isArray(data)) return [];
    return data.map((t, i) => {
      if (t && typeof t === 'object') {
        return {
          text: String(t.text ?? '').trim(),
          done: Boolean(t.done),
          createdAt: t.createdAt ?? null,
          updatedAt: t.updatedAt ?? null,
        };
      }
      return { text: String(t ?? '').trim(), done: false, createdAt: null, updatedAt: null };
    }).filter((t) => t.text.length > 0);
  } catch {
    return [];
  }
}

export function saveTodos(cwd, todos) {
  writeFileSync(todosFile(cwd), JSON.stringify(todos, null, 2) + '\n', 'utf-8');
}

export function formatTodos(todos) {
  if (!todos || !todos.length) return '(no todos yet)';
  return todos.map((t, i) => `${i + 1}. ${t.done ? '[x]' : '[ ]'} ${t.text}`).join('\n');
}

export function addTodo(cwd, text) {
  const clean = String(text ?? '').trim();
  if (!clean) return { error: 'Missing todo text.' };
  const todos = loadTodos(cwd);
  todos.push({ text: clean, done: false, createdAt: new Date().toISOString(), updatedAt: null });
  saveTodos(cwd, todos);
  return { okay: true };
}

export function updateTodo(cwd, index, { done, text } = {}) {
  const todos = loadTodos(cwd);
  const i = Number(index) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= todos.length) {
    return { error: `No todo #${index}.` };
  }
  if (typeof done === 'boolean') todos[i].done = done;
  if (typeof text === 'string' && text.trim()) todos[i].text = text.trim();
  todos[i].updatedAt = new Date().toISOString();
  saveTodos(cwd, todos);
  return { okay: true };
}

export function clearTodos(cwd) {
  saveTodos(cwd, []);
  return { okay: true };
}