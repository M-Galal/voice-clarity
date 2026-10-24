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
    | 'auto_pauses'
    | 'auto_sections';
  vars?: Record<string, string | number>;
}

export interface AutoMeasures {
  snrDb: number;
  whisperShare: number;
  spreadDb: number;
  rumbleDb: number;
  /** Level of the louder speech (80th percentile of ~1 s windows, K-weighted dBFS); reference for sections. */
  speechRefDb?: number;
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

// ------------------------------------------------------------------ per-section settings

export type SectionKind = 'whisper' | 'far' | 'near';

/** One ~1 s speech window, measured on the original audio. Times in seconds. */
export interface SectionWindow {
  start: number;
  end: number;
  /** K-weighted level, dBFS. */
  levelDb: number;
  /** Voice-band level against the noise in the pauses around it, dB. */
  snrDb: number;
  whisper: boolean;
}

/** Settings chosen for one section of the recording. */
export interface SectionSetting {
  start: number;
  end: number;
  kind: SectionKind;
  levelDb: number;
  snrDb: number;
  noiseAmount: number;
  noiseFloorDb: number;
  clarityDb: number;
}

/** Speech this far below the louder speech (dB) counts as distant. */
export const FAR_BELOW_DB = 8;
/** Windows closer than this (s) belong to the same section when they are of the same kind. */
const JOIN_GAP_SEC = 1.5;
/** Shorter sections are folded into an adjacent one, so settings do not flicker. */
const MIN_SECTION_SEC = 2;

function noiseFor(snr: number): { noiseAmount: number; noiseFloorDb: number } {
  if (!Number.isFinite(snr) || snr >= 25) return { noiseAmount: 1.0, noiseFloorDb: -10 };
  if (snr >= 15) return { noiseAmount: 1.3, noiseFloorDb: -15 };
  if (snr >= 8) return { noiseAmount: 1.6, noiseFloorDb: -20 };
  return { noiseAmount: 2.0, noiseFloorDb: -22 };
}

/** Settings for one section: noise reduction from its own noise level, gentler and brighter for quiet speech. */
export function settingsForSection(kind: SectionKind, snrDb: number): Pick<SectionSetting, 'noiseAmount' | 'noiseFloorDb' | 'clarityDb'> {
  let { noiseAmount, noiseFloorDb } = noiseFor(snrDb);
  let clarityDb = 3;
  if (kind === 'whisper') {
    // whispers are noise-like: subtract gently so their consonants survive
    noiseAmount = Math.min(noiseAmount, 1.2);
    noiseFloorDb = Math.max(noiseFloorDb, -14);
    clarityDb = 5;
  } else if (kind === 'far') {
    // distant speech sits close to the noise: protect it, lift the presence range
    noiseAmount = Math.min(noiseAmount, 1.5);
    noiseFloorDb = Math.max(noiseFloorDb, -18);
    clarityDb = 5;
  }
  return { noiseAmount, noiseFloorDb, clarityDb };
}

/**
 * Groups speech windows into sections (whispered, distant, close) and chooses settings for each.
 * `refDb` is the level of the louder speech in the whole recording.
 */
export function planSections(windows: SectionWindow[], refDb: number): SectionSetting[] {
  type Acc = { start: number; end: number; kind: SectionKind; wins: SectionWindow[] };
  const kindOf = (w: SectionWindow): SectionKind => (w.whisper ? 'whisper' : w.levelDb < refDb - FAR_BELOW_DB ? 'far' : 'near');
  let secs: Acc[] = [];
  for (const w of windows) {
    const k = kindOf(w);
    const last = secs[secs.length - 1];
    if (last && last.kind === k && w.start - last.end < JOIN_GAP_SEC) { last.end = w.end; last.wins.push(w); }
    else secs.push({ start: w.start, end: w.end, kind: k, wins: [w] });
  }
  // fold short sections into the longer adjacent neighbour (only neighbours closer than the join gap)
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < secs.length; i++) {
      const c = secs[i];
      if (c.end - c.start >= MIN_SECTION_SEC) continue;
      const prev = i > 0 && c.start - secs[i - 1].end < JOIN_GAP_SEC ? secs[i - 1] : null;
      const next = i + 1 < secs.length && secs[i + 1].start - c.end < JOIN_GAP_SEC ? secs[i + 1] : null;
      const into = prev && next ? (prev.end - prev.start >= next.end - next.start ? prev : next) : prev ?? next;
      if (!into) continue;
      into.start = Math.min(into.start, c.start);
      into.end = Math.max(into.end, c.end);
      into.wins = into === prev ? [...into.wins, ...c.wins] : [...c.wins, ...into.wins];
      secs.splice(i, 1);
      changed = true;
      break;
    }
    // neighbours of the same kind that now touch become one
    const merged: Acc[] = [];
    for (const c of secs) {
      const last = merged[merged.length - 1];
      if (last && last.kind === c.kind && c.start - last.end < JOIN_GAP_SEC) { last.end = c.end; last.wins.push(...c.wins); }
      else merged.push(c);
    }
    if (merged.length !== secs.length) changed = true;
    secs = merged;
  }
  return secs.map((c) => {
    const dur = c.wins.reduce((t, w) => t + (w.end - w.start), 0) || 1;
    const avg = (f: (w: SectionWindow) => number) => c.wins.reduce((t, w) => t + f(w) * (w.end - w.start), 0) / dur;
    const snrDb = avg((w) => (Number.isFinite(w.snrDb) ? Math.min(60, w.snrDb) : 60));
    return { start: c.start, end: c.end, kind: c.kind, levelDb: avg((w) => w.levelDb), snrDb, ...settingsForSection(c.kind, snrDb) };
  });
}

export function countSections(sections: SectionSetting[]): Record<SectionKind, number> {
  const n: Record<SectionKind, number> = { whisper: 0, far: 0, near: 0 };
  for (const s of sections) n[s.kind]++;
  return n;
}
