/**
 * Average spectrum of a signal, fed chunk by chunk: 2048-point Hann-windowed FFT frames
 * (no overlap), power averaged per bin, then grouped into log-spaced bands for display.
 */
import { RealFFT } from './fft';

export interface Spectrum {
  /** Band centre frequencies, Hz. */
  freqs: number[];
  /** Mean power per band, dB (relative to a full-scale sine ≈ 0 dB). */
  db: number[];
}

export class SpectrumMeter {
  private readonly fft: RealFFT;
  private readonly win: Float32Array;
  private readonly buf: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly sum: Float64Array;
  private filled = 0;
  private frames = 0;
  private readonly norm: number;

  constructor(private readonly sampleRate: number, private readonly n = 2048) {
    this.fft = new RealFFT(n);
    this.win = new Float32Array(n);
    let wsum = 0;
    for (let i = 0; i < n; i++) { this.win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n)); wsum += this.win[i]; }
    // a full-scale sine puts amplitude wsum/2 in its bin: scale so that reads 0 dB
    this.norm = 1 / ((wsum / 2) * (wsum / 2));
    this.buf = new Float32Array(n);
    this.re = new Float32Array(n / 2 + 1);
    this.im = new Float32Array(n / 2 + 1);
    this.sum = new Float64Array(n / 2 + 1);
  }

  push(x: Float32Array): void {
    for (let i = 0; i < x.length; i++) {
      this.buf[this.filled++] = x[i] * this.win[this.filled - 1];
      if (this.filled === this.n) {
        this.fft.forward(this.buf, this.re, this.im);
        for (let k = 0; k <= this.n / 2; k++) this.sum[k] += (this.re[k] * this.re[k] + this.im[k] * this.im[k]) * this.norm;
        this.frames++;
        this.filled = 0;
      }
    }
  }

  /** `count` log-spaced bands between fMin and fMax (capped below Nyquist). */
  bands(count = 40, fMin = 60, fMax = 12000): Spectrum {
    const nyq = this.sampleRate / 2;
    const hi = Math.min(fMax, nyq * 0.98);
    const binHz = this.sampleRate / this.n;
    const freqs: number[] = [];
    const db: number[] = [];
    for (let b = 0; b < count; b++) {
      const f0 = fMin * Math.pow(hi / fMin, b / count);
      const f1 = fMin * Math.pow(hi / fMin, (b + 1) / count);
      const k0 = Math.max(1, Math.floor(f0 / binHz));
      const k1 = Math.max(k0 + 1, Math.ceil(f1 / binHz));
      let p = 0;
      for (let k = k0; k < Math.min(k1, this.n / 2 + 1); k++) p += this.sum[k];
      p /= Math.max(1, this.frames) * (k1 - k0);
      freqs.push(Math.sqrt(f0 * f1));
      db.push(10 * Math.log10(p + 1e-20));
    }
    return { freqs, db };
  }
}
