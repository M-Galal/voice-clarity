import { applyChain, designBiquad } from './biquad';
import type { Segment } from './vad';

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

/** Low-pass (when downsampling) then linear interpolation. Good enough for speech → ASR. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return Float32Array.from(input);
  let src = input;
  if (to < from) {
    const fc = to * 0.45;
    src = applyChain(input, [designBiquad('lowpass', from, fc, 0.54), designBiquad('lowpass', from, fc, 1.31)]);
  }
  const outLen = Math.floor((input.length * to) / from);
  const out = new Float32Array(outLen);
  const ratio = from / to;
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(src.length - 1, i0 + 1);
    const f = x - i0;
    out[i] = src[i0] * (1 - f) + src[i1] * f;
  }
  return out;
}

/** Peak envelope for drawing a waveform: `bars` values in 0..1. */
export function waveformPeaks(samples: Float32Array, bars: number): number[] {
  const out: number[] = new Array(bars).fill(0);
  if (samples.length === 0) return out;
  const per = samples.length / bars;
  let max = 0;
  for (let b = 0; b < bars; b++) {
    const st = Math.floor(b * per);
    const en = Math.min(samples.length, Math.floor((b + 1) * per));
    let p = 0;
    for (let i = st; i < en; i++) { const a = Math.abs(samples[i]); if (a > p) p = a; }
    out[b] = p;
    if (p > max) max = p;
  }
  return max > 0 ? out.map((v) => Math.round((v / max) * 1000) / 1000) : out;
}

export interface SilenceRemoval {
  output: Float32Array;
  /** Pieces kept: [sourceStart, sourceEnd, outputStart] in seconds, for remapping timestamps. */
  map: [number, number, number][];
}

/**
 * Keeps speech segments, shortening every pause to at most `keepGapMs`, with 10 ms
 * crossfades so joins don't click.
 */
export function removeSilence(
  input: Float32Array,
  sampleRate: number,
  segments: Segment[],
  keepGapMs = 300,
): SilenceRemoval {
  if (segments.length === 0) return { output: Float32Array.from(input), map: [[0, input.length / sampleRate, 0]] };
  const half = keepGapMs / 2000;
  const dur = input.length / sampleRate;
  const pieces: [number, number][] = [];
  for (const s of segments) {
    const a = Math.max(0, s.start - half);
    const b = Math.min(dur, s.end + half);
    const last = pieces[pieces.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else pieces.push([a, b]);
  }
  const fade = Math.round(0.01 * sampleRate);
  const chunks: Float32Array[] = [];
  const map: [number, number, number][] = [];
  let outPos = 0;
  for (const [a, b] of pieces) {
    const c = input.slice(Math.round(a * sampleRate), Math.round(b * sampleRate));
    for (let i = 0; i < Math.min(fade, c.length); i++) {
      const g = i / fade;
      c[i] *= g;
      c[c.length - 1 - i] *= g;
    }
    map.push([a, b, outPos / sampleRate]);
    chunks.push(c);
    outPos += c.length;
  }
  const output = new Float32Array(outPos);
  let off = 0;
  for (const c of chunks) { output.set(c, off); off += c.length; }
  return { output, map };
}

/** Maps a source time to its time in silence-removed audio (null if it was cut). */
export function remapTime(map: [number, number, number][], t: number): number | null {
  for (const [a, b, o] of map) if (t >= a && t <= b) return o + (t - a);
  return null;
}
