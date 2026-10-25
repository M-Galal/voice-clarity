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
import type { Segment } from '../dsp/vad';
import {
  arabicPunctuation, cleanText, detectTimeScale, flagSegments, type Transcript, type TranscriptSegment,
} from '../transcript/format';
import type { Recording } from '../types';
import { yieldToUi } from './audio';
import { decodeToPcmFile, toInt16 } from './pcm';
import { audioUri } from './processing';
import { modelsDir } from './storage';
import { chunkTimeToRecording, GAP_SEC, planAsrChunks } from '../transcript/chunks';

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

export async function startTranscription(
  rec: Recording,
  opts: { modelId: string; language: string; useEnhanced: boolean; prompt: string },
  onProgress: (p: number) => void,
  /** The text found so far, in order, after each chunk (the final transcript replaces it). */
  onSegments?: (soFar: TranscriptSegment[]) => void,
): Promise<TranscribeJob> {
  const model = MODELS.find((m) => m.id === opts.modelId) ?? MODELS[1];
  if (!isModelReady(model)) throw new Error('model_missing');
  const useEnhanced = opts.useEnhanced && !!rec.enhanced;
  const srcUri = audioUri(rec, useEnhanced ? 'enhanced' : 'original');
  const segs = useEnhanced ? rec.enhanced!.segments : rec.segments ?? [];

  // whisper.cpp works on 16 kHz mono; the file is decoded once to a temporary PCM file
  const decoded = await decodeToPcmFile(srcUri, 16000, useEnhanced ? rec.enhanced!.report.outputDurationSec : rec.durationSec);
  let cancelled = false;
  let current: { stop: () => Promise<void> } | null = null;
  const stop = async () => { cancelled = true; await current?.stop(); };

  const run = async (): Promise<Transcript> => {
    try {
      const src = decoded.source;
      const duration = src.length / 16000;
      // weak speech (little above the noise floor): its text gets a "check this" flag
      const noiseFloor = rec.noiseFloorDb ?? -60;
      const margins: { start: number; end: number; marginDb: number }[] = [];
      for (const g of segs) {
        const a = Math.round(g.start * 16000), b = Math.min(src.length, Math.round(g.end * 16000));
        if (b <= a) continue;
        const x = await src.read(a, b - a);
        let e = 0;
        for (let k = 0; k < x.length; k++) e += x[k] * x[k];
        margins.push({ start: g.start, end: g.end, marginDb: 10 * Math.log10(e / x.length + 1e-12) - noiseFloor });
      }
      const weak = lowQualityRanges(margins);

      const context = await getContext(model);
      const chunks = planAsrChunks(segs, duration);
      const gap = new Int16Array(Math.round(GAP_SEC * 16000));
      let language = opts.language || 'auto';
      let detected = '';
      const raw: TranscriptSegment[] = [];
      const tStart = Date.now();
      for (let c = 0; c < chunks.length; c++) {
        if (cancelled) throw new Error('aborted');
        const ch = chunks[c];
        // the chunk's pieces joined with short silences, as raw 16-bit PCM
        const parts: Int16Array[] = [];
        for (let i = 0; i < ch.pieces.length; i++) {
          const p = ch.pieces[i];
          const a = Math.round(p.start * 16000), b = Math.min(src.length, Math.round(p.end * 16000));
          if (i > 0) parts.push(gap);
          parts.push(toInt16(await src.read(a, Math.max(0, b - a))));
        }
        const n = parts.reduce((t, x) => t + x.length, 0);
        const pcm = new Int16Array(n);
        let o = 0;
        for (const x of parts) { pcm.set(x, o); o += x.length; }
        // Whisper can stop before the end of the audio it is given; then the rest is sent again
        // (from where the text ended), at most three more times.
        let from = 0; // seconds into the chunk
        for (let pass = 0; pass < 4; pass++) {
          const startSample = Math.round(from * 16000);
          const part = pcm.subarray(startSample);
          if (part.length < 16000) break;
          const job = context.transcribeData(part.slice().buffer, {
            language,
            maxLen: 0,
            prompt: opts.prompt || undefined,
            onProgress: (q) => onProgress((c + Math.min(1, from / ch.duration + (q / 100) * (1 - from / ch.duration))) / chunks.length),
          });
          current = job;
          const res = await job.promise;
          current = null;
          if (res.isAborted || cancelled) throw new Error('aborted');
          // after auto-detection, keep the detected language for the rest (consistent and faster)
          if (!detected && res.language) {
            detected = res.language;
            if (language === 'auto') language = detected;
          }
          const partSec = part.length / 16000;
          const scale = detectTimeScale(res.segments.map((s) => s.t1), partSec);
          let lastEnd = 0;
          for (const s of res.segments) {
            const text = cleanText(s.text);
            if (!text) continue;
            lastEnd = Math.max(lastEnd, s.t1 * scale);
            raw.push({
              id: `s${raw.length}`,
              start: chunkTimeToRecording(ch, from + s.t0 * scale),
              end: chunkTimeToRecording(ch, from + s.t1 * scale),
              text: arabicPunctuation(text), // only changes mostly-Arabic text
            });
          }
          if (lastEnd <= 0 || lastEnd >= partSec - 1.5) break;
          console.log(`[VC] transcribe: text ended at ${(from + lastEnd).toFixed(1)} s of a ${ch.duration.toFixed(1)} s chunk; sending the rest again`);
          from += lastEnd;
        }
        onSegments?.(flagSegments(raw.map((x) => ({ ...x })), weak));
        await yieldToUi();
      }
      console.log(`[VC] transcribe ${duration.toFixed(1)}s model=${model.id} lang=${opts.language}: ${chunks.length} chunks, ${chunks.reduce((t, x) => t + x.duration, 0).toFixed(0)}s of speech, ${Date.now() - tStart} ms, detected=${detected}, segments=${raw.length}`);
      onProgress(1);
      return {
        language: detected || opts.language,
        requestedLanguage: opts.language,
        model: model.file,
        createdAt: new Date().toISOString(),
        fromEnhanced: useEnhanced,
        segments: flagSegments(raw, weak),
      };
    } finally {
      decoded.dispose();
    }
  };
  return { stop, promise: run() };
}

export async function releaseWhisper() {
  if (ctx) await ctx.context.release();
  ctx = null;
}
