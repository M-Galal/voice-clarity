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
