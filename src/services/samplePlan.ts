/** Evenly spread parts for analysing a long recording: `count` parts of `length` seconds. */
export function samplePlan(durationSec: number, count = 16, length = 20): { start: number; length: number }[] {
  if (durationSec <= count * length) return [{ start: 0, length: durationSec }];
  const step = (durationSec - length) / (count - 1);
  return Array.from({ length: count }, (_, i) => ({ start: Math.round(i * step * 10) / 10, length }));
}

/**
 * Section times in the joined parts → times in the recording (a section that runs over the join
 * between two parts is split there).
 */
export function mapToParts<T extends { start: number; end: number }>(items: T[], plan: { start: number }[], partFrames: number[], sampleRate: number): T[] {
  const out: T[] = [];
  let off = 0;
  plan.forEach((p, i) => {
    const len = (partFrames[i] ?? 0) / sampleRate;
    for (const it of items) {
      const a = Math.max(it.start, off), b = Math.min(it.end, off + len);
      if (b - a > 0.05) out.push({ ...it, start: p.start + (a - off), end: p.start + (b - off) });
    }
    off += len;
  });
  return out;
}
