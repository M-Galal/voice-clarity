import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamStretcher } from '../src/dsp/stretch';

const sr = 24000;
const tone = (f: number, sec: number) => Float32Array.from({ length: Math.round(sr * sec) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / sr));

function run(x: Float32Array, speed: number, block: number) {
  const st = new StreamStretcher(sr, speed);
  const a: Float32Array[] = [], b: Float32Array[] = [];
  for (let p = 0; p < x.length; p += block) {
    const part = x.subarray(p, p + block);
    const r = st.push(part, part.map((v) => v * 0.5));
    a.push(r.a); b.push(r.b);
  }
  const f = st.flush(); a.push(f.a); b.push(f.b);
  const cat = (xs: Float32Array[]) => { const o = new Float32Array(xs.reduce((t, v) => t + v.length, 0)); let i = 0; for (const v of xs) { o.set(v, i); i += v.length; } return o; };
  return { a: cat(a), b: cat(b) };
}

/** Frequency from zero crossings in the middle of the signal. */
function freq(x: Float32Array) {
  let z = 0;
  const a = Math.round(x.length * 0.2), b = Math.round(x.length * 0.8);
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) z++;
  return z / ((b - a) / sr);
}

for (const speed of [0.25, 0.5, 1.5, 2, 3, 5]) {
  test(`${speed}x: length scales, pitch stays, both signals stay aligned`, () => {
    const x = tone(220, 4);
    const { a, b } = run(x, speed, 4800);
    const want = x.length / speed;
    assert.ok(Math.abs(a.length - want) < sr * 0.05, `length ${a.length} vs ${want}`);
    assert.ok(Math.abs(freq(a) - 220) < 4, `pitch ${freq(a).toFixed(1)} Hz`);
    for (let i = 0; i < a.length; i += 101) assert.ok(Math.abs(b[i] - 0.5 * a[i]) < 1e-6);
  });
}

test('block size does not change the result', () => {
  const x = tone(180, 3);
  const p = run(x, 1.75, 4800), q = run(x, 1.75, 1000);
  assert.equal(p.a.length, q.a.length);
  let d = 0;
  for (let i = 0; i < p.a.length; i++) d = Math.max(d, Math.abs(p.a[i] - q.a[i]));
  assert.ok(d < 1e-5, `max difference ${d}`);
});
