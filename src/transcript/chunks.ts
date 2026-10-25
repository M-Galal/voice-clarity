/**
 * Speech is transcribed in short independent chunks instead of one long pass:
 * - Whisper decodes 30 s windows; carrying a window's text into the next one makes it prone to
 *   repetition loops (openai/whisper transcribe.py, condition_on_previous_text). Independent
 *   chunks carry nothing over, while the user's prompt still applies to each.
 * - Only detected speech is sent (pauses shortened to GAP_SEC), so silence and noise between
 *   sentences cannot produce invented text, and less audio is processed.
 * - Each chunk is a few hundred KB, so long recordings never have to fit in memory.
 */
import type { Segment } from '../dsp/vad';

export interface Piece { start: number; end: number }
/** One request: pieces of the recording joined with GAP_SEC of silence. */
export interface AsrChunk { pieces: Piece[]; duration: number }

export const GAP_SEC = 0.3;
const PAD_SEC = 0.2;

export function planAsrChunks(segments: Segment[], durationSec: number, maxSec = 28): AsrChunk[] {
  // padded, merged speech; the whole file in windows when nothing was detected
  const merged: Piece[] = [];
  const src = segments.length ? segments : [{ start: 0, end: durationSec }];
  for (const s of src) {
    const a = Math.max(0, s.start - PAD_SEC), b = Math.min(durationSec, s.end + PAD_SEC);
    if (b <= a) continue;
    const last = merged[merged.length - 1];
    if (last && a <= last.end + GAP_SEC) last.end = Math.max(last.end, b);
    else merged.push({ start: a, end: b });
  }
  // long stretches split into pieces of at most maxSec
  const pieces: Piece[] = [];
  for (const m of merged) {
    for (let a = m.start; a < m.end - 1e-6; a += maxSec) pieces.push({ start: a, end: Math.min(m.end, a + maxSec) });
  }
  const chunks: AsrChunk[] = [];
  let cur: AsrChunk | null = null;
  for (const p of pieces) {
    const len = p.end - p.start;
    if (cur && cur.duration + GAP_SEC + len <= maxSec) {
      cur.pieces.push(p);
      cur.duration += GAP_SEC + len;
    } else {
      cur = { pieces: [p], duration: len };
      chunks.push(cur);
    }
  }
  return chunks;
}

/** A time inside a chunk's audio → the time in the recording. */
export function chunkTimeToRecording(chunk: AsrChunk, t: number): number {
  let off = 0;
  for (let i = 0; i < chunk.pieces.length; i++) {
    const p = chunk.pieces[i];
    const len = p.end - p.start;
    if (t <= off + len) return p.start + Math.max(0, t - off);
    off += len;
    // inside the inserted gap: snap to the next piece
    if (t < off + GAP_SEC) return i + 1 < chunk.pieces.length ? chunk.pieces[i + 1].start : p.end;
    off += GAP_SEC;
  }
  return chunk.pieces[chunk.pieces.length - 1].end;
}

/**
 * Whisper's input features are log-mel levels with a fixed offset (whisper.cpp:
 * log_mel_spectrogram, `(x + 4) / 4` after flooring at 80 dB below the loudest point), so very
 * quiet speech reaches the model looking much like silence, which it answers with phrases from
 * its training subtitles. Each chunk is therefore brought to a normal speech level first.
 */
export const ASR_TARGET_DBFS = -20;
export const ASR_MAX_GAIN_DB = 30;

/** Gain (dB) that brings the chunk's RMS to ASR_TARGET_DBFS, at most +30 dB, never a cut. */
export function asrGainDb(pcm: Float32Array): { gainDb: number; rmsDb: number } {
  let e = 0;
  for (let i = 0; i < pcm.length; i++) e += pcm[i] * pcm[i];
  const rmsDb = 10 * Math.log10(e / Math.max(1, pcm.length) + 1e-12);
  // keep the loudest 0.1 % of samples from clipping hard (a click may still clip, which is harmless here)
  const abs = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) abs[i] = Math.abs(pcm[i]);
  abs.sort();
  const p999 = abs.length ? abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.999))] : 0;
  const headroom = p999 > 0 ? -20 * Math.log10(p999) - 0.5 : ASR_MAX_GAIN_DB;
  const gainDb = Math.max(0, Math.min(ASR_TARGET_DBFS - rmsDb, ASR_MAX_GAIN_DB, headroom));
  return { gainDb, rmsDb };
}

/**
 * Whisper answers silence or noise in Arabic with "ترجمة نانسي قنقر" ("translation by Nancy
 * Qunqar"), a subtitle credit from its training data (reported on the openai/whisper GitHub; see
 * also "Investigation of Whisper ASR Hallucinations Induced by Non-Speech Audio", 2025, on such
 * recurring outputs). A line that is only this credit is not speech and is removed.
 */
export function isSilencePhrase(text: string): boolean {
  const t = text
    .replace(/[\u064B-\u0652\u0640]/g, '') // diacritics, tatweel
    .replace(/[^\u0621-\u064A\s]/g, ' ') // keep Arabic letters only
    .replace(/[أإآ]/g, 'ا')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(ترجمه|ترجمة)\s+نانسي\s+قنقر$/.test(t) || /^نانسي\s+قنقر$/.test(t);
}
