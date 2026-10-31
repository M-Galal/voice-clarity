import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampRate, clampSkip, formatSkip, parseSkip, shortSkip } from '../src/playback/controls';
import { changeSpeed, MAX_SPEED, MIN_SPEED } from '../src/dsp/edit';
import { formatTime, loopStep, loopValid, parseTime } from '../src/playback/loop';

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

test('jump-to times: m:ss, h:mm:ss, seconds, Arabic digits; nothing outside the recording', () => {
  assert.equal(parseTime('90', 600), 90);
  assert.equal(parseTime('1:30', 600), 90);
  assert.equal(parseTime('01:30.5', 600), 90.5);
  assert.equal(parseTime('1:02:03', 4000), 3723);
  assert.equal(parseTime('١:٣٠', 600), 90);
  assert.equal(parseTime('2,5', 600), 2.5);
  assert.equal(parseTime('1:75', 600), null);
  assert.equal(parseTime('11:00', 600), null);
  assert.equal(parseTime('abc', 600), null);
  assert.equal(parseTime('', 600), null);
  assert.equal(formatTime(90), '1:30');
  assert.equal(formatTime(90.5), '1:30.5');
  assert.equal(formatTime(3723), '1:02:03');
  assert.equal(parseTime(formatTime(75.3), 600), 75.3);
});

test('A-B repeat: back to A each time B is passed, for the set number of passes', () => {
  const loop = { a: 10, b: 20, times: 3, gapSec: 0 };
  assert.ok(loopValid(loop, 60));
  assert.ok(!loopValid({ a: 10, b: 10.5 }, 60));
  assert.ok(!loopValid({ a: 50, b: 70 }, 60));
  let pass = 1;
  let r = loopStep(19.9, 20.05, loop, pass); // first pass ends
  assert.deepEqual(r, { seekTo: 10, pass: 2, done: false });
  pass = r.pass;
  r = loopStep(19.9, 20.1, loop, pass);
  assert.equal(r.seekTo, 10); pass = r.pass; assert.equal(pass, 3);
  r = loopStep(19.9, 20.1, loop, pass); // third pass ends: done, playback continues
  assert.deepEqual(r, { seekTo: null, pass: 3, done: true });
  assert.equal(loopStep(12, 13, loop, 1).seekTo, null); // inside the part
  assert.equal(loopStep(5, 30, loop, 1).seekTo, null); // a jump past B is not the end of a pass
  assert.equal(loopStep(19.5, 20.5, { ...loop, times: 0 }, 99).seekTo, 10); // until stopped
});
