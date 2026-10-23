/**
 * Editing operations: trim (keep a range), cut (remove a range) and speed change that keeps
 * the pitch. All functions return new buffers and never modify their input.
 */

export interface EditSpec {
  /** 'keep' trims the file to [start, end]; 'cut' removes [start, end]; 'none' leaves length alone. */
  mode: 'none' | 'keep' | 'cut';
  start: number; // seconds
  end: number; // seconds
  /** 1 = unchanged, 2 = twice as fast (half the length), 0.5 = half speed. Pitch is kept. */
  speed: number;
}

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

export function normalizeSpec(spec: EditSpec, duration: number): EditSpec {
  const a = Math.max(0, Math.min(duration, Math.min(spec.start, spec.end)));
  const b = Math.max(0, Math.min(duration, Math.max(spec.start, spec.end)));
  return { ...spec, start: a, end: b, speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, spec.speed || 1)) };
}

/** Length in seconds after the edit, before any rounding to whole samples. */
export function editedDuration(spec: EditSpec, duration: number): number {
  const s = normalizeSpec(spec, duration);
  const kept = s.mode === 'keep' ? s.end - s.start : s.mode === 'cut' ? duration - (s.end - s.start) : duration;
  return kept / s.speed;
}

/** Where a time on the old timeline lands after the edit, or null if it was removed. */
export function remapTime(t: number, spec: EditSpec, duration: number): number | null {
  const s = normalizeSpec(spec, duration);
  let u = t;
  if (s.mode === 'keep') {
    if (t < s.start || t > s.end) return null;
    u = t - s.start;
  } else if (s.mode === 'cut') {
    if (t > s.start && t < s.end) return null;
    if (t >= s.end) u = t - (s.end - s.start);
  }
  return u / s.speed;
}

/** Applies trim or cut to every channel, with 5 ms fades at joins so they do not click. */
export function cutChannels(channels: Float32Array[], sampleRate: number, spec: EditSpec): Float32Array[] {
  const len = channels[0]?.length ?? 0;
  const s = normalizeSpec(spec, len / sampleRate);
  if (s.mode === 'none') return channels.map((c) => Float32Array.from(c));
  const a = Math.round(s.start * sampleRate);
  const b = Math.round(s.end * sampleRate);
  const fade = Math.max(1, Math.round(0.005 * sampleRate));
  return channels.map((ch) => {
    if (s.mode === 'keep') {
      const out = ch.slice(a, b);
      for (let i = 0; i < Math.min(fade, out.length); i++) {
        const g = i / fade;
        if (a > 0) out[i] *= g;
        if (b < len) out[out.length - 1 - i] *= g;
      }
      return out;
    }
    const head = ch.slice(0, a);
    const tail = ch.slice(b);
    for (let i = 0; i < Math.min(fade, head.length); i++) head[head.length - 1 - i] *= i / fade;
    for (let i = 0; i < Math.min(fade, tail.length); i++) tail[i] *= i / fade;
    const out = new Float32Array(head.length + tail.length);
    out.set(head, 0);
    out.set(tail, head.length);
    return out;
  });
}

export interface StretchProgress {
  onProgress?: (fraction: number) => void;
  isCancelled?: () => boolean;
  yieldFn?: () => Promise<void>;
}

/**
 * Time-scale modification by WSOLA (waveform-similarity overlap-add). Frames of ~40 ms are
 * overlap-added with a Hann window at 50 % overlap; each input frame is shifted by up to ±10 ms
 * to the position that best continues the previous one, which keeps pitch and avoids
 * phasiness. The shift is searched on a 4 kHz mono copy (fast) and refined at full rate, and
 * the same shift is used for every channel so stereo stays aligned.
 */
export async function changeSpeed(
  channels: Float32Array[],
  sampleRate: number,
  speed: number,
  progress: StretchProgress = {},
): Promise<Float32Array[]> {
  if (Math.abs(speed - 1) < 1e-6 || channels.length === 0) return channels.map((c) => Float32Array.from(c));
  const len = channels[0].length;
  const N = Math.max(64, Math.round(sampleRate * 0.04) & ~1); // frame, even
  const Hs = N / 2; // synthesis hop
  const Ha = Hs * speed; // analysis hop
  const tol = Math.round(sampleRate * 0.01);
  const outLen = Math.max(0, Math.round(len / speed));
  const outs = channels.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));

  // mono, decimated copy for the similarity search
  const mono = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) mono[i] += ch[i] / channels.length;
  const dec = Math.max(1, Math.floor(sampleRate / 4000));
  const small = new Float32Array(Math.ceil(len / dec));
  for (let i = 0, j = 0; i < len; i += dec, j++) {
    let acc = 0;
    let n = 0;
    for (let k = i; k < Math.min(len, i + dec); k++) { acc += mono[k]; n++; }
    small[j] = acc / n;
  }
  const Nd = Math.max(8, Math.floor(N / dec));
  const tolD = Math.max(1, Math.floor(tol / dec));

  const corr = (sig: Float32Array, p: number, q: number, n: number) => {
    // correlation between sig[p..p+n) and sig[q..q+n), normalised
    let xy = 0, xx = 0, yy = 0;
    for (let i = 0; i < n; i++) {
      const x = sig[p + i] ?? 0;
      const y = sig[q + i] ?? 0;
      xy += x * y; xx += x * x; yy += y * y;
    }
    return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
  };

  let prev = 0; // input position of the previous chosen frame
  const frames = Math.ceil(outLen / Hs) + 1;
  for (let f = 0; f < frames; f++) {
    const outPos = f * Hs;
    const ideal = Math.round(f * Ha);
    let pos = ideal;
    if (f > 0) {
      const target = prev + Hs; // natural continuation of the previous frame
      // coarse search on the decimated signal
      const tD = Math.floor(target / dec);
      const iD = Math.floor(ideal / dec);
      let best = -Infinity;
      let bestD = 0;
      for (let d = -tolD; d <= tolD; d++) {
        const c = iD + d;
        if (c < 0 || c + Nd > small.length) continue;
        const v = corr(small, tD, c, Nd);
        if (v > best) { best = v; bestD = d; }
      }
      // refine at full rate around the coarse pick
      const centre = ideal + bestD * dec;
      best = -Infinity;
      pos = centre;
      for (let d = -dec; d <= dec; d++) {
        const c = centre + d;
        if (c < 0 || c + N > len) continue;
        const v = corr(mono, target, c, Math.min(N, 256));
        if (v > best) { best = v; pos = c; }
      }
    }
    pos = Math.max(0, Math.min(len - 1, pos));
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = outs[c];
      for (let i = 0; i < N; i++) {
        const si = pos + i;
        if (si >= len) break;
        dst[outPos + i] += src[si] * win[i];
      }
    }
    for (let i = 0; i < N; i++) norm[outPos + i] += win[i];
    prev = pos;

    if (f % 200 === 199) {
      if (progress.isCancelled?.()) throw Object.assign(new Error('Processing was cancelled'), { name: 'CancelledError' });
      progress.onProgress?.(f / frames);
      if (progress.yieldFn) await progress.yieldFn();
    }
  }
  progress.onProgress?.(1);
  return outs.map((o) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? o[i] / norm[i] : o[i];
    return r;
  });
}

/** Full edit: cut/trim first (cheaper), then speed. */
export async function applyEdit(
  channels: Float32Array[],
  sampleRate: number,
  spec: EditSpec,
  progress: StretchProgress = {},
): Promise<Float32Array[]> {
  const cut = cutChannels(channels, sampleRate, spec);
  const s = normalizeSpec(spec, (channels[0]?.length ?? 0) / sampleRate);
  return changeSpeed(cut, sampleRate, s.speed, progress);
}
