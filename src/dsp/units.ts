/**
 * Level units used across the app.
 *
 * - Gain in dB is the source of truth for every level change.
 * - "Percent" is only a UI view of an amplitude ratio:
 *     percent = (10^(dB/20) - 1) * 100
 *   so +6.02 dB = +100 % (double amplitude), -6.02 dB = -50 %, 0 dB = 0 %.
 *   Converting back always goes through percentToDb, so the two views can never drift.
 */

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

export const gainToDb = (gain: number): number =>
  gain <= 0 ? -Infinity : 20 * Math.log10(gain);

export const dbToPercent = (db: number): number => (dbToGain(db) - 1) * 100;

export const percentToDb = (percent: number): number => {
  const ratio = 1 + percent / 100;
  if (ratio <= 0) throw new RangeError('Percent must be greater than -100');
  return gainToDb(ratio);
};

/** Power ratio helpers for energy-domain math (RMS², spectra). */
export const powerToDb = (p: number): number => (p <= 0 ? -Infinity : 10 * Math.log10(p));
export const dbToPower = (db: number): number => Math.pow(10, db / 10);

export const formatDb = (db: number, digits = 1): string =>
  Number.isFinite(db) ? `${db >= 0 ? '+' : ''}${db.toFixed(digits)} dB` : '−∞ dB';

export const formatLevel = (value: number, unit: 'LUFS' | 'dBFS' | 'dBTP', digits = 1): string =>
  Number.isFinite(value) ? `${value.toFixed(digits)} ${unit}` : `−∞ ${unit}`;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
