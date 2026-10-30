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
import { eqChain, lowPassChain } from './voiceFilters';
import { mixToMono, removeSilence } from './buffers';
import { CancelledError, DD_SMOOTHING, denoise, detectHum, humHarmonics, humNotches, type Progress } from './denoise';
import { applyGain, attenuateGaps, detectClipping, levelSpeech, limit } from './dynamics';
import { kWeight, loudnessPair, samplePeakDb, speechLoudness, truePeakDb } from './loudness';
import { chooseSettings, measureForAuto, type AutoMeasures, type AutoReason, type SectionKind } from './autoTune';
import { clamp } from './units';
import { detectSpeech, estimateSnrDb, type Segment, type VadOptions } from './vad';

export type Strength = 'auto' | 'light' | 'balanced' | 'strong' | 'advanced' | Situation;

/** One-tap presets for a known kind of recording. */
export type Situation = 'whisper' | 'far' | 'noisy' | 'rumble';
export const SITUATIONS: Situation[] = ['whisper', 'far', 'noisy', 'rumble'];
export const isSituation = (s: Strength): s is Situation => (SITUATIONS as string[]).includes(s);

export interface EnhanceSettings {
  strength: Strength;
  noiseSuppression: boolean;
  /** Over-subtraction factor, 1–3. */
  noiseAmount: number;
  /** Max per-band cut, dB (negative). */
  noiseFloorDb: number;
  /** High-pass cutoff in Hz (0 = off). Removes rumble, wind and plosive pops. */
  highPassHz: number;
  /** Voice-band low-pass in Hz (0 = off): removes hiss above the voice. */
  lowPassHz?: number;
  /** Equaliser: dB per band of EQ_BANDS (voiceFilters.ts); missing = 0. */
  eq?: number[];
  /** Remove 50/60 Hz mains hum and harmonics when detected. */
  humRemoval: boolean;
  /** Presence boost around 3 kHz, dB (0 = off). */
  clarityDb: number;
  /** How far pauses are lowered before the gain stage, dB (0 = off). */
  pauseReductionDb: number;
  /** Raise quiet speech (whispers, distant voices) towards the louder speech. */
  levelSpeech: boolean;
  /** Most a quiet speech window may be raised by the leveller, dB. */
  levelMaxBoostDb: number;
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
  /** Smart mode: choose noise reduction and clarity for each section (whispered, distant, close). */
  perSection?: boolean;
  /**
   * Noise reduction goes at least as deep as the boost planned for each part (leveller + gain),
   * so raising quiet speech does not raise the noise and hum under it above their original level.
   * On unless set to false.
   */
  noiseFollowsBoost?: boolean;
  /**
   * Smart mode: raise quiet speech only until the noise left under it is 3 dB above the noise
   * under the loud speech, so the background stays steady.
   */
  steadyNoise?: boolean;
  /**
   * Smart mode with measurements taken elsewhere (the preview uses the whole recording's, not
   * those of the previewed minute). Not saved with the user's settings.
   */
  autoMeasures?: AutoMeasures;
}

/** Most the voice level may be raised by the gain stage (automatic or manual), dB. */
export const MAX_GAIN_DB = 50;

const BASE: EnhanceSettings = {
  strength: 'auto',
  noiseSuppression: true,
  noiseAmount: 1.5,
  noiseFloorDb: -18,
  highPassHz: 80,
  lowPassHz: 0,
  humRemoval: true,
  clarityDb: 3,
  pauseReductionDb: 6,
  levelSpeech: true,
  levelMaxBoostDb: 12,
  gainMode: 'target',
  targetLufs: -16,
  manualGainDb: 0,
  maxAutoGainDb: MAX_GAIN_DB,
  limiterCeilingDb: -1,
  removeSilence: false,
  keepGapMs: 300,
  vad: {},
  perSection: true,
};

export const PRESETS: Record<Exclude<Strength, 'advanced' | 'auto'>, Partial<EnhanceSettings>> = {
  light: { noiseAmount: 1.0, noiseFloorDb: -10, highPassHz: 70, clarityDb: 2, pauseReductionDb: 0, levelSpeech: false, levelMaxBoostDb: 6 },
  balanced: { noiseAmount: 1.5, noiseFloorDb: -18, highPassHz: 80, clarityDb: 3, pauseReductionDb: 6, levelSpeech: true, levelMaxBoostDb: 12 },
  strong: { noiseAmount: 2.2, noiseFloorDb: -26, highPassHz: 100, clarityDb: 4, pauseReductionDb: 10, levelSpeech: true, levelMaxBoostDb: 20 },
  // The same values Smart mode uses for such sections (autoTune.ts settingsForSection), as fixed presets.
  // Whispers are noise-like: gentle subtraction keeps their consonants; presence boost; strong leveller.
  whisper: { noiseSuppression: true, humRemoval: true, noiseAmount: 1.2, noiseFloorDb: -14, highPassHz: 100, clarityDb: 5, pauseReductionDb: 6, levelSpeech: true, levelMaxBoostDb: 24 },
  // Distant voice: close to the noise, thin and quiet: moderate subtraction, presence boost, leveller.
  far: { noiseSuppression: true, humRemoval: true, noiseAmount: 1.5, noiseFloorDb: -18, highPassHz: 100, clarityDb: 5, pauseReductionDb: 6, levelSpeech: true, levelMaxBoostDb: 20 },
  // Loud steady background (fan, traffic, crowd): strong subtraction and pause lowering.
  noisy: { noiseSuppression: true, humRemoval: true, noiseAmount: 2.0, noiseFloorDb: -22, highPassHz: 100, clarityDb: 3, pauseReductionDb: 10, levelSpeech: true, levelMaxBoostDb: 12 },
  // Mains hum, wind, handling and traffic rumble: higher low-cut and hum notches, light subtraction.
  rumble: { noiseSuppression: true, humRemoval: true, noiseAmount: 1.3, noiseFloorDb: -15, highPassHz: 150, clarityDb: 3, pauseReductionDb: 4, levelSpeech: true, levelMaxBoostDb: 12 },
};

/** 'auto' keeps the user's loudness/limiter values; the rest is chosen per file in enhance(). */
export function settingsForPreset(strength: Strength, current?: Partial<EnhanceSettings>): EnhanceSettings {
  // maxAutoGainDb has no control of its own: always the current limit (older saved settings had 24)
  const merged = { ...BASE, ...current, strength, maxAutoGainDb: MAX_GAIN_DB };
  return strength === 'advanced' || strength === 'auto' ? merged : { ...merged, ...PRESETS[strength] };
}

/** Smart mode is the default: the file is analysed and the settings chosen for it. */
export const DEFAULT_SETTINGS: EnhanceSettings = settingsForPreset('auto');

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
  /** Settings actually used (for Smart mode these were chosen from the file). */
  appliedSettings: EnhanceSettings;
  /** Why Smart mode chose what it chose. */
  autoReasons?: AutoReason[];
  /** Number of detected speech sections that were whispered or distant. */
  whisperSections: number;
  /** Largest boost the speech leveller applied, dB. */
  levelerMaxBoostDb: number;
  /** Smart mode per section: how many sections of each kind got their own settings. */
  sectionCounts?: Record<SectionKind, number>;
}

/** What the app keeps from an enhancement run (the audio itself goes to a file). */
export interface EnhanceSummary {
  sampleRate: number;
  report: EnhanceReport;
}

export interface EnhanceResult extends EnhanceSummary {
  output: Float32Array;
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
  requested: EnhanceSettings,
  progress: Progress = {},
): Promise<EnhanceResult> {
  let settings = requested;
  let autoReasons: AutoReason[] | undefined;
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
  if (requested.strength === 'auto') {
    const m = measureForAuto(x, sampleRate, segments, snrDb, kWeight(x, sampleRate));
    const chosen = chooseSettings(requested, m);
    settings = chosen.settings;
    autoReasons = chosen.reasons;
    stages.push('smart-settings');
  }
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
      chain.push(...humNotches(sampleRate, humHz, humHarmonics(x, sampleRate, segments, humHz)));
      stages.push(`hum-${humHz}`);
    }
  }
  const lp = lowPassChain(sampleRate, settings.lowPassHz ?? 0);
  if (lp.length) { chain.push(...lp); stages.push('low-pass'); }
  if (chain.length) x = applyChain(x, chain);
  await step(0.15);

  if (settings.noiseSuppression) {
    x = await denoise(
      x,
      sampleRate,
      segments,
      { overSubtraction: clamp(settings.noiseAmount, 0.5, 3), floorDb: clamp(settings.noiseFloorDb, -40, -3), smoothing: DD_SMOOTHING, rule: 'wiener-dd' },
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
  const eqf = eqChain(sampleRate, settings.eq);
  if (eqf.length) { x = applyChain(x, eqf); stages.push('equaliser'); }
  if (settings.pauseReductionDb > 0) {
    x = attenuateGaps(x, sampleRate, segments, settings.pauseReductionDb);
    stages.push('pause-reduction');
  }
  let levelerMaxBoostDb = 0;
  if (settings.levelSpeech && segments.length > 0) {
    const lv = levelSpeech(x, sampleRate, segments, { maxBoostDb: clamp(settings.levelMaxBoostDb, 0, 30) }, kWeight(x, sampleRate));
    x = lv.output;
    levelerMaxBoostDb = lv.boostsDb.reduce((a, b) => Math.max(a, b), 0);
    stages.push('speech-leveller');
  }
  await step(0.8);

  let appliedGainDb = 0;
  let gainCapped = false;
  if (settings.gainMode === 'manual') {
    appliedGainDb = clamp(settings.manualGainDb, -24, MAX_GAIN_DB);
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
      appliedSettings: settings,
      autoReasons,
      whisperSections: segments.filter((g) => g.kind === 'whisper').length,
      levelerMaxBoostDb,
    },
  };
}
