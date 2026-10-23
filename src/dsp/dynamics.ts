import { dbToGain } from './units';
import type { Segment } from './vad';
import { speechMask } from './vad';

export interface LimiterResult {
  output: Float32Array;
  /** Largest gain reduction applied, in dB (≥ 0). */
  maxReductionDb: number;
  /** Seconds during which more than 3 dB of reduction was applied. */
  heavySeconds: number;
}

/**
 * Look-ahead peak limiter (offline). Gain falls ahead of each peak over `lookaheadMs`,
 * then recovers with `releaseMs`. A final clamp guarantees no sample exceeds the ceiling.
 */
export function limit(
  input: Float32Array,
  sampleRate: number,
  ceilingDb = -1,
  lookaheadMs = 5,
  releaseMs = 80,
): LimiterResult {
  const ceil = dbToGain(ceilingDb);
  const n = input.length;
  const L = Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate));
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(input[i]);
    req[i] = a > ceil ? ceil / a : 1;
  }
  // forward-looking sliding minimum over [i, i+L] with a monotonic deque
  const gMin = new Float32Array(n);
  const dq = new Int32Array(n + L + 1);
  let head = 0, tail = 0;
  let j = 0;
  for (let i = 0; i < n; i++) {
    while (j < n && j <= i + L) {
      while (tail > head && req[dq[tail - 1]] >= req[j]) tail--;
      dq[tail++] = j++;
    }
    while (dq[head] < i) head++;
    gMin[i] = req[dq[head]];
  }
  const atk = 1 - Math.exp(-4.6 / L);
  const rel = 1 - Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  const out = new Float32Array(n);
  let g = 1;
  let maxRed = 1;
  let heavy = 0;
  const heavyGain = dbToGain(-3);
  for (let i = 0; i < n; i++) {
    const t = gMin[i];
    g += (t - g) * (t < g ? atk : rel);
    let y = input[i] * g;
    if (y > ceil) y = ceil; else if (y < -ceil) y = -ceil;
    out[i] = y;
    if (g < maxRed) maxRed = g;
    if (g < heavyGain) heavy++;
  }
  return { output: out, maxReductionDb: -20 * Math.log10(maxRed), heavySeconds: heavy / sampleRate };
}

/**
 * Lowers audio between speech segments by `reductionDb` (ramped at segment edges), so the
 * later gain stage can raise the voice without raising pauses full of noise by the same amount.
 */
export function attenuateGaps(
  input: Float32Array,
  sampleRate: number,
  segments: Segment[],
  reductionDb: number,
): Float32Array {
  if (reductionDb <= 0 || segments.length === 0) return Float32Array.from(input);
  const mask = speechMask(input.length, sampleRate, segments, 40);
  const gap = dbToGain(-reductionDb);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] * (mask[i] + (1 - mask[i]) * gap);
  return out;
}

export function applyGain(input: Float32Array, gainDb: number): Float32Array {
  const g = dbToGain(gainDb);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] * g;
  return out;
}

export interface ClipReport {
  events: number;
  /** Start times (s) of the first clipped runs, max 20. */
  times: number[];
}

/** Runs of ≥ 3 consecutive samples at or above 99.9 % full scale count as clipping. */
export function detectClipping(samples: Float32Array, sampleRate: number): ClipReport {
  const thr = 0.999;
  let run = 0;
  let events = 0;
  const times: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= thr) {
      run++;
      if (run === 3) {
        events++;
        if (times.length < 20) times.push(Math.round(((i - 2) / sampleRate) * 100) / 100);
      }
    } else run = 0;
  }
  return { events, times };
}
