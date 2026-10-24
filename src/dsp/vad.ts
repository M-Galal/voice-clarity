/**
 * Energy-based speech detection with a whisper-sensitive second band.
 *
 * 1. 20 ms frames → RMS in dBFS in two bands:
 *    - voice band 100 Hz–4 kHz (voiced speech, rumble and hiss count less), and
 *    - whisper band 1.5–7 kHz (capped below Nyquist). Whispered and distant speech has
 *      little voiced low end, so its energy shows up here while the voice band barely moves.
 * 2. Each band's noise floor = 10th percentile of its frame levels (assumes some pauses exist).
 * 3. A frame is speech when the voice band is `thresholdDb` above its floor, or (with
 *    `whisper` on) the whisper band is `whisperThresholdDb` above its own floor.
 * 4. Minimum-speech and minimum-silence rules turn frames into segments, then `padMs` is
 *    added on both sides. Segments found mainly through the whisper band are marked
 *    `kind: 'whisper'`.
 *
 * This finds *voice-like energy*, not words. Loud non-speech sounds (a door, music, keyboard
 * clicks in the whisper band) can be marked as speech, and speech fully buried in noise can be
 * missed. The UI says so.
 */
import { BiquadChainState, designBiquad } from './biquad';

export interface Segment {
  start: number; // seconds
  end: number; // seconds
  /** 'whisper' when the segment was found mainly through the whisper band. */
  kind?: 'voice' | 'whisper';
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
  /** Also detect whispered / distant speech through the 1.5–7 kHz band. */
  whisper: boolean;
  /** dB above the whisper-band floor needed to count as (whispered) speech. */
  whisperThresholdDb: number;
}

export const DEFAULT_VAD: VadOptions = {
  thresholdDb: 10,
  minLevelDb: -60,
  minSpeechMs: 250,
  minSilenceMs: 400,
  padMs: 120,
  frameMs: 20,
  whisper: true,
  whisperThresholdDb: 4,
};

export interface FrameAnalysis {
  frameSec: number;
  /** Voice band (100 Hz–4 kHz) frame levels, dBFS. */
  levelsDb: Float32Array;
  noiseFloorDb: number;
  /** Whisper band (1.5–7 kHz) frame levels, dBFS. */
  highLevelsDb: Float32Array;
  highFloorDb: number;
}

const percentile = (x: Float32Array, p: number) => {
  if (!x.length) return -120;
  const sorted = Float32Array.from(x).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

const toDb = (ms: number) => (ms > 1e-12 ? 10 * Math.log10(ms) : -120);

/**
 * Frame levels in the voice and whisper bands, fed chunk by chunk (filters keep their state),
 * so a long recording can be analysed without holding it in memory. Feeding the whole signal
 * at once gives the same result.
 */
export class FrameAnalyzer {
  private readonly band: BiquadChainState;
  private readonly high: BiquadChainState;
  readonly frame: number;
  private bandSum = 0;
  private highSum = 0;
  private filled = 0;
  private readonly bandLevels: number[] = [];
  private readonly highLevels: number[] = [];

  constructor(private readonly sampleRate: number, frameMs = 20) {
    const nyq = sampleRate / 2;
    this.band = new BiquadChainState([
      designBiquad('highpass', sampleRate, 100, 0.707),
      designBiquad('lowpass', sampleRate, Math.min(4000, nyq * 0.9), 0.707),
    ]);
    this.high = new BiquadChainState([
      designBiquad('highpass', sampleRate, Math.min(1500, nyq * 0.5), 0.707),
      designBiquad('highpass', sampleRate, Math.min(1500, nyq * 0.5), 0.707),
      designBiquad('lowpass', sampleRate, Math.min(7000, nyq * 0.9), 0.707),
    ]);
    this.frame = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  }

  push(chunk: Float32Array): void {
    const b = this.band.process(chunk);
    const h = this.high.process(chunk);
    for (let i = 0; i < chunk.length; i++) {
      this.bandSum += b[i] * b[i];
      this.highSum += h[i] * h[i];
      if (++this.filled === this.frame) {
        this.bandLevels.push(toDb(this.bandSum / this.frame));
        this.highLevels.push(toDb(this.highSum / this.frame));
        this.bandSum = 0; this.highSum = 0; this.filled = 0;
      }
    }
  }

  finish(): FrameAnalysis {
    if (this.filled > 0) {
      this.bandLevels.push(toDb(this.bandSum / this.filled));
      this.highLevels.push(toDb(this.highSum / this.filled));
      this.bandSum = 0; this.highSum = 0; this.filled = 0;
    }
    const levelsDb = Float32Array.from(this.bandLevels);
    const rawHigh = Float32Array.from(this.highLevels);
    // whisper energy flickers frame to frame: average its power over ±2 frames (100 ms)
    const highLevelsDb = new Float32Array(rawHigh.length);
    for (let f = 0; f < rawHigh.length; f++) {
      let p = 0, n = 0;
      for (let k = Math.max(0, f - 2); k <= Math.min(rawHigh.length - 1, f + 2); k++) { p += Math.pow(10, rawHigh[k] / 10); n++; }
      highLevelsDb[f] = 10 * Math.log10(p / n);
    }
    return {
      frameSec: this.frame / this.sampleRate,
      levelsDb,
      noiseFloorDb: percentile(levelsDb, 0.1),
      highLevelsDb,
      highFloorDb: percentile(highLevelsDb, 0.1),
    };
  }
}

export function analyzeFrames(samples: Float32Array, sampleRate: number, frameMs = 20): FrameAnalysis {
  const a = new FrameAnalyzer(sampleRate, frameMs);
  a.push(samples);
  return a.finish();
}

export function detectSpeech(
  samples: Float32Array,
  sampleRate: number,
  opts: Partial<VadOptions> = {},
): { segments: Segment[]; analysis: FrameAnalysis; thresholdUsedDb: number } {
  const o = { ...DEFAULT_VAD, ...opts };
  return detectSpeechFromAnalysis(analyzeFrames(samples, sampleRate, o.frameMs), samples.length / sampleRate, o);
}

/** Speech segments from frame levels (see FrameAnalyzer); `analysis` must use opts.frameMs. */
export function detectSpeechFromAnalysis(
  analysis: FrameAnalysis,
  duration: number,
  opts: Partial<VadOptions> = {},
): { segments: Segment[]; analysis: FrameAnalysis; thresholdUsedDb: number } {
  const o = { ...DEFAULT_VAD, ...opts };
  const segments = segmentsWith(analysis, duration, o);
  // Noisy files: if nothing passes, retry once with a lower margin before giving up.
  if (segments.length === 0 && o.thresholdDb > 6) {
    const retry = segmentsWith(analysis, duration, { ...o, thresholdDb: 6 });
    if (retry.length) return { segments: retry, analysis, thresholdUsedDb: 6 };
  }
  return { segments, analysis, thresholdUsedDb: o.thresholdDb };
}

function segmentsWith(analysis: FrameAnalysis, duration: number, o: VadOptions): Segment[] {
  const { levelsDb, highLevelsDb, frameSec, noiseFloorDb, highFloorDb } = analysis;
  const threshold = Math.max(noiseFloorDb + o.thresholdDb, o.minLevelDb);
  // whispers are quiet: allow 15 dB lower absolute level in their band
  const highThreshold = Math.max(highFloorDb + o.whisperThresholdDb, o.minLevelDb - 15);

  // per frame: 0 = silence, 1 = voice band, 2 = whisper band only
  const kind = new Uint8Array(levelsDb.length);
  for (let f = 0; f < levelsDb.length; f++) {
    if (levelsDb[f] >= threshold) kind[f] = 1;
    else if (o.whisper && highLevelsDb[f] >= highThreshold) kind[f] = 2;
  }

  // raw on/off with merging of short gaps
  const raw: Segment[] = [];
  let startF = -1;
  for (let f = 0; f < levelsDb.length; f++) {
    const on = kind[f] > 0;
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
  // label each segment by which band found most of its frames
  const labelled = out.map((s) => {
    const a = Math.floor(s.start / frameSec), b = Math.min(kind.length, Math.ceil(s.end / frameSec));
    let v = 0, w = 0;
    for (let f = a; f < b; f++) { if (kind[f] === 1) v++; else if (kind[f] === 2) w++; }
    const seg: Segment = { start: round3(s.start), end: round3(s.end) };
    if (o.whisper) seg.kind = w > v ? 'whisper' : 'voice';
    return seg;
  });
  return labelled;
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
