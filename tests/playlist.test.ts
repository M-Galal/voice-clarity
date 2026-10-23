import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyFilter, displayName, folderLabel, nameMatcher, parseExtensions, stepIndex, type PlaylistItem,
} from '../src/playlist/filter';

const SUPPORTED = ['m4a', 'mp3', 'wav', 'aac', 'mp4', 'flac', 'ogg', 'opus'] as const;
const item = (name: string, modified = 0, subfolder = ''): PlaylistItem => ({ uri: `file:///x/${name}`, name, subfolder, size: 1, modified });

test('parseExtensions accepts dots, stars, case and separators', () => {
  assert.deepEqual(parseExtensions('m4a, .MP3; *.wav  ogg|m4a'), ['m4a', 'mp3', 'wav', 'ogg']);
  assert.deepEqual(parseExtensions(''), []);
  assert.deepEqual(parseExtensions(' , ; '), []);
});

test('nameMatcher: plain text is a case-insensitive substring', () => {
  const m = nameMatcher('Call');
  assert.ok(m('phone call 01.m4a'));
  assert.ok(m('CALL.mp3'));
  assert.ok(!m('meeting.m4a'));
});

test('nameMatcher: * and ? patterns match the whole name, with or without extension', () => {
  const m = nameMatcher('call_??');
  assert.ok(m('call_01.m4a'));
  assert.ok(!m('call_001.m4a'));
  assert.ok(nameMatcher('*.m4a')('a b.m4a'));
  assert.ok(!nameMatcher('*.m4a')('a.mp3'));
  assert.ok(nameMatcher('rec(1)*')('rec(1) final.wav'), 'regex characters are literal');
});

test('nameMatcher: ; separates alternatives; empty matches all', () => {
  const m = nameMatcher('meeting; call_*');
  assert.ok(m('Team meeting.m4a'));
  assert.ok(m('call_7.mp3'));
  assert.ok(!m('memo.m4a'));
  assert.ok(nameMatcher('  ')('anything'));
});

test('applyFilter keeps supported and chosen extensions, natural name order', () => {
  const items = [item('part 10.m4a'), item('part 2.m4a'), item('notes.txt'), item('part 1.MP3'), item('cover.jpg')];
  const all = applyFilter(items, { name: '', extensions: [], sort: 'name' }, SUPPORTED);
  assert.deepEqual(all.map((i) => i.name), ['part 1.MP3', 'part 2.m4a', 'part 10.m4a']);
  const m4a = applyFilter(items, { name: '', extensions: ['m4a', 'txt'], sort: 'name' }, SUPPORTED);
  assert.deepEqual(m4a.map((i) => i.name), ['part 2.m4a', 'part 10.m4a'], 'unsupported extensions are ignored even if typed');
});

test('applyFilter sorts by date both ways and groups by subfolder for name sort', () => {
  const items = [item('a.m4a', 300), item('b.m4a', 100, 'old'), item('c.m4a', 200)];
  assert.deepEqual(applyFilter(items, { name: '', extensions: [], sort: 'newest' }, SUPPORTED).map((i) => i.name), ['a.m4a', 'c.m4a', 'b.m4a']);
  assert.deepEqual(applyFilter(items, { name: '', extensions: [], sort: 'oldest' }, SUPPORTED).map((i) => i.name), ['b.m4a', 'c.m4a', 'a.m4a']);
  assert.deepEqual(applyFilter(items, { name: '', extensions: [], sort: 'name' }, SUPPORTED).map((i) => i.name), ['a.m4a', 'c.m4a', 'b.m4a']);
});

test('displayName decodes SAF document ids and plain file URIs', () => {
  assert.equal(
    displayName('content://com.android.externalstorage.documents/tree/primary%3AMusic/document/primary%3AMusic%2FCalls%2Fcall%2001.m4a'),
    'call 01.m4a',
  );
  assert.equal(displayName('content://com.android.externalstorage.documents/tree/primary%3AMusic/document/primary%3Atop.mp3'), 'top.mp3');
  assert.equal(displayName('file:///var/mobile/Docs/%D8%AA%D8%B3%D8%AC%D9%8A%D9%84.m4a'), 'تسجيل.m4a');
  assert.equal(displayName('file:///a/b/c.wav'), 'c.wav');
});

test('folderLabel reads SAF tree URIs and file paths', () => {
  assert.equal(folderLabel('content://com.android.externalstorage.documents/tree/primary%3AMusic%2FCalls'), 'Internal storage/Music/Calls');
  assert.equal(folderLabel('content://com.android.externalstorage.documents/tree/1A2B-3C4D%3ARecordings', 'Phone', 'Card'), 'Card (1A2B-3C4D)/Recordings');
  assert.equal(folderLabel('file:///private/var/mobile/Recordings/'), '/private/var/mobile/Recordings');
});

test('stepIndex stops at both ends', () => {
  assert.equal(stepIndex(0, 3, 1), 1);
  assert.equal(stepIndex(2, 3, 1), null);
  assert.equal(stepIndex(0, 3, -1), null);
});
