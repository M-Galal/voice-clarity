/**
 * Filters that shape the voice band: the voice-band low-pass (removes hiss above the voice) and
 * the user's equaliser. Shared by the file pipeline (stream.ts and pipeline.ts) and live
 * listening (live.ts), so all three sound the same.
 */
import { designBiquad, type BiquadCoeffs } from './biquad';

/**
 * Equaliser band centres, Hz: speech fundamentals to sibilants, then the hiss range (8-16 kHz).
 * A band works only below 0.45 x the processing rate (eqBandsFor): at 24 kHz up to 10 kHz, at
 * 48 kHz all of them. New bands are added at the end so saved settings keep their meaning.
 */
export const EQ_BANDS = [125, 250, 500, 1000, 2000, 3000, 4000, 6000, 8000, 10000, 12000, 16000] as const;

/** Indexes of the EQ_BANDS that the processing rate can carry. */
export function eqBandsFor(sampleRate: number): number[] {
  return EQ_BANDS.map((f, i) => (f < sampleRate * 0.45 ? i : -1)).filter((i) => i >= 0);
}
export const EQ_MAX_DB = 12;
/** Bandwidth of each band: Q 1.4 is about one octave. */
const EQ_Q = 1.4;
/** The voice-band low-pass offered in the app (ITU-T G.722 wideband speech: 50 Hz-7 kHz). */
export const LOW_PASS_HZ = 7000;

/**
 * 4th-order Butterworth low-pass (two biquads, Q 0.541 and 1.307): -3 dB at `hz`, -24 dB per
 * octave above. Wideband speech is coded as 50 Hz-7 kHz (ITU-T G.722), so a 7 kHz cut keeps the
 * voice while removing the hiss above it. Off when hz is 0 or too close to the Nyquist frequency.
 */
export function lowPassChain(sampleRate: number, hz: number): BiquadCoeffs[] {
  if (!(hz > 0) || hz >= sampleRate * 0.45) return [];
  return [designBiquad('lowpass', sampleRate, hz, 0.5412), designBiquad('lowpass', sampleRate, hz, 1.3066)];
}

/** Peaking filters for the equaliser bands that are not at 0 dB. */
export function eqChain(sampleRate: number, eq: readonly number[] | undefined): BiquadCoeffs[] {
  if (!eq?.length) return [];
  const out: BiquadCoeffs[] = [];
  EQ_BANDS.forEach((f, i) => {
    const g = Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, eq[i] ?? 0));
    if (Math.abs(g) >= 0.05 && f < sampleRate * 0.45) out.push(designBiquad('peaking', sampleRate, f, EQ_Q, g));
  });
  return out;
}
