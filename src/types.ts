import type { LoopSpec } from './playback/loop';
import type { EnhanceReport, EnhanceSettings } from './dsp/pipeline';
import type { Segment } from './dsp/vad';
import type { Transcript } from './transcript/format';
import type { PlaylistSort } from './playlist/filter';

export interface Bookmark {
  id: string;
  time: number; // seconds
  label: string;
  note?: string;
  createdAt: string;
}

export type ProcessingStatus = 'ready' | 'analyzing' | 'enhancing' | 'transcribing' | 'error';

export interface EnhancedCopy {
  fileName: string; // inside the recording folder
  sizeBytes: number;
  sampleRate: number;
  createdAt: string;
  settings: EnhanceSettings;
  report: Omit<EnhanceReport, 'segments'>;
  /** Speech segments on the enhanced timeline (differs from the original when silence was removed). */
  segments: Segment[];
}

export interface Recording {
  id: string;
  name: string;
  /** File name of the untouched original inside the recording folder. */
  originalFileName: string;
  format: string; // upper-case extension, e.g. "M4A"
  mimeType?: string;
  sizeBytes: number;
  durationSec: number;
  sampleRate?: number;
  channels?: number;
  importedAt: string;
  /** The play-list file this recording belongs to. */
  sourceUri?: string;
  /** True when the audio is played and read from `sourceUri` in place (not copied into the app). */
  external?: boolean;
  /** Play-list folder and subfolder path of `sourceUri`, used when Save has to write a new file. */
  sourceFolderUri?: string;
  sourceSubfolder?: string;
  lastPositionSec: number;
  lastPlayedSource: 'original' | 'enhanced';
  bookmarks: Bookmark[];
  /** The part set for A-B repeat (player and live listening), original timeline. */
  loop?: LoopSpec;
  /** Speech segments on the original timeline. */
  segments?: Segment[];
  waveform?: number[];
  noiseFloorDb?: number;
  enhanced?: EnhancedCopy;
  transcript?: Transcript;
  status: ProcessingStatus;
  statusDetail?: string;
  error?: string;
}

export type UiLanguage = 'en' | 'ar';

export interface AppSettings {
  uiLanguage: UiLanguage;
  theme: 'system' | 'light' | 'dark';
  /** Extra text scale on top of the OS setting. */
  textScale: number;
  playbackRate: number;
  skipSilence: boolean;
  /** Pauses shorter than this are not skipped (seconds). */
  skipSilenceMinGapSec: number;
  /** Back / forward button jumps, 1 s to 1 h. */
  skipBackSec: number;
  skipForwardSec: number;
  /** Also detect whispered and distant speech (1.5–7 kHz band). */
  vadWhisper: boolean;
  /** dB above the noise floor that counts as speech. */
  vadThresholdDb: number;
  /** Processing sample rate for enhancement. */
  processingRate: 16000 | 24000 | 48000;
  enhance: EnhanceSettings;
  auto: {
    detectSpeech: boolean;
    enhance: boolean;
    transcribe: boolean;
    /** Run the auto workflow right after import (still asks before saving). */
    runOnImport: boolean;
  };
  transcription: {
    language: string; // 'auto' or ISO code
    modelId: string;
    useEnhancedAudio: boolean;
    /** Optional prompt to bias vocabulary/dialect, e.g. place names. */
    prompt: string;
    /** Two chunks at a time on two threads (default on). */
    parallel?: boolean;
  };
  export: {
    transcriptFormat: 'txt' | 'srt' | 'vtt' | 'json';
  };
  playlist: PlaylistSettings;
  privacyAcknowledged: boolean;
}

export interface PlaylistSettings {
  /** Folder the play list is read from ('' = none chosen yet). */
  folderUri: string;
  includeSubfolders: boolean;
  /** Part of the file name, or patterns with * and ?, separated by ; */
  nameFilter: string;
  /** Extensions as typed, e.g. "m4a, mp3"; empty = all supported. */
  extensions: string;
  sort: PlaylistSort;
  /** Start the next file when one ends. */
  autoNext: boolean;
}
