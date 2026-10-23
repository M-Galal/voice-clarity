/**
 * On-device transcription with whisper.rn (whisper.cpp). Audio never leaves the phone.
 * The only network use is the one-time model download from Hugging Face, which the user
 * starts explicitly.
 *
 * Notes that the UI states plainly:
 * - Whisper's language code for Arabic is "ar"; it has no dialect switch. The optional prompt
 *   can nudge vocabulary (names, places, dialect words) but does not guarantee anything.
 * - whisper.rn does not return word confidence, so "uncertain" flags come from audio quality
 *   and repetition checks, not from the model.
 * - Speaker separation (tinydiarize) needs a special English-only model, so it is not offered.
 */
import { File } from 'expo-file-system';
import { initWhisper, type WhisperContext } from 'whisper.rn';
import { mixToMono, resample } from '../dsp/buffers';
import type { Segment } from '../dsp/vad';
import {
  arabicPunctuation, cleanText, detectTimeScale, flagSegments, type Transcript, type TranscriptSegment,
} from '../transcript/format';
import type { Recording } from '../types';
import { decodeFile, writeWav, yieldToUi } from './audio';
import { fileIn, modelsDir, tempDir } from './storage';

export interface ModelInfo {
  id: string;
  file: string;
  sizeMB: number;
  labelKey: 'model_base' | 'model_small' | 'model_turbo';
}

// Files and sizes as listed at https://huggingface.co/ggerganov/whisper.cpp
export const MODELS: ModelInfo[] = [
  { id: 'base', file: 'ggml-base.bin', sizeMB: 148, labelKey: 'model_base' },
  { id: 'small', file: 'ggml-small.bin', sizeMB: 488, labelKey: 'model_small' },
  { id: 'turbo', file: 'ggml-large-v3-turbo-q5_0.bin', sizeMB: 574, labelKey: 'model_turbo' },
];

const modelUrl = (m: ModelInfo) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`;
export const modelFile = (m: ModelInfo) => new File(modelsDir(), m.file);
export const isModelReady = (m: ModelInfo) => {
  const f = modelFile(m);
  return f.exists && f.size > m.sizeMB * 1e6 * 0.9;
};

export async function downloadModel(m: ModelInfo, onProgress: (f: number) => void, signal?: AbortSignal) {
  const dest = modelFile(m);
  const part = new File(modelsDir(), `${m.file}.part`);
  if (part.exists) part.delete();
  const task = File.createDownloadTask(modelUrl(m), part, {
    onProgress: ({ bytesWritten, totalBytes }) => onProgress(totalBytes > 0 ? bytesWritten / totalBytes : 0),
    signal,
  });
  const out = await task.downloadAsync();
  if (!out) throw new Error('download_paused');
  if (dest.exists) dest.delete();
  part.moveSync(dest);
}

export function deleteModel(m: ModelInfo) {
  const f = modelFile(m);
  if (f.exists) f.delete();
}

let ctx: { id: string; context: WhisperContext } | null = null;

async function getContext(m: ModelInfo): Promise<WhisperContext> {
  if (ctx?.id === m.id) return ctx.context;
  if (ctx) await ctx.context.release();
  ctx = null;
  const context = await initWhisper({ filePath: modelFile(m).uri });
  ctx = { id: m.id, context };
  return context;
}

export interface TranscribeJob {
  stop: () => Promise<void>;
  promise: Promise<Transcript>;
}

/** Regions where speech is weak relative to the noise floor: transcript there gets flagged. */
export function lowQualityRanges(levels: { start: number; end: number; marginDb: number }[], minMarginDb = 8): Segment[] {
  return levels.filter((l) => l.marginDb < minMarginDb).map(({ start, end }) => ({ start, end }));
}

function segmentMargins(mono: Float32Array, sr: number, segs: Segment[], noiseFloorDb: number) {
  return segs.map((s) => {
    const a = Math.round(s.start * sr), b = Math.min(mono.length, Math.round(s.end * sr));
    let acc = 0;
    for (let i = a; i < b; i++) acc += mono[i] * mono[i];
    const db = b > a ? 10 * Math.log10(acc / (b - a) + 1e-12) : -120;
    return { start: s.start, end: s.end, marginDb: db - noiseFloorDb };
  });
}

export async function startTranscription(
  rec: Recording,
  opts: { modelId: string; language: string; useEnhanced: boolean; prompt: string },
  onProgress: (p: number) => void,
): Promise<TranscribeJob> {
  const model = MODELS.find((m) => m.id === opts.modelId) ?? MODELS[1];
  if (!isModelReady(model)) throw new Error('model_missing');
  const useEnhanced = opts.useEnhanced && !!rec.enhanced;
  const src = fileIn(rec.id, useEnhanced ? rec.enhanced!.fileName : rec.originalFileName);

  // whisper.cpp works on 16 kHz mono; write it as a 16-bit WAV it can read directly.
  const decoded = await decodeFile(src.uri, 16000);
  let mono = mixToMono(decoded.channels);
  if (decoded.sampleRate !== 16000) mono = resample(mono, decoded.sampleRate, 16000);
  await yieldToUi();
  const wav = new File(tempDir(), `${rec.id}-asr.wav`);
  await writeWav(wav, mono, 16000);

  const segs = useEnhanced ? rec.enhanced!.segments : rec.segments ?? [];
  const noiseFloor = rec.noiseFloorDb ?? -60;
  const weak = lowQualityRanges(segmentMargins(mono, 16000, segs, noiseFloor));
  const duration = mono.length / 16000;
  mono = new Float32Array(0);

  const context = await getContext(model);
  const { stop, promise } = context.transcribe(wav.uri, {
    language: opts.language || 'auto',
    maxLen: 0,
    prompt: opts.prompt || undefined,
    onProgress: (p) => onProgress(p / 100),
  });

  const tStart = Date.now();
  const done = promise.then((res) => {
    console.log(`[VC] transcribe ${duration.toFixed(1)}s model=${model.id} lang=${opts.language}: ${Date.now() - tStart} ms, detected=${res.language}, segments=${res.segments.length}`);
    if (wav.exists) wav.delete();
    if (res.isAborted) throw new Error('aborted');
    const scale = detectTimeScale(res.segments.map((s) => s.t1), duration);
    const language = res.language || opts.language;
    const raw: TranscriptSegment[] = res.segments
      .map((s, i) => {
        const text = cleanText(s.text);
        return {
          id: `s${i}`,
          start: s.t0 * scale,
          end: s.t1 * scale,
          text: language === 'ar' ? arabicPunctuation(text) : text,
        };
      })
      .filter((s) => s.text.length > 0);
    const t: Transcript = {
      language,
      requestedLanguage: opts.language,
      model: model.file,
      createdAt: new Date().toISOString(),
      fromEnhanced: useEnhanced,
      segments: flagSegments(raw, weak),
    };
    return t;
  });
  return { stop, promise: done };
}

export async function releaseWhisper() {
  if (ctx) await ctx.context.release();
  ctx = null;
}
