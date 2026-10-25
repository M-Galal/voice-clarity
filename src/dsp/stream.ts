/**
 * Chunked ("streaming") versions of the analysis and enhancement pipelines, for recordings too
 * long to hold in memory. Audio is read from a SampleSource in chunks of a few seconds and every
 * stage keeps its state between chunks, so the result matches the whole-buffer functions in
 * vad.ts and pipeline.ts (checked in tests/stream.test.ts) while memory stays roughly constant:
 * a few chunks plus small per-frame statistics.
 *
 * Enhancement passes:
 *  1. frame levels (speech detection), K-weighted loudness blocks, peaks, clipping
 *  2. Smart-mode measures (speech level spread, rumble in pauses) and audio for hum detection
 *  3. noise profile of the filtered signal (when noise suppression is on)
 *  4. high-pass, hum notches, noise suppression, clarity, pause lowering → temporary track A
 *  5. leveller + loudness of the result (for the gain stage)
 *  6. leveller, gain, limiter → temporary track B (repeated with a lower internal ceiling if the
 *     true peak is over the user's ceiling, like the whole-buffer pipeline)
 *  7. optional silence removal, output measurement → output sink
 *
 * Smart mode per section: pass 2 also measures every ~1 s speech window (level, noise around it,
 * whisper or not); the windows are grouped into whispered, distant and close sections with their
 * own noise reduction and clarity, which pass 4 follows with short crossfades at section edges.
 */
import { BiquadChainState, designBiquad, type BiquadCoeffs } from './biquad';
import { chooseSettings, countSections, planSections, type AutoMeasures, type AutoReason, type SectionSetting, type SectionWindow } from './autoTune';
import { CancelledError, detectHum, frameSizeFor, type Progress } from './denoise';
import { RealFFT } from './fft';
import { KLoudnessMeter, kWeightingCoeffs, loudnessFromBlocks, TruePeakMeter, type BlockPower } from './loudness';
import type { EnhanceReport, EnhanceSettings, LevelReport, WarningCode } from './pipeline';
import { clamp, dbToGain } from './units';
import { detectSpeechFromAnalysis, estimateSnrDb, FrameAnalyzer, type Segment } from './vad';

export interface SampleSource {
  readonly length: number;
  readonly sampleRate: number;
  read(start: number, count: number): Promise<Float32Array>;
}

export interface SampleSink {
  write(chunk: Float32Array): Promise<void>;
}

/** A temporary track: written once, then read any number of times. */
export interface TempTrack extends SampleSink {
  /** Ends writing and returns a source for reading the track back. */
  done(): Promise<SampleSource>;
  dispose(): void;
}

/**
 * Creates a temporary track. 'int16' is enough for audio that is already limited below full
 * scale (it saves half the disk space); 'float' keeps headroom for intermediate stages.
 */
export type TempFactory = (sampleRate: number, precision: 'float' | 'int16') => TempTrack;

export class MemorySource implements SampleSource {
  constructor(private readonly data: Float32Array, readonly sampleRate: number) {}
  get length() { return this.data.length; }
  async read(start: number, count: number) { return this.data.slice(start, start + count); }
}

/** A part of another source, starting at `offset`. */
export class RangeSource implements SampleSource {
  constructor(private readonly inner: SampleSource, private readonly offset: number, readonly length: number) {}
  get sampleRate() { return this.inner.sampleRate; }
  async read(start: number, count: number) {
    const n = Math.max(0, Math.min(count, this.length - start));
    return this.inner.read(this.offset + start, n);
  }
}

/** Picks the start (s) of the `windowSec` stretch with the most speech, for previews. */
export function bestPreviewStart(segments: Segment[], durationSec: number, windowSec: number): number {
  if (durationSec <= windowSec) return 0;
  const coverage = (a: number) => segments.reduce((t, s) => t + Math.max(0, Math.min(a + windowSec, s.end) - Math.max(a, s.start)), 0);
  let best = 0, bestCov = -1;
  const candidates = [0, ...segments.map((s) => Math.max(0, s.start - 0.5))];
  for (const c of candidates) {
    const a = Math.min(c, durationSec - windowSec);
    const cov = coverage(a);
    if (cov > bestCov + 1e-9) { best = a; bestCov = cov; }
  }
  return Math.round(best * 10) / 10;
}

export class MemorySink implements SampleSink {
  private parts: Float32Array[] = [];
  async write(chunk: Float32Array) { this.parts.push(Float32Array.from(chunk)); }
  toArray(): Float32Array {
    const n = this.parts.reduce((a, p) => a + p.length, 0);
    const out = new Float32Array(n);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
  reset() { this.parts = []; }
}

export const memoryTemp: TempFactory = (sampleRate) => {
  const sink = new MemorySink();
  return {
    write: (c) => sink.write(c),
    done: async () => new MemorySource(sink.toArray(), sampleRate),
    dispose: () => sink.reset(),
  };
};

export const CHUNK_SEC = 8;
/** Clarity boost of the filter that per-section clarity is mixed from, dB. */
const CLARITY_MAX_DB = 6;
let chunkOverride = 0;
/** Tests only: read in chunks of exactly `n` samples (0 = normal 8 s chunks). */
export function setChunkSamplesForTests(n: number) { chunkOverride = n; }

type Tick = (fraction: number) => Promise<void>;

async function eachChunk(
  src: SampleSource,
  fn: (x: Float32Array, start: number) => void | Promise<void>,
  tick: Tick,
  range: [number, number] = [0, src.length],
): Promise<void> {
  const size = chunkOverride || Math.max(1024, Math.round(src.sampleRate * CHUNK_SEC));
  const [a, b] = range;
  if (b <= a) return;
  for (let pos = a; pos < b; pos += size) {
    const n = Math.min(size, b - pos);
    const x = await src.read(pos, n);
    await fn(x, pos);
    await tick((pos + n - a) / (b - a));
  }
}

function makeTicker(progress: Progress) {
  return (from: number, to: number): Tick => async (f) => {
    if (progress.isCancelled?.()) throw new CancelledError();
    progress.onProgress?.(from + (to - from) * f);
    if (progress.yieldFn) await progress.yieldFn();
  };
}

// ------------------------------------------------------------------ small stateful pieces

/** Runs of ≥ 3 samples at or above 99.9 % full scale (same rule as detectClipping). */
class ClipCounter {
  events = 0;
  times: number[] = [];
  private run = 0;
  constructor(private readonly sampleRate: number) {}
  push(x: Float32Array, start: number) {
    for (let i = 0; i < x.length; i++) {
      if (Math.abs(x[i]) >= 0.999) {
        this.run++;
        if (this.run === 3) {
          this.events++;
          if (this.times.length < 20) this.times.push(Math.round(((start + i - 2) / this.sampleRate) * 100) / 100);
        }
      } else this.run = 0;
    }
  }
}

const peakOf = (x: Float32Array, cur: number) => {
  let p = cur;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
  return p;
};

/** Sample ranges [a, b) inside segments split into ~`winSec` windows (as levelSpeech / measureForAuto). */
function speechWindows(segments: Segment[], sampleRate: number, length: number, winSec: number): { a: number; b: number; whisper: boolean }[] {
  const out: { a: number; b: number; whisper: boolean }[] = [];
  for (const s of segments) {
    const a0 = Math.round(s.start * sampleRate), b0 = Math.min(length, Math.round(s.end * sampleRate));
    const n = Math.max(1, Math.round((b0 - a0) / (winSec * sampleRate)));
    const step = (b0 - a0) / n;
    for (let k = 0; k < n; k++) out.push({ a: Math.round(a0 + k * step), b: Math.round(a0 + (k + 1) * step), whisper: s.kind === 'whisper' });
  }
  return out;
}

/** Sums of squares over a sorted list of non-overlapping ranges, fed chunk by chunk. */
class RangeEnergy {
  readonly sums: Float64Array;
  private wi = 0;
  constructor(private readonly ranges: { a: number; b: number }[]) {
    this.sums = new Float64Array(ranges.length);
  }
  push(w: Float32Array, start: number) {
    const end = start + w.length;
    while (this.wi < this.ranges.length && this.ranges[this.wi].b <= start) this.wi++;
    for (let r = this.wi; r < this.ranges.length && this.ranges[r].a < end; r++) {
      const { a, b } = this.ranges[r];
      let acc = 0;
      for (let i = Math.max(a, start); i < Math.min(b, end); i++) { const v = w[i - start]; acc += v * v; }
      this.sums[r] += acc;
    }
  }
}

/** Value of speechMask(length, sr, segments, rampMs) for samples [start, start+count). */
function maskRange(segments: Segment[], sampleRate: number, length: number, rampMs: number, start: number, count: number): Float32Array {
  const mask = new Float32Array(count);
  const ramp = Math.max(1, Math.round((rampMs / 1000) * sampleRate));
  const end = start + count;
  for (const s of segments) {
    const a = Math.max(0, Math.round(s.start * sampleRate));
    const b = Math.min(length, Math.round(s.end * sampleRate));
    if (b <= start || a >= end) continue;
    for (let i = Math.max(a, start); i < Math.min(b, end); i++) {
      const edge = Math.min(i - a, b - 1 - i);
      const v = edge < ramp ? (edge + 1) / ramp : 1;
      if (v > mask[i - start]) mask[i - start] = v;
    }
  }
  return mask;
}

/** Gaps between segments, as levelled by detectHum / measureForAuto. */
function gapsOf(segments: Segment[], duration: number): [number, number][] {
  const gaps: [number, number][] = [];
  let c = 0;
  for (const s of segments) { if (s.start > c) gaps.push([c, s.start]); c = s.end; }
  if (c < duration) gaps.push([c, duration]);
  return gaps;
}

/**
 * A setting that changes from section to section: constant inside a section, 0.3 s linear ramps
 * where sections meet, a linear move across the pause between two sections. Queries must not go
 * backwards in time (each consumer has its own curve).
 */
export class SectionCurve {
  private readonly t: number[] = [];
  private readonly v: number[] = [];
  private i = 0;
  constructor(sections: SectionSetting[], value: (s: SectionSetting) => number, rampSec = 0.3) {
    for (const s of sections) {
      const r = Math.min(rampSec / 2, (s.end - s.start) / 2);
      const x = value(s);
      this.t.push(s.start + r, s.end - r);
      this.v.push(x, x);
    }
  }
  at(time: number): number {
    const { t, v } = this;
    const n = t.length;
    if (n === 0) return 0;
    if (time <= t[0]) return v[0];
    while (this.i + 1 < n && t[this.i + 1] <= time) this.i++;
    if (this.i >= n - 1) return v[n - 1];
    const a = t[this.i], b = t[this.i + 1];
    return b > a ? v[this.i] + ((v[this.i + 1] - v[this.i]) * (time - a)) / (b - a) : v[this.i + 1];
  }
}

// ------------------------------------------------------------------ noise suppression

function sqrtHann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * i) / n)));
  return w;
}

/** Concatenates a kept tail with a new chunk. */
function joinBuf(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Mean noise power spectrum, fed chunk by chunk (same frames as estimateNoiseProfile). */
class NoiseProfileAccumulator {
  private readonly n: number;
  private readonly hop: number;
  private readonly bins: number;
  private readonly fft: RealFFT;
  private readonly win: Float32Array;
  private readonly frameBuf: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private tail = new Float32Array(0);
  private tailStart = 0;
  private nextPos = 0;
  private frame = 0;
  readonly energies: number[] = [];
  readonly sum: Float64Array;
  count = 0;

  /**
   * select: null = frames outside speech; otherwise a set of frame indexes to average.
   * withEnergies: also transform speech frames to record every frame's energy (only needed for
   * the no-pauses fallback; otherwise speech frames are skipped, which saves most of the work).
   */
  constructor(private readonly sampleRate: number, private readonly segments: Segment[], private readonly select: Set<number> | null = null, private readonly withEnergies = false) {
    this.n = frameSizeFor(sampleRate);
    this.hop = this.n / 2;
    this.bins = this.n / 2 + 1;
    this.fft = new RealFFT(this.n);
    this.win = sqrtHann(this.n);
    this.frameBuf = new Float32Array(this.n);
    this.re = new Float32Array(this.bins);
    this.im = new Float32Array(this.bins);
    this.sum = new Float64Array(this.bins);
  }

  private si = 0;
  /** Frame centres only move forward, so a moving index replaces a search of all segments. */
  private isNoise(pos: number) {
    const t = (pos + this.n / 2) / this.sampleRate;
    const segs = this.segments;
    while (this.si < segs.length && segs[this.si].end < t) this.si++;
    return !(this.si < segs.length && t >= segs[this.si].start && t <= segs[this.si].end);
  }

  push(x: Float32Array) {
    const buf = joinBuf(this.tail, x);
    const end = this.tailStart + buf.length;
    const n = this.n, bins = this.bins, frameBuf = this.frameBuf, win = this.win, re = this.re, im = this.im, sum = this.sum;
    while (this.nextPos + n <= end) {
      const off = this.nextPos - this.tailStart;
      const take = this.select ? this.select.has(this.frame) : this.isNoise(this.nextPos);
      if (!take && !this.withEnergies) {
        this.frame++;
        this.nextPos += this.hop;
        continue;
      }
      for (let i = 0; i < n; i++) frameBuf[i] = buf[off + i] * win[i];
      this.fft.forward(frameBuf, re, im);
      let e = 0;
      for (let k = 0; k < bins; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        e += p;
        if (take) sum[k] += p;
      }
      if (take) this.count++;
      if (this.withEnergies) this.energies.push(e);
      this.frame++;
      this.nextPos += this.hop;
    }
    const keep = Math.max(this.tailStart, this.nextPos);
    this.tail = buf.slice(keep - this.tailStart);
    this.tailStart = keep;
  }

  profile(): Float32Array {
    const p = new Float32Array(this.bins);
    for (let k = 0; k < this.bins; k++) p[k] = this.sum[k] / Math.max(1, this.count);
    return p;
  }
}

/** Spectral subtraction fed chunk by chunk; output equals denoise() on the whole signal. */
class StreamingDenoiser {
  private readonly n: number;
  private readonly hop: number;
  private readonly bins: number;
  private readonly fft: RealFFT;
  private readonly win: Float32Array;
  private readonly floor: number;
  private readonly smooth: number;
  private readonly frameBuf: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly prevGain: Float32Array;
  private readonly gain: Float32Array;
  private readonly acc: Float32Array; // overlap-add for padded positions [framePos, framePos + n)
  private pend: Float32Array; // padded input from pendStart
  private pendStart = 0;
  private framePos = 0;
  private frame = 0;
  private emitted = 0;
  private si = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly segments: Segment[],
    private readonly noise: Float32Array,
    private readonly opts: { overSubtraction: number; floorDb: number; smoothing: number },
    private readonly length: number,
    /** Per-section over-subtraction and floor (dB); replaces opts.overSubtraction / floorDb. */
    private readonly control: { over: SectionCurve; floorDb: SectionCurve } | null = null,
  ) {
    this.n = frameSizeFor(sampleRate);
    this.hop = this.n / 2;
    this.bins = this.n / 2 + 1;
    this.fft = new RealFFT(this.n);
    this.win = sqrtHann(this.n);
    this.floor = Math.pow(10, opts.floorDb / 20);
    this.smooth = Math.min(0.95, Math.max(0, opts.smoothing));
    this.frameBuf = new Float32Array(this.n);
    this.re = new Float32Array(this.bins);
    this.im = new Float32Array(this.bins);
    this.prevGain = new Float32Array(this.bins).fill(1);
    this.gain = new Float32Array(this.bins);
    this.acc = new Float32Array(this.n);
    this.pend = new Float32Array(this.n); // leading padding
  }

  private speech(f: number): boolean {
    const t = (f * this.hop + this.n / 2 - this.n) / this.sampleRate;
    while (this.si < this.segments.length && this.segments[this.si].end < t) this.si++;
    return this.si < this.segments.length && t >= this.segments[this.si].start && t <= this.segments[this.si].end;
  }

  private runFrames(limit: number, out: number[] | Float32Array[]): void {
    const parts = out as Float32Array[];
    const n = this.n, bins = this.bins, hop = this.hop, frameBuf = this.frameBuf, win = this.win;
    const re = this.re, im = this.im, noise = this.noise, gain = this.gain, prevGain = this.prevGain, acc = this.acc;
    const smooth = this.smooth;
    while (this.framePos + n <= limit) {
      const off = this.framePos - this.pendStart;
      const pend = this.pend;
      for (let i = 0; i < n; i++) frameBuf[i] = pend[off + i] * win[i];
      this.fft.forward(frameBuf, re, im);
      const isNoise = !this.speech(this.frame);
      let floor = this.floor;
      let over = this.opts.overSubtraction;
      if (this.control) {
        const t = (this.frame * this.hop + this.n / 2 - this.n) / this.sampleRate;
        over = clamp(this.control.over.at(t), 0.5, 3);
        floor = Math.pow(10, clamp(this.control.floorDb.at(t), -40, -3) / 20);
      }
      const f2 = floor * floor;
      for (let k = 0; k < bins; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        if (isNoise) noise[k] = 0.97 * noise[k] + 0.03 * p;
        let g = f2;
        if (p > 0) { const v = 1 - (over * noise[k]) / p; g = v > f2 ? v : f2; }
        gain[k] = Math.sqrt(g);
      }
      const last = bins - 1;
      for (let k = 0; k < bins; k++) {
        const a = gain[k > 0 ? k - 1 : 0], b = gain[k], c = gain[k < last ? k + 1 : last];
        const fs = 0.25 * a + 0.5 * b + 0.25 * c;
        const g = smooth * prevGain[k] + (1 - smooth) * fs;
        prevGain[k] = Math.max(floor, Math.min(1, g));
      }
      for (let k = 0; k < bins; k++) { const g = prevGain[k]; re[k] *= g; im[k] *= g; }
      this.fft.inverse(re, im, frameBuf);
      for (let i = 0; i < n; i++) acc[i] += frameBuf[i] * win[i];
      // samples [framePos, framePos + hop) receive no more frames
      parts.push(this.emit(this.framePos, hop));
      acc.copyWithin(0, hop);
      acc.fill(0, n - hop);
      this.framePos += hop;
      this.frame++;
    }
  }

  /** Output for padded positions [pos, pos + count) that fall inside the real signal. */
  private emit(pos: number, count: number): Float32Array {
    const a = Math.max(pos, this.n + this.emitted);
    const b = Math.min(pos + count, this.n + this.length);
    if (b <= a) return new Float32Array(0);
    const out = this.acc.slice(a - pos, b - pos);
    this.emitted += out.length;
    return out;
  }

  private dropBefore(pos: number) {
    if (pos > this.pendStart) {
      this.pend = this.pend.slice(pos - this.pendStart);
      this.pendStart = pos;
    }
  }

  push(x: Float32Array): Float32Array {
    this.pend = joinBuf(this.pend, x);
    const parts: Float32Array[] = [];
    this.runFrames(this.pendStart + this.pend.length, parts);
    this.dropBefore(this.framePos);
    return concat(parts);
  }

  finish(): Float32Array {
    this.pend = joinBuf(this.pend, new Float32Array(this.n)); // trailing padding
    const parts: Float32Array[] = [];
    this.runFrames(this.pendStart + this.pend.length, parts);
    // whatever is left in the accumulator is final
    parts.push(this.emit(this.framePos, this.n));
    return concat(parts);
  }
}

function concat(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0];
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ------------------------------------------------------------------ limiter

/** The look-ahead limiter of dynamics.limit(), fed chunk by chunk (output delayed by the look-ahead). */
class StreamingLimiter {
  private readonly ceil: number;
  private readonly L: number;
  private readonly atk: number;
  private readonly rel: number;
  private readonly heavyGain = dbToGain(-3);
  private readonly ringIn: Float32Array;
  private readonly ringReq: Float32Array;
  private readonly dq: Int32Array;
  private head = 0;
  private tail = 0;
  private j = 0; // next input index
  private i = 0; // next output index
  private g = 1;
  maxRed = 1;
  heavy = 0;

  constructor(sampleRate: number, ceilingDb: number, private readonly length: number, lookaheadMs = 5, releaseMs = 80) {
    this.ceil = dbToGain(ceilingDb);
    this.L = Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate));
    this.atk = 1 - Math.exp(-4.6 / this.L);
    this.rel = 1 - Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
    const cap = this.L + 2;
    this.ringIn = new Float32Array(cap);
    this.ringReq = new Float32Array(cap);
    this.dq = new Int32Array(cap + 1);
  }

  private cap() { return this.ringIn.length; }

  private outOne(out: Float32Array, o: number) {
    const i = this.i;
    while (this.dq[this.head % this.dq.length] < i) this.head++;
    const t = this.ringReq[this.dq[this.head % this.dq.length] % this.cap()];
    this.g += (t - this.g) * (t < this.g ? this.atk : this.rel);
    let y = this.ringIn[i % this.cap()] * this.g;
    if (y > this.ceil) y = this.ceil; else if (y < -this.ceil) y = -this.ceil;
    out[o] = y;
    if (this.g < this.maxRed) this.maxRed = this.g;
    if (this.g < this.heavyGain) this.heavy++;
    this.i++;
  }

  push(x: Float32Array): Float32Array {
    // same steps as outOne, with the state in locals (much faster on an interpreter)
    const out = new Float32Array(x.length);
    let o = 0;
    const ceil = this.ceil, L = this.L, atk = this.atk, rel = this.rel, heavyGain = this.heavyGain;
    const ringIn = this.ringIn, ringReq = this.ringReq, dq = this.dq;
    const cap = ringIn.length, dl = dq.length;
    let head = this.head, tail = this.tail, j = this.j, i = this.i, g = this.g, maxRed = this.maxRed, heavy = this.heavy;
    const n = x.length;
    for (let k = 0; k < n; k++) {
      const v = x[k];
      const a = v < 0 ? -v : v;
      const r = a > ceil ? ceil / a : 1;
      ringIn[j % cap] = v;
      ringReq[j % cap] = r;
      while (tail > head && ringReq[dq[(tail - 1) % dl] % cap] >= r) tail--;
      dq[tail % dl] = j;
      tail++;
      j++;
      // output i once inputs up to i + L are in (or the signal ends there)
      if (j - 1 >= i + L) {
        while (dq[head % dl] < i) head++;
        const t = ringReq[dq[head % dl] % cap];
        g += (t - g) * (t < g ? atk : rel);
        let y = ringIn[i % cap] * g;
        if (y > ceil) y = ceil; else if (y < -ceil) y = -ceil;
        out[o++] = y;
        if (g < maxRed) maxRed = g;
        if (g < heavyGain) heavy++;
        i++;
      }
    }
    this.head = head; this.tail = tail; this.j = j; this.i = i; this.g = g; this.maxRed = maxRed; this.heavy = heavy;
    return out.subarray(0, o);
  }

  finish(): Float32Array {
    const out = new Float32Array(this.length - this.i);
    let o = 0;
    while (this.i < this.length) this.outOne(out, o++);
    return out;
  }
}

// ------------------------------------------------------------------ leveller

interface LevelPlan {
  lin: Float32Array; // smoothed gains per 10 ms block
  block: number;
  maxBoostDb: number;
}

function planLeveller(windows: { a: number; b: number }[], sums: Float64Array, length: number, sampleRate: number, maxBoostDb: number, refP = 0.8): LevelPlan | null {
  if (windows.length === 0) return null;
  const dbs = windows.map((w, i) => {
    const ms = sums[i] / Math.max(1, w.b - w.a);
    return ms > 1e-12 ? 10 * Math.log10(ms) : -120;
  });
  const levels = [...dbs].sort((p, q) => p - q);
  const ref = levels[Math.min(levels.length - 1, Math.floor(refP * levels.length))];
  const boosts = dbs.map((d) => Math.max(0, Math.min(maxBoostDb, ref - d)));
  const block = Math.max(1, Math.round(0.01 * sampleRate));
  const nb = Math.ceil(length / block);
  const env = new Float32Array(nb);
  windows.forEach((w, i) => {
    for (let k = Math.floor(w.a / block); k < Math.min(nb, Math.ceil(w.b / block)); k++) env[k] = boosts[i];
  });
  const smooth = new Float32Array(nb);
  const R = 4;
  for (let k = 0; k < nb; k++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, k - R); j <= Math.min(nb - 1, k + R); j++) { s += env[j]; c++; }
    smooth[k] = s / c;
  }
  const lin = new Float32Array(nb);
  for (let k = 0; k < nb; k++) lin[k] = Math.pow(10, smooth[k] / 20);
  return { lin, block, maxBoostDb: boosts.reduce((a, b) => Math.max(a, b), 0) };
}

function applyLevel(x: Float32Array, start: number, plan: LevelPlan): Float32Array {
  const { lin, block } = plan;
  const nb = lin.length;
  const out = new Float32Array(x.length);
  for (let k = 0; k < x.length; k++) {
    const i = start + k;
    const pos = i / block - 0.5;
    const k0 = Math.max(0, Math.min(nb - 1, Math.floor(pos)));
    const k1 = Math.min(nb - 1, k0 + 1);
    const f = Math.max(0, Math.min(1, pos - k0));
    out[k] = x[k] * (lin[k0] * (1 - f) + lin[k1] * f);
  }
  return out;
}

// ------------------------------------------------------------------ analysis

export interface StreamAnalysis {
  durationSec: number;
  segments: Segment[];
  noiseFloorDb: number;
  waveform: number[];
}

/** Speech detection and waveform for the player, read in chunks. */
export async function analyseStream(src: SampleSource, vad: Partial<{ thresholdDb: number; whisper: boolean }>, progress: Progress = {}, bars = 400): Promise<StreamAnalysis> {
  const tick = makeTicker(progress)(0, 1);
  const fa = new FrameAnalyzer(src.sampleRate);
  const peaks = new Array<number>(bars).fill(0);
  const per = src.length / bars;
  await eachChunk(src, (x, start) => {
    fa.push(x);
    // waveformPeaks: bar b covers [floor(b*per), floor((b+1)*per))
    for (let k = 0; k < x.length; k++) {
      const i = start + k;
      let b = Math.floor(i / per);
      if (b >= bars) b = bars - 1;
      while (b > 0 && Math.floor(b * per) > i) b--;
      while (b < bars - 1 && Math.floor((b + 1) * per) <= i) b++;
      const a = Math.abs(x[k]);
      if (a > peaks[b]) peaks[b] = a;
    }
  }, tick);
  const analysis = fa.finish();
  const { segments } = detectSpeechFromAnalysis(analysis, src.length / src.sampleRate, vad);
  const max = peaks.reduce((a, b) => Math.max(a, b), 0);
  return {
    durationSec: src.length / src.sampleRate,
    segments,
    noiseFloorDb: analysis.noiseFloorDb,
    waveform: max > 0 ? peaks.map((v) => Math.round((v / max) * 1000) / 1000) : peaks,
  };
}

// ------------------------------------------------------------------ enhancement

interface FileMeasures {
  segments: Segment[];
  analysis: ReturnType<FrameAnalyzer['finish']>;
  snrDb: number;
  input: LevelReport;
  clip: ClipCounter;
  /** Up to 10 s of non-speech audio, for hum detection. */
  humAudio: Float32Array;
  /** Smart-mode measurements (only when asked for). */
  measures?: AutoMeasures;
  /** ~1 s speech windows for per-section settings (only with the measurements). */
  windows?: SectionWindow[];
}

/** Passes 1-2 of the enhancement: speech, input levels, Smart-mode measures, audio for hum detection. */
async function measureFile(src: SampleSource, vad: EnhanceSettings['vad'], wantAuto: boolean, tick: Tick): Promise<FileMeasures> {
  const sr = src.sampleRate;
  const len = src.length;
  const durationSec = len / sr;
  const half = async (from: number, to: number, f: number) => tick(from + (to - from) * f);
  // pass 1: frame levels, loudness blocks, peaks, clipping
  const fa = new FrameAnalyzer(sr, vad.frameMs ?? 20);
  const inMeter = new KLoudnessMeter(sr);
  const inTp = new TruePeakMeter();
  const clip = new ClipCounter(sr);
  let inPeak = 0;
  await eachChunk(src, (x, start) => {
    fa.push(x);
    inMeter.push(x);
    inTp.push(x, start + x.length >= len);
    clip.push(x, start);
    inPeak = peakOf(x, inPeak);
  }, (f) => half(0, 0.6, f));
  const { segments, analysis } = detectSpeechFromAnalysis(fa.finish(), durationSec, vad);
  const snrDb = estimateSnrDb(analysis, segments);
  const inLoud = loudnessFromBlocks(inMeter.blocks(), sr, segments);
  const input: LevelReport = {
    integratedLufs: inLoud.integrated,
    speechLufs: inLoud.speech,
    samplePeakDb: inPeak > 0 ? 20 * Math.log10(inPeak) : -Infinity,
    truePeakDb: inTp.db,
  };

  // pass 2: Smart-mode measures and hum audio
  const gaps = gapsOf(segments, durationSec);
  const humRanges: { a: number; b: number }[] = [];
  {
    let total = 0;
    const maxLen = sr * 10;
    for (const [gs, ge] of gaps) {
      if (total >= maxLen) break;
      const a = Math.round(gs * sr);
      const b = Math.min(Math.round(ge * sr), a + (maxLen - total));
      if (b - a > sr * 0.25) { humRanges.push({ a, b }); total += b - a; }
    }
  }
  const humAudio = humRanges.map((r) => new Float32Array(r.b - r.a));
  const gapRanges = gaps.map(([a, b]) => ({ a: Math.round(a * sr), b: Math.min(len, Math.round(b * sr)) }));
  const spreadWins = speechWindows(segments, sr, len, 1);
  const spreadE = new RangeEnergy(spreadWins);
  const kw = new BiquadChainState(kWeightingCoeffs(sr));
  const lowF = new BiquadChainState([designBiquad('lowpass', sr, 100, 0.707), designBiquad('lowpass', sr, 100, 0.707)]);
  const midF = new BiquadChainState([designBiquad('highpass', sr, 100, 0.707), designBiquad('lowpass', sr, Math.min(4000, sr * 0.45), 0.707)]);
  const lowE = new RangeEnergy(gapRanges);
  const midE = new RangeEnergy(gapRanges);
  await eachChunk(src, (x, start) => {
    const end = start + x.length;
    humRanges.forEach((r, i) => {
      const a = Math.max(r.a, start), b = Math.min(r.b, end);
      if (b > a) humAudio[i].set(x.subarray(a - start, b - start), a - r.a);
    });
    if (wantAuto) {
      spreadE.push(kw.process(x), start);
      lowE.push(lowF.process(x), start);
      midE.push(midF.process(x), start);
    }
  }, (f) => half(0.6, 1, f));
  let measures: AutoMeasures | undefined;
  let windows: SectionWindow[] | undefined;
  if (wantAuto) {
    const winDb = spreadWins.map((w, i) => 10 * Math.log10(spreadE.sums[i] / Math.max(1, w.b - w.a) + 1e-12));
    windows = sectionWindows(spreadWins, winDb, analysis, segments, sr, durationSec);
    const levels = [...winDb].sort((p, q) => p - q);
    const pick = (p: number) => (levels.length ? levels[Math.min(levels.length - 1, Math.floor(p * levels.length))] : 0);
    const n = (rs: { a: number; b: number }[]) => rs.reduce((t, r) => t + Math.max(0, r.b - r.a), 0);
    const gapN = n(gapRanges);
    const low = gapN ? lowE.sums.reduce((a, b) => a + b, 0) / gapN : 0;
    const mid = gapN ? midE.sums.reduce((a, b) => a + b, 0) / gapN : 0;
    const speechTime = segments.reduce((t, s) => t + (s.end - s.start), 0);
    const whisperTime = segments.filter((s) => s.kind === 'whisper').reduce((t, s) => t + (s.end - s.start), 0);
    measures = {
      snrDb,
      whisperShare: speechTime > 0 ? whisperTime / speechTime : 0,
      spreadDb: levels.length >= 2 ? pick(0.9) - pick(0.1) : 0,
      rumbleDb: low > 0 && mid > 0 ? 10 * Math.log10(low / mid) : -60,
      speechRefDb: levels.length ? pick(0.8) : undefined,
    };
  }
  const total = humAudio.reduce((t, h) => t + h.length, 0);
  const joined = new Float32Array(total);
  let off = 0;
  for (const h of humAudio) { joined.set(h, off); off += h.length; }
  return { segments, analysis, snrDb, input, clip, humAudio: joined, measures, windows };
}

/** Pauses within this distance (s) of a window are its local noise. */
const LOCAL_NOISE_SEC = 15;

/**
 * Speech windows with their level and their speech-to-noise ratio against the pauses around them
 * (voice band, from the speech-detection frames); the whole file's pauses when there are too few nearby.
 */
function sectionWindows(
  wins: { a: number; b: number; whisper: boolean }[],
  winDb: number[],
  analysis: ReturnType<FrameAnalyzer['finish']>,
  segments: Segment[],
  sampleRate: number,
  durationSec: number,
): SectionWindow[] {
  const { levelsDb, frameSec } = analysis;
  const bins = Math.ceil(durationSec) + 1;
  const nP = new Float64Array(bins + 1); // prefix sums per second: noise power, noise frames
  const nC = new Float64Array(bins + 1);
  const pw = (db: number) => Math.pow(10, db / 10);
  let si = 0;
  for (let f = 0; f < levelsDb.length; f++) {
    const t = (f + 0.5) * frameSec;
    while (si < segments.length && segments[si].end < t) si++;
    const speech = si < segments.length && t >= segments[si].start && t <= segments[si].end;
    if (speech) continue;
    const b = Math.min(bins - 1, Math.floor(t));
    nP[b + 1] += pw(levelsDb[f]);
    nC[b + 1] += 1;
  }
  for (let b = 1; b <= bins; b++) { nP[b] += nP[b - 1]; nC[b] += nC[b - 1]; }
  const globalNoise = nC[bins] > 0 ? nP[bins] / nC[bins] : 0;
  const minFrames = 0.5 / frameSec;
  return wins.map((w, i) => {
    const start = w.a / sampleRate, end = w.b / sampleRate;
    const f0 = Math.max(0, Math.floor(start / frameSec)), f1 = Math.min(levelsDb.length, Math.ceil(end / frameSec));
    let sp = 0;
    for (let f = f0; f < f1; f++) sp += pw(levelsDb[f]);
    sp /= Math.max(1, f1 - f0);
    const c = (start + end) / 2;
    const lo = Math.max(0, Math.floor(c - LOCAL_NOISE_SEC)), hi = Math.min(bins, Math.ceil(c + LOCAL_NOISE_SEC));
    const cnt = nC[hi] - nC[lo];
    const noise = cnt >= minFrames ? (nP[hi] - nP[lo]) / cnt : globalNoise;
    const snrDb = noise > 0 && sp > 0 ? 10 * Math.log10(sp / noise) : Infinity;
    return { start, end, levelDb: winDb[i], snrDb, whisper: w.whisper };
  });
}

interface SmartChoice {
  settings: EnhanceSettings;
  reasons: AutoReason[];
  sections: SectionSetting[] | null;
}

/** Smart-mode settings for the file and, when asked, for each section of it. */
function smartChoice(requested: EnhanceSettings, fm: FileMeasures): SmartChoice {
  const measures = requested.autoMeasures ?? fm.measures!;
  const chosen = chooseSettings(requested, measures);
  const refDb = measures.speechRefDb ?? fm.measures?.speechRefDb;
  let sections: SectionSetting[] | null = null;
  if (requested.perSection !== false && fm.windows?.length && refDb !== undefined) {
    sections = planSections(fm.windows, refDb);
    const n = countSections(sections);
    chosen.reasons.push({ key: 'auto_sections', vars: { whisper: n.whisper, far: n.far, near: n.near } });
  }
  return { settings: chosen.settings, reasons: chosen.reasons, sections };
}

export interface SmartAnalysis {
  measures: AutoMeasures;
  settings: EnhanceSettings;
  reasons: AutoReason[];
  humHz: 50 | 60 | null;
  segments: Segment[];
  input: LevelReport;
  /** Set when only parts of a long recording were analysed. */
  sampled?: { parts: number; seconds: number };
  /** Per-section settings (Smart mode per section), times in seconds of the analysed audio. */
  sections: SectionSetting[] | null;
}

/**
 * Smart mode on the whole file: measures the recording (speech, noise, whispers, level spread,
 * rumble, hum) and chooses the settings for the clearest speech. Same measurements and choices
 * as enhanceStream makes in Smart mode.
 */
export async function analyseForSmart(src: SampleSource, requested: EnhanceSettings, progress: Progress = {}): Promise<SmartAnalysis> {
  const fm = await measureFile(src, requested.vad, true, makeTicker(progress)(0, 1));
  const { autoMeasures: _ignored, ...own } = requested; // always this file's own measurements
  void _ignored;
  const chosen = smartChoice(own, fm);
  const humHz = chosen.settings.humRemoval && fm.humAudio.length >= src.sampleRate ? detectHum(fm.humAudio, src.sampleRate, []) : null;
  return { measures: fm.measures!, settings: chosen.settings, reasons: chosen.reasons, humHz, segments: fm.segments, input: fm.input, sections: chosen.sections };
}

export interface StreamEnhanceResult {
  report: EnhanceReport;
  /** Output length in samples. */
  outputLength: number;
  /** Smart mode per section: the sections and their settings (input timeline). */
  sections: SectionSetting[] | null;
}

export async function enhanceStream(
  src: SampleSource,
  sink: SampleSink,
  requested: EnhanceSettings,
  temp: TempFactory,
  progress: Progress = {},
  /** Called once the input is no longer needed (after pass 4), so its file can be deleted early. */
  releaseInput?: () => void,
): Promise<StreamEnhanceResult> {
  const sr = src.sampleRate;
  const len = src.length;
  const durationSec = len / sr;
  const ticker = makeTicker(progress);
  const stages: string[] = [];
  let settings = requested;
  let autoReasons: AutoReason[] | undefined;
  const tracks: TempTrack[] = [];

  try {
    // ---- passes 1-2: speech, levels, Smart-mode measures, hum audio
    const fm = await measureFile(src, settings.vad, requested.strength === 'auto', ticker(0, 0.2));
    const { segments, analysis, snrDb, input, clip, humAudio } = fm;
    stages.push('analyse');
    let sections: SectionSetting[] | null = null;
    if (fm.measures) {
      const chosen = smartChoice(requested, fm);
      settings = chosen.settings;
      autoReasons = chosen.reasons;
      sections = chosen.sections;
      stages.push('smart-settings');
      if (sections) stages.push('per-section');
    }
    void analysis;

    const chain: BiquadCoeffs[] = [];
    if (settings.highPassHz > 0) {
      chain.push(designBiquad('highpass', sr, settings.highPassHz, 0.707));
      stages.push('high-pass');
    }
    let humHz: 50 | 60 | null = null;
    if (settings.humRemoval) {
      humHz = humAudio.length >= sr ? detectHum(humAudio, sr, []) : null;
      if (humHz) {
        for (let h = 1; h <= 4 && humHz * h < sr / 2; h++) chain.push(designBiquad('notch', sr, humHz * h, 30));
        stages.push(`hum-${humHz}`);
      }
    }

    // ---- pass 3: noise profile of the filtered signal
    let noiseProfile: Float32Array | null = null;
    if (settings.noiseSuppression) {
      const pre = new BiquadChainState(chain);
      const acc = new NoiseProfileAccumulator(sr, segments);
      await eachChunk(src, (x) => acc.push(pre.process(x)), ticker(0.2, 0.3));
      if (acc.count >= 5) noiseProfile = acc.profile();
      else {
        // no pauses: the quietest 10 % of frames (same choice as estimateNoiseProfile)
        const preE = new BiquadChainState(chain);
        const accE = new NoiseProfileAccumulator(sr, segments, null, true);
        await eachChunk(src, (x) => accE.push(preE.process(x)), ticker(0.3, 0.31));
        const k = Math.max(1, Math.floor(accE.energies.length * 0.1));
        const order = accE.energies.map((e, i) => [e, i] as const).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
        const pick = new Set(order.slice(0, k).map(([, i]) => i));
        const pre2 = new BiquadChainState(chain);
        const acc2 = new NoiseProfileAccumulator(sr, segments, pick);
        await eachChunk(src, (x) => acc2.push(pre2.process(x)), ticker(0.31, 0.33));
        noiseProfile = acc2.profile();
      }
    }

    // ---- pass 4: filters, noise suppression, clarity, pause lowering → track A
    const trackA = temp(sr, 'float');
    tracks.push(trackA);
    const pre = new BiquadChainState(chain);
    const dn = noiseProfile
      ? new StreamingDenoiser(
        sr, segments, noiseProfile,
        { overSubtraction: clamp(settings.noiseAmount, 0.5, 3), floorDb: clamp(settings.noiseFloorDb, -40, -3), smoothing: 0.6 }, len,
        sections ? { over: new SectionCurve(sections, (x) => x.noiseAmount), floorDb: new SectionCurve(sections, (x) => x.noiseFloorDb) } : null,
      )
      : null;
    if (dn) stages.push('noise-suppression');
    // per section: the full-boost filter is mixed with the dry signal (exact gain at the centre frequency)
    const clarityCurve = sections && sr > 8000 ? new SectionCurve(sections, (x) => x.clarityDb) : null;
    const clarityMax = clarityCurve ? CLARITY_MAX_DB : clamp(settings.clarityDb, 0, 8);
    const clarity = clarityMax > 0 && sr > 8000
      ? new BiquadChainState([designBiquad('peaking', sr, Math.min(3000, sr * 0.4), 0.9, clarityMax)])
      : null;
    if (clarity) stages.push('clarity');
    const clarityBlock = Math.max(1, Math.round(0.01 * sr));
    let mixBlock = -1, mixNextBlock = -1, mixW0 = 0, mixW1 = 0;
    const mixFor = (db: number) => (Math.pow(10, clamp(db, 0, clarityMax) / 20) - 1) / (Math.pow(10, clarityMax / 20) - 1);
    const gapDb = settings.pauseReductionDb > 0 && segments.length ? settings.pauseReductionDb : 0;
    if (settings.pauseReductionDb > 0) stages.push('pause-reduction');
    const gapGain = dbToGain(-gapDb);
    const useLevel = settings.levelSpeech && segments.length > 0;
    const levelWins = useLevel ? speechWindows(segments, sr, len, 1) : [];
    const levelE = new RangeEnergy(levelWins);
    const levelK = new BiquadChainState(kWeightingCoeffs(sr));
    let aPos = 0;
    const stageA = async (y: Float32Array) => {
      if (y.length === 0) return;
      let z = clarity ? clarity.process(y) : y;
      if (clarity && clarityCurve) {
        // wet/dry mix, interpolated between control points every 10 ms of the file (chunk-independent)
        const o = new Float32Array(y.length);
        for (let i = 0; i < y.length; i++) {
          const p = aPos + i;
          const blk = Math.floor(p / clarityBlock);
          if (blk !== mixBlock) {
            mixBlock = blk;
            if (blk === mixNextBlock) mixW0 = mixW1;
            else mixW0 = mixFor(clarityCurve.at((blk * clarityBlock) / sr));
            mixW1 = mixFor(clarityCurve.at(((blk + 1) * clarityBlock) / sr));
            mixNextBlock = blk + 1;
          }
          const w = mixW0 + ((mixW1 - mixW0) * (p - blk * clarityBlock)) / clarityBlock;
          o[i] = y[i] + w * (z[i] - y[i]);
        }
        z = o;
      }
      if (gapDb > 0) {
        const m = maskRange(segments, sr, len, 40, aPos, z.length);
        const o = new Float32Array(z.length);
        for (let i = 0; i < z.length; i++) o[i] = z[i] * (m[i] + (1 - m[i]) * gapGain);
        z = o;
      }
      if (useLevel) levelE.push(levelK.process(z), aPos);
      aPos += z.length;
      await trackA.write(z);
    };
    await eachChunk(src, async (x) => {
      const f = pre.process(x);
      await stageA(dn ? dn.push(f) : f);
    }, ticker(0.33, 0.8));
    if (dn) await stageA(dn.finish());
    const srcA = await trackA.done();
    releaseInput?.();

    // ---- pass 5: leveller plan, loudness for the gain stage
    const plan = useLevel ? planLeveller(levelWins, levelE.sums, len, sr, clamp(settings.levelMaxBoostDb, 0, 30)) : null;
    if (plan) stages.push('speech-leveller');
    let appliedGainDb = 0;
    let gainCapped = false;
    if (settings.gainMode === 'manual') {
      appliedGainDb = clamp(settings.manualGainDb, -24, 30);
    } else {
      const meter = new KLoudnessMeter(sr);
      await eachChunk(srcA, (x, start) => { meter.push(plan ? applyLevel(x, start, plan) : x); }, ticker(0.8, 0.85));
      const blocks: BlockPower[] = meter.blocks();
      const current = speechLoudnessFromBlocks(blocks, sr, segments);
      if (Number.isFinite(current)) {
        const wanted = settings.targetLufs - current;
        appliedGainDb = Math.min(wanted, settings.maxAutoGainDb);
        gainCapped = wanted > settings.maxAutoGainDb;
      }
    }
    stages.push('gain');
    const g = dbToGain(appliedGainDb);

    // ---- pass 6: leveller, gain, limiter → track B (true-peak loop as in enhance())
    const runLimiter = async (ceilingDb: number, from: number, to: number) => {
      const track = temp(sr, 'int16');
      const lim = new StreamingLimiter(sr, ceilingDb, len);
      const tp = new TruePeakMeter();
      // without silence removal this is the output: measure it here instead of in pass 7
      const meter = settings.removeSilence ? null : new KLoudnessMeter(sr);
      let peak = 0;
      let written = 0;
      const out = async (y: Float32Array, final: boolean) => {
        tp.push(y, final);
        if (meter) { meter.push(y); peak = peakOf(y, peak); }
        written += y.length;
        await track.write(y);
      };
      await eachChunk(srcA, async (x, start) => {
        let y = plan ? applyLevel(x, start, plan) : x;
        if (appliedGainDb !== 0) {
          const o = new Float32Array(y.length);
          for (let i = 0; i < y.length; i++) o[i] = y[i] * g;
          y = o;
        }
        await out(lim.push(y), false);
      }, ticker(from, to));
      await out(lim.finish(), true);
      void written;
      return { track, lim, tpDb: tp.db, meter, peak };
    };
    let lim = await runLimiter(settings.limiterCeilingDb, 0.85, 0.92);
    let internalCeiling = settings.limiterCeilingDb;
    for (let pass = 0; pass < 2; pass++) {
      if (!(lim.tpDb > settings.limiterCeilingDb + 0.05)) break;
      internalCeiling -= lim.tpDb - settings.limiterCeilingDb + 0.05;
      lim.track.dispose();
      lim = await runLimiter(internalCeiling, 0.92, 0.94);
    }
    tracks.push(lim.track);
    stages.push('limiter');
    const srcB = await lim.track.done();
    trackA.dispose();

    // ---- pass 7: optional silence removal, output measurement → sink
    let silenceMap: [number, number, number][] | undefined;
    let pieces: [number, number][] | null = null;
    if (settings.removeSilence && segments.length) {
      const half = settings.keepGapMs / 2000;
      pieces = [];
      for (const s of segments) {
        const a = Math.max(0, s.start - half);
        const b = Math.min(durationSec, s.end + half);
        const last = pieces[pieces.length - 1];
        if (last && a <= last[1]) last[1] = Math.max(last[1], b);
        else pieces.push([a, b]);
      }
      stages.push('silence-removal');
    }
    const measured = !pieces && lim.meter ? { meter: lim.meter, tpDb: lim.tpDb, peak: lim.peak } : null;
    const outMeter = measured ? measured.meter : new KLoudnessMeter(sr);
    const outTp = new TruePeakMeter();
    const outFa = pieces ? new FrameAnalyzer(sr, settings.vad.frameMs ?? 20) : null;
    let outPeak = measured ? measured.peak : 0;
    let outLen = 0;
    const emit = async (y: Float32Array, final: boolean) => {
      if (!measured) {
        outMeter.push(y);
        outTp.push(y, final);
        outPeak = peakOf(y, outPeak);
      }
      outFa?.push(y);
      outLen += y.length;
      await sink.write(y);
    };
    if (!pieces) {
      await eachChunk(srcB, (x, start) => emit(x, start + x.length >= srcB.length), ticker(0.94, 1));
    } else {
      silenceMap = [];
      const fade = Math.round(0.01 * sr);
      const tickP = ticker(0.94, 1);
      for (let p = 0; p < pieces.length; p++) {
        const [a, b] = pieces[p];
        const s0 = Math.round(a * sr), s1 = Math.round(b * sr);
        silenceMap.push([a, b, outLen / sr]);
        const L = s1 - s0;
        await eachChunk(srcB, async (x, start) => {
          const c = Float32Array.from(x);
          for (let i = 0; i < c.length; i++) {
            const k = start - s0 + i; // position inside the piece
            if (k < fade) c[i] *= k / fade;
            if (L - 1 - k < fade) c[i] *= (L - 1 - k) / fade;
          }
          await emit(c, p === pieces!.length - 1 && start + x.length >= s1);
        }, async () => {}, [s0, s1]);
        await tickP((p + 1) / pieces.length);
      }
    }
    lim.track.dispose();
    const outSegments = outFa ? detectSpeechFromAnalysis(outFa.finish(), outLen / sr, settings.vad).segments : segments;
    const outLoud = loudnessFromBlocks(outMeter.blocks(), sr, outSegments);
    const output: LevelReport = {
      integratedLufs: outLoud.integrated,
      speechLufs: outLoud.speech,
      samplePeakDb: outPeak > 0 ? 20 * Math.log10(outPeak) : -Infinity,
      truePeakDb: measured ? measured.tpDb : outTp.db,
    };

    const limMaxReductionDb = -20 * Math.log10(lim.lim.maxRed);
    const warnings: WarningCode[] = [];
    if (segments.length === 0) warnings.push('no_speech_found');
    if (Number.isFinite(snrDb) && snrDb < 3) warnings.push('very_low_snr');
    else if (Number.isFinite(snrDb) && snrDb < 10) warnings.push('low_snr');
    if (settings.noiseSuppression && settings.noiseAmount >= 2 && Number.isFinite(snrDb) && snrDb < 10) warnings.push('strong_suppression_low_snr');
    if (clip.events > 0) warnings.push('input_clipping');
    if (gainCapped) warnings.push('gain_capped');
    if (limMaxReductionDb > 6 || lim.lim.heavy / sr > 1) warnings.push('heavy_limiting');

    return {
      outputLength: outLen,
      sections,
      report: {
        input,
        output,
        appliedGainDb,
        snrDb,
        humHz,
        segments,
        clipping: { events: clip.events, times: clip.times },
        limiterMaxReductionDb: limMaxReductionDb,
        warnings,
        silenceMap,
        durationSec,
        outputDurationSec: outLen / sr,
        stagesRun: stages,
        appliedSettings: settings,
        autoReasons,
        whisperSections: segments.filter((s) => s.kind === 'whisper').length,
        levelerMaxBoostDb: plan?.maxBoostDb ?? 0,
        sectionCounts: sections ? countSections(sections) : undefined,
      },
    };
  } finally {
    for (const t of tracks) { try { t.dispose(); } catch { /* already gone */ } }
  }
}

/** speechLoudness() from block powers. */
function speechLoudnessFromBlocks(blocks: BlockPower[], sampleRate: number, segments: Segment[]): number {
  const all = loudnessFromBlocks(blocks, sampleRate, []).integrated;
  if (segments.length === 0) return all;
  const inSpeech = blocks.filter((b) => {
    const centre = b.start / sampleRate + 0.2;
    return segments.some((s) => centre >= s.start && centre <= s.end);
  });
  if (inSpeech.length === 0) return all;
  return loudnessFromBlocks(inSpeech, sampleRate, []).integrated;
}

/** Internal stages, exported for benchmarks and tests only. */
export const __internals = { StreamingDenoiser, StreamingLimiter, NoiseProfileAccumulator, RangeEnergy, ClipCounter, planLeveller, applyLevel, speechWindows };
