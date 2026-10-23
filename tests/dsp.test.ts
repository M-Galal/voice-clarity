import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FFT } from '../src/dsp/fft';
import { kWeightingCoeffs, integratedLoudness, samplePeakDb, speechLoudness, truePeakDb } from '../src/dsp/loudness';
import { dbToPercent, percentToDb, dbToGain } from '../src/dsp/units';
import { detectSpeech, skipSilenceTarget, nextSegmentStart, previousSegmentStart } from '../src/dsp/vad';
import { denoise, detectHum } from '../src/dsp/denoise';
import { limit, detectClipping, attenuateGaps } from '../src/dsp/dynamics';
import { encodeWav16, decodeWav } from '../src/dsp/wav';
import { removeSilence, remapTime, resample } from '../src/dsp/buffers';
import { enhance, settingsForPreset, DEFAULT_SETTINGS } from '../src/dsp/pipeline';

const SR = 48000;
const sine = (f: number, amp: number, sec: number, sr = SR) =>
  Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));

// deterministic noise
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff) * 2 - 1;
}
const noise = (amp: number, n: number, seed = 1) => { const r = rng(seed); return Float32Array.from({ length: n }, () => amp * r()); };

/** Speech-like test signal: 1.2 s "syllable bursts" (harmonic tone, AM) every 2 s, plus noise. */
function speechLike(sr: number, sec: number, speechAmp: number, noiseAmp: number) {
  const n = Math.round(sec * sr);
  const x = noise(noiseAmp, n, 7);
  const clean = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const inBurst = t % 2 >= 0.5 && t % 2 < 1.7;
    if (!inBurst) continue;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * 160 * h * t) / h;
    clean[i] = speechAmp * env * v * 0.4;
    x[i] += clean[i];
  }
  return { x, clean };
}

test('dB ↔ percent mapping is consistent and invertible', () => {
  assert.ok(Math.abs(dbToPercent(20 * Math.log10(2)) - 100) < 1e-9);
  assert.ok(Math.abs(dbToPercent(-20 * Math.log10(2)) + 50) < 1e-9);
  assert.equal(dbToPercent(0), 0);
  for (const db of [-12, -3, 0.5, 6, 12, 20]) assert.ok(Math.abs(percentToDb(dbToPercent(db)) - db) < 1e-9);
  assert.throws(() => percentToDb(-100));
});

test('K-weighting coefficients at 48 kHz match ITU-R BS.1770-4 Table 1 / 2', () => {
  const [s1, s2] = kWeightingCoeffs(48000);
  assert.ok(Math.abs(s1.b0 - 1.53512485958697) < 1e-6, `b0 ${s1.b0}`);
  assert.ok(Math.abs(s1.b1 + 2.69169618940638) < 1e-6, `b1 ${s1.b1}`);
  assert.ok(Math.abs(s1.b2 - 1.19839281085285) < 1e-6, `b2 ${s1.b2}`);
  assert.ok(Math.abs(s1.a1 + 1.69065929318241) < 1e-6, `a1 ${s1.a1}`);
  assert.ok(Math.abs(s1.a2 - 0.73248077421585) < 1e-6, `a2 ${s1.a2}`);
  assert.deepEqual([s2.b0, s2.b1, s2.b2], [1, -2, 1]);
  assert.ok(Math.abs(s2.a1 + 1.99004745483398) < 1e-6, `a1 ${s2.a1}`);
  assert.ok(Math.abs(s2.a2 - 0.99007225036621) < 1e-6, `a2 ${s2.a2}`);
});

test('BS.1770: full-scale 997 Hz sine in one channel reads −3.01 LUFS', () => {
  const l = integratedLoudness(sine(997, 1, 5), SR);
  assert.ok(Math.abs(l - -3.01) < 0.05, `got ${l}`);
});

test('loudness works at 16 kHz and 44.1 kHz too (within 0.1 LU)', () => {
  for (const sr of [16000, 44100]) {
    const l = integratedLoudness(sine(997, 0.1, 5, sr), sr);
    assert.ok(Math.abs(l - -23.01) < 0.1, `${sr}: ${l}`);
  }
});

test('gating ignores silence: tone + long silence ≈ tone alone', () => {
  const tone = sine(997, 0.1, 3);
  const withSilence = new Float32Array(tone.length * 4);
  withSilence.set(tone, 0);
  const a = integratedLoudness(tone, SR);
  const b = integratedLoudness(withSilence, SR);
  // blocks straddling the tone's end pass the relative gate, so a small drop is expected
  assert.ok(Math.abs(a - b) < 0.5, `${a} vs ${b}`);
});

test('speech loudness only uses blocks inside segments', () => {
  const x = new Float32Array(SR * 6);
  x.set(sine(997, 0.1, 2), 0);
  x.set(sine(997, 0.01, 2), SR * 3);
  const all = integratedLoudness(x, SR);
  const first = speechLoudness(x, SR, [{ start: 0, end: 2 }]);
  assert.ok(Math.abs(first - -23.01) < 0.3, `first ${first}`);
  assert.ok(first > all - 0.01);
});

test('true peak ≥ sample peak, and catches inter-sample peaks', () => {
  // fs/4 sine with 45° phase: samples sit at ±0.707 of the true peak
  const n = 4800;
  const x = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((Math.PI / 2) * i + Math.PI / 4));
  const sp = samplePeakDb(x);
  const tp = truePeakDb(x);
  assert.ok(Math.abs(sp - 20 * Math.log10(0.5 * Math.SQRT1_2)) < 0.01);
  assert.ok(tp > sp + 2.5, `tp ${tp} sp ${sp}`); // true peak ≈ −6.02 dBFS
  assert.ok(Math.abs(tp - 20 * Math.log10(0.5)) < 0.5, `tp ${tp}`);
});

test('FFT round trip', () => {
  const f = new FFT(256);
  const re = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i * 0.3) + 0.2);
  const orig = Float32Array.from(re);
  const im = new Float32Array(256);
  f.transform(re, im);
  f.transform(re, im, true);
  for (let i = 0; i < 256; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-5);
});

test('VAD finds the speech bursts and their timing', () => {
  const sr = 16000;
  const { x } = speechLike(sr, 10, 0.3, 0.01);
  const { segments } = detectSpeech(x, sr);
  assert.equal(segments.length, 5, JSON.stringify(segments));
  for (let i = 0; i < 5; i++) {
    assert.ok(Math.abs(segments[i].start - (2 * i + 0.5)) < 0.2, `start ${segments[i].start}`);
    assert.ok(Math.abs(segments[i].end - (2 * i + 1.7)) < 0.2, `end ${segments[i].end}`);
  }
});

test('navigation helpers: next / previous / skip-silence', () => {
  const segs = [{ start: 1, end: 2 }, { start: 5, end: 6 }, { start: 6.5, end: 7 }];
  assert.equal(nextSegmentStart(segs, 1.5), 5);
  assert.equal(nextSegmentStart(segs, 7), null);
  assert.equal(previousSegmentStart(segs, 5.2), 1);
  assert.equal(previousSegmentStart(segs, 6.2), 5);
  assert.equal(skipSilenceTarget(segs, 2.5, 1), 5);
  assert.equal(skipSilenceTarget(segs, 6.1, 1), null); // gap 0.4 s < 1 s
  assert.equal(skipSilenceTarget(segs, 1.5, 1), null); // in speech
});

test('denoise with gain 1 path reconstructs input (no noise → near-identity)', async () => {
  const sr = 16000;
  const x = sine(440, 0.3, 2, sr);
  const y = await denoise(x, sr, [{ start: 0, end: 2 }], { overSubtraction: 0, floorDb: -20, smoothing: 0 });
  let err = 0;
  for (let i = 1000; i < x.length - 1000; i++) err = Math.max(err, Math.abs(x[i] - y[i]));
  assert.ok(err < 1e-3, `max err ${err}`);
});

test('denoise lowers noise in pauses by > 10 dB and keeps speech within 3 dB', async () => {
  const sr = 16000;
  const { x } = speechLike(sr, 12, 0.3, 0.03);
  const { segments } = detectSpeech(x, sr);
  const y = await denoise(x, sr, segments, { overSubtraction: 1.5, floorDb: -20, smoothing: 0.6 });
  const rms = (a: Float32Array, s: number, e: number) => {
    let acc = 0; const i0 = Math.round(s * sr), i1 = Math.round(e * sr);
    for (let i = i0; i < i1; i++) acc += a[i] * a[i];
    return 10 * Math.log10(acc / (i1 - i0));
  };
  const pauseIn = rms(x, 6.0, 6.4), pauseOut = rms(y, 6.0, 6.4);
  const spIn = rms(x, 6.7, 7.5), spOut = rms(y, 6.7, 7.5);
  assert.ok(pauseIn - pauseOut > 10, `pause reduction ${pauseIn - pauseOut}`);
  assert.ok(Math.abs(spIn - spOut) < 3, `speech change ${spIn - spOut}`);
});

test('hum detector finds 50 Hz and 60 Hz, ignores white noise', () => {
  const sr = 16000;
  const n = sr * 4;
  const mk = (f: number) => { const x = noise(0.005, n, 3); for (let i = 0; i < n; i++) for (let h = 1; h <= 3; h++) x[i] += (0.05 / h) * Math.sin((2 * Math.PI * f * h * i) / sr); return x; };
  assert.equal(detectHum(mk(50), sr, []), 50);
  assert.equal(detectHum(mk(60), sr, []), 60);
  assert.equal(detectHum(noise(0.05, n, 9), sr, []), null);
  // pure 50 Hz with no harmonics, under louder noise
  const pure = noise(0.04, n, 4);
  for (let i = 0; i < n; i++) pure[i] += 0.03 * Math.sin((2 * Math.PI * 50 * i) / sr);
  assert.equal(detectHum(pure, sr, []), 50);
});

test('limiter keeps every sample under the ceiling and reports reduction', () => {
  const x = sine(200, 1.5, 1);
  const r = limit(x, SR, -1);
  const ceil = dbToGain(-1);
  for (const v of r.output) assert.ok(Math.abs(v) <= ceil + 1e-6);
  assert.ok(r.maxReductionDb > 4.4 && r.maxReductionDb < 5, `${r.maxReductionDb}`);
  const quiet = limit(sine(200, 0.2, 1), SR, -1);
  assert.equal(Math.abs(quiet.maxReductionDb), 0);
});

test('clipping detector counts flat-topped runs', () => {
  const x = sine(100, 1.4, 0.1).map((v) => Math.max(-1, Math.min(1, v)));
  assert.ok(detectClipping(x, SR).events >= 10);
  assert.equal(detectClipping(sine(100, 0.9, 0.1), SR).events, 0);
});

test('pause attenuation leaves speech alone and lowers gaps', () => {
  const x = new Float32Array(SR * 2).fill(0.5);
  const y = attenuateGaps(x, SR, [{ start: 0.5, end: 1.5 }], 12);
  assert.ok(Math.abs(y[SR] - 0.5) < 1e-6);
  assert.ok(Math.abs(y[100] - 0.5 * dbToGain(-12)) < 1e-6);
});

test('WAV 16-bit encode/decode round trip', () => {
  const x = sine(440, 0.5, 0.2, 22050);
  const bytes = encodeWav16([x], 22050);
  assert.equal(bytes.length, 44 + x.length * 2);
  const d = decodeWav(bytes);
  assert.equal(d.sampleRate, 22050);
  for (let i = 0; i < x.length; i++) assert.ok(Math.abs(d.channels[0][i] - x[i]) < 1 / 16000);
});

test('silence removal shortens pauses and remaps time', () => {
  const sr = 8000;
  const x = new Float32Array(sr * 10).fill(0.1);
  const r = removeSilence(x, sr, [{ start: 1, end: 2 }, { start: 8, end: 9 }], 400);
  assert.ok(Math.abs(r.output.length / sr - 2.8) < 0.01, `${r.output.length / sr}`);
  assert.ok(Math.abs((remapTime(r.map, 8.5) ?? -1) - (1.4 + 0.2 + 0.5)) < 0.01);
  assert.equal(remapTime(r.map, 5), null);
});

test('resample length and tone preservation', () => {
  const y = resample(sine(440, 0.5, 1, 48000), 48000, 16000);
  assert.equal(y.length, 16000);
  const l = integratedLoudness(y, 16000);
  assert.ok(Math.abs(l - integratedLoudness(sine(440, 0.5, 1, 16000), 16000)) < 0.3);
});

test('pipeline: hits LUFS target on speech, respects ceiling, keeps original untouched', async () => {
  const sr = 24000;
  const { x } = speechLike(sr, 20, 0.05, 0.004);
  const copy = Float32Array.from(x);
  const s = { ...DEFAULT_SETTINGS, targetLufs: -16 };
  const r = await enhance([x], sr, s);
  assert.deepEqual(x, copy, 'original buffer modified');
  assert.ok(Math.abs(r.report.output.speechLufs - -16) < 1.0, `speech LUFS ${r.report.output.speechLufs}`);
  assert.ok(r.report.output.samplePeakDb <= -1 + 1e-4, `peak ${r.report.output.samplePeakDb}`);
  assert.ok(r.report.output.truePeakDb <= -1 + 0.1, `true peak ${r.report.output.truePeakDb}`);
  assert.ok(r.report.appliedGainDb > 5);
  assert.ok(r.report.segments.length >= 9);
});

test('pipeline: manual gain, cancel, and warnings', async () => {
  const sr = 16000;
  const { x } = speechLike(sr, 8, 0.05, 0.012); // noisy (~8 dB in the voice band)
  const r = await enhance([x], sr, { ...settingsForPreset('strong'), gainMode: 'manual', manualGainDb: 6 });
  assert.equal(r.report.appliedGainDb, 6);
  assert.ok(r.report.warnings.includes('low_snr') || r.report.warnings.includes('very_low_snr'), r.report.warnings.join());
  await assert.rejects(enhance([x], sr, DEFAULT_SETTINGS, { isCancelled: () => true }), /cancelled/);
});

test('presets differ and advanced keeps user values', () => {
  const light = settingsForPreset('light');
  const strong = settingsForPreset('strong');
  assert.ok(strong.noiseFloorDb < light.noiseFloorDb);
  const adv = settingsForPreset('advanced', { ...strong, noiseFloorDb: -33 });
  assert.equal(adv.noiseFloorDb, -33);
});
