import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeWav } from '../src/dsp/wav';
import { detectSpeech } from '../src/dsp/vad';
import { levelSpeech } from '../src/dsp/dynamics';
import { chooseSettings } from '../src/dsp/autoTune';
import { enhance, DEFAULT_SETTINGS, settingsForPreset } from '../src/dsp/pipeline';

const fixture = decodeWav(new Uint8Array(readFileSync(new URL('./fixtures/whisper_mix_16k.wav', import.meta.url))));
const X = fixture.channels[0];
const SR = fixture.sampleRate;
// ground truth (see tests/fixtures/README.md)
const NORMAL = [[1.56, 4.3], [15.51, 17.13]]; // spoken part of each normal clip
const WHISPER = [[6.22, 9.56], [11.53, 13.53]]; // spoken part of each whispered clip

const overlap = (a: number[], segs: { start: number; end: number }[]) =>
  segs.reduce((t, s) => t + Math.max(0, Math.min(a[1], s.end) - Math.max(a[0], s.start)), 0) / (a[1] - a[0]);

const rmsDb = (x: Float32Array, a: number, b: number) => {
  let s = 0; const i0 = Math.round(a * SR), i1 = Math.round(b * SR);
  for (let i = i0; i < i1; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / (i1 - i0) + 1e-12);
};

test('whispered speech 20 dB below normal speech is detected and labelled', () => {
  const { segments } = detectSpeech(X, SR);
  for (const w of WHISPER) assert.ok(overlap(w, segments) > 0.85, `whisper ${w} covered ${overlap(w, segments).toFixed(2)}`);
  for (const n of NORMAL) assert.ok(overlap(n, segments) > 0.85, `normal ${n}`);
  assert.equal(segments.filter((s) => s.kind === 'whisper').length, 2);
  // without the whisper band the whispers are missed: shows what the second band adds
  const off = detectSpeech(X, SR, { whisper: false }).segments;
  for (const w of WHISPER) assert.ok(overlap(w, off) < 0.2);
});

test('steady background noise alone is not detected as speech', () => {
  const noise = X.slice(0, Math.round(1.3 * SR)); // the leading 1.3 s has no speech
  const tiled = new Float32Array(noise.length * 8);
  for (let k = 0; k < 8; k++) tiled.set(noise, k * noise.length);
  assert.equal(detectSpeech(tiled, SR).segments.length, 0);
});

test('leveller raises quiet speech to the louder speech, never cuts, caps the boost', () => {
  const sr = 8000;
  const x = new Float32Array(sr * 6);
  for (let i = 0; i < sr * 2; i++) x[i] = 0.5 * Math.sin(i * 0.3); // loud 0-2 s
  for (let i = sr * 3; i < sr * 5; i++) x[i] = 0.05 * Math.sin(i * 0.3); // 20 dB quieter 3-5 s
  const segs = [{ start: 0, end: 2 }, { start: 3, end: 5 }];
  const r = levelSpeech(x, sr, segs, { maxBoostDb: 30 });
  const lvl = (y: Float32Array, a: number, b: number) => { let s = 0; for (let i = a * sr; i < b * sr; i++) s += y[i] * y[i]; return 10 * Math.log10(s / ((b - a) * sr)); };
  assert.ok(Math.abs(lvl(r.output, 3.3, 4.7) - lvl(r.output, 0.3, 1.7)) < 1, 'quiet part raised to loud level');
  assert.ok(Math.abs(lvl(r.output, 0.3, 1.7) - lvl(x, 0.3, 1.7)) < 0.1, 'loud part unchanged');
  assert.ok(Math.abs(r.spreadDb - 20) < 0.5);
  const capped = levelSpeech(x, sr, segs, { maxBoostDb: 6 });
  assert.ok(Math.abs(lvl(capped.output, 3.3, 4.7) - lvl(x, 3.3, 4.7) - 6) < 0.3, 'boost capped at 6 dB');
});

test('Smart settings follow the measurements', () => {
  const clean = chooseSettings(DEFAULT_SETTINGS, { snrDb: 35, whisperShare: 0, spreadDb: 2, rumbleDb: -20 });
  assert.equal(clean.settings.noiseAmount, 1.0);
  assert.equal(clean.settings.levelSpeech, false);
  const noisyWhisper = chooseSettings(DEFAULT_SETTINGS, { snrDb: 5, whisperShare: 0.4, spreadDb: 18, rumbleDb: 8 });
  assert.ok(noisyWhisper.settings.noiseAmount <= 1.4, 'gentle on whispers');
  assert.ok(noisyWhisper.settings.noiseFloorDb >= -16);
  assert.equal(noisyWhisper.settings.levelSpeech, true);
  assert.equal(noisyWhisper.settings.levelMaxBoostDb, 24);
  assert.equal(noisyWhisper.settings.highPassHz, 120);
  assert.ok(noisyWhisper.reasons.some((r) => r.key === 'auto_whisper_protect'));
  // loudness target and limiter stay the user's
  const custom = chooseSettings({ ...DEFAULT_SETTINGS, targetLufs: -20, limiterCeilingDb: -2 }, { snrDb: 20, whisperShare: 0, spreadDb: 3, rumbleDb: -10 });
  assert.equal(custom.settings.targetLufs, -20);
  assert.equal(custom.settings.limiterCeilingDb, -2);
});

test('Smart enhancement makes the whispers about as loud as normal speech', async () => {
  const r = await enhance([X], SR, settingsForPreset('auto'));
  const y = r.output;
  const voice = (rmsDb(y, 1.6, 4.3) + rmsDb(y, 15.6, 17.2)) / 2;
  const whisper = (rmsDb(y, 6.3, 9.4) + rmsDb(y, 11.6, 13.4)) / 2;
  const pause = rmsDb(y, 4.8, 5.9);
  const before = { voice: (rmsDb(X, 1.6, 4.3) + rmsDb(X, 15.6, 17.2)) / 2, whisper: (rmsDb(X, 6.3, 9.4) + rmsDb(X, 11.6, 13.4)) / 2 };
  assert.ok(before.voice - before.whisper > 10, 'fixture: whispers start much quieter');
  assert.ok(Math.abs(voice - whisper) < 4, `after: voice ${voice.toFixed(1)} whisper ${whisper.toFixed(1)}`);
  assert.ok(whisper - pause > 20, `whisper ${whisper.toFixed(1)} vs pause ${pause.toFixed(1)}`);
  assert.equal(r.report.whisperSections, 2);
  assert.equal(r.report.humHz, null, 'no false hum detection');
  assert.ok(r.report.autoReasons && r.report.autoReasons.length > 0);
});
