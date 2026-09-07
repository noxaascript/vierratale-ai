import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.OPENAI_API_KEY = 'test-key';
const { OpenAIProvider } = await import('../src/providers/openai.js');
import { Catalog } from '../src/catalog.js';

test('openai provider: local model falls back to cloud default', () => {
  const p = new OpenAIProvider();
  const real = p._resolveModel({ model: 'VRTL-2.fast' });
  assert.equal(real, Catalog.getRealModel(Catalog.getDefaultCloudModel()));
  assert.ok(real.startsWith('gpt-'));
});

test('openai provider: cloud model is used verbatim', async () => {
  const p = new OpenAIProvider();
  const real = p._resolveModel({ model: 'VRTL-8.cloud' });
  assert.equal(real, 'gpt-4o');
});
