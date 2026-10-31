/**
 * Jump-to and A-B repeat for playback (player screen and live listening). Pure functions,
 * tested in tests/controls.test.ts.
 */

/** A part of the recording played again and again. */
export interface LoopSpec {
  a: number;
  b: number;
  /** How many times the part is played in all; 0 = until repeat is turned off. */
  times: number;
  /** Pause before each new pass, seconds. */
  gapSec: number;
}

export const LOOP_MIN_SEC = 1;
export const LOOP_TIMES = [2, 3, 5, 10, 0] as const;
export const LOOP_GAPS = [0, 1, 2, 3] as const;
/** Playback may pass B by up to this much between two position updates (0.25 s at 5x). */
const CROSS_SEC = 1.5;

/**
 * Reads "90", "90.5", "1:30", "01:30.5", "1:02:03" (also with Arabic-Indic digits and the Arabic
 * decimal comma). Returns seconds, or null when it is not a time within [0, duration].
 */
export function parseTime(text: string, duration: number): number | null {
  const t = text.trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[٫,]/g, '.');
  if (!/^\d+(\.\d+)?$|^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(t)) return null;
  const parts = t.split(':');
  if (parts.slice(1).some((p) => Number(p) >= 60)) return null;
  const sec = parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  if (!Number.isFinite(sec) || sec < 0 || sec > duration + 0.05) return null;
  return Math.min(sec, duration);
}

/** "m:ss.s" for the time fields (tenths kept so a typed time reads back as typed). */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec * 10) / 10);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const ss = (r < 10 ? '0' : '') + (Number.isInteger(r) ? String(r) : r.toFixed(1));
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export const loopValid = (l: Pick<LoopSpec, 'a' | 'b'> | null | undefined, duration: number): l is LoopSpec =>
  !!l && l.a >= 0 && l.b <= duration + 0.05 && l.b - l.a >= LOOP_MIN_SEC;

/**
 * Called on every position update while repeat is on. When playback has just crossed B, returns
 * where to go back to (A) and the new pass number; when the last pass has ended, `done` (playback
 * then simply continues). `pass` counts from 1 (the pass being played).
 */
export function loopStep(prev: number, pos: number, loop: LoopSpec, pass: number): { seekTo: number | null; pass: number; done: boolean } {
  const crossed = prev < loop.b && pos >= loop.b && pos - loop.b < CROSS_SEC;
  if (!crossed) return { seekTo: null, pass, done: false };
  if (loop.times > 0 && pass >= loop.times) return { seekTo: null, pass, done: true };
  return { seekTo: loop.a, pass: pass + 1, done: false };
}
