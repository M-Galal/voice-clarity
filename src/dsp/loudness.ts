/**
 * Loudness and peak measurement.
 *
 * Integrated loudness follows ITU-R BS.1770-4 for a single (mono) channel:
 *  - K-weighting: high-shelf (+4 dB, 1500 Hz) then high-pass (38 Hz). The filters are
 *    re-derived for the actual sample rate (same approach as pyloudnorm), so any rate works.
 *  - 400 ms blocks, 75 % overlap.
 *  - Absolute gate −70 LUFS, then relative gate −10 LU below the absolutely-gated mean.
 *  - Loudness = −0.691 + 10·log10(mean square).
 *
 * "Speech loudness" applies the same math only to blocks that sit inside detected speech,
 * so silence and pauses do not drag the number down (this is what the gain stage targets).
 */
import { applyChain, BiquadChainState, type BiquadCoeffs } from './biquad';
import type { Segment } from './vad';

/**
 * K-weighting coefficients for any sample rate, derived from the analogue prototype the way
 * libebur128 does it. At 48 kHz they reproduce the BS.1770-4 tables (checked in tests).
 */
export function kWeightingCoeffs(sampleRate: number): BiquadCoeffs[] {
  // stage 1: high shelf
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: BiquadCoeffs = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // stage 2: high pass (RLB), numerator [1, −2, 1] as in the standard
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const hp: BiquadCoeffs = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

export function kWeight(samples: Float32Array, sampleRate: number): Float32Array {
  return applyChain(samples, kWeightingCoeffs(sampleRate));
}

function blockPowers(weighted: Float32Array, sampleRate: number): { power: number; start: number }[] {
  const block = Math.round(0.4 * sampleRate);
  const step = Math.round(0.1 * sampleRate);
  const out: { power: number; start: number }[] = [];
  if (weighted.length < block) {
    if (weighted.length === 0) return out;
    let s = 0;
    for (let i = 0; i < weighted.length; i++) s += weighted[i] * weighted[i];
    out.push({ power: s / weighted.length, start: 0 });
    return out;
  }
  // running sum for speed
  let sum = 0;
  for (let i = 0; i < block; i++) sum += weighted[i] * weighted[i];
  let pos = 0;
  out.push({ power: sum / block, start: 0 });
  while (pos + step + block <= weighted.length) {
    for (let i = 0; i < step; i++) {
      const a = weighted[pos + i];
      const b = weighted[pos + block + i];
      sum += b * b - a * a;
    }
    pos += step;
    out.push({ power: Math.max(0, sum) / block, start: pos });
  }
  return out;
}

const toLufs = (power: number) => (power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity);

export function gatedLoudness(powers: number[]): number {
  const abs = powers.filter((p) => toLufs(p) > -70);
  if (abs.length === 0) return -Infinity;
  const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
  const relGate = toLufs(meanAbs) - 10;
  const rel = abs.filter((p) => toLufs(p) > relGate);
  if (rel.length === 0) return -Infinity;
  return toLufs(rel.reduce((a, b) => a + b, 0) / rel.length);
}

export function integratedLoudness(samples: Float32Array, sampleRate: number): number {
  const blocks = blockPowers(kWeight(samples, sampleRate), sampleRate);
  return gatedLoudness(blocks.map((b) => b.power));
}

/** BS.1770 gating restricted to 400 ms blocks whose centre lies inside a speech segment. */
export function speechLoudness(samples: Float32Array, sampleRate: number, segments: Segment[]): number {
  if (segments.length === 0) return integratedLoudness(samples, sampleRate);
  const blocks = blockPowers(kWeight(samples, sampleRate), sampleRate);
  const half = 0.2;
  const inSpeech = blocks.filter((b) => {
    const centre = b.start / sampleRate + half;
    return segments.some((s) => centre >= s.start && centre <= s.end);
  });
  if (inSpeech.length === 0) return integratedLoudness(samples, sampleRate);
  return gatedLoudness(inSpeech.map((b) => b.power));
}

export function samplePeakDb(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Integrated and speech loudness from one K-weighting pass. */
export function loudnessPair(samples: Float32Array, sampleRate: number, segments: Segment[]): { integrated: number; speech: number } {
  const blocks = blockPowers(kWeight(samples, sampleRate), sampleRate);
  const integrated = gatedLoudness(blocks.map((b) => b.power));
  if (segments.length === 0) return { integrated, speech: integrated };
  const inSpeech: number[] = [];
  let si = 0;
  for (const b of blocks) {
    const centre = b.start / sampleRate + 0.2;
    while (si < segments.length && segments[si].end < centre) si++;
    if (si < segments.length && centre >= segments[si].start) inSpeech.push(b.power);
  }
  return { integrated, speech: inSpeech.length ? gatedLoudness(inSpeech) : integrated };
}

/**
 * True-peak estimate: 4× oversampling with a 48-tap windowed-sinc interpolator
 * (the oversampling approach described in BS.1770-4 Annex 2). It is an estimate,
 * labelled as such in the UI.
 */
export function truePeakDb(samples: Float32Array): number {
  const factor = 4;
  const taps = 12; // per phase -> 48 total
  const half = taps / 2;
  const phases: Float32Array[] = [];
  for (let p = 0; p < factor; p++) {
    const k = new Float32Array(taps);
    const frac = p / factor;
    for (let t = 0; t < taps; t++) {
      const x = t - half + 1 - frac;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const win = 0.5 * (1 + Math.cos((Math.PI * x) / (half + 0.5)));
      k[t] = sinc * win;
    }
    phases.push(k);
  }
  const n = samples.length;
  let peak = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  if (peak === 0) return -Infinity;
  // Only interpolate where a neighbouring sample is within 12 dB of the sample peak: for this
  // interpolator, a point further down cannot produce the largest inter-sample value in
  // practice, and skipping it makes the measurement many times faster.
  const gate = peak * 0.25;
  for (let i = 0; i < n; i++) {
    const near = Math.max(Math.abs(samples[i]), i + 1 < n ? Math.abs(samples[i + 1]) : 0);
    if (near < gate) continue;
    for (let p = 1; p < factor; p++) {
      const k = phases[p];
      let acc = 0;
      for (let t = 0; t < taps; t++) {
        const idx = i + t - half + 1;
        if (idx >= 0 && idx < n) acc += samples[idx] * k[t];
      }
      const aa = Math.abs(acc);
      if (aa > peak) peak = aa;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

export interface BlockPower { power: number; start: number }

/**
 * K-weighted 400 ms block powers (100 ms hop), fed chunk by chunk. Gives the same blocks as the
 * whole-signal measurement (400 ms = four 100 ms sub-blocks at the processing rates used here).
 */
export class KLoudnessMeter {
  private readonly k: BiquadChainState;
  private readonly step: number;
  private readonly block: number;
  private readonly sub: number[] = [];
  private acc = 0;
  private filled = 0;
  private total = 0;
  private all = 0;

  constructor(sampleRate: number) {
    this.k = new BiquadChainState(kWeightingCoeffs(sampleRate));
    this.step = Math.round(0.1 * sampleRate);
    this.block = 4 * this.step;
  }

  /** Feeds samples; returns the K-weighted chunk in case the caller needs it. */
  push(chunk: Float32Array): Float32Array {
    const w = this.k.process(chunk);
    let acc = this.acc, all = this.all, filled = this.filled;
    const step = this.step, sub = this.sub, n = w.length;
    for (let i = 0; i < n; i++) {
      const e = w[i] * w[i];
      acc += e;
      all += e;
      if (++filled === step) { sub.push(acc); acc = 0; filled = 0; }
    }
    this.acc = acc; this.all = all; this.filled = filled;
    this.total += n;
    return w;
  }

  blocks(): BlockPower[] {
    const out: BlockPower[] = [];
    if (this.total === 0) return out;
    if (this.total < this.block) return [{ power: this.all / this.total, start: 0 }];
    for (let b = 0; b + 4 <= this.sub.length; b++) {
      out.push({ power: Math.max(0, this.sub[b] + this.sub[b + 1] + this.sub[b + 2] + this.sub[b + 3]) / this.block, start: b * this.step });
    }
    return out;
  }
}

/** Integrated and speech loudness from block powers (same rules as loudnessPair). */
export function loudnessFromBlocks(blocks: BlockPower[], sampleRate: number, segments: Segment[]): { integrated: number; speech: number } {
  const integrated = gatedLoudness(blocks.map((b) => b.power));
  if (segments.length === 0) return { integrated, speech: integrated };
  const inSpeech: number[] = [];
  let si = 0;
  for (const b of blocks) {
    const centre = b.start / sampleRate + 0.2;
    while (si < segments.length && segments[si].end < centre) si++;
    if (si < segments.length && centre >= segments[si].start) inSpeech.push(b.power);
  }
  return { integrated, speech: inSpeech.length ? gatedLoudness(inSpeech) : integrated };
}

/** Polyphase kernels of the true-peak interpolator. */
function truePeakPhases(): Float32Array[] {
  const factor = 4;
  const taps = 12;
  const half = taps / 2;
  const phases: Float32Array[] = [];
  for (let p = 0; p < factor; p++) {
    const k = new Float32Array(taps);
    const frac = p / factor;
    for (let t = 0; t < taps; t++) {
      const x = t - half + 1 - frac;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const win = 0.5 * (1 + Math.cos((Math.PI * x) / (half + 0.5)));
      k[t] = sinc * win;
    }
    phases.push(k);
  }
  return phases;
}

/**
 * True-peak estimate fed chunk by chunk (same interpolator as truePeakDb). Samples are only
 * interpolated near the running peak (12 dB gate); the running peak never exceeds the final
 * one, so at least the samples truePeakDb examines are examined.
 */
export class TruePeakMeter {
  private readonly phases = truePeakPhases();
  private readonly taps = 12;
  private readonly half = 6;
  private hist = new Float32Array(0); // last samples kept for the next chunk's window
  private peak = 0;
  private done = 0; // absolute index of the next sample to examine
  private histStart = 0; // absolute index of hist[0]

  push(chunk: Float32Array, final = false): void {
    let peak = this.peak;
    const cn = chunk.length;
    for (let i = 0; i < cn; i++) { let a = chunk[i]; if (a < 0) a = -a; if (a > peak) peak = a; }
    const hl = this.hist.length;
    const buf = new Float32Array(hl + cn);
    buf.set(this.hist, 0);
    buf.set(chunk, hl);
    const bl = buf.length;
    const histStart = this.histStart;
    const end = histStart + bl; // absolute end (exclusive)
    const taps = this.taps, half = this.half;
    // a sample i needs i+1 and up to i+half samples after it, unless the signal ends
    const limit = final ? end : end - (taps - half);
    const gate = peak * 0.25;
    const k1 = this.phases[1], k2 = this.phases[2], k3 = this.phases[3];
    for (let i = this.done; i < limit; i++) {
      const li = i - histStart;
      let a0 = buf[li]; if (a0 < 0) a0 = -a0;
      let a1 = i + 1 < end ? buf[li + 1] : 0; if (a1 < 0) a1 = -a1;
      const near = a0 > a1 ? a0 : a1;
      if (near < gate || gate === 0) continue;
      const base = li - half + 1;
      let s1 = 0, s2 = 0, s3 = 0;
      if (base >= 0 && base + taps <= bl) {
        // all taps inside the buffer: the three phases in one pass (same sums, same order)
        for (let t = 0; t < taps; t++) { const v = buf[base + t]; s1 += v * k1[t]; s2 += v * k2[t]; s3 += v * k3[t]; }
      } else {
        for (let t = 0; t < taps; t++) {
          const idx = base + t;
          if (idx >= 0 && idx < bl) { const v = buf[idx]; s1 += v * k1[t]; s2 += v * k2[t]; s3 += v * k3[t]; }
        }
      }
      if (s1 < 0) s1 = -s1; if (s1 > peak) peak = s1;
      if (s2 < 0) s2 = -s2; if (s2 > peak) peak = s2;
      if (s3 < 0) s3 = -s3; if (s3 > peak) peak = s3;
    }
    this.peak = peak;
    this.done = Math.max(this.done, limit);
    // keep enough history for the next window (half samples before the next unexamined one)
    const keepFrom = Math.max(this.histStart, this.done - this.half);
    this.hist = buf.slice(keepFrom - this.histStart);
    this.histStart = keepFrom;
  }

  get db(): number { return this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity; }
}
