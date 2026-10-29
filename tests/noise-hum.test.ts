/**
 * Noise and hum under raised speech. Synthetic voiced speech (close, and distant 20 dB lower) with
 * pink noise and a buzzy 50 Hz hum (harmonics to 1 kHz). The leveller raises the distant speech by
 * about 20 dB; the hum and noise under it must not come up with it. Before the October 2026 fix,
 * Smart mode left the hum under raised speech 18 dB louder than in the original.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsForPreset } from '../src/dsp/pipeline';
import { enhanceStream, MemorySink, MemorySource, memoryTemp } from '../src/dsp/stream';
import { designBiquad, applyChain } from '../src/dsp/biquad';
import { humHarmonics } from '../src/dsp/denoise';

const sr = 24000, dur = 24;
let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const clean = new Float32Array(sr * dur);
const segs: { start: number; end: number; quiet: boolean }[] = [];
for (let s = 0.5, k = 0; s + 1.6 < dur; s += 2.2, k++) {
  const quiet = k % 3 === 2 || k % 3 === 1 && k > 8; // mix of close and distant (20 dB lower)
  segs.push({ start: s, end: s + 1.6, quiet });
  const level = quiet ? 0.012 : 0.12;
  let phi = 0; // accumulated phase of the fundamental (so each harmonic stays at h·f0)
  for (let i = Math.round(s * sr); i < Math.round((s + 1.6) * sr); i++) {
    const t = i / sr - s; const f0 = 118 + 35 * Math.sin(2 * Math.PI * 1.1 * t + k);
    phi += 2 * Math.PI * f0 / sr;
    let v = 0;
    for (let h = 1; h <= 24; h++) { const f = f0 * h; if (f > 3500) break; const fw = Math.exp(-((f - 650) ** 2) / 2e5) + 0.6 * Math.exp(-((f - 1700) ** 2) / 4e5) + 0.35 * Math.exp(-((f - 2600) ** 2) / 5e5); v += fw * Math.sin(h * phi + h); }
    clean[i] = level * Math.min(1, t / 0.03, (1.6 - t) / 0.03) * (t < 1.6 ? 1 : 0) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t) ** 2) * v / 3;
  }
}
// pink noise and buzzy hum (50 Hz, harmonics with 1/h amplitude to 1 kHz)
const noise = new Float32Array(clean.length);
{ let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0; for (let i = 0; i < noise.length; i++) { const w = rnd(); b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898; noise[i] = 0.004 * (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11 * 9; b6 = w * 0.115926; } }
const hum = new Float32Array(clean.length);
for (let i = 0; i < hum.length; i++) { let v = 0; for (let h = 1; h <= 20; h++) v += Math.sin(2 * Math.PI * 50 * h * i / sr + h * 0.7) / h; hum[i] = 0.0025 * v; }
const mix = clean.map((v, i) => v + noise[i] + hum[i]);
const hp = [designBiquad('highpass', sr, 4500, 0.707), designBiquad('highpass', sr, 4500, 0.707), designBiquad('lowpass', sr, 9000, 0.707)];
const db = (e: number) => 10 * Math.log10(e + 1e-20);
function regions(kind: 'pause' | 'quiet' | 'loud') {
  const r: [number, number][] = [];
  if (kind === 'pause') { for (let k = 0; k + 1 < segs.length; k++) r.push([segs[k].end + 0.2, segs[k + 1].start - 0.2]); }
  else for (const s of segs) if (s.quiet === (kind === 'quiet')) r.push([s.start + 0.3, s.end - 0.3]);
  return r;
}
function bandLevel(x: Float32Array, kind: 'pause' | 'quiet' | 'loud') { const y = applyChain(x, hp); let e = 0, n = 0; for (const [a, b] of regions(kind)) for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) { e += y[i] ** 2; n++; } return db(e / n); }
function humLevel(x: Float32Array, kind: 'pause' | 'quiet' | 'loud', from = 2, to = 20) { // Goertzel at 50·h, summed power, per region
  let tot = 0, nr = 0;
  for (const [a, b] of regions(kind)) {
    const i0 = Math.round(a * sr), i1 = Math.round(b * sr), N = i1 - i0; let p = 0;
    for (let h = from; h <= to; h++) { const w = 2 * Math.PI * 50 * h / sr, c = 2 * Math.cos(w); let s1 = 0, s2 = 0; for (let i = i0; i < i1; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; } p += (s1 * s1 + s2 * s2 - c * s1 * s2) / (N * N / 4); }
    tot += p; nr++;
  }
  return db(tot / nr / 2);
}
function speechLevel(x: Float32Array, kind: 'quiet' | 'loud') { let e = 0, n = 0; for (const [a, b] of regions(kind)) for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) { e += x[i] ** 2; n++; } return db(e / n); }

async function run(preset: 'auto' | 'whisper' | 'balanced') {
  const sink = new MemorySink();
  await enhanceStream(new MemorySource(mix, sr), sink, settingsForPreset(preset), memoryTemp);
  const out = sink.toArray();
  return {
    quietSpeech: speechLevel(out, 'quiet') - speechLevel(mix, 'quiet'),
    noiseQuiet: bandLevel(out, 'quiet') - bandLevel(mix, 'quiet'),
    humQuiet: humLevel(out, 'quiet') - humLevel(mix, 'quiet'),
    humPause: humLevel(out, 'pause') - humLevel(mix, 'pause'),
  };
}

test('hum harmonics above the fourth are found in the pauses', () => {
  const h = humHarmonics(mix, sr, segs, 50);
  for (const k of [1, 2, 3, 4, 5, 8, 12, 20]) assert.ok(h.includes(k), `harmonic ${k} in ${h.join(',')}`);
});

for (const preset of ['auto', 'whisper', 'balanced'] as const) {
  test(`${preset}: hum and noise do not come up with raised quiet speech`, async () => {
    const r = await run(preset);
    assert.ok(r.quietSpeech > 8, `quiet speech raised (${r.quietSpeech.toFixed(1)} dB)`);
    assert.ok(r.humQuiet < 3, `hum under raised speech ${r.humQuiet.toFixed(1)} dB vs original`);
    assert.ok(r.humPause < -20, `hum in pauses ${r.humPause.toFixed(1)} dB`);
    assert.ok(r.noiseQuiet < r.quietSpeech - 6, `noise ${r.noiseQuiet.toFixed(1)} dB vs speech ${r.quietSpeech.toFixed(1)} dB`);
  });
}
