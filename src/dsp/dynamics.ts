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

export interface LevelerOptions {
  /** Most a quiet speech window may be raised, dB. */
  maxBoostDb: number;
  /** Length of the windows speech is measured in, seconds. */
  windowSec?: number;
  /** Level that quiet speech is raised towards: this percentile of all speech windows. */
  refPercentile?: number;
}

export interface LevelerResult {
  output: Float32Array;
  /** Boost applied to each window, for reporting. */
  boostsDb: number[];
  /** Level spread between loud and quiet speech before levelling (p90 − p10), dB. */
  spreadDb: number;
}

/**
 * Speech leveller: raises quiet speech (whispers, distant talkers) towards the level of the
 * louder speech in the same file. Speech is measured in ~1 s windows on a K-weighted copy
 * (BS.1770 weighting, which counts the 1.5–7 kHz whisper region more than the low end);
 * each window gets a boost of (reference − its level), between 0 and `maxBoostDb`. Nothing is
 * ever turned down and pauses get no boost. Gains change smoothly over ~80 ms.
 */
export function levelSpeech(
  input: Float32Array,
  sampleRate: number,
  segments: Segment[],
  opts: LevelerOptions,
  weighted?: Float32Array,
): LevelerResult {
  const win = opts.windowSec ?? 1.0;
  const refP = opts.refPercentile ?? 0.8;
  const w = weighted ?? input;
  const windows: { a: number; b: number; db: number }[] = [];
  for (const s of segments) {
    const a0 = Math.round(s.start * sampleRate), b0 = Math.min(input.length, Math.round(s.end * sampleRate));
    const n = Math.max(1, Math.round((b0 - a0) / (win * sampleRate)));
    const step = (b0 - a0) / n;
    for (let k = 0; k < n; k++) {
      const a = Math.round(a0 + k * step), b = Math.round(a0 + (k + 1) * step);
      let acc = 0;
      for (let i = a; i < b; i++) acc += w[i] * w[i];
      const ms = acc / Math.max(1, b - a);
      windows.push({ a, b, db: ms > 1e-12 ? 10 * Math.log10(ms) : -120 });
    }
  }
  if (windows.length === 0) return { output: Float32Array.from(input), boostsDb: [], spreadDb: 0 };
  const levels = windows.map((x) => x.db).sort((p, q) => p - q);
  const pick = (p: number) => levels[Math.min(levels.length - 1, Math.floor(p * levels.length))];
  const ref = pick(refP);
  const spreadDb = pick(0.9) - pick(0.1);
  const boostsDb = windows.map((x) => Math.max(0, Math.min(opts.maxBoostDb, ref - x.db)));

  // gain envelope in 10 ms blocks, then smoothed
  const block = Math.max(1, Math.round(0.01 * sampleRate));
  const nb = Math.ceil(input.length / block);
  const env = new Float32Array(nb);
  windows.forEach((x, i) => {
    for (let k = Math.floor(x.a / block); k < Math.min(nb, Math.ceil(x.b / block)); k++) env[k] = boostsDb[i];
  });
  const smooth = new Float32Array(nb);
  const R = 4; // ±40 ms → ~80 ms transitions
  for (let k = 0; k < nb; k++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, k - R); j <= Math.min(nb - 1, k + R); j++) { s += env[j]; c++; }
    smooth[k] = s / c;
  }
  const lin = new Float32Array(nb);
  for (let k = 0; k < nb; k++) lin[k] = Math.pow(10, smooth[k] / 20);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const pos = i / block - 0.5;
    const k0 = Math.max(0, Math.min(nb - 1, Math.floor(pos)));
    const k1 = Math.min(nb - 1, k0 + 1);
    const f = Math.max(0, Math.min(1, pos - k0));
    out[i] = input[i] * (lin[k0] * (1 - f) + lin[k1] * f);
  }
  return { output: out, boostsDb, spreadDb };
}
