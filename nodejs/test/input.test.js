import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineEditor } from '../src/ui/input.js';

const CMDS = [
  { name: 'help', desc: 'Show all commands' },
  { name: 'clear', desc: 'Clear the screen' },
  { name: 'new', desc: 'Start a new empty conversation' },
  { name: 'search', args: '<query>', desc: 'Search the web' },
  { name: 'fetch', args: '<url>', desc: 'Open a link' },
  { name: 'quit', desc: 'Exit' },
];

function makeEditor() {
  const writes = [];
  const editor = new LineEditor({
    stream: { isTTY: true },
    commands: CMDS,
    dims: () => ({ columns: 100, rows: 24 }),
    write: (s) => writes.push(s),
  });
  return { editor, writes };
}

function submit(editor, sequence) {
  editor._feed(sequence);
  return editor.readLine();
}

test('input: typing "/" opens a popup listing every command', () => {
  const { editor } = makeEditor();
  editor._feed('/');
  assert.ok(editor.popup);
  assert.deepEqual(
    editor.popup.matches.map((m) => m.name),
    CMDS.map((c) => c.name)
  );
});

test('input: popup filters as more characters are typed', () => {
  const { editor } = makeEditor();
  editor._feed('/se');
  assert.deepEqual(editor.popup.matches.map((m) => m.name), ['search']);
});

test('input: Tab opens and cycles the popup, Escape closes it', () => {
  const { editor } = makeEditor();
  editor._feed('/');
  editor._feed('\t'); // open popup, select first match
  assert.ok(editor.popup);
  assert.equal(editor.popup.selected, 0);
  editor._feed('\t'); // cycle
  assert.equal(editor.popup.selected, 1);
  editor._feed('\x1b'); // close
  assert.equal(editor.popup, null);
});

test('input: up/down arrows navigate the popup', () => {
  const { editor } = makeEditor();
  editor._feed('/');
  assert.equal(editor.popup.selected, -1);
  editor._feed('\x1b[B');
  assert.equal(editor.popup.selected, 0);
  editor._feed('\x1b[B');
  assert.equal(editor.popup.selected, 1);
  editor._feed('\x1b[A');
  assert.equal(editor.popup.selected, 0);
});

test('input: Enter runs a no-argument command from the popup', async () => {
  const { editor } = makeEditor();
  const p = submit(editor, '/cl\r');
  assert.equal(await p, '/clear');
});

test('input: Enter on an args command completes then keeps editing', async () => {
  const { editor } = makeEditor();
  const p = submit(editor, '/se\r');
  assert.deepEqual(editor.buffer, [...'/search ']);
  assert.equal(editor.popup, null);
  editor._feed('cats\r');
  assert.equal(await p, '/search cats');
});

test('input: typing args after a command closes the popup and submits', async () => {
  const { editor } = makeEditor();
  const p = submit(editor, '/search cats now\r');
  assert.equal(editor.popup, null);
  assert.equal(await p, '/search cats now');
});

test('input: a bare URL typed after the command is preserved', async () => {
  const { editor } = makeEditor();
  const p = submit(editor, '/fetch https://example.com/x\r');
  assert.equal(await p, '/fetch https://example.com/x');
});

test('input: backspace and arrow editing work', async () => {
  const { editor } = makeEditor();
  editor._feed('hello world');
  editor._feed('\x7f'); // remove 'd'
  editor._feed('\x1b[D'); // left over 'l'
  editor._feed('X'); // insert
  editor._feed('\x1b[C'); // right
  assert.equal(editor.buffer.join(''), 'hello worXl');
  editor._feed('\r');
  await editor.readLine();
});

test('input: multibyte UTF-8 input survives round-trip', async () => {
  const { editor } = makeEditor();
  const p = submit(editor, 'halo dunia ✓\r');
  assert.equal(await p, 'halo dunia ✓');
});

test('input: question() reads a y/N prompt', async () => {
  const { editor } = makeEditor();
  const p = editor.question('Overwrite?');
  editor._feed('y\r');
  assert.equal(await p, 'y');
  assert.equal(editor.questionText, null);
});

test('input: line received while busy is queued for the next read', async () => {
  const { editor } = makeEditor();
  editor.setBusy(true);
  editor._feed('queued line\r');
  editor.setBusy(false);
  assert.equal(await editor.readLine(), 'queued line');
});

test('input: arrow-up recalls history', async () => {
  const { editor } = makeEditor();
  await submit(editor, 'first\r');
  await submit(editor, 'second\r');
  const p = submit(editor, '\x1b[A\r');
  assert.equal(await p, 'second');
});

test('input: Ctrl+D on an empty line triggers exit', () => {
  const { editor } = makeEditor();
  let exited = false;
  editor.onExit = () => {
    exited = true;
  };
  editor._feed('\x04');
  assert.ok(exited);
});

test('input: draw writes a popup box plus a bottom input bar', () => {
  const { editor, writes } = makeEditor();
  editor._feed('/');
  writes.length = 0;
  editor.draw();
  const out = writes.join('').replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[\d+;\d*H/g, '|').replace(/\x1b\[2K/g, '');
  assert.match(out, /Commands/);
  assert.match(out, /\/help/);
  assert.match(out, /\/quit/);
  assert.match(out, /╭/);
  assert.match(out, /╰/);
});