import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../src/catalog.js';

test('catalog: real <-> display mapping', () => {
  assert.equal(Catalog.getRealModel('VRTL-2.fast'), 'gemma3:1b');
  assert.equal(Catalog.getDisplayName('gemma3:1b'), 'VTL-2.7-Flash');
  assert.equal(Catalog.getDisplayName('qwen2.5-coder:1.5b'), 'VTL-3.3-Pro');
  assert.equal(Catalog.getRealModel('gpt-4o-mini'), 'gpt-4o-mini');
});

test('catalog: legacy vierratale-* names still map', () => {
  assert.equal(Catalog.getRealModel('vierratale-fast'), 'gemma3:1b');
  assert.equal(Catalog.getRealModel('vierratale-plus'), 'qwen3:1.7b');
  assert.equal(Catalog.normalize('VRTL-4.coder'), 'VTL-3.3-Pro');
  assert.equal(Catalog.normalize('VRTL-5.plus'), 'VTL-3.5-Reason');
  assert.equal(Catalog.normalize('nonsense'), 'nonsense');
});

test('catalog: local vs cloud', () => {
  assert.equal(Catalog.isLocalModel('VRTL-2.fast'), true);
  assert.equal(Catalog.isLocalModel('VRTL-8.cloud'), false);
  assert.equal(Catalog.isLocalModel('vierratale-fast'), true);
  assert.equal(Catalog.isCloudModel('VRTL-7.cloud-mini'), false);
  assert.equal(Catalog.isCloudModel('VRTL-6.pro'), false);
  assert.equal(Catalog.isCloudModel('vierratale-cloud'), false);
});

test('catalog: no cloud models are configured', () => {
  const def = Catalog.getDefaultCloudModel();
  assert.equal(def, '');
  assert.equal(Catalog.getCloudModels().length, 0);
});

test('catalog: cloud vendor routing falls back to openai when not a cloud model', () => {
  assert.equal(Catalog.getVendorForCloudModel('VRTL-7.cloud-mini'), 'openai');
  assert.equal(Catalog.getVendorForCloudModel('VTL-2.7-Flash'), 'openai');
});

test('catalog: getModelInfo present for all listed models', () => {
  for (const m of Object.values(Catalog.getAllModels())) {
    assert.ok(Catalog.getModelInfo(m), `no info for ${m}`);
  }
});

test('catalog: coder tier VRTL-4.coder maps to the installed coder model', () => {
  assert.equal(Catalog.getRealModel('VRTL-4.coder'), 'qwen2.5-coder:1.5b');
  assert.equal(Catalog.getDisplayName('qwen2.5-coder:1.5b'), 'VTL-3.3-Pro');
  assert.equal(Catalog.isLocalModel('VRTL-4.coder'), true);
  const info = Catalog.getModelInfo('VRTL-4.coder');
  assert.equal(info.realModel, 'qwen2.5-coder:1.5b');
  assert.equal(info.isLocal, true);
  assert.equal(info.isCloud, false);
});

test('catalog: raw engine model names are not remapped', () => {
  assert.equal(Catalog.getRealModel('qwen3:0.6b'), 'qwen3:0.6b');
  assert.equal(Catalog.getRealModel('qwen2.5-coder:1.5b'), 'qwen2.5-coder:1.5b');
});