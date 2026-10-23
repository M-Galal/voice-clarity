/**
 * Smart mode: measures the recording and chooses enhancement settings for the clearest
 * speech. Every choice comes with a reason the app shows to the user.
 *
 * Measurements (all on the original audio):
 * - speech-to-noise ratio in the voice band (frame levels inside vs outside speech)
 * - share of speech time that was detected as whispered / distant (whisper band only)
 * - level spread between loud and quiet speech windows (K-weighted, p90 − p10)
 * - low-frequency rumble: energy below 100 Hz vs 100 Hz–4 kHz in the pauses
 * - mains hum (detected separately by the pipeline) and clipping
 */
import { applyChain, designBiquad } from './biquad';
import type { EnhanceSettings } from './pipeline';
import type { Segment } from './vad';

export interface AutoReason {
  key:
    | 'auto_noise_clean'
    | 'auto_noise_some'
    | 'auto_noise_noisy'
    | 'auto_noise_very_noisy'
    | 'auto_whisper_protect'
    | 'auto_level_on'
    | 'auto_level_off'
    | 'auto_rumble'
    | 'auto_clarity_far'
    | 'auto_pauses';
  vars?: Record<string, string | number>;
}

export interface AutoMeasures {
  snrDb: number;
  whisperShare: number;
  spreadDb: number;
  rumbleDb: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

function bandPower(x: Float32Array, sr: number, ranges: [number, number][], chain: ReturnType<typeof designBiquad>[]): number {
  const y = applyChain(x, chain);
  let p = 0, n = 0;
  for (const [a, b] of ranges) {
    for (let i = Math.round(a * sr); i < Math.min(y.length, Math.round(b * sr)); i++) { p += y[i] * y[i]; n++; }
  }
  return n ? p / n : 0;
}

export function measureForAuto(
  mono: Float32Array,
  sampleRate: number,
  segments: Segment[],
  snrDb: number,
  weighted: Float32Array,
): AutoMeasures {
  const speechTime = segments.reduce((t, s) => t + (s.end - s.start), 0);
  const whisperTime = segments.filter((s) => s.kind === 'whisper').reduce((t, s) => t + (s.end - s.start), 0);
  // level spread of ~1 s speech windows
  const levels: number[] = [];
  for (const s of segments) {
    const a0 = Math.round(s.start * sampleRate), b0 = Math.min(weighted.length, Math.round(s.end * sampleRate));
    const n = Math.max(1, Math.round((b0 - a0) / sampleRate));
    const step = (b0 - a0) / n;
    for (let k = 0; k < n; k++) {
      let acc = 0;
      const a = Math.round(a0 + k * step), b = Math.round(a0 + (k + 1) * step);
      for (let i = a; i < b; i++) acc += weighted[i] * weighted[i];
      levels.push(10 * Math.log10(acc / Math.max(1, b - a) + 1e-12));
    }
  }
  levels.sort((p, q) => p - q);
  const pick = (p: number) => (levels.length ? levels[Math.min(levels.length - 1, Math.floor(p * levels.length))] : 0);
  const spreadDb = levels.length >= 2 ? pick(0.9) - pick(0.1) : 0;
  // rumble in pauses
  const dur = mono.length / sampleRate;
  const gaps: [number, number][] = [];
  let c = 0;
  for (const s of segments) { if (s.start > c) gaps.push([c, s.start]); c = s.end; }
  if (c < dur) gaps.push([c, dur]);
  const low = bandPower(mono, sampleRate, gaps, [designBiquad('lowpass', sampleRate, 100, 0.707), designBiquad('lowpass', sampleRate, 100, 0.707)]);
  const mid = bandPower(mono, sampleRate, gaps, [designBiquad('highpass', sampleRate, 100, 0.707), designBiquad('lowpass', sampleRate, Math.min(4000, sampleRate * 0.45), 0.707)]);
  const rumbleDb = low > 0 && mid > 0 ? 10 * Math.log10(low / mid) : -60;
  return { snrDb, whisperShare: speechTime > 0 ? whisperTime / speechTime : 0, spreadDb, rumbleDb };
}

/** Chooses settings from the measurements. Loudness target and limiter ceiling stay as the user set them. */
export function chooseSettings(base: EnhanceSettings, m: AutoMeasures): { settings: EnhanceSettings; reasons: AutoReason[] } {
  const reasons: AutoReason[] = [];
  const snr = Number.isFinite(m.snrDb) ? m.snrDb : 40;
  let noiseAmount: number, noiseFloorDb: number;
  if (snr >= 25) { noiseAmount = 1.0; noiseFloorDb = -10; reasons.push({ key: 'auto_noise_clean', vars: { snr: Math.round(snr) } }); }
  else if (snr >= 15) { noiseAmount = 1.3; noiseFloorDb = -15; reasons.push({ key: 'auto_noise_some', vars: { snr: Math.round(snr) } }); }
  else if (snr >= 8) { noiseAmount = 1.6; noiseFloorDb = -20; reasons.push({ key: 'auto_noise_noisy', vars: { snr: Math.round(snr) } }); }
  else { noiseAmount = 2.0; noiseFloorDb = -22; reasons.push({ key: 'auto_noise_very_noisy', vars: { snr: Math.round(snr) } }); }

  const hasWhisper = m.whisperShare > 0.02;
  if (hasWhisper) {
    // whispers are noise-like: gentler subtraction so their consonants survive
    noiseAmount = Math.min(noiseAmount, 1.4);
    noiseFloorDb = Math.max(noiseFloorDb, -16);
    reasons.push({ key: 'auto_whisper_protect', vars: { pct: Math.round(m.whisperShare * 100) } });
  }

  const levelSpeech = hasWhisper || m.spreadDb > 4;
  const levelMaxBoostDb = Math.round(Math.min(30, Math.max(8, m.spreadDb + 6)));
  reasons.push(levelSpeech
    ? { key: 'auto_level_on', vars: { spread: r1(m.spreadDb), boost: levelMaxBoostDb } }
    : { key: 'auto_level_off', vars: { spread: r1(m.spreadDb) } });

  let highPassHz = 80;
  if (m.rumbleDb > 6) { highPassHz = 120; reasons.push({ key: 'auto_rumble', vars: { hz: highPassHz } }); }
  else if (m.rumbleDb > 0) { highPassHz = 100; reasons.push({ key: 'auto_rumble', vars: { hz: highPassHz } }); }

  const clarityDb = hasWhisper || m.spreadDb > 10 ? 4 : 3;
  if (clarityDb > 3) reasons.push({ key: 'auto_clarity_far', vars: { db: clarityDb } });

  const pauseReductionDb = snr < 15 ? 8 : 4;
  reasons.push({ key: 'auto_pauses', vars: { db: pauseReductionDb } });

  return {
    settings: {
      ...base,
      strength: 'auto',
      noiseSuppression: true,
      noiseAmount,
      noiseFloorDb,
      humRemoval: true,
      highPassHz,
      clarityDb,
      pauseReductionDb,
      levelSpeech,
      levelMaxBoostDb,
      gainMode: 'target',
    },
    reasons,
  };
}
