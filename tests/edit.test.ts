import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, changeSpeed, cutChannels, editedDuration, normalizeSpec, remapTime } from '../src/dsp/edit';

const sine = (f: number, sec: number, sr: number, amp = 0.5) =>
  Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));

/** Dominant frequency from positive-going zero crossings in the middle of the buffer. */
function freq(x: Float32Array, sr: number) {
  const a = Math.floor(x.length * 0.2), b = Math.floor(x.length * 0.8);
  let n = 0, first = -1, last = -1;
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) { if (first < 0) first = i; last = i; n++; }
  return ((n - 1) * sr) / (last - first);
}
const rms = (x: Float32Array, a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };

test('speed change keeps pitch and scales length', async () => {
  const sr = 16000;
  for (const speed of [0.5, 0.75, 1.5, 2]) {
    const [y] = await changeSpeed([sine(220, 3, sr)], sr, speed);
    assert.equal(y.length, Math.round((3 * sr) / speed), `len @${speed}`);
    const f = freq(y, sr);
    assert.ok(Math.abs(f - 220) < 3, `pitch @${speed}: ${f}`);
    // steady level: no dropouts in the middle
    const mid = Math.floor(y.length / 2);
    assert.ok(Math.abs(rms(y, mid - 800, mid + 800) - 0.5 / Math.SQRT2) < 0.05, `level @${speed}`);
  }
});

test('speed 1 is an exact copy', async () => {
  const x = sine(300, 0.5, 8000);
  const [y] = await changeSpeed([x], 8000, 1);
  assert.deepEqual(y, x);
  assert.notEqual(y, x);
});

test('speed change moves events in time correctly', async () => {
  const sr = 16000;
  const x = new Float32Array(sr * 4);
  // a 200 ms burst starting at 2.0 s
  for (let i = 0; i < sr * 0.2; i++) x[2 * sr + i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / sr);
  const [y] = await changeSpeed([x], sr, 2);
  let onset = -1;
  for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > 0.1) { onset = i / sr; break; }
  assert.ok(Math.abs(onset - 1.0) < 0.03, `onset ${onset}`);
});

test('stereo channels stay aligned after a speed change', async () => {
  const sr = 16000;
  const l = sine(250, 2, sr), r = sine(250, 2, sr);
  const [yl, yr] = await changeSpeed([l, r], sr, 1.25);
  for (let i = 0; i < yl.length; i++) assert.ok(Math.abs(yl[i] - yr[i]) < 1e-6);
});

test('keep (trim) and cut lengths, with fades only at joins', () => {
  const sr = 1000;
  const x = Float32Array.from({ length: 10 * sr }, () => 1);
  const [k] = cutChannels([x], sr, { mode: 'keep', start: 2, end: 5, speed: 1 });
  assert.equal(k.length, 3 * sr);
  assert.equal(k[1500], 1);
  assert.ok(k[0] < 0.5 && k[k.length - 1] < 0.5);
  const [c] = cutChannels([x], sr, { mode: 'cut', start: 2, end: 5, speed: 1 });
  assert.equal(c.length, 7 * sr);
  assert.equal(c[0], 1);
  assert.equal(c[c.length - 1], 1);
  const [whole] = cutChannels([x], sr, { mode: 'keep', start: 0, end: 10, speed: 1 });
  assert.equal(whole[0], 1);
  assert.equal(whole[whole.length - 1], 1);
});

test('spec normalisation, edited duration and bookmark remap', () => {
  assert.deepEqual(normalizeSpec({ mode: 'keep', start: 8, end: 3, speed: 9 }, 10), { mode: 'keep', start: 3, end: 8, speed: 2 });
  assert.equal(editedDuration({ mode: 'keep', start: 2, end: 6, speed: 2 }, 10), 2);
  assert.equal(editedDuration({ mode: 'cut', start: 2, end: 6, speed: 0.5 }, 10), 12);
  assert.equal(editedDuration({ mode: 'none', start: 0, end: 0, speed: 1.25 }, 10), 8);
  assert.equal(remapTime(4, { mode: 'keep', start: 2, end: 6, speed: 2 }, 10), 1);
  assert.equal(remapTime(7, { mode: 'keep', start: 2, end: 6, speed: 1 }, 10), null);
  assert.equal(remapTime(3, { mode: 'cut', start: 2, end: 6, speed: 1 }, 10), null);
  assert.equal(remapTime(8, { mode: 'cut', start: 2, end: 6, speed: 1 }, 10), 4);
  assert.equal(remapTime(1, { mode: 'cut', start: 2, end: 6, speed: 1 }, 10), 1);
});

test('applyEdit combines trim and speed', async () => {
  const sr = 8000;
  const out = await applyEdit([sine(200, 6, sr)], sr, { mode: 'keep', start: 1, end: 5, speed: 2 });
  assert.equal(out[0].length, 2 * sr);
});

test('cancel stops a long speed change', async () => {
  const sr = 16000;
  await assert.rejects(changeSpeed([sine(200, 30, sr)], sr, 1.5, { isCancelled: () => true }), /cancelled/);
});
