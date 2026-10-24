/**
 * Biquad filters (Direct Form I) with coefficients from the
 * RBJ "Audio EQ Cookbook" (Robert Bristow-Johnson).
 */

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

type Kind = 'highpass' | 'lowpass' | 'peaking' | 'notch' | 'highshelf' | 'lowshelf';

export function designBiquad(
  kind: Kind,
  sampleRate: number,
  freq: number,
  q: number,
  gainDb = 0,
): BiquadCoeffs {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;

  switch (kind) {
    case 'highpass':
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'lowpass':
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * cos; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cos + s);
      b1 = -2 * A * ((A - 1) + (A + 1) * cos);
      b2 = A * ((A + 1) + (A - 1) * cos - s);
      a0 = (A + 1) - (A - 1) * cos + s;
      a1 = 2 * ((A - 1) - (A + 1) * cos);
      a2 = (A + 1) - (A - 1) * cos - s;
      break;
    }
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cos + s);
      b1 = 2 * A * ((A - 1) - (A + 1) * cos);
      b2 = A * ((A + 1) - (A - 1) * cos - s);
      a0 = (A + 1) + (A - 1) * cos + s;
      a1 = -2 * ((A - 1) + (A + 1) * cos);
      a2 = (A + 1) + (A - 1) * cos - s;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Filters `input` into a new array (input is left untouched). */
export function applyBiquad(input: Float32Array, c: BiquadCoeffs): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

export function applyChain(input: Float32Array, chain: BiquadCoeffs[]): Float32Array {
  let out = input;
  for (const c of chain) out = applyBiquad(out, c);
  return out === input ? Float32Array.from(input) : out;
}

/**
 * A biquad chain that keeps its state between calls, so a long signal can be filtered chunk by
 * chunk with exactly the same result as applyChain on the whole signal.
 */
export class BiquadChainState {
  private readonly st: Float64Array; // per stage: x1, x2, y1, y2

  constructor(private readonly chain: BiquadCoeffs[]) {
    this.st = new Float64Array(chain.length * 4);
  }

  process(input: Float32Array): Float32Array {
    let cur = input;
    for (let s = 0; s < this.chain.length; s++) {
      const c = this.chain[s];
      const o = s * 4;
      let x1 = this.st[o], x2 = this.st[o + 1], y1 = this.st[o + 2], y2 = this.st[o + 3];
      const out = new Float32Array(cur.length);
      for (let i = 0; i < cur.length; i++) {
        const x0 = cur[i];
        const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        out[i] = y0;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      }
      this.st[o] = x1; this.st[o + 1] = x2; this.st[o + 2] = y1; this.st[o + 3] = y2;
      cur = out;
    }
    return cur === input ? Float32Array.from(input) : cur;
  }
}
