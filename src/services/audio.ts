/**
 * Decoding via react-native-audio-api (FFmpeg on mobile for AAC/M4A/MP4, built-in decoders
 * for WAV/MP3/FLAC/OGG/Opus). Decoded audio is resampled by the library when a rate is given.
 */
import { decodeAudioData, getAudioDuration, isFfmpegEnabled } from 'react-native-audio-api';
import { File } from 'expo-file-system';
import { encodeWav16 } from '../dsp/wav';
import { fileUri } from './uri';

export const SUPPORTED_EXTENSIONS = ['m4a', 'mp4', 'aac', 'mp3', 'wav', 'flac', 'ogg', 'opus'] as const;
const NEEDS_FFMPEG = new Set(['m4a', 'mp4', 'aac']);

export const PICKER_TYPES = [
  'audio/*',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/ogg',
  'audio/opus',
  'video/mp4',
];

export class UnsupportedFormatError extends Error {
  constructor(public ext: string) {
    super(`unsupported:${ext}`);
    this.name = 'UnsupportedFormatError';
  }
}

export const extOf = (name: string) => (name.split('.').pop() ?? '').toLowerCase();

export function assertSupported(name: string): string {
  const ext = extOf(name);
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) throw new UnsupportedFormatError(ext || '?');
  if (NEEDS_FFMPEG.has(ext) && !isFfmpegEnabled()) throw new UnsupportedFormatError(`${ext} (FFmpeg disabled in this build)`);
  return ext;
}

export interface Decoded {
  channels: Float32Array[];
  sampleRate: number;
  durationSec: number;
}


/**
 * Files outside the app (play-list folders, content:// URIs) are read into memory and decoded
 * from there; nothing is written to disk. react-native-audio-api decodes an ArrayBuffer directly.
 */
const isInPlace = (uri: string) => /^content:/i.test(uri);
const readBytes = (uri: string) => new File(uri).arrayBuffer();

export async function decodeFile(uri: string, sampleRate?: number): Promise<Decoded> {
  const buf = await decodeAudioData(isInPlace(uri) ? await readBytes(uri) : fileUri(uri), sampleRate);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(Float32Array.from(buf.getChannelData(c)));
  return { channels, sampleRate: buf.sampleRate, durationSec: buf.duration };
}

export async function readDuration(uri: string): Promise<number | null> {
  try {
    return await getAudioDuration(isInPlace(uri) ? await readBytes(uri) : fileUri(uri));
  } catch {
    return null;
  }
}

export async function writeWavChannels(file: File, channels: Float32Array[], sampleRate: number): Promise<void> {
  if (file.exists) file.delete();
  file.create({ intermediates: true });
  await file.write(encodeWav16(channels, sampleRate));
}

export async function writeWav(file: File, mono: Float32Array, sampleRate: number): Promise<void> {
  if (file.exists) file.delete();
  file.create({ intermediates: true });
  await file.write(encodeWav16([mono], sampleRate));
}

/** Lets the JS thread render between DSP chunks. */
export const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));
