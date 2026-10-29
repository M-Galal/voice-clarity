import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeWav } from '../src/dsp/wav';
import { resample } from '../src/dsp/buffers';
import { settingsForPreset } from '../src/dsp/pipeline';
import { chooseSettings } from '../src/dsp/autoTune';
import { analyseForSmart, MemorySource } from '../src/dsp/stream';
import { LiveChain, liveNoiseProfile, type LiveContext } from '../src/dsp/live';

const fx = decodeWav(new Uint8Array(readFileSync(new URL('./fixtures/whisper_mix_16k.wav', import.meta.url))));
const X = resample(fx.channels[0], 16000, 24000);
const SR = 24000;

async function setup(steadyNoise = true) {
  const src = new MemorySource(X, SR);
  const a = await analyseForSmart(src, settingsForPreset('auto'));
  const settings = chooseSettings({ ...settingsForPreset('auto'), steadyNoise }, a.measures).settings;
  const ctx: LiveContext = { segments: a.segments, humHz: a.humHz, sections: a.sections, speechRefDb: a.measures.speechRefDb, inputSpeechLufs: a.input.speechLufs };
  return { src, settings, ctx };
}

async function runLive(startSec: number, block: number, steadyNoise = true) {
  const { src, settings, ctx } = await setup(steadyNoise);
  const s0 = Math.round(startSec * SR);
  const noise = await liveNoiseProfile(src, s0, settings, ctx);
  const chain = new LiveChain(SR, settings, ctx, s0, noise);
  const enh: Float32Array[] = [], orig: Float32Array[] = [];
  let expect = s0;
  for (let p = s0; p < X.length; p += block) {
    const r = chain.push(X.slice(p, Math.min(X.length, p + block)));
    assert.equal(r.start, expect, 'outputs are consecutive');
    expect += r.enhanced.length;
    enh.push(r.enhanced); orig.push(r.original);
  }
  const f = chain.finish();
  enh.push(f.enhanced); orig.push(f.original);
  const cat = (xs: Float32Array[]) => { const o = new Float32Array(xs.reduce((t, x) => t + x.length, 0)); let i = 0; for (const x of xs) { o.set(x, i); i += x.length; } return o; };
  return { enh: cat(enh), orig: cat(orig), s0, chain, settings };
}

test('live chain: every sample comes out, lined up with the original', async () => {
  const { enh, orig, s0 } = await runLive(3, 6000);
  assert.equal(enh.length, X.length - s0);
  assert.equal(orig.length, enh.length);
  for (let i = 0; i < orig.length; i += 997) assert.equal(orig[i], X[s0 + i]);
});

test('live chain: the result does not depend on the block size', async () => {
  const a = await runLive(2, 6000);
  const b = await runLive(2, 2048);
  let d = 0;
  for (let i = 0; i < a.enh.length; i++) d = Math.max(d, Math.abs(a.enh[i] - b.enh[i]));
  assert.ok(d < 1e-5, `max difference ${d}`);
});

test('live chain: below the peak ceiling, louder whispers, quieter pauses', async () => {
  // without the steady-noise limit: these whispers are only ~1 dB above the background
  const { enh, orig, s0, settings } = await runLive(0, 4096, false);
  let peak = 0;
  for (const v of enh) peak = Math.max(peak, Math.abs(v));
  assert.ok(20 * Math.log10(peak) <= settings.limiterCeilingDb + 0.01, `peak ${20 * Math.log10(peak)}`);
  const { ctx } = await setup();
  const rms = (x: Float32Array, a: number, b: number) => { let e = 0; for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) e += x[i] * x[i]; return 10 * Math.log10(e / ((b - a) * SR) + 1e-12); };
  const wh = ctx.segments.filter((s) => s.kind === 'whisper' && s.start > 1);
  assert.ok(wh.length > 0);
  for (const w of wh) assert.ok(rms(enh, w.start - s0 / SR, w.end - s0 / SR) > rms(orig, w.start, w.end) + 10, 'whispers raised');
});
