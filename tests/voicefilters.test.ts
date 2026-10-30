import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChain } from '../src/dsp/biquad';
import { EQ_BANDS, eqChain, LOW_PASS_HZ, lowPassChain } from '../src/dsp/voiceFilters';

const sr = 48000;
const tone = (f: number) => Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * f * i) / sr));
const gainDb = (y: Float32Array, x: Float32Array) => {
  let a = 0, b = 0;
  for (let i = sr / 2; i < sr; i++) { a += y[i] * y[i]; b += x[i] * x[i]; } // after the filters settle
  return 10 * Math.log10(a / b);
};

test('each equaliser band changes its own frequency by its setting', () => {
  for (let k = 0; k < EQ_BANDS.length; k++) {
    const eq = EQ_BANDS.map((_, i) => (i === k ? 12 : 0));
    const x = tone(EQ_BANDS[k]);
    const g = gainDb(applyChain(x, eqChain(sr, eq)), x);
    assert.ok(Math.abs(g - 12) < 0.6, `${EQ_BANDS[k]} Hz: ${g.toFixed(2)} dB`);
  }
  // flat: no filters at all
  assert.equal(eqChain(sr, EQ_BANDS.map(() => 0)).length, 0);
  assert.equal(eqChain(sr, undefined).length, 0);
});

test('the voice-band low-pass keeps speech and cuts above 7 kHz', () => {
  const lp = lowPassChain(sr, LOW_PASS_HZ);
  const at = (f: number) => { const x = tone(f); return gainDb(applyChain(x, lp), x); };
  assert.ok(Math.abs(at(1000)) < 0.1);
  assert.ok(Math.abs(at(LOW_PASS_HZ) + 3) < 0.3);
  assert.ok(at(2 * LOW_PASS_HZ) < -23);
  assert.equal(lowPassChain(sr, 0).length, 0);
  assert.equal(lowPassChain(12000, LOW_PASS_HZ).length, 0); // at or above 0.45 x the rate: off
});
