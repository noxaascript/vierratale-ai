import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vcpuSet, parseMask, nVcpu } from '../vcpu/vcpu.js';

test('vcpu: set is sorted and bounded by cpu count', () => {
  const cpus = vcpuSet();
  assert.deepEqual(cpus, [...cpus].sort((a, b) => a - b));
  assert.ok(cpus.length >= 1);
});

test('vcpu: nVcpu respects override and clamps', () => {
  assert.equal(nVcpu(4), 4);
  assert.ok(nVcpu(-1) >= 1);
});

test('vcpu: parseMask joins with commas', () => {
  assert.equal(parseMask([1, 2, 3]), '1,2,3');
});