import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const INSTALLED = ['qwen3:0.6b', 'gemma3:1b', 'llama3.2:1b', 'qwen2.5-coder:1.5b'];

test('engine: exact installed model is used as-is', () => {
  const r = Engine.chooseModel(INSTALLED, 'gemma3:1b');
  assert.equal(r.model, 'gemma3:1b');
  assert.equal(r.substituted, false);
  assert.equal(r.reason, null);
});

test('engine: same-family sibling substitutes qwen2.5:1.5b', () => {
  const r = Engine.chooseModel(INSTALLED, 'qwen2.5:1.5b');
  assert.equal(r.model, 'qwen2.5-coder:1.5b');
  assert.equal(r.substituted, true);
  assert.match(r.reason, /same family/);
});

test('engine: same-family sibling carries across size gaps and variant suffixes', () => {
  const r = Engine.chooseModel(INSTALLED, 'qwen2.5-coder:14b');
  assert.equal(r.model, 'qwen2.5-coder:1.5b');
  assert.equal(Engine.chooseModel(INSTALLED, 'qwen2.5-instruct:3b').model, 'qwen2.5-coder:1.5b');
});

test('engine: no match returns model null (caller falls back to download)', () => {
  const r = Engine.chooseModel(INSTALLED, 'mistral:7b');
  assert.equal(r.model, null);
  assert.equal(r.substituted, true);
});

test('engine: empty installed list never matches', () => {
  const r = Engine.chooseModel([], 'gemma3:1b');
  assert.equal(r.model, null);
});
