/**
 * Which file type an edit is saved as. Pure functions (no React Native imports) so they can be tested.
 *
 * The phone's own encoders decide what is possible:
 * - WAV is written by the app itself.
 * - M4A / MP4 audio: AAC in an MPEG-4 container (Android MediaCodec + MediaMuxer, iOS AVAudioFile).
 * - AAC (raw ADTS): written on Android; iOS has no ADTS writer in this app, so those save as M4A.
 * - MP3, FLAC, OGG, Opus: no matching encoder is used here (Android lists no MP3 encoder at all),
 *   so those save as M4A (AAC), and the Edit screen says so before saving.
 */
export type Container = 'wav' | 'mpeg4' | 'adts';

export interface SaveTarget {
  ext: string; // without dot, lower case
  container: Container;
  /** True when the saved file will not have the original's extension. */
  changed: boolean;
}

export function saveTarget(originalExt: string, encoderContainers: readonly string[]): SaveTarget {
  const ext = originalExt.toLowerCase().replace(/^\./, '');
  const has = (c: string) => encoderContainers.includes(c);
  if (ext === 'wav') return { ext: 'wav', container: 'wav', changed: false };
  if ((ext === 'm4a' || ext === 'mp4') && has('mpeg4')) return { ext, container: 'mpeg4', changed: false };
  if (ext === 'aac' && has('adts')) return { ext: 'aac', container: 'adts', changed: false };
  if (has('mpeg4')) return { ext: 'm4a', container: 'mpeg4', changed: ext !== 'm4a' };
  // no native encoder in this build: WAV is always possible
  return { ext: 'wav', container: 'wav', changed: ext !== 'wav' };
}

export const MIME: Record<string, string> = {
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
};

/**
 * AAC bit rate for the saved file: close to the original's average bit rate so size and
 * quality stay similar, kept within what AAC-LC encoders accept for the sample rate.
 */
export function aacBitrate(originalBytes: number, durationSec: number, sampleRate: number, channels: number): number {
  const original = durationSec > 0 ? (originalBytes * 8) / durationSec : 0;
  const floor = 32000 * channels;
  const ceiling = Math.min(160000 * channels, Math.floor(sampleRate * 6 * channels * 0.9));
  const fallback = (sampleRate <= 24000 ? 48000 : 96000) * channels;
  const want = original > 0 ? original : fallback;
  return Math.round(Math.max(floor, Math.min(ceiling, want)) / 1000) * 1000;
}

/**
 * Default name for "Save as": "<base>-v<n>", where base drops an existing "-v<n>" suffix and
 * n is one more than the highest version already in the library (starting at 1).
 */
export function nextVersionName(name: string, existingNames: readonly string[]): string {
  const base = name.replace(/-v\d+$/i, '');
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}-v(\\d+)$`, 'i');
  let max = 0;
  for (const n of existingNames) {
    const m = re.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${base}-v${max + 1}`;
}
