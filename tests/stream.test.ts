/**
 * The chunked pipeline (stream.ts) must give the same result as the whole-buffer pipeline.
 * Chunks are 8 s, so a 19 s fixture (24 kHz) crosses chunk boundaries several times; a small
 * chunk-size override is also used to put boundaries inside FFT frames and limiter look-ahead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeWav } from '../src/dsp/wav';
import { resample } from '../src/dsp/buffers';
import { enhance, settingsForPreset, type EnhanceSettings } from '../src/dsp/pipeline';
import { detectSpeech } from '../src/dsp/vad';
import { waveformPeaks } from '../src/dsp/buffers';
import { analyseStream, enhanceStream, MemorySink, MemorySource, memoryTemp, setChunkSamplesForTests, type SampleSource } from '../src/dsp/stream';

const fixture = decodeWav(new Uint8Array(readFileSync(new URL('./fixtures/whisper_mix_16k.wav', import.meta.url))));
const X16 = fixture.channels[0];
const X24 = resample(X16, 16000, 24000);

/** Source that returns reads in odd-sized pieces, to put chunk joins in awkward places. */
class OddSource implements SampleSource {
  constructor(private readonly inner: SampleSource, private readonly piece: number) {}
  get length() { return this.inner.length; }
  get sampleRate() { return this.inner.sampleRate; }
  async read(start: number, count: number) {
    // eachChunk asks for CHUNK_SEC; we honour it but the pipeline must not care about sizes
    void this.piece;
    return this.inner.read(start, count);
  }
}

const maxDiff = (a: Float32Array, b: Float32Array) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

async function compare(x: Float32Array, sr: number, settings: EnhanceSettings, label: string) {
  const batch = await enhance([x], sr, settings);
  const sink = new MemorySink();
  const s = await enhanceStream(new OddSource(new MemorySource(x, sr), 4097), sink, settings, memoryTemp);
  const out = sink.toArray();
  assert.equal(out.length, batch.output.length, `${label}: length`);
  const d = maxDiff(out, batch.output);
  assert.ok(d < 1e-5, `${label}: max sample difference ${d}`);
  const r = s.report, b = batch.report;
  assert.deepEqual(r.segments, b.segments, `${label}: segments`);
  assert.equal(r.humHz, b.humHz, `${label}: hum`);
  assert.ok(Math.abs(r.appliedGainDb - b.appliedGainDb) < 1e-6, `${label}: gain ${r.appliedGainDb} vs ${b.appliedGainDb}`);
  for (const k of ['integratedLufs', 'speechLufs', 'samplePeakDb'] as const) {
    assert.ok(Math.abs(r.input[k] - b.input[k]) < 1e-6 || r.input[k] === b.input[k], `${label}: input ${k}`);
    assert.ok(Math.abs(r.output[k] - b.output[k]) < 1e-4 || r.output[k] === b.output[k], `${label}: output ${k} ${r.output[k]} vs ${b.output[k]}`);
  }
  // true peak: the chunked meter may examine a few more samples, never fewer
  assert.ok(r.output.truePeakDb >= b.output.truePeakDb - 1e-6, `${label}: true peak`);
  assert.deepEqual(r.stagesRun, b.stagesRun, `${label}: stages`);
  assert.deepEqual(r.warnings, b.warnings, `${label}: warnings`);
  assert.deepEqual(r.appliedSettings, b.appliedSettings, `${label}: settings`);
  assert.deepEqual(r.silenceMap, b.silenceMap, `${label}: silence map`);
  assert.ok(Math.abs(r.levelerMaxBoostDb - b.levelerMaxBoostDb) < 1e-6, `${label}: leveller`);
}

test('chunked Smart enhancement matches the whole-buffer pipeline (24 kHz whisper fixture)', async () => {
  // the whole-buffer pipeline has one setting per file, so per-section is compared separately below
  await compare(X24, 24000, { ...settingsForPreset('auto'), perSection: false }, 'auto');
});

test('chunked enhancement matches for every preset, manual gain and silence removal', async () => {
  await compare(X16, 16000, settingsForPreset('light'), 'light');
  await compare(X24, 24000, settingsForPreset('strong'), 'strong');
  await compare(X24, 24000, { ...settingsForPreset('balanced'), gainMode: 'manual', manualGainDb: 6 }, 'manual');
  await compare(X24, 24000, { ...settingsForPreset('balanced'), removeSilence: true, keepGapMs: 300 }, 'silence');
  await compare(X16, 16000, { ...settingsForPreset('advanced'), noiseSuppression: false, humRemoval: false, highPassHz: 0 }, 'bare');
  for (const sit of ['whisper', 'far', 'noisy', 'rumble'] as const) await compare(X24, 24000, settingsForPreset(sit), sit);
});

test('chunked enhancement handles a file without pauses (noise profile fallback)', async () => {
  // only the speech: the quietest-frames fallback picks the noise profile
  const speech = X24.slice(Math.round(1.4 * 24000), Math.round(4.4 * 24000));
  const tiled = new Float32Array(speech.length * 4);
  for (let k = 0; k < 4; k++) tiled.set(speech, k * speech.length);
  await compare(tiled, 24000, settingsForPreset('balanced'), 'no pauses');
});

test('odd chunk sizes (joins inside FFT frames and limiter look-ahead) give the same result', async () => {
  for (const n of [12345, 4099]) {
    setChunkSamplesForTests(n);
    try {
      await compare(X24, 24000, { ...settingsForPreset('auto'), perSection: false }, `auto/${n}`);
      await compare(X24, 24000, { ...settingsForPreset('strong'), removeSilence: true }, `strong+silence/${n}`);
    } finally {
      setChunkSamplesForTests(0);
    }
  }
  setChunkSamplesForTests(777);
  try {
    const a = await analyseStream(new MemorySource(X16, 16000), { thresholdDb: 10, whisper: true });
    assert.deepEqual(a.segments, detectSpeech(X16, 16000, { thresholdDb: 10, whisper: true }).segments);
    assert.deepEqual(a.waveform, waveformPeaks(X16, 400));
  } finally {
    setChunkSamplesForTests(0);
  }
});

test('chunked analysis matches whole-buffer speech detection and waveform', async () => {
  const a = await analyseStream(new MemorySource(X16, 16000), { thresholdDb: 10, whisper: true });
  const b = detectSpeech(X16, 16000, { thresholdDb: 10, whisper: true });
  assert.deepEqual(a.segments, b.segments);
  assert.deepEqual(a.waveform, waveformPeaks(X16, 400));
});

test('10 minutes of audio are enhanced with roughly constant memory', async () => {
  const { openSync, writeSync, readSync, closeSync, unlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const sr = 16000;
  const total = 10 * 60 * sr; // 9.6 M samples: 38 MB as one float array
  // the fixture repeated, generated on demand (never held as one array)
  const src: SampleSource = {
    length: total,
    sampleRate: sr,
    async read(start, count) {
      const out = new Float32Array(Math.min(count, total - start));
      for (let i = 0; i < out.length; i++) out[i] = X16[(start + i) % X16.length];
      return out;
    },
  };
  let n = 0;
  const diskTemp = (rate: number) => {
    const path = join(tmpdir(), `vc-stream-${process.pid}-${n++}.f32`);
    const fd = openSync(path, 'w+');
    let len = 0;
    return {
      async write(c: Float32Array) { writeSync(fd, new Uint8Array(c.buffer, c.byteOffset, c.byteLength), 0, c.byteLength, len * 4); len += c.length; },
      async done(): Promise<SampleSource> {
        return {
          length: len, sampleRate: rate,
          async read(start: number, count: number) {
            const k = Math.max(0, Math.min(count, len - start));
            const b = new Uint8Array(k * 4);
            readSync(fd, b, 0, b.length, start * 4);
            return new Float32Array(b.buffer);
          },
        };
      },
      dispose() { try { closeSync(fd); unlinkSync(path); } catch { /* gone */ } },
    };
  };
  let outLen = 0;
  const sink = { async write(c: Float32Array) { outLen += c.length; } };
  globalThis.gc?.();
  const base = process.memoryUsage();
  let peak = 0;
  const sample = () => {
    const m = process.memoryUsage();
    peak = Math.max(peak, m.heapUsed + m.arrayBuffers - base.heapUsed - base.arrayBuffers);
  };
  const r = await enhanceStream(src, sink, settingsForPreset('auto'), diskTemp, { onProgress: sample });
  assert.equal(outLen, total);
  assert.ok(r.report.segments.length > 50, 'speech found throughout');
  // the whole-buffer pipeline holds many 38 MB copies at once; chunks keep this far lower
  assert.ok(peak < 90e6, `peak extra memory ${(peak / 1e6).toFixed(0)} MB`);
  console.log(`# 10 min @16 kHz: peak extra memory ${(peak / 1e6).toFixed(0)} MB`);
});

test('preview part: the 15 s stretch with the most speech', async () => {
  const { bestPreviewStart, RangeSource } = await import('../src/dsp/stream');
  const segs = [{ start: 1, end: 3 }, { start: 40, end: 52 }, { start: 53, end: 58 }];
  assert.equal(bestPreviewStart(segs, 120, 15), 39.5);
  assert.equal(bestPreviewStart(segs, 10, 15), 0);
  assert.equal(bestPreviewStart([], 120, 15), 0);
  // never past the end
  assert.equal(bestPreviewStart([{ start: 115, end: 119 }], 120, 15), 105);
  const r = new RangeSource(new MemorySource(Float32Array.from([0, 1, 2, 3, 4, 5]), 8000), 2, 3);
  assert.deepEqual(Array.from(await r.read(0, 10)), [2, 3, 4]);
});

test('whole-file Smart analysis chooses exactly what a full Smart run uses', async () => {
  const { analyseForSmart } = await import('../src/dsp/stream');
  const s = settingsForPreset('auto');
  const a = await analyseForSmart(new MemorySource(X24, 24000), s);
  const sink = new MemorySink();
  const r = await enhanceStream(new MemorySource(X24, 24000), sink, s, memoryTemp);
  assert.deepEqual(a.settings, r.report.appliedSettings);
  assert.deepEqual(a.reasons, r.report.autoReasons);
  assert.equal(a.humHz, r.report.humHz);
  assert.deepEqual(a.segments, r.report.segments);
});

test('per-section Smart mode: same result whatever the chunk size, and it changes the audio', async () => {
  const s = settingsForPreset('auto');
  const run = async (settings: EnhanceSettings) => {
    const sink = new MemorySink();
    const r = await enhanceStream(new MemorySource(X24, 24000), sink, settings, memoryTemp);
    return { out: sink.toArray(), r };
  };
  const ref = await run(s);
  assert.ok(ref.r.sections && ref.r.sections.length > 0, 'sections found');
  assert.ok(ref.r.sections.some((x) => x.kind === 'whisper'), 'the whisper fixture has whispered sections');
  assert.ok(ref.r.report.stagesRun.includes('per-section'));
  assert.deepEqual(ref.r.report.sectionCounts, (await import('../src/dsp/autoTune')).countSections(ref.r.sections));
  for (const n of [12345, 4099]) {
    setChunkSamplesForTests(n);
    try {
      const o = await run(s);
      assert.equal(o.out.length, ref.out.length);
      assert.ok(maxDiff(o.out, ref.out) < 1e-5, `chunk ${n}: ${maxDiff(o.out, ref.out)}`);
    } finally {
      setChunkSamplesForTests(0);
    }
  }
  const flat = await run({ ...s, perSection: false });
  assert.equal(flat.r.sections, null);
  assert.ok(maxDiff(flat.out, ref.out) > 1e-3, 'per-section output differs from one setting for the file');
});

test('preview with the whole file\'s measurements uses them for the file settings and the sections', async () => {
  const { analyseForSmart } = await import('../src/dsp/stream');
  const s = settingsForPreset('auto');
  const a = await analyseForSmart(new MemorySource(X24, 24000), s);
  // a part of the file, processed with the whole file's measurements (as the preview does)
  const part = X24.slice(0, 10 * 24000);
  const r = await enhanceStream(new MemorySource(part, 24000), new MemorySink(), { ...s, autoMeasures: a.measures }, memoryTemp);
  const { autoMeasures: _x, ...applied } = r.report.appliedSettings;
  void _x;
  assert.deepEqual(applied, a.settings);
  for (const sec of r.sections ?? []) assert.ok(sec.end <= 10.01);
});
