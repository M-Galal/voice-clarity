/**
 * Streaming time-scale modification (WSOLA, as changeSpeed in edit.ts) for live listening at
 * 0.25x-5x with the pitch kept. Two aligned signals go in (enhanced and original); the frame
 * positions are chosen on the first one and used for both, so they stay in step and switching
 * between them during playback has no jump.
 *
 * Frames of 40 ms are overlap-added with a Hann window at 50 % overlap (synthesis hop 20 ms);
 * each input frame starts near speed x its output position and is moved by up to +-10 ms to where
 * it best continues the previous frame (searched on a ~4 kHz copy, refined at full rate).
 */
export const STRETCH_MIN = 0.25;
export const STRETCH_MAX = 5;

export interface StretchOut {
  a: Float32Array;
  b: Float32Array;
}

export class StreamStretcher {
  private readonly N: number;
  private readonly Hs: number;
  private readonly Ha: number;
  private readonly tol: number;
  private readonly dec: number;
  private readonly win: Float32Array;
  // input (absolute index from the stretcher's start), kept from inStart
  private inA = new Float32Array(0);
  private inB = new Float32Array(0);
  private inStart = 0;
  private inEnd = 0;
  // output accumulators for positions [outBase, outBase + acc length)
  private accA: Float32Array;
  private accB: Float32Array;
  private norm: Float32Array;
  private outBase = 0;
  private frame = 0;
  private prev = 0;

  constructor(sampleRate: number, readonly speed: number) {
    this.N = Math.max(64, Math.round(sampleRate * 0.04) & ~1);
    this.Hs = this.N / 2;
    this.Ha = this.Hs * speed;
    this.tol = Math.round(sampleRate * 0.01);
    this.dec = Math.max(1, Math.floor(sampleRate / 4000));
    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) this.win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.N));
    this.accA = new Float32Array(this.N);
    this.accB = new Float32Array(this.N);
    this.norm = new Float32Array(this.N);
  }

  /** Output samples produced per input sample. */
  get ratio() { return 1 / this.speed; }

  private append(a: Float32Array, b: Float32Array) {
    const join = (x: Float32Array, y: Float32Array) => { const o = new Float32Array(x.length + y.length); o.set(x, 0); o.set(y, x.length); return o; };
    this.inA = join(this.inA, a);
    this.inB = join(this.inB, b);
    this.inEnd += a.length;
  }

  /** Normalised correlation of input [p, p+n) and [q, q+n) with stride `step` (outside the buffer = 0). */
  private corr(p: number, q: number, n: number, step: number): number {
    const x = this.inA, len = x.length;
    let a = p - this.inStart, b = q - this.inStart;
    // only the part where both windows are inside the buffer contributes
    let i0 = 0, i1 = n;
    if (a < 0 || b < 0) { const s = -Math.min(a, b); i0 = Math.ceil(s / step) * step; }
    i1 = Math.min(n, len - a, len - b);
    let xy = 0, xx = 0, yy = 0;
    a += i0; b += i0;
    for (let i = i0; i < i1; i += step, a += step, b += step) {
      const u = x[a], v = x[b];
      xy += u * v; xx += u * u; yy += v * v;
    }
    return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
  }

  /** Places frame `frame` if its input is in (or `final`); returns false when more input is needed. */
  private placeFrame(final: boolean): boolean {
    const { N, Hs, tol, dec } = this;
    const ideal = Math.round(this.frame * this.Ha);
    if (!final && ideal + tol + N > this.inEnd) return false;
    if (final && ideal >= this.inEnd) return false;
    let pos = ideal;
    if (this.frame > 0) {
      const target = this.prev + Hs; // natural continuation of the previous frame
      // coarse search every `dec` samples with a decimated correlation, then refine
      let best = -Infinity, bestD = 0;
      for (let d = -tol; d <= tol; d += dec) {
        const c = ideal + d;
        if (c < this.inStart || (!final && c + N > this.inEnd)) continue;
        const v = this.corr(target, c, N, dec);
        if (v > best) { best = v; bestD = d; }
      }
      const centre = ideal + bestD;
      best = -Infinity;
      pos = centre;
      for (let d = -dec; d <= dec; d++) {
        const c = centre + d;
        if (c < this.inStart) continue;
        const v = this.corr(target, c, Math.min(N, 256), 1);
        if (v > best) { best = v; pos = c; }
      }
    }
    const outPos = this.frame * Hs - this.outBase;
    // grow the accumulators to hold [outPos, outPos + N)
    if (outPos + N > this.accA.length) {
      const grow = (x: Float32Array) => { const o = new Float32Array(outPos + N); o.set(x, 0); return o; };
      this.accA = grow(this.accA); this.accB = grow(this.accB); this.norm = grow(this.norm);
    }
    const inA = this.inA, inB = this.inB, accA = this.accA, accB = this.accB, norm = this.norm, win = this.win;
    const k0 = pos - this.inStart;
    for (let i = 0; i < N; i++) {
      const w = win[i];
      const k = k0 + i;
      if (k >= 0 && k < inA.length) { accA[outPos + i] += inA[k] * w; accB[outPos + i] += inB[k] * w; }
      norm[outPos + i] += w;
    }
    this.prev = pos;
    this.frame++;
    return true;
  }

  /** Output positions below `upto` (absolute) are final: hand them out. */
  private emit(upto: number): StretchOut {
    const n = Math.max(0, upto - this.outBase);
    const a = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const g = this.norm[i] > 1e-3 ? 1 / this.norm[i] : 1;
      a[i] = this.accA[i] * g;
      b[i] = this.accB[i] * g;
    }
    this.accA = this.accA.slice(n); this.accB = this.accB.slice(n); this.norm = this.norm.slice(n);
    this.outBase += n;
    // input before the earliest position a later frame can read is no longer needed
    const keep = Math.max(this.inStart, Math.min(this.prev, Math.round(this.frame * this.Ha) - this.tol) - this.dec);
    if (keep > this.inStart) {
      this.inA = this.inA.slice(keep - this.inStart);
      this.inB = this.inB.slice(keep - this.inStart);
      this.inStart = keep;
    }
    return { a, b };
  }

  push(a: Float32Array, b: Float32Array): StretchOut {
    this.append(a, b);
    while (this.placeFrame(false)) { /* place every frame whose input is in */ }
    // samples before the next frame's start receive no more frames
    return this.emit(this.frame * this.Hs);
  }

  /** End of input: the remaining frames and everything still accumulated. */
  flush(): StretchOut {
    while (this.placeFrame(true)) { /* to the end of the input */ }
    const end = Math.max(this.outBase, Math.round(this.inEnd / this.speed));
    return this.emit(Math.min(end, this.outBase + this.accA.length));
  }
}
