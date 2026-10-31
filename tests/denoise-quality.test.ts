/**
 * Noise reduction quality: the decision-directed Wiener rule (used by the app) against power
 * spectral subtraction, on synthetic voiced speech in pink noise where the clean signal is known.
 * Measures: segmental SNR of the speech (fidelity), residual level in the pauses, and the mean
 * frame-to-frame spectral change of that residual (higher = more "musical noise").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DD_SMOOTHING, denoise } from '../src/dsp/denoise';
import { RealFFT } from '../src/dsp/fft';

const sr = 16000, dur = 30;
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
// clean: voiced "syllables" (harmonics with moving pitch, formant-like weighting), 1.2 s on, 0.8 s off
const clean = new Float32Array(sr * dur);
const segs: { start: number; end: number }[] = [];
for (let s = 0.5; s + 1.2 < dur; s += 2) {
  segs.push({ start: s, end: s + 1.2 });
  const level = 0.1 * (s % 6 < 2 ? 1 : 0.3); // some quiet speech too
  for (let i = Math.round(s * sr); i < Math.round((s + 1.2) * sr); i++) {
    const t = i / sr - s; const f0 = 120 + 40 * Math.sin(2 * Math.PI * 1.3 * t);
    let v = 0;
    for (let h = 1; h <= 25; h++) { const f = f0 * h; const fw = Math.exp(-((f - 700) ** 2) / 2e5) + 0.6 * Math.exp(-((f - 1800) ** 2) / 4e5) + 0.3 * Math.exp(-((f - 2800) ** 2) / 6e5); v += fw * Math.sin(2 * Math.PI * f0 * h * t + h); }
    const env = Math.sin(Math.PI * t / 1.2) ** 0.5 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t) ** 2);
    clean[i] = level * env * v / 3;
  }
}
// pink noise (Paul Kellet filter)
function pink(n: number, amp: number) { const o = new Float32Array(n); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0; for (let i = 0; i < n; i++) { const w = rnd(); b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898; o[i] = amp * (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926; } return o; }
const segSnr = (ref: Float32Array, x: Float32Array) => { // segmental SNR over speech, 20 ms frames, clamped −10..35
  const F = 320; let s = 0, n = 0;
  for (const g of segs) for (let a = Math.round(g.start * sr); a + F <= Math.round(g.end * sr); a += F) {
    let e = 0, d = 0; for (let i = a; i < a + F; i++) { e += ref[i] ** 2; d += (ref[i] - x[i]) ** 2; }
    s += Math.max(-10, Math.min(35, 10 * Math.log10(e / (d + 1e-12) + 1e-12))); n++;
  }
  return s / n;
};
// residual noise in pauses: level, and "musicality" = mean frame-to-frame spectral flux of the residual (dB)
function pauseStats(x: Float32Array) {
  const n = 512, fft = new RealFFT(n), re = new Float32Array(n / 2 + 1), im = new Float32Array(n / 2 + 1), buf = new Float32Array(n);
  let prev: Float32Array | null; let flux = 0, fc = 0, e = 0, ec = 0;
  for (let k = 0; k < segs.length - 1; k++) {
    const a = Math.round((segs[k].end + 0.15) * sr), b = Math.round((segs[k + 1].start - 0.15) * sr);
    prev = null;
    for (let p = a; p + n <= b; p += n / 2) {
      for (let i = 0; i < n; i++) { buf[i] = x[p + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n)); e += x[p + i] ** 2; ec++; }
      fft.forward(buf, re, im);
      const db = new Float32Array(n / 2 + 1); for (let i = 8; i < n / 2; i++) db[i] = 10 * Math.log10(re[i] ** 2 + im[i] ** 2 + 1e-14);
      if (prev) { let s = 0; for (let i = 8; i < n / 2; i++) s += Math.abs(db[i] - prev[i]); flux += s / (n / 2 - 8); fc++; }
      prev = db;
    }
  }
  return { levelDb: 10 * Math.log10(e / ec), fluxDb: flux / fc };
}

test('decision-directed noise reduction: cleaner pauses, less musical noise, speech kept', async () => {
  for (const snrIn of [15, 5]) {
    let es = 0, cnt = 0;
    for (const g of segs.slice(0, 1)) for (let i = Math.round(g.start * sr); i < Math.round(g.end * sr); i++) { es += clean[i] ** 2; cnt++; }
    const nz = pink(clean.length, 1); let en = 0; for (const v of nz) en += v * v; en /= nz.length;
    const k = Math.sqrt((es / cnt) / en / 10 ** (snrIn / 10));
    const noisy = clean.map((v, i) => v + k * nz[i]);
    for (const [amount, floor] of [[1.0, -10], [1.2, -14], [1.6, -20], [2.0, -22], [2.2, -26]] as const) {
      const sub = await denoise(noisy, sr, segs, { overSubtraction: amount, floorDb: floor, smoothing: 0.6, rule: 'subtract' });
      const dd = await denoise(noisy, sr, segs, { overSubtraction: amount, floorDb: floor, smoothing: DD_SMOOTHING, rule: 'wiener-dd' });
      const a = pauseStats(sub), b = pauseStats(dd);
      const label = `SNR ${snrIn} dB, ${amount}x/${floor} dB`;
      assert.ok(b.levelDb < a.levelDb - 2.5, `${label}: pauses ${b.levelDb.toFixed(1)} vs ${a.levelDb.toFixed(1)} dB`);
      assert.ok(b.fluxDb < a.fluxDb - 0.1, `${label}: residual fluctuation ${b.fluxDb.toFixed(2)} vs ${a.fluxDb.toFixed(2)} dB`);
      assert.ok(segSnr(clean, dd) > segSnr(clean, sub) - 0.2, `${label}: speech ${segSnr(clean, dd).toFixed(2)} vs ${segSnr(clean, sub).toFixed(2)} dB`);
    }
  }
});

// Phase inversion (Hagerman & Olofsson): processing speech+noise and speech-noise, (a-b)/2 is the
// noise as processed and (a+b)/2 the speech, for the noise left under speech and in pauses.
test('two-step gain: less hiss left under speech, speech kept, pauses as clean (24 kHz, white hiss)', async () => {
  const sr2 = 24000;
  const up = new Float32Array(clean.length * 1.5);
  for (let i = 0; i < up.length; i++) { const p = i / 1.5, a = Math.floor(p), f = p - a; up[i] = (clean[a] ?? 0) * (1 - f) + (clean[a + 1] ?? 0) * f; }
  const hiss = new Float32Array(up.length);
  for (let i = 0; i < hiss.length; i++) hiss[i] = rnd() * 0.004;
  const run = (x: Float32Array, twoStep: boolean) => denoise(x, sr2, segs, { overSubtraction: 1.5, floorDb: -18, smoothing: DD_SMOOTHING, rule: 'wiener-dd', twoStep });
  const measure = async (twoStep: boolean) => {
    const a = await run(up.map((v, i) => v + hiss[i]), twoStep), b = await run(up.map((v, i) => v - hiss[i]), twoStep);
    let es = 0, en = 0, ep = 0, np = 0;
    for (const g of segs) for (let i = Math.round(g.start * sr2); i < Math.round(g.end * sr2); i++) { es += ((a[i] + b[i]) / 2) ** 2; en += ((a[i] - b[i]) / 2) ** 2; }
    for (let k = 0; k < segs.length - 1; k++) for (let i = Math.round((segs[k].end + 0.15) * sr2); i < Math.round((segs[k + 1].start - 0.15) * sr2); i++) { ep += ((a[i] - b[i]) / 2) ** 2; np++; }
    return { snr: 10 * Math.log10(es / en), pause: 10 * Math.log10(ep / np) };
  };
  const one = await measure(false), two = await measure(true);
  assert.ok(two.snr > one.snr + 0.2, `speech-to-hiss during speech ${two.snr.toFixed(2)} vs ${one.snr.toFixed(2)} dB`);
  assert.ok(two.pause < one.pause + 0.5, `pauses ${two.pause.toFixed(1)} vs ${one.pause.toFixed(1)} dB`);
});
