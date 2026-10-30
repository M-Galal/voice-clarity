/**
 * Import, analysis, enhancement and export. All audio work happens on the device.
 */
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { Directory, File, FileMode } from 'expo-file-system';
import { displayName } from '../playlist/filter';
import VoiceEncoder from '../../modules/voice-encoder/src/VoiceEncoderModule';
import { aacBitrate, MIME, saveTarget, type SaveTarget } from '../edit/saveFormat';
import { CancelledError } from '../dsp/denoise';
import type { EnhanceSettings, EnhanceSummary } from '../dsp/pipeline';
import { analyseForSmart, analyseStream, enhanceStream, type SampleSource, type SmartAnalysis } from '../dsp/stream';
import { decodeRangesToPcmFile, decodeToPcmFile, fileTemp, samplePlan, SeekingSource, WavFileSink, type DecodedPcm } from './pcm';
import { mapToParts } from './samplePlan';
import type { Segment } from '../dsp/vad';
import { toJson, toSrt, toTxt, toVtt, type Transcript } from '../transcript/format';
import type { Bookmark, Recording } from '../types';
import { assertSupported, decodeFile, extOf, PICKER_TYPES, readDuration, writeWavChannels, yieldToUi } from './audio';
import { applyEdit, editedDuration, normalizeSpec, remapTime, type EditSpec } from '../dsp/edit';
import { ensureDirs, fileIn, freeBytes, newId, recordingDir, tempDir } from './storage';

export class LowStorageError extends Error {
  constructor(public neededBytes: number, public freeBytes: number) {
    super('low_storage');
    this.name = 'LowStorageError';
  }
}

/**
 * Temporary disk space for enhancing `durationSec` at `rate`: at most 6 bytes per sample are on
 * disk at once (decoded 16-bit input + float stage, then float stage + 16-bit limited track,
 * then 16-bit track + 16-bit output), plus margin.
 */
export const estimateWorkBytes = (durationSec: number, rate: number) => Math.round(durationSec * rate * 6 * 1.1 + 20e6);

export function checkStorage(needed: number) {
  const free = freeBytes();
  if (free < needed) throw new LowStorageError(needed, free);
}

export async function pickRecordings(): Promise<DocumentPicker.DocumentPickerAsset[]> {
  const res = await DocumentPicker.getDocumentAsync({ type: PICKER_TYPES, multiple: true, copyToCacheDirectory: true });
  return res.canceled ? [] : res.assets;
}

/** Copies the picked file into app storage untouched. Returns a new Recording (not yet analysed). */
export async function importAsset(asset: { uri: string; name: string; size?: number; mimeType?: string }): Promise<Recording> {
  const ext = assertSupported(asset.name);
  ensureDirs();
  const src = new File(asset.uri);
  const size = asset.size ?? src.size ?? 0;
  checkStorage(size * 1.1 + 5e6);
  const id = newId();
  const dir = recordingDir(id);
  dir.create({ intermediates: true, idempotent: true });
  const originalFileName = `original.${ext}`;
  const dest = new File(dir, originalFileName);
  await src.copy(dest);
  const duration = (await readDuration(dest.uri)) ?? 0;
  return {
    id,
    name: asset.name.replace(/\.[^.]+$/, ''),
    originalFileName,
    format: ext.toUpperCase(),
    mimeType: asset.mimeType,
    sizeBytes: dest.size || size,
    durationSec: duration,
    importedAt: new Date().toISOString(),
    lastPositionSec: 0,
    lastPlayedSource: 'original',
    bookmarks: [],
    status: 'analyzing',
  };
}

/**
 * Adds a play-list file to the library without copying it: the audio stays in its folder and is
 * played and decoded from there. Only the app's own data (bookmarks, speech sections, any enhanced
 * copy or transcript the user makes) is stored in the app.
 */
export async function linkExternal(item: { uri: string; name: string; size?: number; folderUri?: string; subfolder?: string }): Promise<Recording> {
  const ext = assertSupported(item.name);
  ensureDirs();
  const id = newId();
  recordingDir(id).create({ intermediates: true, idempotent: true });
  const duration = (await readDuration(item.uri)) ?? 0;
  return {
    id,
    name: item.name.replace(/\.[^.]+$/, ''),
    originalFileName: item.name,
    format: ext.toUpperCase(),
    mimeType: MIME[ext],
    sizeBytes: item.size ?? 0,
    durationSec: duration,
    importedAt: new Date().toISOString(),
    lastPositionSec: 0,
    lastPlayedSource: 'original',
    bookmarks: [],
    status: 'analyzing',
    sourceUri: item.uri,
    external: true,
    sourceFolderUri: item.folderUri,
    sourceSubfolder: item.subfolder,
  };
}

/** Where the recording's original audio is: in its folder for play-list files, else in the app. */
export const originalUri = (rec: Recording) =>
  rec.external && rec.sourceUri ? rec.sourceUri : fileIn(rec.id, rec.originalFileName).uri;

export interface AnalysisResult {
  durationSec: number;
  sampleRate: number;
  channels: number;
  segments: Segment[];
  waveform: number[];
  noiseFloorDb: number;
}

/** Decodes at 16 kHz (enough for speech detection and drawing) and finds speech. */
export async function analyse(rec: Recording, vadThresholdDb: number, whisper = true): Promise<AnalysisResult> {
  // decoded to a temporary 16 kHz PCM file and read in chunks, so long files fit in memory
  const decoded = await decodeToPcmFile(originalUri(rec), 16000, rec.durationSec);
  try {
    const tVad = Date.now();
    const a = await analyseStream(decoded.source, { thresholdDb: vadThresholdDb, whisper }, { yieldFn: yieldToUi });
    console.log(`[VC] analyse ${rec.format} ${a.durationSec.toFixed(1)}s: ${a.segments.length} speech sections (${a.segments.filter((s) => s.kind === 'whisper').length} whispered), VAD ${Date.now() - tVad} ms`);
    return {
      durationSec: a.durationSec,
      sampleRate: 16000,
      channels: decoded.channels,
      segments: a.segments,
      waveform: a.waveform,
      noiseFloorDb: a.noiseFloorDb,
    };
  } finally {
    decoded.dispose();
  }
}

export interface CancelToken {
  cancelled: boolean;
}

/** Runs the pipeline and writes the result to a temporary preview file. Nothing is saved yet. */
export async function enhanceToPreview(
  rec: Recording,
  settings: EnhanceSettings,
  processingRate: number,
  token: CancelToken,
  onProgress: (f: number, stage: string) => void,
  /** Already-decoded audio at `processingRate` (kept by the caller, not deleted here). */
  reuse?: DecodedPcm | null,
): Promise<{ result: EnhanceSummary; previewUri: string }> {
  checkStorage(estimateWorkBytes(rec.durationSec, processingRate));
  const t0 = Date.now();
  onProgress(0, 'decode');
  // Long recordings never sit in memory: the file is decoded to a temporary PCM file, processed
  // in chunks (dsp/stream.ts) and written straight to the preview WAV.
  const own = !reuse;
  const decoded = reuse ?? await decodeToPcmFile(originalUri(rec), processingRate, rec.durationSec, (f) => onProgress(0.1 * f, 'decode'), () => token.cancelled);
  const preview = new File(tempDir(), `${rec.id}-preview-${Date.now()}.wav`);
  let sink: WavFileSink | null = null;
  try {
    if (token.cancelled) throw new CancelledError();
    sink = new WavFileSink(preview, decoded.source.sampleRate);
    const { report } = await enhanceStream(decoded.source, sink, settings, fileTemp, {
      isCancelled: () => token.cancelled,
      yieldFn: yieldToUi,
      onProgress: (f) => onProgress(0.1 + f * 0.9, f < 0.94 ? 'process' : 'write'),
    }, own ? () => decoded.dispose() : undefined);
    sink.close();
    sink = null;
    console.log(`[VC] enhance ${rec.durationSec.toFixed(1)}s @${processingRate}: ${Date.now() - t0} ms, gain ${report.appliedGainDb.toFixed(1)} dB, speech ${report.output.speechLufs.toFixed(1)} LUFS, TP ${report.output.truePeakDb.toFixed(2)}, hum ${report.humHz}, warnings ${report.warnings.join(',') || 'none'}`);
    onProgress(1, 'done');
    return { result: { report, sampleRate: decoded.source.sampleRate }, previewUri: preview.uri };
  } catch (e) {
    try { sink?.close(); } catch { /* closed */ }
    if (preview.exists) preview.delete();
    throw e;
  } finally {
    if (own) decoded.dispose();
  }
}


/**
 * Quick previews of enhancement settings on a short part of the recording. The recording is
 * decoded once (at the processing rate) and kept as a temporary PCM file while the settings
 * screen is open; each preview processes only the chosen 15 s, in memory, and writes a WAV.
 * Smart mode and the loudness/noise measurements then look only at that part, so the full run
 * can differ slightly.
 */
/** Longer recordings are analysed and previewed from parts decoded by seeking (Android). */
export const FULL_DECODE_MAX_SEC = 12 * 60;
/** Live listening decodes by seeking above this length, so playback can start at once. */
const LIVE_SEEK_ABOVE_SEC = 60;

export class EnhancePreviewer {
  private decoded: DecodedPcm | null = null;
  private decodedRate = 0;
  private seeking: SeekingSource | null = null;
  private readonly long: boolean;

  constructor(private readonly rec: Recording) {
    this.long = rec.durationSec > FULL_DECODE_MAX_SEC;
  }

  /** The decoded recording, for reuse by the full run (owned by this previewer). */
  decodedFor(rate: number): DecodedPcm | null {
    return this.decoded && this.decodedRate === rate ? this.decoded : null;
  }

  /**
   * Smart mode. Short recordings: the whole file at the processing rate (exactly what the full
   * run measures). Long ones: 16 parts of 20 s spread over the file, decoded by seeking at 16 kHz,
   * so the analysis takes about as long as for a 5-minute file whatever the length.
   */
  async analyseSmart(rate: number, settings: EnhanceSettings, onProgress: (f: number, stage: 'reading' | 'measuring') => void, isCancelled: () => boolean): Promise<SmartAnalysis> {
    const t0 = Date.now();
    let r: SmartAnalysis | null = null;
    if (this.long) {
      const plan = samplePlan(this.rec.durationSec);
      const parts = await decodeRangesToPcmFile(originalUri(this.rec), 16000, plan, (f) => onProgress(0.5 * f, 'reading'), isCancelled);
      if (parts) {
        try {
          r = await analyseForSmart(parts.source, settings, { onProgress: (f) => onProgress(0.5 + 0.5 * f, 'measuring'), isCancelled, yieldFn: yieldToUi });
          r = { ...r, sampled: { parts: plan.length, seconds: parts.source.length / 16000 }, sections: r.sections && mapToParts(r.sections, plan, parts.partFrames, 16000), windows: mapToParts(r.windows, plan, parts.partFrames, 16000) };
        } finally {
          parts.dispose();
        }
      }
    }
    if (!r) {
      await this.prepare(rate, (f) => onProgress(0.4 * f, 'reading'), isCancelled);
      r = await analyseForSmart(this.decoded!.source, settings, { onProgress: (f) => onProgress(0.4 + 0.6 * f, 'measuring'), isCancelled, yieldFn: yieldToUi });
    }
    console.log(`[VC] smart analysis ${this.rec.durationSec.toFixed(1)}s${r.sampled ? ` (${r.sampled.parts} parts, ${r.sampled.seconds.toFixed(0)}s)` : ''}: snr ${r.measures.snrDb.toFixed(1)} dB, whispers ${(r.measures.whisperShare * 100).toFixed(0)}%, spread ${r.measures.spreadDb.toFixed(1)} dB, rumble ${r.measures.rumbleDb.toFixed(1)} dB, hum ${r.humHz} in ${Date.now() - t0} ms`);
    return r;
  }

  private pending: { rate: number; p: Promise<void> } | null = null;
  /** Decodes the whole recording at `rate` once; callers asking at the same time share it. */
  async prepare(rate: number, onProgress: (f: number) => void, isCancelled: () => boolean): Promise<void> {
    if (this.decoded && this.decodedRate === rate) return;
    if (this.pending?.rate === rate) return this.pending.p;
    const p = (async () => {
      this.decoded?.dispose();
      this.decoded = null;
      this.decoded = await decodeToPcmFile(originalUri(this.rec), rate, this.rec.durationSec, onProgress, isCancelled);
      this.decodedRate = rate;
    })();
    this.pending = { rate, p };
    try { await p; } finally { if (this.pending?.p === p) this.pending = null; }
  }

  /**
   * The recording at `rate` for live listening: the whole decode for recordings up to a minute
   * (shared with the Smart analysis and the full run, a few seconds), decoded by seeking in 20 s
   * blocks around the play position for longer ones, so listening never waits for a full decode.
   */
  async liveSource(rate: number, onProgress: (f: number) => void, isCancelled: () => boolean): Promise<SampleSource> {
    if (this.rec.durationSec > LIVE_SEEK_ABOVE_SEC && VoiceEncoder?.decodeRangesToPcm) {
      if (this.seeking?.sampleRate !== rate) {
        this.seeking?.dispose();
        this.seeking = new SeekingSource(originalUri(this.rec), rate, this.rec.durationSec);
      }
      return this.seeking;
    }
    await this.prepare(rate, onProgress, isCancelled);
    return this.decoded!.source;
  }

  dispose() {
    this.seeking?.dispose();
    this.seeking = null;
    this.decoded?.dispose();
    this.decoded = null;
  }
}

/** Moves an accepted preview into the recording folder, replacing any previous enhanced copy. */
export function commitPreview(rec: Recording, previewUri: string): { fileName: string; sizeBytes: number } {
  const fileName = 'enhanced.wav';
  const dest = fileIn(rec.id, fileName);
  if (dest.exists) dest.delete();
  const src = new File(previewUri);
  src.moveSync(dest);
  return { fileName, sizeBytes: dest.size };
}

export function discardPreview(previewUri: string) {
  const f = new File(previewUri);
  if (f.exists) f.delete();
}

export function deleteEnhanced(rec: Recording) {
  if (!rec.enhanced) return;
  const f = fileIn(rec.id, rec.enhanced.fileName);
  if (f.exists) f.delete();
}

export const audioUri = (rec: Recording, which: 'original' | 'enhanced') =>
  which === 'enhanced' && rec.enhanced ? fileIn(rec.id, rec.enhanced.fileName).uri : originalUri(rec);

export async function shareAudio(rec: Recording, which: 'original' | 'enhanced', dialogTitle?: string) {
  const uri = audioUri(rec, which);
  const mime = which === 'enhanced' ? 'audio/wav' : rec.mimeType ?? 'audio/*';
  if (!(await Sharing.isAvailableAsync())) throw new Error('sharing_unavailable');
  // Give the shared copy a readable name.
  const ext = which === 'enhanced' ? 'wav' : extOf(rec.originalFileName);
  const named = new File(tempDir(), `${safeName(rec.name)}${which === 'enhanced' ? '-enhanced' : ''}.${ext}`);
  if (named.exists) named.delete();
  await new File(uri).copy(named);
  await Sharing.shareAsync(named.uri, { mimeType: mime, dialogTitle: dialogTitle ?? rec.name });
}

export async function shareTranscript(rec: Recording, t: Transcript, format: 'txt' | 'srt' | 'vtt' | 'json') {
  const body = format === 'srt' ? toSrt(t) : format === 'vtt' ? toVtt(t) : format === 'json' ? toJson(t) : toTxt(t);
  const mime = { txt: 'text/plain', srt: 'application/x-subrip', vtt: 'text/vtt', json: 'application/json' }[format];
  const f = new File(tempDir(), `${safeName(rec.name)}.${format}`);
  if (f.exists) f.delete();
  f.create();
  // UTF-8 BOM helps some desktop editors pick the right encoding for Arabic text
  await f.write(format === 'json' ? body : `\uFEFF${body}`);
  if (!(await Sharing.isAvailableAsync())) throw new Error('sharing_unavailable');
  await Sharing.shareAsync(f.uri, { mimeType: mime, dialogTitle: rec.name });
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'recording';

// ---------------------------------------------------------------- editing

export interface EditRender {
  previewUri: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
  spec: EditSpec;
  source: 'original' | 'enhanced';
}

/** Recordings longer than this are edited at 24 kHz to keep memory use reasonable. */
const LONG_EDIT_SEC = 20 * 60;

export async function renderEdit(
  rec: Recording,
  source: 'original' | 'enhanced',
  spec: EditSpec,
  token: CancelToken,
  onProgress: (f: number) => void,
): Promise<EditRender> {
  const rate = rec.durationSec > LONG_EDIT_SEC ? 24000 : undefined;
  checkStorage(estimateWorkBytes(editedDuration(spec, rec.durationSec) * (rec.channels ?? 1), rate ?? 48000));
  const t0 = Date.now();
  onProgress(0.02);
  const decoded = await decodeFile(audioUri(rec, source), rate);
  if (token.cancelled) throw new CancelledError();
  const dur = decoded.channels[0].length / decoded.sampleRate;
  const s = normalizeSpec(spec, dur);
  const out = await applyEdit(decoded.channels, decoded.sampleRate, s, {
    isCancelled: () => token.cancelled,
    yieldFn: yieldToUi,
    onProgress: (f) => onProgress(0.1 + f * 0.8),
  });
  if (token.cancelled) throw new CancelledError();
  onProgress(0.92);
  const f = new File(tempDir(), `${rec.id}-edit-${Date.now()}.wav`);
  await writeWavChannels(f, out, decoded.sampleRate);
  console.log(`[VC] edit ${s.mode} ${s.start.toFixed(2)}-${s.end.toFixed(2)} x${s.speed}: ${dur.toFixed(1)}s -> ${(out[0].length / decoded.sampleRate).toFixed(1)}s in ${Date.now() - t0} ms`);
  onProgress(1);
  return { previewUri: f.uri, sampleRate: decoded.sampleRate, channels: out.length, durationSec: out[0].length / decoded.sampleRate, spec: s, source };
}

/** Bookmarks live on the original timeline. They can be carried over when the edit started from it
 * (or from an enhanced copy of the same length). */
function carryBookmarks(rec: Recording, r: EditRender): Bookmark[] {
  const sameTimeline = r.source === 'original' || !rec.enhanced?.report.silenceMap;
  if (!sameTimeline) return [];
  return rec.bookmarks
    .map((b) => {
      const t = remapTime(b.time, r.spec, rec.durationSec);
      return t === null ? null : { ...b, time: Math.round(t * 10) / 10 };
    })
    .filter((b): b is Bookmark => b !== null);
}

/** The file type an edit of this recording will be saved as on this phone. */
export function editSaveTarget(rec: Recording): SaveTarget {
  return saveTarget(extOf(rec.originalFileName), VoiceEncoder?.containers ?? []);
}

/**
 * Writes the rendered edit (a WAV preview) as `<baseName>.<ext>` in `dir`, encoding to AAC when
 * the original was M4A/MP4/AAC (or a format the phone cannot write). If encoding fails, the WAV
 * is kept instead so the edit is never lost.
 */
async function writeSaved(rec: Recording, r: EditRender, dir: Directory, baseName: string) {
  const target = editSaveTarget(rec);
  const preview = new File(r.previewUri);
  if (target.container !== 'wav' && VoiceEncoder) {
    const out = new File(dir, `${baseName}.${target.ext}`);
    try {
      const bitrate = aacBitrate(rec.sizeBytes, rec.durationSec, r.sampleRate, r.channels);
      const t0 = Date.now();
      await VoiceEncoder.encodeAac(preview.uri, out.uri, target.container as 'mpeg4' | 'adts', bitrate);
      console.log(`[VC] encoded ${target.ext} ${bitrate / 1000} kb/s in ${Date.now() - t0} ms: ${out.size} bytes`);
      if (out.exists && out.size > 0) {
        preview.delete();
        return { fileName: out.name, sizeBytes: out.size, format: target.ext.toUpperCase(), mimeType: MIME[target.ext] ?? 'audio/*' };
      }
    } catch (e) {
      console.warn(`[VC] AAC encoding failed, saving WAV instead: ${e instanceof Error ? e.message : String(e)}`);
      if (out.exists) out.delete();
    }
  }
  const wav = new File(dir, `${baseName}.wav`);
  if (wav.exists) wav.delete();
  preview.moveSync(wav);
  return { fileName: wav.name, sizeBytes: wav.size, format: 'WAV', mimeType: 'audio/wav' };
}

/** Save: the recording's audio is replaced by the edit. The previous audio and enhanced copy are deleted. */
export async function saveEditReplace(rec: Recording, r: EditRender): Promise<Partial<Recording>> {
  if (rec.external && rec.sourceUri) return saveEditToFolder(rec, r);
  const saved = await writeSaved(rec, r, recordingDir(rec.id), `audio-${Date.now()}`);
  const old = fileIn(rec.id, rec.originalFileName);
  if (old.exists && old.name !== saved.fileName) old.delete();
  deleteEnhanced(rec);
  return {
    originalFileName: saved.fileName,
    format: saved.format,
    mimeType: saved.mimeType,
    sizeBytes: saved.sizeBytes,
    durationSec: r.durationSec,
    channels: r.channels,
    sampleRate: r.sampleRate,
    bookmarks: carryBookmarks(rec, r),
    enhanced: undefined,
    transcript: undefined,
    segments: undefined,
    waveform: undefined,
    lastPositionSec: 0,
    lastPlayedSource: 'original',
    status: 'analyzing',
    error: undefined,
  };
}

/** What Save does to a play-list file: overwrite it, or write a new file when its type cannot be written. */
export function folderSavePlan(rec: Recording): { overwrite: boolean; file: string; newFile: string } {
  const target = editSaveTarget(rec);
  const file = rec.originalFileName;
  const base = file.replace(/\.[^.]+$/, '');
  const overwrite = target.ext === extOf(file);
  return { overwrite, file, newFile: overwrite ? file : `${base}.${target.ext}` };
}

/** Writes all of `src` into `destUri`, truncating it first. */
async function writeOver(destUri: string, data: Uint8Array) {
  const h = new File(destUri).open(FileMode.Truncate);
  try {
    await h.writeBytes(data);
  } finally {
    h.close();
  }
}

/** Finds the play-list subfolder (e.g. "2025/Calls") inside the picked folder. */
function findSubfolder(folderUri: string, subfolder: string): Directory | null {
  let dir = new Directory(folderUri);
  for (const part of subfolder.split('/').filter(Boolean)) {
    const next = dir.list().find((e): e is Directory => e instanceof Directory && displayName(e.uri) === part);
    if (!next) return null;
    dir = next;
  }
  return dir;
}

/**
 * Save for a play-list file: the file in its folder is replaced by the edit. When the phone can
 * write the same type (M4A, MP4, WAV, and AAC on Android) the file is overwritten in place; the
 * previous contents are kept in memory and written back if the write fails. Otherwise (MP3, FLAC,
 * OGG, Opus) the edit is written next to it as M4A and the old file is deleted after that succeeds.
 */
async function saveEditToFolder(rec: Recording, r: EditRender): Promise<Partial<Recording>> {
  const plan = folderSavePlan(rec);
  const saved = await writeSaved(rec, r, tempDir(), `save-${Date.now()}`);
  const tmp = new File(tempDir(), saved.fileName);
  let sourceUri = rec.sourceUri!;
  let fileName = rec.originalFileName;
  try {
    const data = await tmp.bytes();
    if (plan.overwrite && extOf(saved.fileName) === extOf(rec.originalFileName)) {
      const backup = await new File(sourceUri).bytes();
      try {
        await writeOver(sourceUri, data);
      } catch (e) {
        try { await writeOver(sourceUri, backup); } catch { /* reported below */ }
        throw e;
      }
    } else {
      const dir = rec.sourceFolderUri ? findSubfolder(rec.sourceFolderUri, rec.sourceSubfolder ?? '') : null;
      if (!dir) throw new Error('folder_unavailable');
      const name = `${rec.originalFileName.replace(/\.[^.]+$/, '')}.${extOf(saved.fileName)}`;
      const created = dir.createFile(name, saved.mimeType);
      await writeOver(created.uri, data);
      new File(sourceUri).delete();
      sourceUri = created.uri;
      fileName = displayName(created.uri);
    }
  } finally {
    if (tmp.exists) tmp.delete();
  }
  deleteEnhanced(rec);
  return {
    sourceUri,
    originalFileName: fileName,
    format: saved.format,
    mimeType: saved.mimeType,
    sizeBytes: saved.sizeBytes,
    durationSec: r.durationSec,
    channels: r.channels,
    sampleRate: r.sampleRate,
    bookmarks: carryBookmarks(rec, r),
    enhanced: undefined,
    transcript: undefined,
    segments: undefined,
    waveform: undefined,
    lastPositionSec: 0,
    lastPlayedSource: 'original',
    status: 'analyzing',
    error: undefined,
  };
}

/** Save As: a new recording in the library; the current one is left as it is. */
export async function saveEditAsNew(rec: Recording, r: EditRender, name: string): Promise<Recording> {
  ensureDirs();
  const id = newId();
  const dir = recordingDir(id);
  dir.create({ intermediates: true, idempotent: true });
  const saved = await writeSaved(rec, r, dir, 'original');
  return {
    id,
    name: name.trim() || `${rec.name}-v1`,
    originalFileName: saved.fileName,
    format: saved.format,
    mimeType: saved.mimeType,
    sizeBytes: saved.sizeBytes,
    durationSec: r.durationSec,
    channels: r.channels,
    sampleRate: r.sampleRate,
    importedAt: new Date().toISOString(),
    lastPositionSec: 0,
    lastPlayedSource: 'original',
    bookmarks: carryBookmarks(rec, r).map((b) => ({ ...b, id: newId() })),
    status: 'analyzing',
  };
}
