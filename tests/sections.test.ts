import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countSections, planSections, settingsForSection, type SectionWindow } from '../src/dsp/autoTune';
import { SectionCurve } from '../src/dsp/stream';

const win = (start: number, levelDb: number, snrDb = 20, whisper = false): SectionWindow => ({ start, end: start + 1, levelDb, snrDb, whisper });

test('close, distant and whispered speech become separate sections with their own settings', () => {
  const w: SectionWindow[] = [];
  for (let t = 0; t < 5; t++) w.push(win(t, -20, 30));          // close, clean
  for (let t = 6; t < 11; t++) w.push(win(t, -34, 10));         // distant (14 dB lower), noisier
  for (let t = 12; t < 16; t++) w.push(win(t, -40, 12, true));  // whispered
  const s = planSections(w, -20);
  assert.deepEqual(s.map((x) => x.kind), ['near', 'far', 'whisper']);
  assert.deepEqual(countSections(s), { whisper: 1, far: 1, near: 1 });
  assert.equal(s[0].noiseAmount, 1.0);
  assert.ok(s[1].noiseAmount <= 1.5 && s[1].noiseFloorDb >= -18 && s[1].clarityDb > s[0].clarityDb);
  assert.ok(s[2].noiseAmount <= 1.2 && s[2].noiseFloorDb >= -14);
});

test('a short dip does not make its own section', () => {
  const w = [win(0, -20), win(1, -20), win(2, -20), win(3, -35), win(4, -20), win(5, -20)];
  const s = planSections(w, -20);
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, 'near');
  assert.equal(s[0].start, 0);
  assert.equal(s[0].end, 6);
});

test('noise reduction follows the noise around each section', () => {
  assert.equal(settingsForSection('near', 30).noiseAmount, 1.0);
  assert.equal(settingsForSection('near', 5).noiseAmount, 2.0);
  assert.equal(settingsForSection('whisper', 5).noiseAmount, 1.2);
});

test('section curve: constant inside sections, short ramps at the edges, monotone across pauses', () => {
  const secs = planSections([win(0, -20), win(1, -20), win(2, -20), win(5, -35), win(6, -35), win(7, -35)], -20);
  assert.equal(secs.length, 2);
  const c = new SectionCurve(secs, (x) => x.clarityDb);
  assert.equal(c.at(1), 3);
  const mid = c.at(4);
  assert.ok(mid > 3 && mid < 5);
  assert.equal(c.at(6.5), 5);
  assert.equal(c.at(100), 5);
});
