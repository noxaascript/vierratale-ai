import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const home = mkdtempSync(join(tmpdir(), 'vrtl-session-test-'));
process.env.HOME = home;

const { Session } = await import('../src/session.js');

function configDir() {
  return join(home, '.config', 'vierrataleai');
}

// Simulate a pre-upgrade install: the old single history.json already exists
// with messages before the very first Session access.
mkdirSync(configDir(), { recursive: true });
writeFileSync(join(configDir(), 'history.json'), JSON.stringify([
  { role: 'user', content: 'old question' },
  { role: 'assistant', content: 'old answer' },
]));

test('legacy history.json migrates into a "default" session on first access', () => {
  const migrated = Session.list().find((s) => s.name === 'default');
  assert.ok(migrated, 'default session exists after migration');
  assert.equal(migrated.count, 2);
  assert.ok(migrated.preview.includes('old question'));
  // Establish a clean active session for the tests below.
  Session.create(null);
});

test('create/new session becomes active and starts empty', () => {
  const name = Session.create(null);
  assert.ok(/\bsession-\d{8}-\d{6}\b/.test(name), `auto name ${name}`);
  assert.equal(Session.load().length, 0);
  assert.equal(Session.activeName(), name);
});

test('save/load writes to the active session only', () => {
  Session.create('first');
  Session.save([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);
  assert.equal(Session.load().length, 2);
  Session.create('second');
  assert.equal(Session.load().length, 0, 'second session is empty');
  Session.save([{ role: 'user', content: 'new line' }]);
  assert.equal(Session.load().length, 1);
});

test('list shows all sessions with counts and current marker', () => {
  const list = Session.list();
  assert.ok(list.length >= 2);
  const second = list.find((s) => s.name === 'second');
  const first = list.find((s) => s.name === 'first');
  assert.ok(second && second.active === true);
  assert.ok(first && first.active === false);
  assert.equal(first.count, 2);
  assert.ok(first.preview.includes('hello'));
});

test('open by name and by #index resumes the right session', () => {
  const secondMostRecent = Session.list()[1].name;
  const opened = Session.open('#2');
  assert.equal(opened, secondMostRecent);
  assert.equal(Session.activeName(), opened);
  const byName = Session.open('first');
  assert.equal(byName, 'first');
  assert.equal(Session.load()[0].content, 'hello');
});

test('open unknown session returns null', () => {
  assert.equal(Session.open('does-not-exist'), null);
  assert.equal(Session.open('#99'), null);
});

test('remove non-active session keeps pointer', () => {
  Session.open('second');
  Session.remove('first');
  assert.equal(Session.activeName(), 'second');
  assert.ok(!Session.list().some((s) => s.name === 'first'));
});

test('remove active session switches to another or creates a fresh one', () => {
  Session.open('second');
  const removed = Session.remove('second');
  assert.equal(removed, 'second');
  assert.notEqual(Session.activeName(), 'second');
  assert.ok(Session.list().length >= 1);
});

test('removing the only session auto-creates a new empty one', () => {
  Session.create('only');
  for (const s of Session.list()) Session.remove(s.name);
  const list = Session.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].active, true);
  assert.equal(Session.load().length, 0);
});

test('clear empties the active session', () => {
  Session.create('clear-test');
  Session.save([{ role: 'user', content: 'x' }]);
  assert.equal(Session.load().length, 1);
  Session.clear();
  assert.equal(Session.load().length, 0);
  assert.equal(Session.hasHistory(), false);
});

test('sessions live under the config dir', () => {
  assert.ok(existsSync(join(configDir(), 'sessions')), 'sessions dir exists');
});

after(() => rmSync(home, { recursive: true, force: true }));