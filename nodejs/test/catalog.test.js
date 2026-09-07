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
  assert.equal(Catalog.getRealModel('vierratale-cloud-mini'), 'gpt-4o-mini');
  assert.equal(Catalog.normalize('vierratale-pro'), 'VTL-3.7-Ultra');
  assert.equal(Catalog.normalize('VRTL-6.pro'), 'VTL-3.7-Ultra');
  assert.equal(Catalog.normalize('nonsense'), 'nonsense');
});

test('catalog: local vs cloud', () => {
  assert.equal(Catalog.isLocalModel('VRTL-2.fast'), true);
  assert.equal(Catalog.isLocalModel('VRTL-8.cloud'), false);
  assert.equal(Catalog.isLocalModel('vierratale-fast'), true);
  assert.equal(Catalog.isCloudModel('VRTL-7.cloud-mini'), true);
  assert.equal(Catalog.isCloudModel('VRTL-6.pro'), false);
  assert.equal(Catalog.isCloudModel('vierratale-cloud'), true);
});

test('catalog: default cloud model is a real cloud display name', () => {
  const def = Catalog.getDefaultCloudModel();
  assert.equal(Catalog.isCloudModel(def), true);
  assert.ok(Catalog.getRealModel(def).startsWith('gpt-'));
});

test('catalog: cloud vendor routing', () => {
  assert.equal(Catalog.getVendorForCloudModel('VRTL-7.cloud-mini'), 'openai');
  assert.equal(Catalog.getVendorForCloudModel('VRTL-9.cloud-fast'), 'anthropic');
  assert.equal(Catalog.getVendorForCloudModel('VRTL-10.cloud-pro'), 'anthropic');
  assert.equal(Catalog.getVendorForCloudModel('VRTL-11.cloud-lite'), 'gemini');
  assert.equal(Catalog.getVendorForCloudModel('VRTL-12.cloud-plus'), 'gemini');
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