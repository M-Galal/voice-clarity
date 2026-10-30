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
import {
  asrGainDb, chunkTimeToRecording, GAP_SEC, isSilencePhrase, pairLayout, planAsrChunks, splitPair, type AsrChunk, type TimedText,
} from '../transcript/chunks';

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
  opts: { modelId: string; language: string; useEnhanced: boolean; prompt: string; parallel?: boolean },
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
      const gap = new Float32Array(Math.round(GAP_SEC * 16000));
      let language = opts.language || 'auto';
      let detected = '';
      const raw: TranscriptSegment[] = [];
      let removed = 0;
      let paired = 0;
      const tStart = Date.now();

      /** The chunk's pieces joined with short silences, levelled, as 16-bit PCM. */
      const prepare = async (c: number) => {
        const ch = chunks[c];
        const parts: Float32Array[] = [];
        for (let i = 0; i < ch.pieces.length; i++) {
          const p = ch.pieces[i];
          const a = Math.round(p.start * 16000), b = Math.min(src.length, Math.round(p.end * 16000));
          if (i > 0) parts.push(gap);
          parts.push(await src.read(a, Math.max(0, b - a)));
        }
        const n = parts.reduce((t, x) => t + x.length, 0);
        const flt = new Float32Array(n);
        let o = 0;
        for (const x of parts) { flt.set(x, o); o += x.length; }
        // quiet speech is raised to a normal level (Whisper treats very quiet input like silence)
        const { gainDb, rmsDb } = asrGainDb(flt);
        if (gainDb > 0) { const g = Math.pow(10, gainDb / 20); for (let i = 0; i < n; i++) flt[i] *= g; }
        return { c, ch, pcm: toInt16(flt), gainDb, rmsDb };
      };
      type Prepared = Awaited<ReturnType<typeof prepare>>;

      const call = async (pcm: Int16Array, nProcessors: number, progress: (q: number) => void) => {
        if (cancelled) throw new Error('aborted');
        const job = context.transcribeData(pcm.slice().buffer, {
          language,
          maxLen: 0,
          prompt: opts.prompt || undefined,
          nProcessors,
          onProgress: (q) => progress(q / 100),
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
        const scale = detectTimeScale(res.segments.map((s) => s.t1), pcm.length / 16000);
        return res.segments.map((s): TimedText => ({ t0: s.t0 * scale, t1: s.t1 * scale, text: s.text }));
      };

      /** Adds a chunk's text from `from` s on; returns where the text ended (0: none). */
      const take = (ch: AsrChunk, from: number, list: TimedText[]) => {
        let lastEnd = 0;
        for (const s of list) {
          const text = cleanText(s.text);
          if (!text) continue;
          lastEnd = Math.max(lastEnd, s.t1);
          if (isSilencePhrase(text)) { removed++; continue; }
          raw.push({
            id: `s${raw.length}`,
            start: chunkTimeToRecording(ch, from + s.t0),
            end: chunkTimeToRecording(ch, from + s.t1),
            text: arabicPunctuation(text), // only changes mostly-Arabic text
          });
        }
        return lastEnd;
      };

      const log = (p: Prepared, list: TimedText[], how: string) =>
        console.log(`[VC] asr chunk ${p.c + 1}/${chunks.length}${how}: ${p.ch.duration.toFixed(1)} s, level ${p.rmsDb.toFixed(1)} dBFS, gain +${p.gainDb.toFixed(1)} dB: ${list.map((x) => cleanText(x.text)).join(' | ').slice(0, 200)}`);

      // Whisper can stop before the end of the audio it is given; then the rest is sent again
      // (from where the text ended), at most three more times.
      const rest = async (p: Prepared, ended: number, passesLeft: number) => {
        let from = ended;
        for (let pass = 0; pass < passesLeft; pass++) {
          const part = p.pcm.subarray(Math.round(from * 16000));
          const partSec = part.length / 16000;
          if (ended <= 0 || part.length < 16000 || from >= p.ch.duration - 1.5) return;
          console.log(`[VC] transcribe: text ended at ${from.toFixed(1)} s of a ${p.ch.duration.toFixed(1)} s chunk; sending the rest again`);
          const lastEnd = take(p.ch, from, await call(part, 1, (q) => onProgress((p.c + Math.min(1, from / p.ch.duration + q * (1 - from / p.ch.duration))) / chunks.length)));
          if (lastEnd <= 0 || lastEnd >= partSec - 1.5) return;
          from += lastEnd;
        }
      };

      const single = async (p: Prepared) => {
        if (p.pcm.length < 16000) return;
        const list = await call(p.pcm, 1, (q) => onProgress((p.c + q) / chunks.length));
        log(p, list, '');
        const lastEnd = take(p.ch, 0, list);
        if (lastEnd > 0 && lastEnd < p.pcm.length / 16000 - 1.5) await rest(p, lastEnd, 3);
      };

      // Two chunks at a time on two threads (whisper_full_parallel), once the language is known
      // so both halves use the same one. The next chunks are read while Whisper works.
      const parallel = opts.parallel !== false;
      const ready = new Map<number, Promise<Prepared>>();
      const get = (k: number) => {
        let pr = ready.get(k);
        if (!pr) { pr = prepare(k); pr.catch(() => undefined); ready.set(k, pr); }
        return pr;
      };
      let c = 0;
      while (c < chunks.length) {
        if (cancelled) throw new Error('aborted');
        const A = await get(c);
        ready.delete(c);
        const pair = parallel && language !== 'auto' && c + 1 < chunks.length;
        if (!pair || A.pcm.length < 16000) {
          if (c + 1 < chunks.length) void get(c + 1);
          await single(A);
          c += 1;
        } else {
          const B = await get(c + 1);
          ready.delete(c + 1);
          for (let k = c + 2; k < Math.min(chunks.length, c + 4); k++) void get(k);
          if (B.pcm.length < 16000) {
            await single(A);
            await single(B);
          } else {
            const lay = pairLayout(A.pcm.length, B.pcm.length);
            const both = new Int16Array(2 * lay.half);
            both.set(A.pcm, lay.offA);
            both.set(B.pcm, lay.offB);
            const list = await call(both, 2, (q) => onProgress((c + 2 * q) / chunks.length));
            const [la, lb] = splitPair(list, lay, 16000);
            log(A, la, ' (pair)');
            log(B, lb, ' (pair)');
            paired += 2;
            const endA = take(A.ch, 0, la);
            if (endA > 0 && endA < A.pcm.length / 16000 - 1.5) await rest(A, endA, 3);
            const endB = take(B.ch, 0, lb);
            if (endB > 0 && endB < B.pcm.length / 16000 - 1.5) await rest(B, endB, 3);
          }
          c += 2;
        }
        onSegments?.(flagSegments(raw.map((x) => ({ ...x })), weak));
        await yieldToUi();
      }
      console.log(`[VC] transcribe ${duration.toFixed(1)}s model=${model.id} lang=${opts.language}: ${chunks.length} chunks, ${chunks.reduce((t, x) => t + x.duration, 0).toFixed(0)}s of speech, ${Date.now() - tStart} ms, detected=${detected}, segments=${raw.length}, silence phrases removed=${removed}, paired chunks=${paired}`);
      onProgress(1);
      return {
        language: detected || opts.language,
        requestedLanguage: opts.language,
        model: model.file,
        createdAt: new Date().toISOString(),
        fromEnhanced: useEnhanced,
        segments: flagSegments(raw, weak),
        removedSilencePhrases: removed || undefined,
        elapsedMs: Date.now() - tStart,
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
