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
import { applyChain, type BiquadCoeffs } from './biquad';
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

function gatedLoudness(powers: number[]): number {
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
  let peak = 0;
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
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
