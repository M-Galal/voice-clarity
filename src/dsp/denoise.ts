/**
 * Noise suppression by spectral subtraction (STFT, sqrt-Hann analysis/synthesis, 50 % overlap,
 * which reconstructs the input exactly when the gain is 1).
 *
 * - Noise profile: average power spectrum of frames outside detected speech. If the file has
 *   no pauses, the quietest 10 % of frames are used instead.
 * - The profile keeps adapting in non-speech frames, so slowly changing noise (traffic, fans,
 *   room tone) is followed. Short sudden sounds during speech are NOT learned, so intermittent
 *   noise is only partly reduced.
 * - Per-bin gain: g = max(floor, 1 − α·N/P), smoothed over time and neighbouring bins to limit
 *   "musical noise". `floorDb` caps how deep any bin can be cut, which protects words.
 */
import { FFT, nextPow2 } from './fft';
import type { Segment } from './vad';

export interface DenoiseOptions {
  /** Over-subtraction factor α (1 = plain subtraction). */
  overSubtraction: number;
  /** Maximum attenuation per bin in dB (negative, e.g. −18). */
  floorDb: number;
  /** Time smoothing of gains, 0–0.95. Higher = fewer artefacts, slower response. */
  smoothing: number;
}

export interface Progress {
  onProgress?: (fraction: number) => void;
  isCancelled?: () => boolean;
  /** Called between chunks so a UI thread can breathe. */
  yieldFn?: () => Promise<void>;
}

export class CancelledError extends Error {
  constructor() {
    super('Processing was cancelled');
    this.name = 'CancelledError';
  }
}

export function frameSizeFor(sampleRate: number): number {
  return nextPow2(Math.round(sampleRate * 0.032)); // ~32 ms → 512 @16k, 1024 @24k/44.1k/48k
}

function window(n: number): Float32Array {
  // sqrt of periodic Hann: w² sums to 1 at 50 % overlap
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * i) / n)));
  return w;
}

const inSpeech = (t: number, segs: Segment[]) => segs.some((s) => t >= s.start && t <= s.end);

/** Mean noise power spectrum (length n/2+1). */
export function estimateNoiseProfile(
  samples: Float32Array,
  sampleRate: number,
  segments: Segment[],
): Float32Array {
  const n = frameSizeFor(sampleRate);
  const hop = n / 2;
  const fft = new FFT(n);
  const win = window(n);
  const bins = n / 2 + 1;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const frames: { energy: number; spec: Float32Array; noise: boolean }[] = [];
  for (let pos = 0; pos + n <= samples.length; pos += hop) {
    for (let i = 0; i < n; i++) { re[i] = samples[pos + i] * win[i]; im[i] = 0; }
    fft.transform(re, im);
    const spec = new Float32Array(bins);
    let e = 0;
    for (let k = 0; k < bins; k++) { spec[k] = re[k] * re[k] + im[k] * im[k]; e += spec[k]; }
    frames.push({ energy: e, spec, noise: !inSpeech((pos + n / 2) / sampleRate, segments) });
  }
  let pick = frames.filter((f) => f.noise);
  if (pick.length < 5) {
    pick = [...frames].sort((a, b) => a.energy - b.energy).slice(0, Math.max(1, Math.floor(frames.length * 0.1)));
  }
  const profile = new Float32Array(bins);
  for (const f of pick) for (let k = 0; k < bins; k++) profile[k] += f.spec[k];
  for (let k = 0; k < bins; k++) profile[k] /= Math.max(1, pick.length);
  return profile;
}

export async function denoise(
  samples: Float32Array,
  sampleRate: number,
  segments: Segment[],
  opts: DenoiseOptions,
  progress: Progress = {},
): Promise<Float32Array> {
  const n = frameSizeFor(sampleRate);
  const hop = n / 2;
  const bins = n / 2 + 1;
  const fft = new FFT(n);
  const win = window(n);
  const noise = estimateNoiseProfile(samples, sampleRate, segments);
  const floor = Math.pow(10, opts.floorDb / 20);
  const smooth = Math.min(0.95, Math.max(0, opts.smoothing));

  // pad so every sample is covered by two frames
  const padded = new Float32Array(samples.length + 2 * n);
  padded.set(samples, n);
  const out = new Float32Array(padded.length);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const prevGain = new Float32Array(bins).fill(1);
  const gain = new Float32Array(bins);
  const totalFrames = Math.floor((padded.length - n) / hop) + 1;
  const chunk = 400;

  for (let f = 0; f < totalFrames; f++) {
    const pos = f * hop;
    for (let i = 0; i < n; i++) { re[i] = padded[pos + i] * win[i]; im[i] = 0; }
    fft.transform(re, im);

    const tCentre = (pos + n / 2 - n) / sampleRate;
    const isNoise = !inSpeech(tCentre, segments);
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      if (isNoise) noise[k] = 0.97 * noise[k] + 0.03 * p;
      const g = p > 0 ? Math.max(floor * floor, 1 - (opts.overSubtraction * noise[k]) / p) : floor * floor;
      gain[k] = Math.sqrt(g); // power gain → amplitude gain
    }
    // smooth across neighbouring bins, then across time
    for (let k = 0; k < bins; k++) {
      const a = gain[Math.max(0, k - 1)], b = gain[k], c = gain[Math.min(bins - 1, k + 1)];
      const fs = 0.25 * a + 0.5 * b + 0.25 * c;
      const g = smooth * prevGain[k] + (1 - smooth) * fs;
      prevGain[k] = Math.max(floor, Math.min(1, g));
    }
    for (let k = 0; k < bins; k++) {
      const g = prevGain[k];
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < n / 2) { re[n - k] *= g; im[n - k] *= g; }
    }
    fft.transform(re, im, true);
    for (let i = 0; i < n; i++) out[pos + i] += re[i] * win[i];

    if (f % chunk === chunk - 1) {
      if (progress.isCancelled?.()) throw new CancelledError();
      progress.onProgress?.(f / totalFrames);
      if (progress.yieldFn) await progress.yieldFn();
    }
  }
  progress.onProgress?.(1);
  return out.slice(n, n + samples.length);
}

/**
 * Mains-hum detection with Goertzel power at the exact harmonic frequencies versus nearby
 * off-frequencies, measured on non-speech audio. Returns 50, 60 or null.
 */
export function detectHum(samples: Float32Array, sampleRate: number, segments: Segment[]): 50 | 60 | null {
  // collect up to 10 s of non-speech audio
  const parts: Float32Array[] = [];
  let total = 0;
  const maxLen = sampleRate * 10;
  let cursor = 0;
  const gaps: Segment[] = [];
  for (const s of segments) { if (s.start > cursor) gaps.push({ start: cursor, end: s.start }); cursor = s.end; }
  const dur = samples.length / sampleRate;
  if (cursor < dur) gaps.push({ start: cursor, end: dur });
  for (const g of gaps) {
    if (total >= maxLen) break;
    const a = Math.round(g.start * sampleRate);
    const b = Math.min(Math.round(g.end * sampleRate), a + (maxLen - total));
    if (b - a > sampleRate * 0.25) { parts.push(samples.subarray(a, b)); total += b - a; }
  }
  if (total < sampleRate) return null;
  const x = new Float32Array(total);
  let off = 0;
  for (const p of parts) { x.set(p, off); off += p.length; }

  const goertzel = (freq: number) => {
    const w = (2 * Math.PI * freq) / sampleRate;
    const c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
    return s1 * s1 + s2 * s2 - c * s1 * s2;
  };
  const score = (base: number) => {
    let acc = 0;
    for (let h = 1; h <= 4; h++) {
      const on = goertzel(base * h);
      const offP = (goertzel(base * h - 7) + goertzel(base * h + 7)) / 2;
      acc += 10 * Math.log10((on + 1e-20) / (offP + 1e-20));
    }
    return acc / 4;
  };
  const s50 = score(50);
  const s60 = score(60);
  const best = s50 >= s60 ? 50 : 60;
  return Math.max(s50, s60) >= 10 ? best : null;
}
