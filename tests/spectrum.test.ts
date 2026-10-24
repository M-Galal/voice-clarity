import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpectrumMeter } from '../src/dsp/spectrum';

test('spectrum: a 1 kHz sine peaks in the band around 1 kHz, chunking does not matter', () => {
  const sr = 24000;
  const x = Float32Array.from({ length: sr * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sr));
  const a = new SpectrumMeter(sr);
  a.push(x);
  const b = new SpectrumMeter(sr);
  for (let i = 0; i < x.length; i += 777) b.push(x.subarray(i, i + 777));
  const sa = a.bands(40), sb = b.bands(40);
  assert.deepEqual(sa.db, sb.db);
  const peak = sa.db.indexOf(Math.max(...sa.db));
  assert.ok(sa.freqs[peak] > 800 && sa.freqs[peak] < 1250, `peak at ${sa.freqs[peak]} Hz`);
  // far bands are much lower than the tone's band
  assert.ok(sa.db[0] < sa.db[peak] - 40);
});
