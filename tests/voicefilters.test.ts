import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChain } from '../src/dsp/biquad';
import { EQ_BANDS, eqBandsFor, eqChain, LOW_PASS_HZ, lowPassChain } from '../src/dsp/voiceFilters';
import { chooseSettings, HISS_CUT_BELOW_DB, HISS_CUT_HZ, measureForAuto } from '../src/dsp/autoTune';
import { settingsForPreset } from '../src/dsp/pipeline';

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

test('equaliser bands the processing rate can carry', () => {
  const khz = (sr: number) => eqBandsFor(sr).map((i) => EQ_BANDS[i]);
  assert.deepEqual(khz(16000).slice(-1), [6000]);
  assert.deepEqual(khz(24000).slice(-2), [8000, 10000]);
  assert.deepEqual(khz(48000).slice(-2), [12000, 16000]);
  // a hiss band at 10 kHz works at 24 kHz
  const sr2 = 24000;
  const x = new Float32Array(sr2);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 10000 * i) / sr2) * 0.1;
  const eq = EQ_BANDS.map((f) => (f === 10000 ? -12 : 0));
  const y = applyChain(x, eqChain(sr2, eq));
  const rms = (v: Float32Array) => Math.sqrt(v.slice(sr2 / 2).reduce((a, b) => a + b * b, 0) / (sr2 / 2));
  assert.ok(Math.abs(20 * Math.log10(rms(y) / rms(x)) + 12) < 0.6);
});

test('Smart hiss cut: on when the speech above 7 kHz is weaker than the hiss, and the user can override', () => {
  const base = settingsForPreset('auto');
  const m = { snrDb: 20, whisperShare: 0, spreadDb: 3, rumbleDb: -20 };
  const weak = chooseSettings(base, { ...m, hissSnrDb: -4 });
  assert.equal(weak.settings.lowPassHz, HISS_CUT_HZ);
  assert.ok(weak.reasons.some((r) => r.key === 'auto_hiss'));
  assert.equal(chooseSettings(base, { ...m, hissSnrDb: 6 }).settings.lowPassHz, 0);
  assert.equal(chooseSettings(base, m).settings.lowPassHz, 0); // not measured (16 kHz)
  assert.equal(chooseSettings({ ...base, hissFilter: 'off' }, { ...m, hissSnrDb: -10 }).settings.lowPassHz, 0);
  assert.equal(chooseSettings({ ...base, hissFilter: 'on' }, { ...m, hissSnrDb: 10 }).settings.lowPassHz, HISS_CUT_HZ);
  // settings saved with the earlier on/off switch
  assert.equal(chooseSettings({ ...base, lowPassHz: 7000 }, { ...m, hissSnrDb: 10 }).settings.lowPassHz, HISS_CUT_HZ);
});

test('hiss measure: speech that stops at 4 kHz under white hiss reads below 0 dB, bright speech above', () => {
  const sr2 = 24000, dur = 8;
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const segs = [{ start: 1, end: 3 }, { start: 5, end: 7 }];
  const make = (bright: boolean) => {
    const x = new Float32Array(sr2 * dur);
    for (let i = 0; i < x.length; i++) {
      const t = i / sr2;
      const on = segs.some((g) => t >= g.start && t < g.end);
      let v = 0;
      if (on) for (let h = 1; h * 150 < (bright ? 11000 : 4000); h++) v += Math.sin(2 * Math.PI * 150 * h * t + h) * (bright ? 0.02 : 0.03);
      x[i] = v + rnd() * 0.003;
    }
    return x;
  };
  const dull = measureForAuto(make(false), sr2, segs, 20, new Float32Array(sr2 * dur));
  const bright = measureForAuto(make(true), sr2, segs, 20, new Float32Array(sr2 * dur));
  assert.ok(dull.hissSnrDb !== undefined && dull.hissSnrDb < HISS_CUT_BELOW_DB, `dull ${dull.hissSnrDb}`);
  assert.ok(bright.hissSnrDb !== undefined && bright.hissSnrDb > 10, `bright ${bright.hissSnrDb}`);
  assert.equal(measureForAuto(make(false).slice(0, 16000 * dur), 16000, segs, 20, new Float32Array(16000 * dur)).hissSnrDb, undefined);
});
