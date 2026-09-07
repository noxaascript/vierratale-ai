import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Catalog } from '../src/catalog.js';

test('cortex provider: 404 model-not-found gives actionable guidance', async () => {
  let received = null;
  const server = createServer((req, res) => {
    received = { url: req.url, method: req.method };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.body = JSON.parse(body);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `model '${received.body.model}' not found` }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  process.env.VIERRATALE_ENGINE_HOST = `http://127.0.0.1:${port}`;
  process.env.VIERRATALE_MODEL = 'VRTL-7.cloud-mini';
  const { CortexProvider } = await import('../src/providers/cortex.js');
  const Config = (await import('../src/config.js')).Config;

  const provider = new CortexProvider();
  const real = Catalog.getRealModel(Config.get('model'));
  assert.equal(real, 'gpt-4o-mini');

  let error = null;
  try {
    const gen = provider.stream([{ role: 'user', content: 'hi' }]);
    for await (const chunk of gen) {
      void chunk;
    }
  } catch (err) {
    error = err;
  }

  assert.ok(received, 'engine should have received the request');
  assert.equal(received.url, '/api/chat');
  assert.equal(received.body.model, 'gpt-4o-mini');
  assert.ok(error, 'expected an error to be thrown');
  assert.match(error.message, /^\[ERR-0002\]/);
  assert.match(error.message, /not installed/);
  assert.match(error.message, /VRTL-6\.pro/);
  assert.ok(!error.message.includes('127.0.0.1'), 'error must not leak the engine URL');
  assert.ok(!error.message.includes(String(port)), 'error must not leak the engine port');

  await new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
});