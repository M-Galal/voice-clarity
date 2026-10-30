import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, settingsForPreset, SITUATIONS } from '../src/dsp/pipeline';
import { settingsForSection } from '../src/dsp/autoTune';

test('situation presets set every enhancement value and keep the loudness settings', () => {
  for (const sit of SITUATIONS) {
    const s = settingsForPreset(sit, { targetLufs: -19, limiterCeilingDb: -2, noiseSuppression: false, humRemoval: false });
    assert.equal(s.strength, sit);
    assert.equal(s.noiseSuppression, true, sit);
    assert.equal(s.humRemoval, true, sit);
    assert.equal(s.targetLufs, -19);
    assert.equal(s.limiterCeilingDb, -2);
    for (const [k, v] of Object.entries(PRESETS[sit])) assert.deepEqual((s as unknown as Record<string, unknown>)[k], v, `${sit}.${k}`);
  }
});

test('whisper and distant presets match what Smart mode uses for such sections', () => {
  for (const [sit, kind, snr] of [['whisper', 'whisper', 30], ['far', 'far', 10]] as const) {
    const sec = settingsForSection(kind, snr);
    const p = PRESETS[sit];
    assert.equal(p.clarityDb, sec.clarityDb);
    assert.ok((p.noiseAmount ?? 0) <= (kind === 'whisper' ? 1.2 : 1.5));
  }
});

test('the voice level can be raised by up to +50 dB, also with settings saved by older versions', async () => {
  const { MAX_GAIN_DB } = await import('../src/dsp/pipeline');
  assert.equal(MAX_GAIN_DB, 50);
  assert.equal(settingsForPreset('auto', { maxAutoGainDb: 24 }).maxAutoGainDb, 50);
  const { enhanceStream, MemorySink, MemorySource, memoryTemp } = await import('../src/dsp/stream');
  // a very quiet tone: the manual gain is applied in full
  const x = Float32Array.from({ length: 16000 * 3 }, (_, i) => 0.0005 * Math.sin(i / 7));
  const r = await enhanceStream(new MemorySource(x, 16000), new MemorySink(), { ...settingsForPreset('advanced'), noiseSuppression: false, levelSpeech: false, gainMode: 'manual', manualGainDb: 50 }, memoryTemp);
  assert.equal(r.report.appliedGainDb, 50);
});
