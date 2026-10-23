import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aacBitrate, nextVersionName, saveTarget } from '../src/edit/saveFormat';

const ANDROID = ['mpeg4', 'adts'];
const IOS = ['mpeg4'];

test('edits keep the original extension where the phone can encode it', () => {
  assert.deepEqual(saveTarget('m4a', ANDROID), { ext: 'm4a', container: 'mpeg4', changed: false });
  assert.deepEqual(saveTarget('MP4', IOS), { ext: 'mp4', container: 'mpeg4', changed: false });
  assert.deepEqual(saveTarget('wav', IOS), { ext: 'wav', container: 'wav', changed: false });
  assert.deepEqual(saveTarget('aac', ANDROID), { ext: 'aac', container: 'adts', changed: false });
});

test('formats without an encoder fall back to M4A, or WAV without the native module', () => {
  assert.deepEqual(saveTarget('aac', IOS), { ext: 'm4a', container: 'mpeg4', changed: true });
  for (const e of ['mp3', 'flac', 'ogg', 'opus']) assert.deepEqual(saveTarget(e, ANDROID), { ext: 'm4a', container: 'mpeg4', changed: true });
  assert.deepEqual(saveTarget('m4a', []), { ext: 'wav', container: 'wav', changed: true });
});

test('version names: base-v1, then the next free counter', () => {
  assert.equal(nextVersionName('meeting', []), 'meeting-v1');
  assert.equal(nextVersionName('meeting', ['meeting', 'meeting-v1', 'meeting-v3', 'other-v9']), 'meeting-v4');
  assert.equal(nextVersionName('meeting-v2', ['meeting', 'meeting-v1', 'meeting-v2']), 'meeting-v3');
  assert.equal(nextVersionName('a.b (1)', ['a.b (1)-v1']), 'a.b (1)-v2');
  assert.equal(nextVersionName('تسجيل', ['تسجيل-v1']), 'تسجيل-v2');
});

test('AAC bit rate follows the original within encoder limits', () => {
  // 1 MB over 80 s ≈ 100 kb/s mono at 44.1 kHz
  assert.equal(aacBitrate(1_000_000, 80, 44100, 1), 100000);
  // a WAV original (1411 kb/s stereo) is capped
  assert.equal(aacBitrate(10_584_000, 60, 44100, 2), 320000);
  // tiny 8 kHz mono stays within 6 bits per sample
  assert.ok(aacBitrate(100_000, 10, 8000, 1) <= 43200);
  assert.equal(aacBitrate(0, 0, 48000, 1), 96000);
});
