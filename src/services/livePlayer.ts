/**
 * Plays a recording with live enhancement (dsp/live.ts) through react-native-audio-api: blocks
 * of 0.2 s are processed just ahead of the playhead and queued, original and enhanced side by
 * side on two queue sources, so the Original/Enhanced switch is a gain change (instant) and new
 * settings are heard as soon as the audio already queued (about 0.6 s) has played.
 *
 * Speed (0.25x-5x, pitch kept) is applied here with a streaming WSOLA stretcher (dsp/stretch.ts)
 * on both signals together; react-native-audio-api's own pitch-corrected rate stops at 4x
 * (WsolaTimeStretcher::MAX_PLAYBACK_RATE in 0.13.6). Positions are kept on the output clock
 * and mapped back to the recording through the list of queued buffers.
 */
import { AudioContext, type AudioBufferQueueSourceNode, type GainNode } from 'react-native-audio-api';
import { LiveChain, liveNoiseProfile, type LiveContext, type LiveOutput } from '../dsp/live';
import type { EnhanceSettings } from '../dsp/pipeline';
import type { SampleSource } from '../dsp/stream';
import { SpectrumMeter, type Spectrum } from '../dsp/spectrum';
import { STRETCH_MAX, STRETCH_MIN, StreamStretcher } from '../dsp/stretch';

const BLOCK_SEC = 0.2;
const AHEAD_SEC = 0.6;
/** Audio fed to a new chain before the point it takes over (fills filters and noise estimate). */
const PREROLL_SEC = 0.5;

type Nodes = { enh: AudioBufferQueueSourceNode; org: AudioBufferQueueSourceNode; gE: GainNode; gO: GainNode };
/** A queued buffer: its place on the output clock and the part of the recording it plays. */
type Piece = { id: string; outStart: number; outEnd: number; inStart: number; inEnd: number };

export class LivePlayer {
  private ctx: AudioContext | null = null;
  private nodes: Nodes | null = null;
  private chain: LiveChain | null = null;
  private readPos = 0;
  private skipUntil = 0;
  /** Recording position (samples) the chain has produced up to: where new settings take over. */
  private chainEnd = 0;
  // output clock
  private outQueued = 0;
  private anchorOut = 0;
  private anchorTime = 0;
  private pieces: Piece[] = [];
  /** Position (samples) when not playing, and where playback restarts. */
  private rest = 0;
  // speed
  private speed = 1;
  private pendingSpeed: number | null = null;
  private st: StreamStretcher | null = null;
  private stIn0 = 0;
  private stOut = 0;
  private started = false;
  private inputDone = false;
  private filling = false;
  private gen = 0;
  private settings: EnhanceSettings | null = null;
  private context: LiveContext | null = null;
  private rebuild = false;
  private specO: SpectrumMeter;
  private specE: SpectrumMeter;
  private specN = 0;
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
  get currentSpeed() { return this.pendingSpeed ?? this.speed; }

  /** New settings: heard after the audio already queued. */
  configure(settings: EnhanceSettings, context: LiveContext) {
    this.settings = settings;
    this.context = context;
    if (this.chain) this.rebuild = true;
  }

  /** Playback speed, 0.25-5 (pitch kept); heard after the audio already queued. */
  setSpeed(speed: number) {
    const s = Math.max(STRETCH_MIN, Math.min(STRETCH_MAX, speed));
    if (s === this.currentSpeed) return;
    if (this.chain) this.pendingSpeed = s;
    else this.speed = s;
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
      const p = this.pieces.find((x) => x.id === e.bufferId);
      if (p && this.ctx) { this.anchorOut = p.outEnd; this.anchorTime = this.ctx.currentTime; }
      if (e.isLastBufferInQueue && this.inputDone) {
        this.rest = this.src.length;
        this.playing = false;
        this.ended = true;
        this.onEnded?.();
        return;
      }
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
  }

  /** Output samples heard so far (since the last start). */
  private outPlayed(): number {
    if (!this.started || !this.ctx) return this.anchorOut;
    const o = this.anchorOut + (this.ctx.currentTime - this.anchorTime) * this.src.sampleRate;
    return Math.max(this.anchorOut, Math.min(this.outQueued, o));
  }

  /** Position in the recording, seconds (what is being heard). */
  position(): number {
    const sr = this.src.sampleRate;
    if (!this.started || !this.playing) return this.rest / sr;
    const o = this.outPlayed();
    // drop pieces long finished
    while (this.pieces.length > 1 && this.pieces[0].outEnd < o - sr) this.pieces.shift();
    for (const p of this.pieces) {
      if (o < p.outEnd) {
        const f = p.outEnd > p.outStart ? Math.max(0, (o - p.outStart) / (p.outEnd - p.outStart)) : 0;
        return (p.inStart + f * (p.inEnd - p.inStart)) / sr;
      }
    }
    const last = this.pieces[this.pieces.length - 1];
    return (last ? last.inEnd : this.rest) / sr;
  }

  private async newChain(at: number, takeOverAt: number) {
    const s = this.settings!, c = this.context!;
    const from = Math.max(0, at);
    const noise = await liveNoiseProfile(this.src, takeOverAt, s, c);
    this.chain = new LiveChain(this.src.sampleRate, s, c, from, noise);
    this.readPos = from;
    this.skipUntil = takeOverAt;
  }

  private newStretcher(at: number) {
    this.st = this.speed === 1 ? null : new StreamStretcher(this.src.sampleRate, this.speed);
    this.stIn0 = at;
    this.stOut = 0;
  }

  /** Starts (or restarts) playback at `sec`. */
  async play(sec?: number) {
    if (!this.settings || !this.context) return;
    const sr = this.src.sampleRate;
    const my = ++this.gen;
    const ctx = this.ensureContext();
    if (sec !== undefined || !this.started || this.ended) {
      const at = Math.round(Math.max(0, Math.min(this.duration - 0.05, sec ?? (this.ended ? 0 : this.rest / sr))) * sr);
      this.dropNodes();
      this.started = false;
      this.ended = false;
      this.inputDone = false;
      this.rebuild = false;
      if (this.pendingSpeed !== null) { this.speed = this.pendingSpeed; this.pendingSpeed = null; }
      await this.newChain(at - Math.round(PREROLL_SEC * sr), at);
      if (my !== this.gen) return;
      this.chainEnd = at;
      this.newStretcher(at);
      this.outQueued = 0;
      this.anchorOut = 0;
      this.pieces = [];
      this.rest = at;
      this.nodes = this.makeNodes();
    }
    if (ctx.state === 'suspended') await ctx.resume();
    this.playing = true;
    await this.fill();
  }

  async pause() {
    this.rest = Math.round(this.position() * this.src.sampleRate);
    this.playing = false;
    if (this.ctx) {
      // on resume the queued audio continues from here
      this.anchorOut = this.outPlayed();
      await this.ctx.suspend();
      this.anchorTime = this.ctx.currentTime;
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

  /** Processed audio of the recording [start, start + n): through the stretcher, then queued. */
  private output(enhanced: Float32Array, original: Float32Array, start: number, final: boolean) {
    this.chainEnd = start + enhanced.length;
    if (!this.st) {
      if (enhanced.length) this.enqueue(enhanced, original, start, start + enhanced.length);
      return;
    }
    const r = this.st.push(enhanced, original);
    const f = final ? this.st.flush() : null;
    for (const o of f ? [r, f] : [r]) {
      if (!o.a.length) continue;
      const inStart = this.stIn0 + this.stOut * this.speed;
      this.stOut += o.a.length;
      const inEnd = Math.min(this.chainEnd, this.stIn0 + this.stOut * this.speed);
      this.enqueue(o.a, o.b, Math.round(inStart), Math.round(inEnd));
    }
  }

  /** A new speed takes over where the processed audio ends (the old stretcher is emptied first). */
  private applySpeed() {
    if (this.pendingSpeed === null) return;
    if (this.st) {
      const f = this.st.flush();
      if (f.a.length) {
        const inStart = this.stIn0 + this.stOut * this.speed;
        this.enqueue(f.a, f.b, Math.round(inStart), this.chainEnd);
      }
    }
    this.speed = this.pendingSpeed;
    this.pendingSpeed = null;
    this.newStretcher(this.chainEnd);
  }

  private async fill() {
    if (this.filling || !this.nodes || !this.chain) return;
    this.filling = true;
    const my = this.gen;
    const sr = this.src.sampleRate;
    const block = Math.round(BLOCK_SEC * sr);
    try {
      while (my === this.gen && this.nodes && !this.inputDone && this.outQueued - this.outPlayed() < AHEAD_SEC * sr) {
        if (this.rebuild) {
          // new settings take over where the processed audio ends
          this.rebuild = false;
          console.log(`[VC] live: new settings from ${(this.chainEnd / sr).toFixed(2)} s (heard ${((this.outQueued - this.outPlayed()) / sr).toFixed(2)} s after the change)`);
          await this.newChain(this.chainEnd - Math.round(PREROLL_SEC * sr), this.chainEnd);
        }
        if (this.pendingSpeed !== null) {
          console.log(`[VC] live: speed ${this.speed}x -> ${this.pendingSpeed}x from ${(this.chainEnd / sr).toFixed(2)} s`);
          this.applySpeed();
        }
        const chain: LiveChain = this.chain;
        let out: LiveOutput;
        let final = false;
        if (this.readPos < this.src.length) {
          const x = await this.src.read(this.readPos, Math.min(block, this.src.length - this.readPos));
          if (my !== this.gen || chain !== this.chain) continue;
          this.readPos += x.length;
          const t0 = Date.now();
          out = chain.push(x);
          this.workMs += Date.now() - t0;
          this.workSec += x.length / sr;
          if (this.workSec >= 10) {
            console.log(`[VC] live: ${(this.workMs / this.workSec / 1000 * 100).toFixed(1)} % of real time spent processing (${this.workMs} ms for ${this.workSec.toFixed(1)} s @${sr}, speed ${this.speed}x), at ${this.position().toFixed(1)} s`);
            this.workMs = 0;
            this.workSec = 0;
          }
        } else {
          out = chain.finish();
          this.inputDone = true;
          final = true;
        }
        let { enhanced, original } = out;
        let start = out.start;
        // a new chain starts a little early to settle; drop what is already queued
        const cut = Math.max(0, Math.min(enhanced.length, this.skipUntil - out.start));
        if (cut) { enhanced = enhanced.subarray(cut); original = original.subarray(cut); start += cut; }
        if (!enhanced.length && !final) continue;
        const t0 = Date.now();
        this.output(enhanced, original, start, final);
        this.workMs += Date.now() - t0;
      }
      if (my === this.gen && this.nodes && !this.started && this.outQueued > 0 && this.playing) {
        const ctx = this.ctx!;
        const t = ctx.currentTime + 0.02;
        // explicit offset: in react-native-audio-api 0.13.6 the queue source's default offset (-1)
        // fails its own non-negative check
        this.nodes.enh.start(t, 0);
        this.nodes.org.start(t, 0);
        this.anchorOut = 0;
        this.anchorTime = t;
        this.started = true;
      }
    } catch (e) {
      this.onError?.(e);
    } finally {
      this.filling = false;
    }
  }

  private enqueue(enhanced: Float32Array, original: Float32Array, inStart: number, inEnd: number) {
    const ctx = this.ctx!, n = this.nodes!;
    const sr = this.src.sampleRate;
    const bE = ctx.createBuffer(1, enhanced.length, sr);
    bE.copyToChannel(Float32Array.from(enhanced), 0);
    const bO = ctx.createBuffer(1, original.length, sr);
    bO.copyToChannel(Float32Array.from(original), 0);
    const id = n.enh.enqueueBuffer(bE);
    n.org.enqueueBuffer(bO);
    this.pieces.push({ id, outStart: this.outQueued, outEnd: this.outQueued + enhanced.length, inStart, inEnd });
    this.outQueued += enhanced.length;
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
