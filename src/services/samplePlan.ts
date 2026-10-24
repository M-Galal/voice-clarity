/** Evenly spread parts for analysing a long recording: `count` parts of `length` seconds. */
export function samplePlan(durationSec: number, count = 16, length = 20): { start: number; length: number }[] {
  if (durationSec <= count * length) return [{ start: 0, length: durationSec }];
  const step = (durationSec - length) / (count - 1);
  return Array.from({ length: count }, (_, i) => ({ start: Math.round(i * step * 10) / 10, length }));
}
