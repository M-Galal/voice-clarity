/** In-place iterative radix-2 complex FFT. `re`/`im` length must be a power of two. */
export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
  }

  transform(re: Float32Array, im: Float32Array, inverse = false): void {
    const n = this.size;
    const rev = this.rev, cos = this.cos, sin = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const step = n / len;
      for (let j = 0; j < halfLen; j++) {
        // one twiddle for all butterflies of this j (same arithmetic as before, fewer lookups)
        const wr = cos[j * step];
        const wi = sign * sin[j * step];
        for (let a = j; a < n; a += len) {
          const b = a + halfLen;
          const rb = re[b], ib = im[b];
          const tr = rb * wr - ib * wi;
          const ti = rb * wi + ib * wr;
          const ra = re[a], ia = im[a];
          re[b] = ra - tr; im[b] = ia - ti;
          re[a] = ra + tr; im[a] = ia + ti;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }
}

export const nextPow2 = (n: number): number => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

/**
 * Real FFT of size n using one complex FFT of size n/2 (about twice as fast as a full complex
 * transform). Spectrum bins 0..n/2 are returned in re/im arrays of length n/2 + 1.
 */
export class RealFFT {
  readonly size: number;
  private readonly half: FFT;
  private readonly zr: Float32Array;
  private readonly zi: Float32Array;
  private readonly wr: Float32Array;
  private readonly wi: Float32Array;

  constructor(size: number) {
    this.size = size;
    const h = size / 2;
    this.half = new FFT(h);
    this.zr = new Float32Array(h);
    this.zi = new Float32Array(h);
    this.wr = new Float32Array(h + 1);
    this.wi = new Float32Array(h + 1);
    for (let k = 0; k <= h; k++) {
      this.wr[k] = Math.cos((2 * Math.PI * k) / size);
      this.wi[k] = -Math.sin((2 * Math.PI * k) / size);
    }
  }

  /** x (length n) → re/im (length n/2 + 1). */
  forward(x: Float32Array, re: Float32Array, im: Float32Array): void {
    const h = this.size / 2;
    const zr = this.zr, zi = this.zi, twr = this.wr, twi = this.wi;
    for (let i = 0; i < h; i++) { zr[i] = x[2 * i]; zi[i] = x[2 * i + 1]; }
    this.half.transform(zr, zi);
    for (let k = 0; k <= h; k++) {
      const a = k % h, b = (h - k) % h;
      const ar = zr[a], ai = zi[a], br = zr[b], bi = -zi[b]; // Z[k], conj(Z[h-k])
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi); // even part
      const or = 0.5 * (ai - bi), oi = -0.5 * (ar - br); // odd part: (Z[k] - conj)/2i
      const wr = twr[k], wi = twi[k];
      re[k] = er + wr * or - wi * oi;
      im[k] = ei + wr * oi + wi * or;
    }
  }

  /** re/im (length n/2 + 1) → x (length n). */
  inverse(re: Float32Array, im: Float32Array, x: Float32Array): void {
    const h = this.size / 2;
    const zr = this.zr, zi = this.zi, twr = this.wr, twi = this.wi;
    for (let k = 0; k < h; k++) {
      const ar = re[k], ai = im[k], br = re[h - k], bi = -im[h - k]; // X[k], conj(X[h-k])
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      const dr = 0.5 * (ar - br), di = 0.5 * (ai - bi);
      // odd part = d · W^-k
      const wr = twr[k], wi = -twi[k];
      const or = dr * wr - di * wi, oi = dr * wi + di * wr;
      // Z = E + i·O
      zr[k] = er - oi;
      zi[k] = ei + or;
    }
    this.half.transform(zr, zi, true);
    for (let i = 0; i < h; i++) { x[2 * i] = zr[i]; x[2 * i + 1] = zi[i]; }
  }
}
