import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.OPENAI_API_KEY = 'test-key';
const { OpenAIProvider } = await import('../src/providers/openai.js');

test('openai provider: local model falls back to the cloud default', () => {
  const p = new OpenAIProvider();
  const real = p._resolveModel({ model: 'VRTL-2.fast' });
  assert.equal(real, 'gpt-4o-mini');
});

test('openai provider: non-cloud model falls back to the cloud default', () => {
  const p = new OpenAIProvider();
  const real = p._resolveModel({ model: 'VRTL-8.cloud' });
  assert.equal(real, 'gpt-4o-mini');
});
