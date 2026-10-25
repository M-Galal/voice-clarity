import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkTimeToRecording, GAP_SEC, planAsrChunks } from '../src/transcript/chunks';

test('speech is packed into chunks of at most 28 s, pauses left out', () => {
  const segs = [{ start: 1, end: 6 }, { start: 20, end: 30 }, { start: 100, end: 110 }, { start: 200, end: 205 }];
  const c = planAsrChunks(segs, 300);
  for (const ch of c) assert.ok(ch.duration <= 28 + 1e-9);
  const total = c.reduce((t, ch) => t + ch.pieces.reduce((u, p) => u + p.end - p.start, 0), 0);
  assert.ok(total < 35, `only speech is sent (${total} s)`);
  assert.equal(c[0].pieces[0].start, 0.8);
});

test('a long stretch of speech is split; nothing detected means the whole file in windows', () => {
  const c = planAsrChunks([{ start: 0, end: 70 }], 70);
  assert.deepEqual(c.map((x) => x.pieces.map((p) => [Math.round(p.start), Math.round(p.end)])), [[[0, 28]], [[28, 56]], [[56, 70]]]);
  assert.equal(planAsrChunks([], 60).length, 3);
});

test('times in a chunk map back to the recording', () => {
  const [ch] = planAsrChunks([{ start: 10.2, end: 14.8 }, { start: 40.2, end: 44.8 }], 100);
  assert.equal(ch.pieces.length, 2);
  assert.equal(chunkTimeToRecording(ch, 0), 10);
  assert.equal(chunkTimeToRecording(ch, 2), 12);
  assert.equal(chunkTimeToRecording(ch, 5 + GAP_SEC + 1), 41);
  assert.equal(chunkTimeToRecording(ch, 5 + GAP_SEC / 2), 40);
});

test('the Whisper silence credit is recognised in its usual spellings, real speech is not', async () => {
  const { isSilencePhrase } = await import('../src/transcript/chunks');
  for (const s of ['ترجمة نانسي قنقر', ' ترجمة نانسي قنقر.', 'تَرْجَمَة نانسي قنقر', '«ترجمه نانسي قنقر»', 'نانسي قنقر']) assert.ok(isSilencePhrase(s), s);
  for (const s of ['السلام عليكم ورحمة الله', 'ترجمة نانسي قنقر وهذا كلام', 'Nancy']) assert.ok(!isSilencePhrase(s), s);
});

test('quiet chunks are raised to about -20 dBFS, loud ones are left alone', async () => {
  const { asrGainDb } = await import('../src/transcript/chunks');
  const tone = (amp: number) => Float32Array.from({ length: 16000 }, (_, i) => amp * Math.sin(i / 5));
  const quiet = asrGainDb(tone(0.003)); // about -53 dBFS RMS
  assert.ok(Math.abs(quiet.gainDb - 30) < 1e-9, `capped at +30 dB (${quiet.gainDb})`);
  const mid = asrGainDb(tone(0.03)); // about -33 dBFS
  assert.ok(Math.abs(mid.rmsDb + mid.gainDb + 20) < 0.1, `${mid.rmsDb} + ${mid.gainDb}`);
  assert.equal(asrGainDb(tone(0.5)).gainDb, 0);
});
