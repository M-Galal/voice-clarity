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
import { decodeToPcmFile, WavFileSink } from './pcm';
import { audioUri } from './processing';
import { modelsDir, tempDir } from './storage';

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
  /**
   * The text found so far, in order, while the file is still being worked through (whisper.cpp
   * goes through the audio in 30 s windows from the start; whisper.rn reports each window's new
   * segments). The final transcript replaces it when the run ends.
   */
  onSegments?: (soFar: TranscriptSegment[]) => void,
): Promise<TranscribeJob> {
  const model = MODELS.find((m) => m.id === opts.modelId) ?? MODELS[1];
  if (!isModelReady(model)) throw new Error('model_missing');
  const useEnhanced = opts.useEnhanced && !!rec.enhanced;
  const srcUri = audioUri(rec, useEnhanced ? 'enhanced' : 'original');

  // whisper.cpp works on 16 kHz mono; write it as a 16-bit WAV it can read directly. The file is
  // decoded to a temporary PCM file and copied in chunks, so long recordings fit in memory.
  const prepare = async () => {
    const decoded = await decodeToPcmFile(srcUri, 16000, useEnhanced ? rec.enhanced!.report.outputDurationSec : rec.durationSec);
    try {
      const src = decoded.source;
      const file = new File(tempDir(), `${rec.id}-asr.wav`);
      const sink = new WavFileSink(file, 16000);
      const segs = useEnhanced ? rec.enhanced!.segments : rec.segments ?? [];
      const ranges = segs.map((g) => ({ a: Math.round(g.start * 16000), b: Math.min(src.length, Math.round(g.end * 16000)) }));
      const sums = new Float64Array(segs.length);
      const step = 16000 * 8;
      for (let pos = 0; pos < src.length; pos += step) {
        const x = await src.read(pos, Math.min(step, src.length - pos));
        ranges.forEach((r, i) => {
          for (let k = Math.max(r.a, pos); k < Math.min(r.b, pos + x.length); k++) sums[i] += x[k - pos] * x[k - pos];
        });
        await sink.write(x);
        await yieldToUi();
      }
      sink.close();
      const noiseFloor = rec.noiseFloorDb ?? -60;
      const margins = segs.map((g, i) => {
        const n = ranges[i].b - ranges[i].a;
        const db = n > 0 ? 10 * Math.log10(sums[i] / n + 1e-12) : -120;
        return { start: g.start, end: g.end, marginDb: db - noiseFloor };
      });
      return { wav: file, weak: lowQualityRanges(margins), duration: src.length / 16000 };
    } finally {
      decoded.dispose();
    }
  };
  const { wav, weak, duration } = await prepare();

  const context = await getContext(model);
  const live: TranscriptSegment[] = [];
  const { stop, promise } = context.transcribe(wav.uri, {
    language: opts.language || 'auto',
    maxLen: 0,
    prompt: opts.prompt || undefined,
    onProgress: (p) => onProgress(p / 100),
    onNewSegments: onSegments
      ? (r) => {
        for (const s of r.segments) {
          const text = arabicPunctuation(cleanText(s.text));
          // whisper.cpp times are in 10 ms units (the final result re-checks this against the duration)
          if (text) live.push({ id: `l${live.length}`, start: s.t0 * 0.01, end: s.t1 * 0.01, text });
        }
        console.log(`[VC] live transcript: ${live.length} segments, up to ${live.length ? live[live.length - 1].end.toFixed(1) : 0}s`);
        onSegments(flagSegments([...live], weak));
      }
      : undefined,
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
