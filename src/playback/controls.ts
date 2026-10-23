/** Skip intervals and playback speed limits. Pure functions, tested in tests/controls.test.ts. */

export const SKIP_MIN_SEC = 1;
export const SKIP_MAX_SEC = 3600;
export const SKIP_PRESETS = [1, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

export const RATE_MIN = 0.1;
export const RATE_MAX = 5;
export const RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5];

export const clampSkip = (sec: number) => Math.round(Math.min(SKIP_MAX_SEC, Math.max(SKIP_MIN_SEC, sec)));
export const clampRate = (r: number) => Math.round(Math.min(RATE_MAX, Math.max(RATE_MIN, r)) * 100) / 100;

export interface Units { s: string; min: string; h: string }
const EN: Units = { s: 's', min: 'min', h: 'h' };

/** 10 → "10 s", 90 → "1 min 30 s", 3600 → "1 h". */
export function formatSkip(sec: number, u: Units = EN): string {
  const t = clampSkip(sec);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} ${u.h}`);
  if (m) parts.push(`${m} ${u.min}`);
  if (s || parts.length === 0) parts.push(`${s} ${u.s}`);
  return parts.join(' ');
}

/** Compact form for the round buttons: "10s", "2m", "1m30", "1h". */
export function shortSkip(sec: number): string {
  const t = clampSkip(sec);
  if (t >= 3600) return '1h';
  if (t >= 60) return t % 60 ? `${Math.floor(t / 60)}m${t % 60}` : `${t / 60}m`;
  return `${t}s`;
}

/**
 * Reads "45", "45 s", "45sec", "2 min", "2m", "1.5 min", "1 h", "1:30", "1:00:00",
 * and the Arabic unit letters ث / د / س. Returns seconds, or null if it is not a time in range.
 */
export function parseSkip(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(',', '.');
  if (!t) return null;
  let sec: number;
  if (/^\d+(:\d{1,2}){1,2}$/.test(t)) {
    sec = t.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
  } else {
    const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|ث|m|min|mins|minute|minutes|د|h|hr|hour|hours|س)?$/.exec(t);
    if (!m) return null;
    const v = Number(m[1]);
    const unit = m[2] ?? 's';
    const mult = /^(m|min|mins|minute|minutes|د)$/.test(unit) ? 60 : /^(h|hr|hour|hours|س)$/.test(unit) ? 3600 : 1;
    sec = v * mult;
  }
  if (!Number.isFinite(sec) || sec < SKIP_MIN_SEC || sec > SKIP_MAX_SEC) return null;
  return Math.round(sec);
}
