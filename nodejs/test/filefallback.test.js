import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeFileRequest,
  requestedFileName,
  extractFallbackFile,
  storyFileName,
  responseWantsFile,
  responseIsSoloCode,
  languageFileName,
  fallbackHasUsefulCode,
  looksLikeJunkCode,
} from '../src/cli.js';

test('filefallback: html/css/js requests are recognized as file requests', () => {
  assert.equal(looksLikeFileRequest('create an html page'), true);
  assert.equal(looksLikeFileRequest('make me a css file'), true);
  assert.equal(looksLikeFileRequest('write a javascript file'), true);
  assert.equal(looksLikeFileRequest('tell me a story about the phoenix'), false);
});

test('filefallback: natural paraphrases are recognized', () => {
  assert.equal(looksLikeFileRequest('can you code a website html'), true);
  assert.equal(looksLikeFileRequest('build a simple website'), true);
  assert.equal(looksLikeFileRequest('do you have any html code for a login page'), true);
  assert.equal(looksLikeFileRequest('design a nice webpage with css'), true);
  assert.equal(looksLikeFileRequest('write me a python script how to sort a list'), true);
  assert.equal(looksLikeFileRequest('can you show me how css works'), false);
  assert.equal(looksLikeFileRequest('what is html'), false);
  assert.equal(looksLikeFileRequest('explain css to me'), false);
  assert.equal(looksLikeFileRequest('what is the weather'), false);
});

test('filefallback: requested filename is inferred from the request (html included)', () => {
  assert.equal(requestedFileName('create an html page'), 'index.html');
  assert.equal(requestedFileName('make a website'), 'index.html');
  assert.equal(requestedFileName('please style with css'), 'style.css');
  assert.equal(requestedFileName('write a javascript function'), 'script.js');
  assert.equal(requestedFileName('build me a config.json file'), 'config.json');
  assert.equal(requestedFileName('make a readme.md'), 'readme.md');
  assert.equal(requestedFileName('hello there'), null);
});

test('filefallback: an unfenced FILE: header is rescued with the right path', () => {
  const resp = 'FILE: index.html\n<!doctype html>\n<html>…</html>';
  const out = extractFallbackFile(resp, 'create an html page');
  assert.equal(out.path, 'index.html');
  assert.match(out.content, /<!doctype html>/);
});

test('filefallback: a FILE: header with an unclosed fence is still rescued', () => {
  const resp = 'FILE: index.html\n```html\n<!doctype html>\n<title>Hi</title>\n';
  const out = extractFallbackFile(resp, 'can you code a website');
  assert.equal(out.path, 'index.html');
  assert.equal(out.content, '<!doctype html>\n<title>Hi</title>');
});

test('filefallback: response with explicit FILE: header triggers saving even without request match', () => {
  assert.equal(responseWantsFile('FILE: index.html\n```html\n<p>Hi</p>\n```'), true);
  assert.equal(responseWantsFile('Let me save this:\nFILE: app.js\n```\nconsole.log(1)\n```'), true);
  assert.equal(responseWantsFile('FOLDER: assets'), true);
  assert.equal(responseWantsFile('Just a normal answer, no header here.'), false);
  assert.equal(responseWantsFile(''), false);
});

test('filefallback: a bare unclosed fence is extracted to end-of-reply (no prose, no backticks)', () => {
  const resp = 'Okay, here is your code:\n```python\nprint("hi")\n';
  const out = extractFallbackFile(resp, 'write a python script');
  assert.equal(out.path, 'script.py');
  assert.equal(out.content, 'print("hi")');
});

test('filefallback: prose-only replies for file requests are never saved as code', () => {
  assert.equal(fallbackHasUsefulCode('Okay, let me explain how file saving works in detail...', 'write a python script'), false);
  assert.equal(fallbackHasUsefulCode('Okay, let\u2019s build a Python file to generate a basic', 'make a python file'), false);
  assert.equal(fallbackHasUsefulCode('```python\nprint("hi")\n```', 'write a python script'), true);
  assert.equal(fallbackHasUsefulCode('FILE: x.py\nprint(1)', 'hello there'), true);
  assert.equal(fallbackHasUsefulCode('The legend says a phoenix rose from ashes and lived for a thousand years.', 'tell me a story about the phoenix'), true);
});

test('filefallback: python + web/routing requests produce app.py, not script.py', () => {
  assert.equal(requestedFileName('make me a file about html,css and javascript to make a web, and please route them using python'), 'app.py');
  assert.equal(requestedFileName('make a web with css and html, route it with python flask'), 'app.py');
  assert.equal(requestedFileName('write a python script to sort a list'), 'script.py');
  assert.equal(requestedFileName('code a website in html css js'), 'script.js');
  const out = extractFallbackFile('```python\nfrom flask import Flask\napp = Flask(__name__)\n```', 'make a web with html and python');
  assert.equal(out.path, 'app.py');
});

test('filefallback: a reply that is basically just code triggers saving', () => {
  assert.equal(
    responseIsSoloCode('Here you go:\n```html\n<!doctype html><body><h1>Hello world</h1></body></html>\n```'),
    true
  );
  assert.equal(
    responseIsSoloCode('```js\nfunction add(a, b) { return a + b; }\nconsole.log(add(1, 2));\n```'),
    true
  );
  assert.equal(
    responseIsSoloCode('Let me explain the algorithm first. ```python\nx = 1\n``` And that is all.'),
    false
  );
  assert.equal(responseIsSoloCode('No code here, just text.'), false);
});

test('filefallback: fence language maps to a filename when the request has none', () => {
  assert.equal(languageFileName('html'), 'index.html');
  assert.equal(languageFileName('python'), 'script.py');
  assert.equal(languageFileName('json'), 'output.json');
  assert.equal(languageFileName('weirdlang'), null);
  const out = extractFallbackFile('```js\nconsole.log("hi");\n```', 'hello there');
  assert.equal(out.path, 'script.js');
  assert.equal(out.content, 'console.log("hi");');
});

test('filefallback: fenced code without FILE: header is rescued', () => {
  const resp = 'Here you go:\n```html\n<!doctype html><title>Hi</title>\n```';
  const out = extractFallbackFile(resp, 'create an html page');
  assert.equal(out.path, 'index.html');
  assert.equal(out.content, '<!doctype html><title>Hi</title>');
});

test('filefallback: story filename still works from topic', () => {
  assert.equal(storyFileName('tell me a story about timun mas and save it to a file'), 'timun-mas.txt');
});

test('filefallback: python requests save with a .py name, not .js', () => {
  assert.equal(requestedFileName('write a python script'), 'script.py');
  assert.equal(requestedFileName('write me a python script how to sort a list'), 'script.py');
  assert.equal(requestedFileName('python flask code'), 'script.py');
  const out = extractFallbackFile('Here:\n```python\nprint("hi")\n```', 'write a python script');
  assert.equal(out.path, 'script.py');
  assert.match(out.content, /print/);
});

test('filefallback: app/framework/shell requests map to sensible names', () => {
  assert.equal(requestedFileName('make a flask app'), 'app.py');
  assert.equal(requestedFileName('build me a todo app'), 'app.py');
  assert.equal(requestedFileName('create a django project'), 'app.py');
  assert.equal(requestedFileName('set up a bash script'), 'script.sh');
  assert.equal(requestedFileName('create a typescript file'), 'script.ts');
  assert.equal(requestedFileName('write yaml config'), 'output.yml');
  assert.equal(requestedFileName('make a csv file'), 'output.csv');
});

test('filefallback: app-ish requests are treated as file requests', () => {
  assert.equal(looksLikeFileRequest('make a flask app'), true);
  assert.equal(looksLikeFileRequest('build an api'), true);
  assert.equal(looksLikeFileRequest('create a game'), true);
  assert.equal(looksLikeFileRequest('what is an api for'), false);
});

test('filefallback: bare "ts" in a normal word is not a typescript request', () => {
  assert.equal(requestedFileName('please bring the cats'), null);
  assert.equal(requestedFileName('what is the best rate'), null);
});

test('junk detector flags placeholder scaffolding but not real code', () => {
  const junk = `def generate_web_project(file_name="web_project.py"):
    f.write("[0] # This is a Python web project file.")
    f.write('<script src="https://code.google.com/add-on/script/google-chrome-extension.js">')`;
  assert.equal(looksLikeJunkCode(junk, 'app.py'), true);
  assert.equal(looksLikeJunkCode('Lorem ipsum dolor sit amet, building a website.', 'index.html'), true);
  assert.equal(looksLikeJunkCode('some placeholder text here', 'readme.md'), true);

  assert.equal(
    looksLikeJunkCode("from flask import Flask\napp = Flask(__name__)\n\ndef index():\n    return '<h1>Hi</h1>'\n", 'app.py'),
    false,
  );
  assert.equal(looksLikeJunkCode('print([0, 1, 2])\n', 'script.py'), false);
  assert.equal(looksLikeJunkCode('a = value[0]  # index\n', 'script.py'), false);
});