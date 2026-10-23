/**
 * Import, analysis, enhancement and export. All audio work happens on the device.
 */
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { File } from 'expo-file-system';
import { mixToMono, waveformPeaks } from '../dsp/buffers';
import { CancelledError } from '../dsp/denoise';
import { enhance, type EnhanceResult, type EnhanceSettings } from '../dsp/pipeline';
import { detectSpeech, type Segment } from '../dsp/vad';
import { toJson, toSrt, toTxt, toVtt, type Transcript } from '../transcript/format';
import type { Recording } from '../types';
import { assertSupported, decodeFile, extOf, PICKER_TYPES, readDuration, writeWav, yieldToUi } from './audio';
import { ensureDirs, fileIn, freeBytes, newId, recordingDir, tempDir } from './storage';

export class LowStorageError extends Error {
  constructor(public neededBytes: number, public freeBytes: number) {
    super('low_storage');
    this.name = 'LowStorageError';
  }
}

/** Bytes needed to process `durationSec` (decoded float buffers + output WAV), with margin. */
export const estimateWorkBytes = (durationSec: number, rate: number) => Math.round(durationSec * rate * 2 * 3 + 20e6);

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

export interface AnalysisResult {
  durationSec: number;
  sampleRate: number;
  channels: number;
  segments: Segment[];
  waveform: number[];
  noiseFloorDb: number;
}

/** Decodes at 16 kHz (enough for speech detection and drawing) and finds speech. */
export async function analyse(rec: Recording, vadThresholdDb: number): Promise<AnalysisResult> {
  const f = fileIn(rec.id, rec.originalFileName);
  // 16 kHz keeps memory low for long recordings (≈ 230 MB per hour as float32 at 16 kHz mono)
  const native = await decodeFile(f.uri, 16000);
  const nativeRate = native.sampleRate;
  const channels = native.channels.length;
  const mono = mixToMono(native.channels);
  native.channels.length = 0;
  await yieldToUi();
  const { segments, analysis } = detectSpeech(mono, nativeRate, { thresholdDb: vadThresholdDb });
  await yieldToUi();
  return {
    durationSec: mono.length / nativeRate,
    sampleRate: nativeRate,
    channels,
    segments,
    waveform: waveformPeaks(mono, 400),
    noiseFloorDb: analysis.noiseFloorDb,
  };
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
): Promise<{ result: EnhanceResult; previewUri: string }> {
  checkStorage(estimateWorkBytes(rec.durationSec, processingRate));
  onProgress(0, 'decode');
  const decoded = await decodeFile(fileIn(rec.id, rec.originalFileName).uri, processingRate);
  if (token.cancelled) throw new CancelledError();
  const result = await enhance(decoded.channels, decoded.sampleRate, settings, {
    isCancelled: () => token.cancelled,
    yieldFn: yieldToUi,
    onProgress: (f) => onProgress(0.05 + f * 0.9, 'process'),
  });
  onProgress(0.96, 'write');
  const preview = new File(tempDir(), `${rec.id}-preview-${Date.now()}.wav`);
  await writeWav(preview, result.output, result.sampleRate);
  onProgress(1, 'done');
  return { result, previewUri: preview.uri };
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
  fileIn(rec.id, which === 'enhanced' && rec.enhanced ? rec.enhanced.fileName : rec.originalFileName).uri;

export async function shareAudio(rec: Recording, which: 'original' | 'enhanced') {
  const uri = audioUri(rec, which);
  const mime = which === 'enhanced' ? 'audio/wav' : rec.mimeType ?? 'audio/*';
  if (!(await Sharing.isAvailableAsync())) throw new Error('sharing_unavailable');
  // Give the shared copy a readable name.
  const ext = which === 'enhanced' ? 'wav' : extOf(rec.originalFileName);
  const named = new File(tempDir(), `${safeName(rec.name)}${which === 'enhanced' ? '-enhanced' : ''}.${ext}`);
  if (named.exists) named.delete();
  await new File(uri).copy(named);
  await Sharing.shareAsync(named.uri, { mimeType: mime, dialogTitle: rec.name });
}

export async function shareTranscript(rec: Recording, t: Transcript, format: 'txt' | 'srt' | 'vtt' | 'json') {
  const body = format === 'srt' ? toSrt(t) : format === 'vtt' ? toVtt(t) : format === 'json' ? toJson(t) : toTxt(t);
  const mime = { txt: 'text/plain', srt: 'application/x-subrip', vtt: 'text/vtt', json: 'application/json' }[format];
  const f = new File(tempDir(), `${safeName(rec.name)}.${format}`);
  if (f.exists) f.delete();
  f.create();
  // UTF-8 BOM helps some desktop editors pick the right encoding for Arabic text
  await f.write(format === 'json' ? body : `﻿${body}`);
  if (!(await Sharing.isAvailableAsync())) throw new Error('sharing_unavailable');
  await Sharing.shareAsync(f.uri, { mimeType: mime, dialogTitle: rec.name });
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'recording';
