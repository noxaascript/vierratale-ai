import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeModel } from '../src/utils/router.js';

test('router: file/folder/code routes to coder', () => {
  assert.equal(routeModel('Look at this file and fix it'), 'VTL-3.3-Pro');
  assert.equal(routeModel('create a config file'), 'VTL-3.3-Pro');
  assert.equal(routeModel('show me the diff of my changes'), 'VTL-3.3-Pro');
  assert.equal(routeModel('please fix this bug in app.py'), 'VTL-3.3-Pro');
  assert.equal(routeModel('refactor the folder src'), 'VTL-3.3-Pro');
});

test('router: research routes to reasoning', () => {
  assert.equal(routeModel('explain the difference between react and vue'), 'VTL-3.5-Reason');
  assert.equal(routeModel('what is the capital of france'), 'VTL-3.5-Reason');
  assert.equal(routeModel('research the history of the roman empire'), 'VTL-3.5-Reason');
  assert.equal(routeModel('compare machine learning models'), 'VTL-3.5-Reason');
});

test('router: daily chat stays on the flash default', () => {
  assert.equal(routeModel('hello, how are you doing today'), 'VTL-2.7-Flash');
  assert.equal(routeModel('tell me a joke'), 'VTL-2.7-Flash');
  assert.equal(routeModel('i like pizza'), 'VTL-2.7-Flash');
});

test('router: slash commands and empty input are not auto-routed', () => {
  assert.equal(routeModel('/search python'), null);
  assert.equal(routeModel(''), null);
});