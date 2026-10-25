/**
 * File-backed audio for long recordings: the native streaming decoder writes raw mono 16-bit
 * PCM, the chunked DSP reads it a few seconds at a time, temporary stages are float32 files, and
 * the result is written as a 16-bit WAV. Memory use stays roughly constant with file length.
 */
import { File, FileMode, type FileHandle } from 'expo-file-system';
import VoiceEncoder from '../../modules/voice-encoder/src/VoiceEncoderModule';
import type { SampleSink, SampleSource, TempFactory, TempTrack } from '../dsp/stream';
import { decodeFile } from './audio';
import { newId, tempDir } from './storage';

/** Copies bytes into a fresh, aligned buffer (typed-array views need aligned offsets). */
const aligned = (b: Uint8Array) => b.slice().buffer;

/** Raw mono PCM file read in chunks: 16-bit (decoder output) or 32-bit float (temporary tracks). */
export class PcmFileSource implements SampleSource {
  private handle: FileHandle | null = null;
  constructor(private readonly file: File, readonly sampleRate: number, readonly length: number, private readonly format: 'i16' | 'f32') {}

  private open(): FileHandle {
    if (!this.handle) this.handle = this.file.open(FileMode.ReadOnly);
    return this.handle;
  }

  async read(start: number, count: number): Promise<Float32Array> {
    const h = this.open();
    const bps = this.format === 'i16' ? 2 : 4;
    h.offset = start * bps;
    const bytes = await h.readBytes(count * bps);
    if (this.format === 'f32') return new Float32Array(aligned(bytes), 0, Math.floor(bytes.length / 4));
    const s = new Int16Array(aligned(bytes), 0, Math.floor(bytes.length / 2));
    const out = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s[i] / 32767;
    return out;
  }

  close() {
    try { this.handle?.close(); } catch { /* closed */ }
    this.handle = null;
  }
}

/** 16-bit conversion used everywhere here (symmetric, so a round trip is exact). */
export function toInt16(chunk: Float32Array): Int16Array {
  const s = new Int16Array(chunk.length);
  for (let i = 0; i < chunk.length; i++) s[i] = Math.round(Math.max(-1, Math.min(1, chunk[i])) * 32767);
  return s;
}

/** Temporary track in the app's temp folder (float32, or 16-bit for already-limited audio). */
export const fileTemp: TempFactory = (sampleRate, precision) => {
  const fmt = precision === 'int16' ? 'i16' : 'f32';
  const file = new File(tempDir(), `stage-${newId()}.${fmt}`);
  file.create({ overwrite: true });
  let handle: FileHandle | null = file.open(FileMode.WriteOnly);
  let length = 0;
  let source: PcmFileSource | null = null;
  const track: TempTrack = {
    async write(chunk) {
      if (!handle) throw new Error('temp track closed');
      if (chunk.length === 0) return;
      const bytes = fmt === 'i16' ? new Uint8Array(toInt16(chunk).buffer) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      await handle.writeBytes(bytes);
      length += chunk.length;
    },
    async done() {
      handle?.close();
      handle = null;
      source = new PcmFileSource(file, sampleRate, length, fmt);
      return source;
    },
    dispose() {
      try { handle?.close(); } catch { /* closed */ }
      handle = null;
      source?.close();
      try { if (file.exists) file.delete(); } catch { /* gone */ }
    },
  };
  return track;
};

/** Writes 16-bit mono WAV chunk by chunk; the header sizes are filled in by close(). */
export class WavFileSink implements SampleSink {
  private handle: FileHandle;
  private frames = 0;

  constructor(file: File, private readonly sampleRate: number) {
    file.create({ overwrite: true });
    this.handle = file.open(FileMode.WriteOnly);
    this.handle.writeBytesSync(this.header(0));
  }

  private header(dataBytes: number): Uint8Array {
    const b = new ArrayBuffer(44);
    const v = new DataView(b);
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, this.sampleRate, true); v.setUint32(28, this.sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, dataBytes, true);
    return new Uint8Array(b);
  }

  async write(chunk: Float32Array): Promise<void> {
    if (chunk.length === 0) return;
    await this.handle.writeBytes(new Uint8Array(toInt16(chunk).buffer));
    this.frames += chunk.length;
  }

  close(): number {
    this.handle.offset = 0;
    this.handle.writeBytesSync(this.header(this.frames * 2));
    this.handle.close();
    return this.frames;
  }
}

export interface DecodedPcm {
  source: PcmFileSource;
  file: File;
  /** Original channel count, for the library record. */
  channels: number;
  dispose(): void;
}

/** Files longer than this are only processed through the streaming decoder. */
export const MAX_IN_MEMORY_SEC = 20 * 60;
/** Files up to this length use the in-memory decoder (fast, small at this length). */
export const SHORT_IN_MEMORY_SEC = 5 * 60;

export class StreamDecodeUnavailableError extends Error {
  constructor(public detail: string) {
    super('stream_decode_unavailable');
    this.name = 'StreamDecodeUnavailableError';
  }
}

/**
 * Decodes `uri` to a temporary mono PCM file at `sampleRate`. Uses the native streaming decoder;
 * if it is missing or cannot read the format, short files fall back to the in-memory decoder.
 */
export async function decodeToPcmFile(
  uri: string,
  sampleRate: number,
  durationSec: number,
  onProgress?: (f: number) => void,
  isCancelled?: () => boolean,
): Promise<DecodedPcm> {
  const file = new File(tempDir(), `decode-${newId()}.pcm`);
  const dispose = () => { try { if (file.exists) file.delete(); } catch { /* gone */ } };
  let nativeError = 'native decoder not in this build';
  // Short files: the in-memory decoder is quick and needs little memory at this length. On the
  // emulator the platform AAC decoder ran at ~2x real time (about 10 ms per AAC frame).
  const preferMemory = durationSec > 0 && durationSec <= SHORT_IN_MEMORY_SEC;
  if (VoiceEncoder && !preferMemory) {
    const id = newId();
    const sub = VoiceEncoder.addListener('onDecodeProgress', (e) => { if (e.id === id) onProgress?.(e.fraction); });
    const poll = isCancelled ? setInterval(() => { if (isCancelled()) VoiceEncoder!.cancelDecode(id); }, 200) : null;
    try {
      const t0 = Date.now();
      const r = await VoiceEncoder.decodeToPcm(id, uri, file.uri, sampleRate);
      console.log(`[VC] stream-decoded ${(r.frames / sampleRate).toFixed(1)}s @${sampleRate} (source ${r.sourceRate} Hz, ${r.sourceChannels} ch) in ${Date.now() - t0} ms`);
      const source = new PcmFileSource(file, sampleRate, r.frames, 'i16');
      return { source, file, channels: r.sourceChannels, dispose: () => { source.close(); dispose(); } };
    } catch (e) {
      dispose();
      if (isCancelled?.()) throw Object.assign(new Error('Processing was cancelled'), { name: 'CancelledError' });
      nativeError = e instanceof Error ? e.message : String(e);
      console.warn(`[VC] stream decode failed: ${nativeError}`);
    } finally {
      sub.remove();
      if (poll) clearInterval(poll);
    }
  }
  if (durationSec > MAX_IN_MEMORY_SEC) throw new StreamDecodeUnavailableError(nativeError);
  // short file: decode in memory once and store it like the native decoder would
  const t0 = Date.now();
  const d = await decodeFile(uri, sampleRate);
  console.log(`[VC] memory-decoded ${(d.durationSec).toFixed(1)}s @${d.sampleRate} in ${Date.now() - t0} ms`);
  const n = d.channels[0]?.length ?? 0;
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const ch of d.channels) v += ch[i];
    v = Math.max(-1, Math.min(1, v / d.channels.length));
    s[i] = Math.round(v * 32767);
  }
  file.create({ overwrite: true });
  await file.write(new Uint8Array(s.buffer)); // async: reading before it finishes gave silence
  const source = new PcmFileSource(file, d.sampleRate, n, 'i16');
  return { source, file, channels: d.channels.length, dispose: () => { source.close(); dispose(); } };
}

export interface DecodedParts extends DecodedPcm {
  /** Frames decoded for each requested part, in order. */
  partFrames: number[];
}

/**
 * Decodes only some parts of a recording (start/length in seconds) into one temporary PCM file,
 * by seeking: a few minutes of a long recording are ready quickly. Returns null when this build
 * or format cannot do that, so the caller can fall back to decoding everything.
 */
export async function decodeRangesToPcmFile(
  uri: string,
  sampleRate: number,
  parts: { start: number; length: number }[],
  onProgress?: (f: number) => void,
  isCancelled?: () => boolean,
): Promise<DecodedParts | null> {
  if (!VoiceEncoder?.decodeRangesToPcm || parts.length === 0) return null;
  const file = new File(tempDir(), `parts-${newId()}.pcm`);
  const id = newId();
  const sub = VoiceEncoder.addListener('onDecodeProgress', (e) => { if (e.id === id) onProgress?.(e.fraction); });
  const poll = isCancelled ? setInterval(() => { if (isCancelled()) VoiceEncoder!.cancelDecode(id); }, 200) : null;
  try {
    const t0 = Date.now();
    const r = await VoiceEncoder.decodeRangesToPcm(id, uri, file.uri, sampleRate, parts.map((p) => p.start), parts.map((p) => p.length));
    const total = r.frames.reduce((a, b) => a + b, 0);
    console.log(`[VC] range-decoded ${parts.length} parts, ${(total / sampleRate).toFixed(1)}s @${sampleRate} in ${Date.now() - t0} ms`);
    const source = new PcmFileSource(file, sampleRate, total, 'i16');
    return {
      source, file, channels: r.sourceChannels, partFrames: r.frames,
      dispose: () => { source.close(); try { if (file.exists) file.delete(); } catch { /* gone */ } },
    };
  } catch (e) {
    try { if (file.exists) file.delete(); } catch { /* gone */ }
    if (isCancelled?.()) throw Object.assign(new Error('Processing was cancelled'), { name: 'CancelledError' });
    console.warn(`[VC] range decode failed, decoding everything instead: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    sub.remove();
    if (poll) clearInterval(poll);
  }
}

export { samplePlan } from './samplePlan';

/**
 * A long recording read anywhere without decoding all of it: 20 s blocks are decoded by seeking
 * when first needed (the next block is decoded ahead), and the last few are kept.
 */
export class SeekingSource implements SampleSource {
  readonly length: number;
  private readonly blocks = new Map<number, Promise<DecodedParts | null>>();
  private readonly order: number[] = [];
  private readonly blockLen: number;

  constructor(private readonly uri: string, readonly sampleRate: number, durationSec: number, private readonly blockSec = 20) {
    this.length = Math.round(durationSec * sampleRate);
    this.blockLen = Math.round(blockSec * sampleRate);
  }

  private block(b: number): Promise<DecodedParts | null> {
    let p = this.blocks.get(b);
    if (!p) {
      const start = b * this.blockSec;
      p = decodeRangesToPcmFile(this.uri, this.sampleRate, [{ start, length: this.blockSec }]);
      this.blocks.set(b, p);
      this.order.push(b);
      while (this.order.length > 4) {
        const old = this.order.shift()!;
        void this.blocks.get(old)?.then((d) => d?.dispose());
        this.blocks.delete(old);
      }
    }
    return p;
  }

  async read(start: number, count: number): Promise<Float32Array> {
    const n = Math.max(0, Math.min(count, this.length - start));
    const out = new Float32Array(n);
    let o = 0;
    while (o < n) {
      const pos = start + o;
      const b = Math.floor(pos / this.blockLen);
      const d = await this.block(b);
      if (!d) throw new Error('stream_decode_unavailable');
      const off = pos - b * this.blockLen;
      const take = Math.min(n - o, this.blockLen - off);
      const x = off < d.source.length ? await d.source.read(off, Math.min(take, d.source.length - off)) : new Float32Array(0);
      out.set(x, o);
      o += take; // a block shorter than expected (end of file) leaves silence
      // decode the next block ahead once this one is being read past its middle
      if (off + take > this.blockLen / 2 && (b + 1) * this.blockLen < this.length) void this.block(b + 1);
    }
    return out;
  }

  dispose() {
    for (const p of this.blocks.values()) void p.then((d) => d?.dispose());
    this.blocks.clear();
    this.order.length = 0;
  }
}
