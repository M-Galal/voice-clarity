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

test('sections found in the joined parts are placed back in the recording', async () => {
  const { mapToParts } = await import('../src/services/samplePlan');
  const plan = [{ start: 0 }, { start: 100 }];
  const frames = [20 * 1000, 20 * 1000]; // two 20 s parts at 1 kHz
  const out = mapToParts([{ start: 5, end: 10, k: 'a' }, { start: 18, end: 25, k: 'b' }], plan, frames, 1000);
  assert.deepEqual(out, [
    { start: 5, end: 10, k: 'a' },
    { start: 18, end: 20, k: 'b' },
    { start: 100, end: 105, k: 'b' },
  ]);
});
