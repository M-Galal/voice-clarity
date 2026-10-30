/**
 * On-device storage. Everything lives under the app's document directory:
 *
 *   VoiceClarity/
 *     library.json            list of recordings (metadata, bookmarks, segments, transcripts)
 *     settings.json
 *     recordings/<id>/        original file (never modified) + enhanced.wav
 *     models/                 downloaded Whisper models
 *
 * Writes go to a temp file first and are then moved into place, so a crash mid-write
 * cannot leave a half-written library.json.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { DEFAULT_SETTINGS, MAX_GAIN_DB } from '../dsp/pipeline';
import type { AppSettings, Recording } from '../types';

export const root = () => new Directory(Paths.document, 'VoiceClarity');
export const recordingsDir = () => new Directory(root(), 'recordings');
export const modelsDir = () => new Directory(root(), 'models');
export const recordingDir = (id: string) => new Directory(recordingsDir(), id);
export const tempDir = () => new Directory(Paths.cache, 'VoiceClarityTemp');

export function ensureDirs(): void {
  for (const d of [root(), recordingsDir(), modelsDir(), tempDir()]) {
    if (!d.exists) d.create({ intermediates: true, idempotent: true });
  }
}

async function readJson<T>(name: string, fallback: T): Promise<T> {
  const f = new File(root(), name);
  if (!f.exists) return fallback;
  try {
    return JSON.parse(await f.text()) as T;
  } catch {
    // keep the broken file for diagnosis, start clean
    try { f.moveSync(new File(root(), `${name}.corrupt-${Date.now()}`)); } catch { /* ignore */ }
    return fallback;
  }
}

async function writeJson(name: string, data: unknown): Promise<void> {
  ensureDirs();
  const tmp = new File(root(), `${name}.tmp`);
  if (tmp.exists) tmp.delete();
  tmp.create();
  await tmp.write(JSON.stringify(data));
  const target = new File(root(), name);
  if (target.exists) target.delete();
  tmp.moveSync(target);
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  uiLanguage: 'en',
  theme: 'system',
  textScale: 1,
  playbackRate: 1,
  skipSilence: false,
  skipSilenceMinGapSec: 1,
  skipBackSec: 10,
  skipForwardSec: 10,
  vadWhisper: true,
  vadThresholdDb: 10,
  processingRate: 24000,
  enhance: DEFAULT_SETTINGS,
  auto: { detectSpeech: true, enhance: true, transcribe: false, runOnImport: false },
  transcription: { language: 'ar', modelId: 'small', useEnhancedAudio: true, prompt: '' },
  export: { transcriptFormat: 'srt' },
  playlist: { folderUri: '', includeSubfolders: false, nameFilter: '', extensions: '', sort: 'name', autoNext: true },
  privacyAcknowledged: false,
};

export async function loadLibrary(): Promise<Recording[]> {
  ensureDirs();
  const list = await readJson<Recording[]>('library.json', []);
  // anything interrupted mid-processing is reset so the user can retry
  return list.map((r) =>
    r.status === 'analyzing' || r.status === 'enhancing' || r.status === 'transcribing'
      ? { ...r, status: 'error', error: 'interrupted' }
      : r,
  );
}

export const saveLibrary = (list: Recording[]) => writeJson('library.json', list);

export async function loadSettings(): Promise<AppSettings> {
  const s = await readJson<Partial<AppSettings>>('settings.json', {});
  return {
    ...DEFAULT_APP_SETTINGS,
    ...s,
    enhance: { ...DEFAULT_APP_SETTINGS.enhance, ...s.enhance, maxAutoGainDb: MAX_GAIN_DB },
    auto: { ...DEFAULT_APP_SETTINGS.auto, ...s.auto },
    transcription: { ...DEFAULT_APP_SETTINGS.transcription, ...s.transcription },
    export: { ...DEFAULT_APP_SETTINGS.export, ...s.export },
    playlist: { ...DEFAULT_APP_SETTINGS.playlist, ...s.playlist },
  };
}

export const saveSettings = (s: AppSettings) => writeJson('settings.json', s);

export const fileIn = (id: string, name: string) => new File(recordingDir(id), name);

export function deleteRecordingFiles(id: string): void {
  const d = recordingDir(id);
  if (d.exists) d.delete();
}

export function freeBytes(): number {
  try {
    return Paths.availableDiskSpace;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function clearTemp(): void {
  const d = tempDir();
  if (d.exists) d.delete();
  d.create({ intermediates: true, idempotent: true });
}

export function deleteAllData(): void {
  const r = root();
  if (r.exists) r.delete();
  clearTemp();
  ensureDirs();
}

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
