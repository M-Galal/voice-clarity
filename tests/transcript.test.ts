import { test } from 'node:test';
import { fileUri } from '../src/services/uri';
import assert from 'node:assert/strict';
import {
  arabicPunctuation, detectTimeScale, flagSegments, isMostlyArabic, normalizeArabic,
  searchTranscript, timecode, toSrt, toTxt, toVtt, clockTenths, type Transcript,
} from '../src/transcript/format';

const t: Transcript = {
  language: 'ar', requestedLanguage: 'auto', model: 'ggml-base', createdAt: '2026-10-23T00:00:00Z', fromEnhanced: true,
  segments: [
    { id: 'a', start: 0, end: 2.5, text: 'السلام عليكم، كيف الحال؟' },
    { id: 'b', start: 2.5, end: 61.25, text: 'Hello there' },
  ],
};

test('Arabic detection and punctuation', () => {
  assert.ok(isMostlyArabic('مرحبا بكم'));
  assert.ok(!isMostlyArabic('hello'));
  assert.equal(arabicPunctuation('كيف حالك ?'), 'كيف حالك؟');
  assert.equal(arabicPunctuation('نعم, شكرا; إلى اللقاء'), 'نعم، شكرا؛ إلى اللقاء');
  assert.equal(arabicPunctuation('السعر 3,5 دينار'), 'السعر 3,5 دينار');
  assert.equal(arabicPunctuation('hello, world?'), 'hello, world?');
});

test('Arabic search normalisation', () => {
  assert.equal(normalizeArabic('أَهْلاً'), 'اهلا');
  assert.deepEqual(searchTranscript(t, 'السلام'), ['a']);
  assert.deepEqual(searchTranscript(t, 'hello'), ['b']);
});

test('timecodes and formats', () => {
  assert.equal(timecode(3661.5), '01:01:01,500');
  assert.equal(timecode(1.25, '.'), '00:00:01.250');
  const srt = toSrt(t);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,500\n‫/);
  assert.match(toVtt(t), /^WEBVTT/);
  assert.match(toTxt(t), /\[1:00\]|\[0:02\]/);
});

test('whisper time scale: 10 ms units by default, seconds when they fit', () => {
  assert.equal(detectTimeScale([500, 1200], 12.3), 0.01);
  assert.equal(detectTimeScale([5, 12], 12.3), 1);
  assert.equal(detectTimeScale([12000], 12.3), 0.001);
});

test('flags: repetition and low audio quality', () => {
  const f = flagSegments(
    [
      { id: '1', start: 0, end: 1, text: 'نعم' },
      { id: '2', start: 1, end: 2, text: 'نعم' },
      { id: '3', start: 5, end: 6, text: 'كلام' },
    ],
    [{ start: 4.5, end: 7 }],
  );
  assert.equal(f[0].flag, undefined);
  assert.equal(f[1].flag, 'possible_repetition');
  assert.equal(f[2].flag, 'low_audio_quality');
});

test('decoder paths keep or gain the file:// prefix (Android release builds need it)', () => {
  assert.equal(fileUri('file:///data/user/0/app/files/a.m4a'), 'file:///data/user/0/app/files/a.m4a');
  assert.equal(fileUri('/data/user/0/app/files/a.m4a'), 'file:///data/user/0/app/files/a.m4a');
  assert.equal(fileUri('content://x/y'), 'content://x/y');
});

test('clockTenths rounds before formatting', () => {
  assert.equal(clockTenths(9.99), '0:10.0');
  assert.equal(clockTenths(59.96), '1:00.0');
  assert.equal(clockTenths(0.5), '0:00.5');
  assert.equal(clockTenths(125.04), '2:05.0');
});
