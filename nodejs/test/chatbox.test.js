import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatUI, FrameThrottle } from '../src/ui/chatbox.js';

function capture(fn) {
  const oldWrite = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = oldWrite;
  }
  return out.replace(/\x1b\[[0-9;]*m/g, '');
}

test('chatui: renders header, role labels, status, and a boxed code block', () => {
  const ui = new ChatUI({ model: 'lite', engine: 'Cortex' });
  ui.setStatus('Searching...');
  const out = capture(() =>
    ui.render([
      { role: 'user', content: 'make an html page' },
      { role: 'assistant', content: 'Here:\n```html\n<p>Hi</p>\n```' },
    ])
  );
  assert.match(out, /VierrataleAI/);
  assert.match(out, /Searching/);
  assert.match(out, /^ *You$/m);
  assert.match(out, /make an html page/);
  assert.match(out, /^ *AI$/m);
  assert.match(out, /╭─ html/);
  assert.match(out, /│ <p>Hi<\/p>/);
  assert.match(out, /^ *│ .+│$/m);
  assert.match(out, /╰───/);
  assert.match(out, /╯/);
});

test('chatui: plain streaming text is NOT boxed', () => {
  const ui = new ChatUI({});
  ui.setStreaming('Once upon a time...');
  const out = capture(() => ui.render([]));
  assert.match(out, /Once upon a time/);
  assert.match(out, /^ *AI$/m);
  // The streaming text line itself must be plain (not inside a code box).
  assert.doesNotMatch(out, /[│┃│].*Once upon a time/);
  assert.doesNotMatch(out, /Once upon a time.*[│┃│]/);
  assert.doesNotMatch(out, /(?:┌|╭)[^\n]*Once upon a time/);
});

test('chatui: FrameThrottle coalesces rapid renders and flushes the last state', () => {
  let n = 0;
  const t = new FrameThrottle(() => n++, 40);
  for (let i = 0; i < 500; i++) t.schedule();
  const during = n;
  assert.ok(during < 500, 'rendered once per schedule call');
  t.flush();
  assert.equal(n, during + 1);
});