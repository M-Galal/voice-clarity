import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampRate, clampSkip, formatSkip, parseSkip, shortSkip } from '../src/playback/controls';
import { changeSpeed, MAX_SPEED, MIN_SPEED } from '../src/dsp/edit';

test('skip interval: 1 s to 1 h, parsing and formatting', () => {
  assert.equal(clampSkip(0), 1);
  assert.equal(clampSkip(5000), 3600);
  assert.equal(parseSkip('45'), 45);
  assert.equal(parseSkip('45 s'), 45);
  assert.equal(parseSkip('2 min'), 120);
  assert.equal(parseSkip('1.5m'), 90);
  assert.equal(parseSkip('1 h'), 3600);
  assert.equal(parseSkip('1:30'), 90);
  assert.equal(parseSkip('1:00:00'), 3600);
  assert.equal(parseSkip('٣٠ ث'), 30);
  assert.equal(parseSkip('2 د'), 120);
  assert.equal(parseSkip('0'), null);
  assert.equal(parseSkip('2 h'), null);
  assert.equal(parseSkip('abc'), null);
  assert.equal(formatSkip(10), '10 s');
  assert.equal(formatSkip(90), '1 min 30 s');
  assert.equal(formatSkip(3600), '1 h');
  assert.equal(formatSkip(30, { s: 'ث', min: 'د', h: 'س' }), '30 ث');
  assert.equal(shortSkip(10), '10s');
  assert.equal(shortSkip(120), '2m');
  assert.equal(shortSkip(90), '1m30');
  assert.equal(shortSkip(3600), '1h');
});

test('playback rate is limited to 0.1x-5x', () => {
  assert.equal(clampRate(0.01), 0.1);
  assert.equal(clampRate(9), 5);
  assert.equal(clampRate(1.234), 1.23);
});

test('saved-file speed change also covers 0.1x-5x and keeps pitch', async () => {
  assert.equal(MIN_SPEED, 0.1);
  assert.equal(MAX_SPEED, 5);
  const sr = 16000;
  const x = Float32Array.from({ length: sr * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr));
  for (const speed of [0.1, 0.25, 3, 5]) {
    const [y] = await changeSpeed([x], sr, speed);
    assert.equal(y.length, Math.round((2 * sr) / speed));
    let n = 0, first = -1, last = -1;
    const a = Math.floor(y.length * 0.2), b = Math.floor(y.length * 0.8);
    for (let i = a + 1; i < b; i++) if (y[i - 1] < 0 && y[i] >= 0) { if (first < 0) first = i; last = i; n++; }
    const f = ((n - 1) * sr) / (last - first);
    assert.ok(Math.abs(f - 220) < 4, `pitch @${speed}: ${f}`);
  }
});
