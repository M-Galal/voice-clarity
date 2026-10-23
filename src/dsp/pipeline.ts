/**
 * Enhancement pipeline (mono, offline):
 *
 *   input ─► measure ─► speech detection ─► high-pass ─► hum notches ─► noise suppression
 *         ─► clarity EQ ─► pause attenuation ─► gain (to LUFS target or manual dB)
 *         ─► peak limiter ─► [optional silence removal] ─► measure ─► report + warnings
 *
 * The original audio is never modified; a new buffer is returned.
 */
import { applyChain, designBiquad, type BiquadCoeffs } from './biquad';
import { mixToMono, removeSilence } from './buffers';
import { CancelledError, denoise, detectHum, type Progress } from './denoise';
import { applyGain, attenuateGaps, detectClipping, limit } from './dynamics';
import { loudnessPair, samplePeakDb, speechLoudness, truePeakDb } from './loudness';
import { clamp } from './units';
import { detectSpeech, estimateSnrDb, type Segment, type VadOptions } from './vad';

export type Strength = 'light' | 'balanced' | 'strong' | 'advanced';

export interface EnhanceSettings {
  strength: Strength;
  noiseSuppression: boolean;
  /** Over-subtraction factor, 1–3. */
  noiseAmount: number;
  /** Max per-band cut, dB (negative). */
  noiseFloorDb: number;
  /** High-pass cutoff in Hz (0 = off). Removes rumble, wind and plosive pops. */
  highPassHz: number;
  /** Remove 50/60 Hz mains hum and harmonics when detected. */
  humRemoval: boolean;
  /** Presence boost around 3 kHz, dB (0 = off). */
  clarityDb: number;
  /** How far pauses are lowered before the gain stage, dB (0 = off). */
  pauseReductionDb: number;
  /** 'target' = reach targetLufs on speech; 'manual' = apply manualGainDb. */
  gainMode: 'target' | 'manual';
  targetLufs: number;
  manualGainDb: number;
  /** Upper bound on automatic gain, dB. */
  maxAutoGainDb: number;
  limiterCeilingDb: number;
  removeSilence: boolean;
  keepGapMs: number;
  vad: Partial<VadOptions>;
}

const BASE: EnhanceSettings = {
  strength: 'balanced',
  noiseSuppression: true,
  noiseAmount: 1.5,
  noiseFloorDb: -18,
  highPassHz: 80,
  humRemoval: true,
  clarityDb: 3,
  pauseReductionDb: 6,
  gainMode: 'target',
  targetLufs: -16,
  manualGainDb: 0,
  maxAutoGainDb: 24,
  limiterCeilingDb: -1,
  removeSilence: false,
  keepGapMs: 300,
  vad: {},
};

export const PRESETS: Record<Exclude<Strength, 'advanced'>, Partial<EnhanceSettings>> = {
  light: { noiseAmount: 1.0, noiseFloorDb: -10, highPassHz: 70, clarityDb: 2, pauseReductionDb: 0 },
  balanced: { noiseAmount: 1.5, noiseFloorDb: -18, highPassHz: 80, clarityDb: 3, pauseReductionDb: 6 },
  strong: { noiseAmount: 2.2, noiseFloorDb: -26, highPassHz: 100, clarityDb: 4, pauseReductionDb: 10 },
};

export function settingsForPreset(strength: Strength, current?: Partial<EnhanceSettings>): EnhanceSettings {
  const merged = { ...BASE, ...current, strength };
  return strength === 'advanced' ? merged : { ...merged, ...PRESETS[strength] };
}

export const DEFAULT_SETTINGS: EnhanceSettings = settingsForPreset('balanced');

export interface LevelReport {
  integratedLufs: number;
  speechLufs: number;
  samplePeakDb: number;
  truePeakDb: number;
}

export type WarningCode =
  | 'low_snr'
  | 'very_low_snr'
  | 'input_clipping'
  | 'gain_capped'
  | 'heavy_limiting'
  | 'no_speech_found'
  | 'strong_suppression_low_snr';

export interface EnhanceReport {
  input: LevelReport;
  output: LevelReport;
  appliedGainDb: number;
  snrDb: number;
  humHz: 50 | 60 | null;
  segments: Segment[];
  clipping: { events: number; times: number[] };
  limiterMaxReductionDb: number;
  warnings: WarningCode[];
  silenceMap?: [number, number, number][];
  durationSec: number;
  outputDurationSec: number;
  stagesRun: string[];
}

export interface EnhanceResult {
  output: Float32Array;
  sampleRate: number;
  report: EnhanceReport;
}

function measure(x: Float32Array, sr: number, segs: Segment[]): LevelReport {
  const { integrated, speech } = loudnessPair(x, sr, segs);
  return {
    integratedLufs: integrated,
    speechLufs: speech,
    samplePeakDb: samplePeakDb(x),
    truePeakDb: truePeakDb(x),
  };
}

export async function enhance(
  channels: Float32Array[],
  sampleRate: number,
  settings: EnhanceSettings,
  progress: Progress = {},
): Promise<EnhanceResult> {
  const step = async (frac: number) => {
    if (progress.isCancelled?.()) throw new CancelledError();
    progress.onProgress?.(frac);
    if (progress.yieldFn) await progress.yieldFn();
  };
  const stages: string[] = [];
  let x = mixToMono(channels);
  const durationSec = x.length / sampleRate;

  await step(0.02);
  const clipping = detectClipping(x, sampleRate);
  const { segments, analysis } = detectSpeech(x, sampleRate, settings.vad);
  const snrDb = estimateSnrDb(analysis, segments);
  const input = measure(x, sampleRate, segments);
  stages.push('analyse');
  await step(0.1);

  const chain: BiquadCoeffs[] = [];
  if (settings.highPassHz > 0) {
    chain.push(designBiquad('highpass', sampleRate, settings.highPassHz, 0.707));
    stages.push('high-pass');
  }
  let humHz: 50 | 60 | null = null;
  if (settings.humRemoval) {
    humHz = detectHum(x, sampleRate, segments);
    if (humHz) {
      for (let h = 1; h <= 4 && humHz * h < sampleRate / 2; h++) chain.push(designBiquad('notch', sampleRate, humHz * h, 30));
      stages.push(`hum-${humHz}`);
    }
  }
  if (chain.length) x = applyChain(x, chain);
  await step(0.15);

  if (settings.noiseSuppression) {
    x = await denoise(
      x,
      sampleRate,
      segments,
      { overSubtraction: clamp(settings.noiseAmount, 0.5, 3), floorDb: clamp(settings.noiseFloorDb, -40, -3), smoothing: 0.6 },
      {
        isCancelled: progress.isCancelled,
        yieldFn: progress.yieldFn,
        onProgress: (f) => progress.onProgress?.(0.15 + 0.6 * f),
      },
    );
    stages.push('noise-suppression');
  }
  await step(0.76);

  if (settings.clarityDb > 0 && sampleRate > 8000) {
    x = applyChain(x, [designBiquad('peaking', sampleRate, Math.min(3000, sampleRate * 0.4), 0.9, clamp(settings.clarityDb, 0, 8))]);
    stages.push('clarity');
  }
  if (settings.pauseReductionDb > 0) {
    x = attenuateGaps(x, sampleRate, segments, settings.pauseReductionDb);
    stages.push('pause-reduction');
  }
  await step(0.8);

  let appliedGainDb = 0;
  let gainCapped = false;
  if (settings.gainMode === 'manual') {
    appliedGainDb = clamp(settings.manualGainDb, -24, 30);
  } else {
    const current = speechLoudness(x, sampleRate, segments);
    if (Number.isFinite(current)) {
      const wanted = settings.targetLufs - current;
      appliedGainDb = Math.min(wanted, settings.maxAutoGainDb);
      gainCapped = wanted > settings.maxAutoGainDb;
    }
  }
  if (appliedGainDb !== 0) x = applyGain(x, appliedGainDb);
  stages.push('gain');
  await step(0.86);

  // The limiter works on sample peaks; peaks between samples can still exceed the ceiling
  // after D/A conversion or lossy encoding. Re-run with a lower internal ceiling until the
  // estimated true peak is within the user's ceiling (two extra passes at most).
  const preLimit = x;
  let lim = limit(preLimit, sampleRate, settings.limiterCeilingDb);
  let internalCeiling = settings.limiterCeilingDb;
  for (let pass = 0; pass < 2; pass++) {
    const tp = truePeakDb(lim.output);
    if (!(tp > settings.limiterCeilingDb + 0.05)) break;
    internalCeiling -= tp - settings.limiterCeilingDb + 0.05;
    lim = limit(preLimit, sampleRate, internalCeiling);
  }
  x = lim.output;
  stages.push('limiter');
  await step(0.92);

  let silenceMap: [number, number, number][] | undefined;
  let outSegments = segments;
  if (settings.removeSilence && segments.length) {
    const r = removeSilence(x, sampleRate, segments, settings.keepGapMs);
    x = r.output;
    silenceMap = r.map;
    outSegments = detectSpeech(x, sampleRate, settings.vad).segments;
    stages.push('silence-removal');
  }

  const output = measure(x, sampleRate, outSegments);
  await step(1);

  const warnings: WarningCode[] = [];
  if (segments.length === 0) warnings.push('no_speech_found');
  if (Number.isFinite(snrDb) && snrDb < 3) warnings.push('very_low_snr');
  else if (Number.isFinite(snrDb) && snrDb < 10) warnings.push('low_snr');
  if (settings.noiseSuppression && settings.noiseAmount >= 2 && Number.isFinite(snrDb) && snrDb < 10)
    warnings.push('strong_suppression_low_snr');
  if (clipping.events > 0) warnings.push('input_clipping');
  if (gainCapped) warnings.push('gain_capped');
  if (lim.maxReductionDb > 6 || lim.heavySeconds > 1) warnings.push('heavy_limiting');

  return {
    output: x,
    sampleRate,
    report: {
      input,
      output,
      appliedGainDb,
      snrDb,
      humHz,
      segments,
      clipping,
      limiterMaxReductionDb: lim.maxReductionDb,
      warnings,
      silenceMap,
      durationSec,
      outputDurationSec: x.length / sampleRate,
      stagesRun: stages,
    },
  };
}
