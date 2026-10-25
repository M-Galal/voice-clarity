/**
 * Plays a recording with live enhancement (dsp/live.ts) through react-native-audio-api: blocks
 * of 0.2 s are processed just ahead of the playhead and queued, original and enhanced side by
 * side on two queue sources, so the Original/Enhanced switch is a gain change (instant) and new
 * settings are heard as soon as the audio already queued (about 0.6 s) has played.
 */
import { AudioContext, type AudioBufferQueueSourceNode, type GainNode } from 'react-native-audio-api';
import { LiveChain, liveNoiseProfile, type LiveContext, type LiveOutput } from '../dsp/live';
import type { EnhanceSettings } from '../dsp/pipeline';
import type { SampleSource } from '../dsp/stream';
import { SpectrumMeter, type Spectrum } from '../dsp/spectrum';

const BLOCK_SEC = 0.2;
const AHEAD_SEC = 0.6;
/** Audio fed to a new chain before the point it takes over (fills filters and noise estimate). */
const PREROLL_SEC = 0.5;

type Nodes = { enh: AudioBufferQueueSourceNode; org: AudioBufferQueueSourceNode; gE: GainNode; gO: GainNode };

export interface LiveStatus {
  playing: boolean;
  /** Seconds. */
  position: number;
  ended: boolean;
}

export class LivePlayer {
  private ctx: AudioContext | null = null;
  private nodes: Nodes | null = null;
  private chain: LiveChain | null = null;
  private readPos = 0;
  private skipUntil = 0;
  private queuedEnd = 0;
  private refSample = 0;
  private refTime = 0;
  private started = false;
  private inputDone = false;
  private filling = false;
  private gen = 0;
  private ids = new Map<string, number>();
  private settings: EnhanceSettings | null = null;
  private context: LiveContext | null = null;
  private rebuild = false;
  private specO: SpectrumMeter;
  private specE: SpectrumMeter;
  private workMs = 0;
  private workSec = 0;
  mode: 'enhanced' | 'original' = 'enhanced';
  playing = false;
  ended = false;
  onError?: (e: unknown) => void;
  onEnded?: () => void;

  constructor(private readonly src: SampleSource) {
    this.specO = new SpectrumMeter(src.sampleRate);
    this.specE = new SpectrumMeter(src.sampleRate);
  }

  get sampleRate() { return this.src.sampleRate; }
  get duration() { return this.src.length / this.src.sampleRate; }
  /** Loudness gain the live chain applies now, dB. */
  get gainDb() { return this.chain?.gainDb ?? 0; }

  /** New settings: heard after the audio already queued. */
  configure(settings: EnhanceSettings, context: LiveContext) {
    this.settings = settings;
    this.context = context;
    if (this.chain) this.rebuild = true;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: this.src.sampleRate });
    return this.ctx;
  }

  private makeNodes(): Nodes {
    const ctx = this.ensureContext();
    const enh = ctx.createBufferQueueSource({ pitchCorrection: false });
    const org = ctx.createBufferQueueSource({ pitchCorrection: false });
    const gE = ctx.createGain();
    const gO = ctx.createGain();
    gE.gain.value = this.mode === 'enhanced' ? 1 : 0;
    gO.gain.value = this.mode === 'original' ? 1 : 0;
    enh.connect(gE); gE.connect(ctx.destination);
    org.connect(gO); gO.connect(ctx.destination);
    enh.onBufferEnded = (e) => {
      const end = this.ids.get(e.bufferId);
      this.ids.delete(e.bufferId);
      if (end !== undefined && this.ctx) { this.refSample = end; this.refTime = this.ctx.currentTime; }
      if (e.isLastBufferInQueue && this.inputDone) { this.playing = false; this.ended = true; this.onEnded?.(); return; }
      void this.fill();
    };
    return { enh, org, gE, gO };
  }

  private dropNodes() {
    const n = this.nodes;
    this.nodes = null;
    if (!n) return;
    try { n.enh.onBufferEnded = null; } catch { /* gone */ }
    for (const s of [n.enh, n.org]) { try { s.stop(); } catch { /* not started */ } try { s.disconnect(); } catch { /* gone */ } }
    for (const g of [n.gE, n.gO]) { try { g.disconnect(); } catch { /* gone */ } }
    this.ids.clear();
  }

  /** Position in seconds (what is being heard). */
  position(): number {
    const sr = this.src.sampleRate;
    if (!this.started || !this.ctx || !this.playing) return this.refSample / sr;
    const p = this.refSample + (this.ctx.currentTime - this.refTime) * sr;
    return Math.max(this.refSample, Math.min(this.queuedEnd, p)) / sr;
  }

  private async newChain(at: number, takeOverAt: number) {
    const s = this.settings!, c = this.context!;
    const from = Math.max(0, at);
    const noise = await liveNoiseProfile(this.src, takeOverAt, s, c);
    this.chain = new LiveChain(this.src.sampleRate, s, c, from, noise);
    this.readPos = from;
    this.skipUntil = takeOverAt;
  }

  /** Starts (or restarts) playback at `sec`. */
  async play(sec?: number) {
    if (!this.settings || !this.context) return;
    const sr = this.src.sampleRate;
    const my = ++this.gen;
    const ctx = this.ensureContext();
    if (sec !== undefined || !this.started || this.ended) {
      const at = Math.round(Math.max(0, Math.min(this.duration - 0.05, sec ?? (this.ended ? 0 : this.refSample / sr))) * sr);
      this.dropNodes();
      this.started = false;
      this.ended = false;
      this.inputDone = false;
      this.rebuild = false;
      await this.newChain(at - Math.round(PREROLL_SEC * sr), at);
      if (my !== this.gen) return;
      this.queuedEnd = at;
      this.refSample = at;
      this.nodes = this.makeNodes();
    }
    if (ctx.state === 'suspended') await ctx.resume();
    this.playing = true;
    await this.fill();
  }

  async pause() {
    this.playing = false;
    this.refSample = Math.round(this.position() * this.src.sampleRate);
    if (this.ctx) {
      // remember where we are: on resume the queued audio continues from here
      await this.ctx.suspend();
      this.refTime = this.ctx.currentTime;
    }
  }

  async seek(sec: number) {
    const wasPlaying = this.playing;
    await this.play(sec);
    if (!wasPlaying) await this.pause();
  }

  setMode(mode: 'enhanced' | 'original') {
    this.mode = mode;
    const n = this.nodes, ctx = this.ctx;
    if (!n || !ctx) return;
    const t = ctx.currentTime;
    // 15 ms crossfade: no click
    for (const [g, on] of [[n.gE, mode === 'enhanced'], [n.gO, mode === 'original']] as const) {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(on ? 1 : 0, t + 0.015);
    }
  }

  /** Average spectra of the audio queued since the last call (original, enhanced); null if none. */
  spectrum(): { original: Spectrum; enhanced: Spectrum } | null {
    if (!this.specN) return null;
    const r = { original: this.specO.bands(), enhanced: this.specE.bands() };
    this.specO = new SpectrumMeter(this.src.sampleRate);
    this.specE = new SpectrumMeter(this.src.sampleRate);
    this.specN = 0;
    return r;
  }
  private specN = 0;

  private async fill() {
    if (this.filling || !this.nodes || !this.chain) return;
    this.filling = true;
    const my = this.gen;
    const sr = this.src.sampleRate;
    const block = Math.round(BLOCK_SEC * sr);
    try {
      while (my === this.gen && this.nodes && !this.inputDone && this.queuedEnd - this.position() * sr < AHEAD_SEC * sr) {
        if (this.rebuild) {
          // new settings take over where the queued audio ends
          this.rebuild = false;
          console.log(`[VC] live: new settings from ${(this.queuedEnd / sr).toFixed(2)} s (heard ${((this.queuedEnd / sr) - this.position()).toFixed(2)} s after the change)`);
          await this.newChain(this.queuedEnd - Math.round(PREROLL_SEC * sr), this.queuedEnd);
        }
        const chain: LiveChain = this.chain;
        let out: LiveOutput;
        if (this.readPos < this.src.length) {
          const x = await this.src.read(this.readPos, Math.min(block, this.src.length - this.readPos));
          if (my !== this.gen || chain !== this.chain) continue;
          this.readPos += x.length;
          const t0 = Date.now();
          out = chain.push(x);
          this.workMs += Date.now() - t0;
          this.workSec += x.length / sr;
          if (this.workSec >= 10) {
            console.log(`[VC] live: ${(this.workMs / this.workSec / 1000 * 100).toFixed(1)} % of real time spent processing (${this.workMs} ms for ${this.workSec.toFixed(1)} s @${sr}), at ${this.position().toFixed(1)} s`);
            this.workMs = 0;
            this.workSec = 0;
          }
        } else {
          out = chain.finish();
          this.inputDone = true;
        }
        let { enhanced, original } = out;
        // a new chain starts a little early to settle; drop what is already queued
        const cut = Math.max(0, Math.min(enhanced.length, this.skipUntil - out.start));
        if (cut) { enhanced = enhanced.subarray(cut); original = original.subarray(cut); }
        if (!enhanced.length) continue;
        this.enqueue(enhanced, original);
      }
      if (my === this.gen && this.nodes && !this.started && this.queuedEnd > this.refSample && this.playing) {
        const ctx = this.ctx!;
        const t = ctx.currentTime + 0.02;
        // explicit offset: in react-native-audio-api 0.13.6 the queue source's default offset (-1)
        // fails its own non-negative check
        this.nodes.enh.start(t, 0);
        this.nodes.org.start(t, 0);
        this.refTime = t;
        this.started = true;
      }
    } catch (e) {
      this.onError?.(e);
    } finally {
      this.filling = false;
    }
  }

  private enqueue(enhanced: Float32Array, original: Float32Array) {
    const ctx = this.ctx!, n = this.nodes!;
    const sr = this.src.sampleRate;
    const bE = ctx.createBuffer(1, enhanced.length, sr);
    bE.copyToChannel(Float32Array.from(enhanced), 0);
    const bO = ctx.createBuffer(1, original.length, sr);
    bO.copyToChannel(Float32Array.from(original), 0);
    const id = n.enh.enqueueBuffer(bE);
    n.org.enqueueBuffer(bO);
    this.queuedEnd += enhanced.length;
    this.ids.set(id, this.queuedEnd);
    this.specE.push(enhanced);
    this.specO.push(original);
    this.specN += enhanced.length;
  }

  async dispose() {
    this.gen++;
    this.dropNodes();
    this.chain = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) { try { await ctx.close(); } catch { /* closed */ } }
  }
}
