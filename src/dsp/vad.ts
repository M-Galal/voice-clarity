/**
 * Energy-based speech detection.
 *
 * 1. 20 ms frames → RMS in dBFS, measured on a 100 Hz–4 kHz band-passed copy so rumble
 *    and hiss count less than voice.
 * 2. Noise floor = 10th percentile of frame levels (assumes some pauses exist).
 * 3. A frame is speech when it is `thresholdDb` above the floor (and above `minLevelDb`).
 * 4. Hangover, minimum-speech and minimum-silence rules turn frames into segments,
 *    then `padMs` is added on both sides.
 *
 * This finds *voice-like energy*, not words. Loud non-speech sounds (a door, music) can be
 * marked as speech, and very quiet speech under loud noise can be missed. The UI says so.
 */
import { applyChain, designBiquad } from './biquad';

export interface Segment {
  start: number; // seconds
  end: number; // seconds
}

export interface VadOptions {
  /** dB above the estimated noise floor needed to count as speech. */
  thresholdDb: number;
  /** Absolute minimum frame level in dBFS. */
  minLevelDb: number;
  minSpeechMs: number;
  minSilenceMs: number;
  padMs: number;
  frameMs: number;
}

export const DEFAULT_VAD: VadOptions = {
  thresholdDb: 10,
  minLevelDb: -60,
  minSpeechMs: 250,
  minSilenceMs: 400,
  padMs: 120,
  frameMs: 20,
};

export interface FrameAnalysis {
  frameSec: number;
  levelsDb: Float32Array;
  noiseFloorDb: number;
}

export function analyzeFrames(samples: Float32Array, sampleRate: number, frameMs = 20): FrameAnalysis {
  const band = applyChain(samples, [
    designBiquad('highpass', sampleRate, 100, 0.707),
    designBiquad('lowpass', sampleRate, Math.min(4000, sampleRate * 0.45), 0.707),
  ]);
  const frame = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  const count = Math.ceil(band.length / frame);
  const levels = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    let s = 0;
    const st = f * frame;
    const en = Math.min(band.length, st + frame);
    for (let i = st; i < en; i++) s += band[i] * band[i];
    const ms = s / Math.max(1, en - st);
    levels[f] = ms > 1e-12 ? 10 * Math.log10(ms) : -120;
  }
  const sorted = Float32Array.from(levels).sort();
  const noiseFloorDb = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : -120;
  return { frameSec: frame / sampleRate, levelsDb: levels, noiseFloorDb };
}

export function detectSpeech(
  samples: Float32Array,
  sampleRate: number,
  opts: Partial<VadOptions> = {},
): { segments: Segment[]; analysis: FrameAnalysis; thresholdUsedDb: number } {
  const o = { ...DEFAULT_VAD, ...opts };
  const result = detectWith(samples, sampleRate, o);
  // Noisy files: if nothing passes, retry once with a lower margin before giving up.
  if (result.segments.length === 0 && o.thresholdDb > 6) {
    const retry = detectWith(samples, sampleRate, { ...o, thresholdDb: 6 });
    if (retry.segments.length) return { ...retry, thresholdUsedDb: 6 };
  }
  return { ...result, thresholdUsedDb: o.thresholdDb };
}

function detectWith(
  samples: Float32Array,
  sampleRate: number,
  o: VadOptions,
): { segments: Segment[]; analysis: FrameAnalysis } {
  const analysis = analyzeFrames(samples, sampleRate, o.frameMs);
  const { levelsDb, frameSec, noiseFloorDb } = analysis;
  const threshold = Math.max(noiseFloorDb + o.thresholdDb, o.minLevelDb);
  const duration = samples.length / sampleRate;

  // raw on/off with merging of short gaps
  const raw: Segment[] = [];
  let startF = -1;
  for (let f = 0; f < levelsDb.length; f++) {
    const on = levelsDb[f] >= threshold;
    if (on && startF < 0) startF = f;
    if (!on && startF >= 0) {
      raw.push({ start: startF * frameSec, end: f * frameSec });
      startF = -1;
    }
  }
  if (startF >= 0) raw.push({ start: startF * frameSec, end: levelsDb.length * frameSec });

  const merged: Segment[] = [];
  for (const s of raw) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < o.minSilenceMs / 1000) last.end = s.end;
    else merged.push({ ...s });
  }
  const segments = merged
    .filter((s) => s.end - s.start >= o.minSpeechMs / 1000)
    .map((s) => ({
      start: Math.max(0, s.start - o.padMs / 1000),
      end: Math.min(duration, s.end + o.padMs / 1000),
    }));
  // padding may cause overlaps
  const out: Segment[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push(s);
  }
  return { segments: out.map((s) => ({ start: round3(s.start), end: round3(s.end) })), analysis };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Rough speech-to-noise estimate (dB) from frame levels inside vs outside speech. */
export function estimateSnrDb(analysis: FrameAnalysis, segments: Segment[]): number {
  const { levelsDb, frameSec } = analysis;
  let sp = 0, spN = 0, ns = 0, nsN = 0;
  for (let f = 0; f < levelsDb.length; f++) {
    const t = (f + 0.5) * frameSec;
    const p = Math.pow(10, levelsDb[f] / 10);
    if (segments.some((s) => t >= s.start && t <= s.end)) { sp += p; spN++; } else { ns += p; nsN++; }
  }
  if (spN === 0) return -Infinity;
  if (nsN === 0 || ns === 0) return Infinity;
  return 10 * Math.log10(sp / spN / (ns / nsN));
}

/** Per-sample speech mask (1 = speech) with linear ramps of `rampMs` at the edges. */
export function speechMask(length: number, sampleRate: number, segments: Segment[], rampMs = 30): Float32Array {
  const mask = new Float32Array(length);
  const ramp = Math.max(1, Math.round((rampMs / 1000) * sampleRate));
  for (const s of segments) {
    const a = Math.max(0, Math.round(s.start * sampleRate));
    const b = Math.min(length, Math.round(s.end * sampleRate));
    for (let i = a; i < b; i++) {
      const edge = Math.min(i - a, b - 1 - i);
      const v = edge < ramp ? (edge + 1) / ramp : 1;
      if (v > mask[i]) mask[i] = v;
    }
  }
  return mask;
}

/** Index helpers for navigation. */
export function nextSegmentStart(segments: Segment[], t: number): number | null {
  const s = segments.find((x) => x.start > t + 0.05);
  return s ? s.start : null;
}

export function previousSegmentStart(segments: Segment[], t: number): number | null {
  // jump to the start of the current segment if we are >1 s into it, else the previous one
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (s.start < t - 1) return s.start;
  }
  return segments.length ? segments[0].start : null;
}

/** Where skip-silence playback should jump to, or null if `t` is in speech or close to it. */
export function skipSilenceTarget(segments: Segment[], t: number, minGapSec: number): number | null {
  if (segments.some((s) => t >= s.start && t < s.end)) return null;
  const next = segments.find((s) => s.start > t);
  if (!next) return null;
  return next.start - t >= minGapSec ? next.start : null;
}
