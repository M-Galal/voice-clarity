/**
 * Live enhancement: the same stages as the file pipeline (stream.ts), in one pass, for
 * listening while settings change. Audio goes in block by block from any position of the
 * recording and comes out processed, together with the matching original samples (both delayed
 * by the same amount), so Original/Enhanced can be switched without a jump.
 *
 * What differs from the file result, and why:
 * - The file pipeline measures the whole recording first (speech loudness after levelling, the
 *   level of the louder speech, the noise of all pauses). Live, those come from the Smart
 *   analysis and from the audio around the playhead, and the loudness gain is corrected slowly
 *   while playing. Loudness can therefore differ by a dB or two from the saved file.
 * - The leveller looks 0.3 s ahead instead of using whole 1 s windows.
 * Noise reduction, hum removal, low cut, clarity, per-section settings, pause lowering and the
 * limiter are the same code as the file pipeline.
 */
import { BiquadChainState, designBiquad, type BiquadCoeffs } from './biquad';
import type { SectionSetting, SectionWindow } from './autoTune';
import { DD_SMOOTHING, frameSizeFor, humNotches } from './denoise';
import { kWeightingCoeffs } from './loudness';
import type { EnhanceSettings } from './pipeline';
import {
  CLARITY_MAX_DB, maskRange, noiseControl, NoiseProfileAccumulator, predictedGainDb, SectionCurve, steadyNoiseCaps, StreamingDenoiser, StreamingLimiter, type SampleSource,
} from './stream';
import { clamp, dbToGain } from './units';
import type { Segment } from './vad';

/** What the live chain needs to know about the recording (from the Smart analysis). */
export interface LiveContext {
  /** Speech in the recording, seconds. */
  segments: Segment[];
  humHz: 50 | 60 | null;
  /** Per-section settings (Smart mode), recording timeline. */
  sections: SectionSetting[] | null;
  /** Level of the louder speech (K-weighted dBFS) the leveller raises quiet speech towards. */
  speechRefDb?: number;
  /** Speech loudness of the original, LUFS: the starting point for the loudness gain. */
  inputSpeechLufs?: number;
  /** Hum harmonics to notch (default: the first four). */
  humHarmonics?: number[];
  /** ~1 s speech windows (recording timeline), for the boost-following noise floor. */
  windows?: SectionWindow[];
}

const BIG = Number.MAX_SAFE_INTEGER;
/** Leveller blocks and look-ahead. */
const BLOCK_SEC = 0.01;
const LOOK_BLOCKS = 30;

const shift = <T extends { start: number; end: number }>(xs: T[], by: number): T[] =>
  xs.map((x) => ({ ...x, start: x.start - by, end: x.end - by })).filter((x) => x.end > 0);

/** "Is time t in speech?" for times that only move forward. */
class SpeechCursor {
  private i = 0;
  constructor(private readonly segs: Segment[]) {}
  at(t: number): boolean {
    const s = this.segs;
    while (this.i < s.length && s[this.i].end < t) this.i++;
    return this.i < s.length && t >= s[this.i].start && t <= s[this.i].end;
  }
}

/** Delay line for the original samples, so they line up with the processed ones. */
class History {
  private buf = new Float32Array(0);
  constructor(private start: number) {} // absolute index of buf[0]
  push(x: Float32Array) {
    const out = new Float32Array(this.buf.length + x.length);
    out.set(this.buf, 0);
    out.set(x, this.buf.length);
    this.buf = out;
  }
  take(from: number, count: number): Float32Array {
    const a = from - this.start;
    const r = this.buf.slice(a, a + count);
    // drop what is no longer needed
    this.buf = this.buf.slice(a + count);
    this.start = from + count;
    return r;
  }
}

/**
 * Speech leveller with a short look-ahead: each 10 ms block is raised towards `refDb` by the
 * K-weighted level of the speech within ±0.3 s (pauses do not count and hold the last boost).
 */
class LiveLeveller {
  private readonly k: BiquadChainState;
  private readonly block: number;
  private readonly energies: number[] = [];
  private readonly speech: boolean[] = [];
  private readonly pending: Float32Array[] = [];
  private acc = 0;
  private filled = 0;
  private cur: Float32Array[] = [];
  private boostDb = 0;
  private gain = 1;
  private nextOut = 0; // next block index to output (into the arrays below)
  private readonly alpha: number;
  maxBoostSeen = 0;
  /** Smart mode: noise left after noise reduction per block (absolute block index), from the denoiser. */
  private readonly left = new Map<number, { s: number; n: number }>();
  private base = 0; // blocks dropped from the front of the arrays

  constructor(
    sampleRate: number,
    private readonly refDb: number,
    private readonly maxBoostDb: number,
    private readonly isSpeech: (sample: number) => boolean,
    /** Smart mode (steady noise): the loudness gain now, dB; null = no noise limit. */
    private readonly gainNow: (() => number) | null = null,
  ) {
    this.k = new BiquadChainState(kWeightingCoeffs(sampleRate));
    this.block = Math.max(1, Math.round(BLOCK_SEC * sampleRate));
    this.alpha = 1 - Math.exp(-1 / (0.04 * sampleRate)); // ~40 ms smoothing
  }

  /** Noise left in a denoiser frame centred at `sample` (fraction of the original noise). */
  addResidual(sample: number, r: number) {
    const b = Math.floor(sample / this.block);
    const e = this.left.get(b);
    if (e) { e.s += r; e.n++; } else this.left.set(b, { s: r, n: 1 });
  }

  get blockSize() { return this.block; }

  private blockIndex = 0;
  push(x: Float32Array): Float32Array {
    const w = this.k.process(x);
    const parts: Float32Array[] = [];
    let i = 0;
    while (i < x.length) {
      const take = Math.min(this.block - this.filled, x.length - i);
      for (let k = 0; k < take; k++) this.acc += w[i + k] * w[i + k];
      this.cur.push(x.subarray(i, i + take));
      this.filled += take;
      i += take;
      if (this.filled === this.block) {
        const b = this.blockIndex++;
        this.energies.push(this.acc / this.block);
        this.speech.push(this.isSpeech(b * this.block + this.block / 2));
        this.pending.push(concat(this.cur));
        this.cur = [];
        this.acc = 0;
        this.filled = 0;
        // a block is output once its look-ahead is in
        while (this.nextOut + LOOK_BLOCKS < this.energies.length) parts.push(this.out(this.nextOut++));
      }
    }
    return concat(parts);
  }

  private out(b: number): Float32Array {
    if (this.speech[b]) {
      let e = 0, n = 0;
      for (let j = Math.max(0, b - LOOK_BLOCKS); j <= b + LOOK_BLOCKS && j < this.energies.length; j++) {
        if (this.speech[j]) { e += this.energies[j]; n++; }
      }
      const level = n ? 10 * Math.log10(e / n + 1e-12) : -120;
      this.boostDb = clamp(this.refDb - level, 0, this.maxBoostDb);
      if (this.gainNow) {
        // as in the file pipeline (steadyNoiseCaps): the noise left here, raised by the boost and
        // the gain, stays within the allowance of the original background
        let ls = 0, ln = 0;
        for (let j = Math.max(0, b - LOOK_BLOCKS); j <= b + LOOK_BLOCKS && j < this.energies.length; j++) {
          const v = this.speech[j] ? this.left.get(j + this.base) : undefined;
          if (v) { ls += v.s; ln += v.n; }
        }
        if (ln) this.boostDb = Math.min(this.boostDb, steadyNoiseCaps([10 * Math.log10(ls / ln + 1e-30)], this.gainNow())[0]);
      }
      if (this.boostDb > this.maxBoostSeen) this.maxBoostSeen = this.boostDb;
    }
    const x = this.pending.shift()!;
    const target = dbToGain(this.boostDb);
    const a = this.alpha;
    const y = new Float32Array(x.length);
    let g = this.gain;
    for (let k = 0; k < x.length; k++) { g += (target - g) * a; y[k] = x[k] * g; }
    this.gain = g;
    // keep memory bounded: blocks before the look-back are no longer read
    const drop = b - LOOK_BLOCKS - 1;
    if (drop > 1000) {
      this.energies.splice(0, drop);
      this.speech.splice(0, drop);
      this.nextOut -= drop;
      for (const k of this.left.keys()) if (k < this.base + drop) this.left.delete(k);
      this.base += drop;
    }
    return y;
  }

  /** The blocks still held for look-ahead (end of the recording). */
  flush(): Float32Array {
    if (this.filled > 0) {
      this.energies.push(this.acc / this.filled);
      this.speech.push(this.isSpeech(this.blockIndex * this.block));
      this.pending.push(concat(this.cur));
      this.cur = [];
      this.filled = 0;
    }
    const parts: Float32Array[] = [];
    while (this.pending.length) parts.push(this.out(this.nextOut++));
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

export interface LiveOutput {
  enhanced: Float32Array;
  original: Float32Array;
  /** Recording position (samples) of the first sample of this output. */
  start: number;
}

/**
 * One-pass enhancement from `startSample` onwards. Feed consecutive input blocks with push();
 * each call returns the processed samples that are ready (possibly none at first).
 */
export class LiveChain {
  readonly sampleRate: number;
  private readonly pre: BiquadChainState;
  private readonly dn: StreamingDenoiser | null;
  private readonly clarity: BiquadChainState | null;
  private readonly clarityCurve: SectionCurve | null;
  private readonly clarityMax: number;
  private readonly lev: LiveLeveller | null;
  private readonly lim: StreamingLimiter;
  private readonly hist: History;
  private readonly segs: Segment[];
  private readonly gapGain: number;
  private readonly gapOn: boolean;
  private inPos: number;
  private outPos: number;
  private aPos = 0; // samples through the denoiser (relative)
  private mixBlock = -1;
  private mixW0 = 0;
  private mixW1 = 0;
  /** Loudness gain, dB (corrected slowly towards the target while playing). */
  gainDb: number;
  private readonly targetLufs: number | null;
  private readonly gainCap: number;
  private loudE = 0;
  private loudN = 0;

  constructor(
    sampleRate: number,
    readonly settings: EnhanceSettings,
    ctx: LiveContext,
    readonly startSample: number,
    noiseProfile: Float32Array | null,
  ) {
    this.sampleRate = sampleRate;
    const sr = sampleRate;
    const startSec = startSample / sr;
    this.inPos = startSample;
    this.outPos = startSample;
    this.hist = new History(startSample);
    this.segs = shift(ctx.segments, startSec);
    const chain: BiquadCoeffs[] = [];
    if (settings.highPassHz > 0) chain.push(designBiquad('highpass', sr, settings.highPassHz, 0.707));
    if (settings.humRemoval && ctx.humHz) {
      chain.push(...humNotches(sr, ctx.humHz, ctx.humHarmonics ?? [1, 2, 3, 4]));
    }
    this.pre = new BiquadChainState(chain);
    const sections = ctx.sections ? shift(ctx.sections, startSec) : null;
    let residualSink: ((c: number, r: number) => void) | null = null;
    this.dn = settings.noiseSuppression && noiseProfile
      ? new StreamingDenoiser(
        sr, this.segs, Float32Array.from(noiseProfile),
        { overSubtraction: clamp(settings.noiseAmount, 0.5, 3), floorDb: clamp(settings.noiseFloorDb, -40, -3), smoothing: DD_SMOOTHING, rule: 'wiener-dd' }, BIG,
        noiseControl(settings, sections, shift(ctx.windows ?? [], startSec), ctx.speechRefDb, predictedGainDb(settings, ctx.inputSpeechLufs ?? NaN)),
        settings.steadyNoise === true ? (c, r) => residualSink?.(c, r) : null,
      )
      : null;
    this.clarityCurve = sections?.length && sr > 8000 ? new SectionCurve(sections, (x) => x.clarityDb) : null;
    this.clarityMax = this.clarityCurve ? CLARITY_MAX_DB : clamp(settings.clarityDb, 0, 8);
    this.clarity = this.clarityMax > 0 && sr > 8000
      ? new BiquadChainState([designBiquad('peaking', sr, Math.min(3000, sr * 0.4), 0.9, this.clarityMax)])
      : null;
    this.gapOn = settings.pauseReductionDb > 0 && this.segs.length > 0;
    this.gapGain = dbToGain(-settings.pauseReductionDb);
    const levCursor = new SpeechCursor(this.segs);
    const inSpeech = (rel: number) => levCursor.at(rel / sr);
    this.trackCursor = new SpeechCursor(this.segs);
    const steady = settings.steadyNoise === true && !!this.dn;
    this.lev = settings.levelSpeech && ctx.speechRefDb !== undefined && this.segs.length
      ? new LiveLeveller(sr, ctx.speechRefDb, clamp(settings.levelMaxBoostDb, 0, 30), inSpeech, steady ? () => this.initialGain : null)
      : null;
    if (steady && this.lev) { const lev = this.lev; residualSink = (c, r) => lev.addResidual(c, r); }
    if (settings.gainMode === 'manual') {
      this.gainDb = clamp(settings.manualGainDb, -24, 30);
      this.targetLufs = null;
    } else {
      const inLufs = ctx.inputSpeechLufs;
      this.gainDb = inLufs !== undefined && Number.isFinite(inLufs) ? Math.min(settings.targetLufs - inLufs, settings.maxAutoGainDb) : 0;
      this.targetLufs = settings.targetLufs;
    }
    this.gainCap = settings.maxAutoGainDb;
    this.initialGain = this.gainDb;
    this.gLin = dbToGain(this.gainDb);
    this.gAlpha = 1 - Math.exp(-1 / (0.5 * sr));
    this.trackK = new BiquadChainState(kWeightingCoeffs(sr));
    this.lim = new StreamingLimiter(sr, settings.limiterCeilingDb, BIG);
  }

  /** End of the recording: everything still held back, by pushing silence through. */
  finish(): LiveOutput {
    const want = this.inPos;
    const start = this.outPos;
    const enh: Float32Array[] = [];
    const orig: Float32Array[] = [];
    for (let guard = 0; this.outPos < want && guard < 20; guard++) {
      const r = this.push(new Float32Array(Math.max(1024, this.latency)));
      const keep = Math.max(0, Math.min(r.enhanced.length, want - r.start));
      enh.push(r.enhanced.subarray(0, keep));
      orig.push(r.original.subarray(0, keep));
    }
    return { enhanced: concat(enh), original: concat(orig), start };
  }

  /** Samples the chain holds back (output lags input by this much). */
  get latency(): number { return this.inPos - this.outPos; }

  push(x: Float32Array): LiveOutput {
    const sr = this.sampleRate;
    this.hist.push(x);
    this.inPos += x.length;
    const f = this.pre.process(x);
    let y = this.dn ? this.dn.push(f) : f;
    if (y.length) {
      // clarity (fixed, or mixed per section) and pause lowering, as in the file pipeline
      let z = this.clarity ? this.clarity.process(y) : y;
      if (this.clarity && this.clarityCurve) {
        // wet/dry mix on a 10 ms grid of the stream, interpolated (as the file pipeline does)
        const G = Math.pow(10, this.clarityMax / 20) - 1;
        const mixFor = (db: number) => (Math.pow(10, clamp(db, 0, this.clarityMax) / 20) - 1) / G;
        const B = Math.max(1, Math.round(0.01 * sr));
        const o = new Float32Array(y.length);
        for (let i = 0; i < y.length; i++) {
          const p = this.aPos + i;
          const blk = Math.floor(p / B);
          if (blk !== this.mixBlock) {
            this.mixW0 = blk === this.mixBlock + 1 ? this.mixW1 : mixFor(this.clarityCurve.at((blk * B) / sr));
            this.mixW1 = mixFor(this.clarityCurve.at(((blk + 1) * B) / sr));
            this.mixBlock = blk;
          }
          const w = this.mixW0 + ((this.mixW1 - this.mixW0) * (p - blk * B)) / B;
          o[i] = y[i] + w * (z[i] - y[i]);
        }
        z = o;
      }
      if (this.gapOn) {
        const m = maskRange(this.segs, sr, BIG, 40, this.aPos, z.length);
        const o = new Float32Array(z.length);
        for (let i = 0; i < z.length; i++) o[i] = z[i] * (m[i] + (1 - m[i]) * this.gapGain);
        z = o;
      }
      this.aPos += z.length;
      y = z;
    }
    if (this.lev && y.length) y = this.lev.push(y);
    if (y.length) y = this.applyGain(y);
    const out = y.length ? this.lim.push(y) : y;
    const start = this.outPos;
    this.outPos += out.length;
    return { enhanced: out, original: this.hist.take(start, out.length), start };
  }

  private readonly trackCursor: SpeechCursor;
  private readonly trackK: BiquadChainState;
  private readonly initialGain: number;
  private gPos = 0; // samples through the gain stage (relative)
  private gLin = 1;
  private readonly gAlpha: number;

  /**
   * Loudness gain. Every ~2 s of speech the speech loudness before the gain is measured and the
   * gain moves a third of the way to what reaches the target (within ±6 dB of the starting
   * value), ramping over about half a second. Sample-exact, so block sizes do not matter.
   */
  private applyGain(y: Float32Array): Float32Array {
    const sr = this.sampleRate;
    const w = this.trackK.process(y);
    const o = new Float32Array(y.length);
    let g = this.gLin;
    let target = dbToGain(this.gainDb);
    for (let i = 0; i < y.length; i++) {
      const p = this.gPos + i;
      if (this.targetLufs !== null && (p & 7) === 0 && this.trackCursor.at(p / sr)) {
        this.loudE += w[i] * w[i];
        if (++this.loudN > (2 * sr) / 8) {
          const lufs = -0.691 + 10 * Math.log10(this.loudE / this.loudN + 1e-12);
          const want = this.targetLufs - lufs;
          const next = this.gainDb + (want - this.gainDb) / 3;
          this.gainDb = Math.min(this.gainCap, clamp(next, this.initialGain - 6, this.initialGain + 6));
          target = dbToGain(this.gainDb);
          this.loudE = 0;
          this.loudN = 0;
        }
      }
      g += (target - g) * this.gAlpha;
      o[i] = y[i] * g;
    }
    this.gLin = g;
    this.gPos += y.length;
    return o;
  }
}

/**
 * Noise profile for a live chain starting at `startSample`: the pauses in the few seconds
 * before it (after the same low cut and hum filters), or the quietest frames when there are none.
 */
export async function liveNoiseProfile(src: SampleSource, startSample: number, settings: EnhanceSettings, ctx: LiveContext, lookSec = 8): Promise<Float32Array | null> {
  if (!settings.noiseSuppression) return null;
  const sr = src.sampleRate;
  const a = Math.max(0, startSample - Math.round(lookSec * sr));
  let b = Math.min(src.length, Math.max(startSample, a + Math.round(lookSec * sr)));
  if (b - a < frameSizeFor(sr) * 4) b = Math.min(src.length, a + Math.round(lookSec * sr));
  if (b <= a) return null;
  const x = await src.read(a, b - a);
  const chain: BiquadCoeffs[] = [];
  if (settings.highPassHz > 0) chain.push(designBiquad('highpass', sr, settings.highPassHz, 0.707));
  if (settings.humRemoval && ctx.humHz) {
    chain.push(...humNotches(sr, ctx.humHz, ctx.humHarmonics ?? [1, 2, 3, 4]));
  }
  const f = new BiquadChainState(chain).process(x);
  const segs = shift(ctx.segments, a / sr);
  const acc = new NoiseProfileAccumulator(sr, segs);
  acc.push(f);
  if (acc.count >= 5) return acc.profile();
  const accE = new NoiseProfileAccumulator(sr, segs, null, true);
  accE.push(f);
  if (!accE.energies.length) return null;
  const k = Math.max(1, Math.floor(accE.energies.length * 0.1));
  const order = accE.energies.map((e, i) => [e, i] as const).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const acc2 = new NoiseProfileAccumulator(sr, segs, new Set(order.slice(0, k).map(([, i]) => i)));
  acc2.push(f);
  return acc2.profile();
}
