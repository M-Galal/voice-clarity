
/** Colour pairs chosen for ≥ 4.5:1 contrast for body text and ≥ 3:1 for UI shapes. */
export interface Palette {
  bg: string;
  surface: string;
  surface2: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  speech: string;
  whisper: string;
  bookmark: string;
  playhead: string;
  wave: string;
  waveDim: string;
  warn: string;
  warnBg: string;
  danger: string;
  border: string;
  ok: string;
}

export const LIGHT: Palette = {
  bg: '#F6F7F9',
  surface: '#FFFFFF',
  surface2: '#EDEFF3',
  text: '#121417',
  textMuted: '#4A515C',
  primary: '#0B5FCC',
  onPrimary: '#FFFFFF',
  speech: 'rgba(11,95,204,0.18)',
  whisper: 'rgba(122,74,0,0.22)',
  bookmark: '#B3261E',
  playhead: '#121417',
  wave: '#0B5FCC',
  waveDim: '#8C96A5',
  warn: '#7A4A00',
  warnBg: '#FFF3D6',
  danger: '#B3261E',
  border: '#C9CED6',
  ok: '#1E6B35',
};

export const DARK: Palette = {
  bg: '#0E1013',
  surface: '#171A1F',
  surface2: '#22262D',
  text: '#F1F3F6',
  textMuted: '#B4BBC6',
  primary: '#7FB2FF',
  onPrimary: '#06203F',
  speech: 'rgba(127,178,255,0.20)',
  whisper: 'rgba(255,210,122,0.24)',
  bookmark: '#FF8A80',
  playhead: '#F1F3F6',
  wave: '#7FB2FF',
  waveDim: '#5C6573',
  warn: '#FFD27A',
  warnBg: '#3A2E12',
  danger: '#FF8A80',
  border: '#39404A',
  ok: '#7BD88F',
};

export const fontSizes = (scale: number) => ({
  xs: 11 * scale,
  sm: 13 * scale,
  md: 15 * scale,
  lg: 17 * scale,
  xl: 21 * scale,
  xxl: 28 * scale,
});

/** Compact spacing (the text size setting still scales the text). */
export const space = { xs: 2, sm: 6, md: 8, lg: 12, xl: 16 };

export const radius = 10;

/**
 * Visible height of buttons, chips, switches and list rows. It is below the 48 dp touch-target
 * guideline (Material; Apple: 44 pt), so controls add HIT_SLOP around themselves: the area that
 * reacts to touch stays 48 dp (32 + 8 + 8).
 */
export const TOUCH = 32;
export const HIT_SLOP = { top: 8, bottom: 8, left: 4, right: 4 };

