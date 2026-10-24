import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplePlan } from '../src/services/samplePlan';

test('short recordings are analysed whole', () => {
  assert.deepEqual(samplePlan(300), [{ start: 0, length: 300 }]);
});

test('long recordings: 16 parts of 20 s from the start to the end', () => {
  const p = samplePlan(36000);
  assert.equal(p.length, 16);
  assert.equal(p[0].start, 0);
  assert.equal(p[15].start + p[15].length, 36000);
  for (let i = 1; i < p.length; i++) assert.ok(p[i].start > p[i - 1].start + p[i - 1].length);
});
