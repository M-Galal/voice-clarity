/** Transcript model, Arabic text helpers and export formats. Pure functions, no RN imports. */
import type { Segment } from '../dsp/vad';

export interface TranscriptSegment {
  id: string;
  start: number; // seconds
  end: number; // seconds
  text: string;
  /** Set when the passage sits in low-quality audio; shown as "check this passage". */
  flag?: 'low_audio_quality' | 'possible_repetition' | 'edited';
  edited?: boolean;
}

export interface Transcript {
  language: string; // detected or chosen, e.g. "ar"
  requestedLanguage: string; // "auto" or a code
  model: string;
  createdAt: string;
  segments: TranscriptSegment[];
  /** True when the source audio was the enhanced copy. */
  fromEnhanced: boolean;
  /** Lines removed because they were a known Whisper "silence" phrase, not speech. */
  removedSilencePhrases?: number;
}

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;

export function arabicRatio(text: string): number {
  const letters = text.replace(/[\s\d\p{P}]/gu, '');
  if (!letters.length) return 0;
  return (text.match(ARABIC_RE)?.length ?? 0) / letters.length;
}

export const isMostlyArabic = (text: string): boolean => arabicRatio(text) >= 0.5;

/**
 * Converts Latin punctuation to Arabic forms in Arabic text: , → ، ; → ؛ ? → ؟
 * Leaves digits, decimals (3,5) and URLs alone.
 */
export function arabicPunctuation(text: string): string {
  if (!isMostlyArabic(text)) return text;
  return text
    .replace(/(?<!\d),(?!\d)/g, '،')
    .replace(/;/g, '؛')
    .replace(/\?/g, '؟')
    .replace(/\s+([،؛؟.!:])/g, '$1');
}

/**
 * whisper.cpp reports segment times in 10 ms units. If a future binding returns seconds or
 * milliseconds, pick the scale whose last end time best matches the audio duration.
 */
export function detectTimeScale(rawEnds: number[], durationSec: number): number {
  const last = Math.max(0, ...rawEnds);
  if (last === 0 || durationSec <= 0) return 0.01;
  const candidates = [1, 0.01, 0.001];
  let best = 0.01;
  let bestErr = Infinity;
  for (const c of candidates) {
    const t = last * c;
    if (t > durationSec * 1.1 + 1) continue;
    const err = Math.abs(durationSec - t);
    if (err < bestErr) { bestErr = err; best = c; }
  }
  return best;
}

export function cleanText(t: string): string {
  return t.replace(/\s+/g, ' ').trim();
}

/** Whisper sometimes loops on noise; repeated identical segments get flagged, not removed. */
export function flagSegments(
  segs: TranscriptSegment[],
  lowQualityRanges: Segment[],
): TranscriptSegment[] {
  return segs.map((s, i) => {
    if (s.flag === 'edited') return s;
    const prev = segs[i - 1];
    if (prev && cleanText(prev.text) === cleanText(s.text) && s.text.trim().length > 0)
      return { ...s, flag: 'possible_repetition' };
    const mid = (s.start + s.end) / 2;
    if (lowQualityRanges.some((r) => mid >= r.start && mid <= r.end)) return { ...s, flag: 'low_audio_quality' };
    return s;
  });
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function timecode(sec: number, sep: ',' | '.' = ','): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** m:ss.t, rounded to tenths first so 9.99 s reads 0:10.0, not 0:010.0. */
export function clockTenths(sec: number): string {
  const tenths = Math.round(Math.max(0, sec) * 10);
  const m = Math.floor(tenths / 600);
  const r = (tenths % 600) / 10;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

/** Unicode RLE/PDF marks keep Arabic lines right-to-left in players that ignore direction. */
const RLE = '‫';
const PDF = '‬';
const wrapRtl = (t: string) => (isMostlyArabic(t) ? `${RLE}${t}${PDF}` : t);

export function toSrt(t: Transcript): string {
  return t.segments
    .filter((s) => s.text.trim())
    .map((s, i) => `${i + 1}\n${timecode(s.start)} --> ${timecode(s.end)}\n${wrapRtl(s.text.trim())}\n`)
    .join('\n');
}

export function toVtt(t: Transcript): string {
  const body = t.segments
    .filter((s) => s.text.trim())
    .map((s) => `${timecode(s.start, '.')} --> ${timecode(s.end, '.')}\n${wrapRtl(s.text.trim())}\n`)
    .join('\n');
  return `WEBVTT\nLanguage: ${t.language}\n\n${body}`;
}

export function toTxt(t: Transcript, withTimes = true): string {
  return t.segments
    .filter((s) => s.text.trim())
    .map((s) => {
      const mark = s.flag && s.flag !== 'edited' ? ' [?]' : '';
      return withTimes ? `[${clock(s.start)}] ${s.text.trim()}${mark}` : `${s.text.trim()}${mark}`;
    })
    .join('\n');
}

export function toJson(t: Transcript): string {
  return JSON.stringify(t, null, 2);
}

export function searchTranscript(t: Transcript, query: string): string[] {
  const q = normalizeArabic(query.trim().toLowerCase());
  if (!q) return [];
  return t.segments.filter((s) => normalizeArabic(s.text.toLowerCase()).includes(q)).map((s) => s.id);
}

/** Search-only normalisation: strip tashkeel and tatweel, unify alef/yaa/taa-marbuta forms. */
export function normalizeArabic(s: string): string {
  return s
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}

export function segmentAt(t: Transcript, time: number): TranscriptSegment | undefined {
  return t.segments.find((s) => time >= s.start && time < s.end);
}
