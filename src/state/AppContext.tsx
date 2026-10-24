import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Appearance, I18nManager, useColorScheme } from 'react-native';
import { STRINGS, type StringKey } from '../i18n/strings';
import { analyse, importAsset, linkExternal, LowStorageError, pickRecordings } from '../services/processing';
import { UnsupportedFormatError } from '../services/audio';
import {
  DEFAULT_APP_SETTINGS, clearTemp, deleteRecordingFiles, loadLibrary, loadSettings, saveLibrary, saveSettings,
} from '../services/storage';
import { File } from 'expo-file-system';
import type { AppSettings, Recording } from '../types';
import type { PlaylistItem } from '../playlist/filter';
import { FolderUnavailableError } from '../services/playlist';
import { StreamDecodeUnavailableError } from '../services/pcm';
import { DARK, LIGHT, fontSizes, type Palette } from '../ui/theme';

export type Route =
  | { name: 'library' }
  | { name: 'player'; id: string; queueIndex?: number; autoplay?: boolean }
  | { name: 'playlist' }
  | { name: 'enhance'; id: string; auto?: boolean }
  | { name: 'transcript'; id: string }
  | { name: 'edit'; id: string }
  | { name: 'settings' };

interface Ctx {
  ready: boolean;
  library: Recording[];
  settings: AppSettings;
  route: Route;
  navigate: (r: Route) => void;
  /** Swaps the current screen (used to move between play-list files without growing the back stack). */
  replace: (r: Route) => void;
  goBack: () => void;
  /** Files of the play list being played, in order; null when none. */
  queue: PlaylistItem[] | null;
  /** Index of the play-list file being opened (copied in), or null. */
  queueOpening: number | null;
  /** Plays play-list file `index` (copies it into the library the first time). */
  playFromQueue: (items: PlaylistItem[] | null, index: number, opts?: { replace?: boolean; autoplay?: boolean }) => Promise<void>;
  t: (k: StringKey, vars?: Record<string, string | number>) => string;
  colors: Palette;
  fs: ReturnType<typeof fontSizes>;
  rtl: boolean;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateRecording: (id: string, patch: Partial<Recording> | ((r: Recording) => Partial<Recording>)) => void;
  getRecording: (id: string) => Recording | undefined;
  importFromPicker: () => Promise<void>;
  reanalyse: (id: string) => Promise<void>;
  addRecording: (rec: Recording) => Promise<void>;
  deleteRecording: (id: string) => void;
  /** Deletes a play-list file from its folder, with any app data kept for it. Returns true when deleted. */
  deleteFolderFile: (uri: string) => Promise<boolean>;
  showError: (e: unknown) => void;
  resetAll: (lib: Recording[]) => void;
}

const AppCtx = createContext<Ctx | null>(null);

export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp outside provider');
  return c;
};

export const formatBytes = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [library, setLibrary] = useState<Recording[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [stack, setStack] = useState<Route[]>([{ name: 'library' }]);
  const [queue, setQueue] = useState<PlaylistItem[] | null>(null);
  const [queueOpening, setQueueOpening] = useState<number | null>(null);
  const queueRef = useRef<PlaylistItem[] | null>(null);
  const libRef = useRef<Recording[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheme = useColorScheme();

  useEffect(() => {
    void (async () => {
      try {
        clearTemp();
        const [lib, s] = await Promise.all([loadLibrary(), loadSettings()]);
        libRef.current = lib;
        setLibrary(lib);
        setSettings(s);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const persist = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveLibrary(libRef.current).catch(() => {});
    }, 400);
  }, []);

  const setLib = useCallback(
    (fn: (l: Recording[]) => Recording[]) => {
      libRef.current = fn(libRef.current);
      setLibrary(libRef.current);
      persist();
    },
    [persist],
  );

  const t = useCallback(
    (k: StringKey, vars?: Record<string, string | number>) => {
      let s: string = STRINGS[settings.uiLanguage][k] ?? STRINGS.en[k] ?? k;
      if (vars) for (const [key, v] of Object.entries(vars)) s = s.split(`{${key}}`).join(String(v));
      return s;
    },
    [settings.uiLanguage],
  );

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next).catch(() => {});
      if (patch.uiLanguage && patch.uiLanguage !== prev.uiLanguage) {
        const wantRtl = patch.uiLanguage === 'ar';
        if (I18nManager.isRTL !== wantRtl) {
          I18nManager.allowRTL(wantRtl);
          I18nManager.forceRTL(wantRtl);
          Alert.alert(STRINGS[patch.uiLanguage].ui_language, STRINGS[patch.uiLanguage].restart_rtl);
        }
      }
      return next;
    });
  }, []);

  const updateRecording = useCallback<Ctx['updateRecording']>(
    (id, patch) =>
      setLib((l) => l.map((r) => (r.id === id ? { ...r, ...(typeof patch === 'function' ? patch(r) : patch) } : r))),
    [setLib],
  );

  const getRecording = useCallback((id: string) => libRef.current.find((r) => r.id === id), []);

  const showError = useCallback(
    (e: unknown) => {
      let msg: string;
      if (e instanceof UnsupportedFormatError) msg = t('err_unsupported', { ext: e.ext });
      else if (e instanceof LowStorageError) msg = t('err_low_storage', { need: formatBytes(e.neededBytes), free: formatBytes(e.freeBytes) });
      else if (e instanceof Error && e.name === 'CancelledError') msg = t('err_cancelled');
      else if (e instanceof Error && e.message === 'model_missing') msg = t('model_missing');
      else if (e instanceof Error && e.message === 'sharing_unavailable') msg = t('err_share');
      else if (e instanceof FolderUnavailableError) msg = t('pl_folder_unavailable');
      else if (e instanceof StreamDecodeUnavailableError) msg = t('err_stream_decode', { detail: e.detail });
      else if (e instanceof Error && e.message === 'folder_unavailable') msg = t('pl_folder_unavailable');
      else if (e instanceof Error && /decode|codec|format/i.test(e.message)) msg = t('err_decode');
      else msg = t('err_generic', { msg: e instanceof Error ? e.message : String(e) });
      Alert.alert(t('err_title'), msg);
    },
    [t],
  );

  const runAnalysis = useCallback(
    async (rec: Recording) => {
      updateRecording(rec.id, { status: 'analyzing', error: undefined });
      try {
        const a = await analyse(rec, settings.vadThresholdDb, settings.vadWhisper);
        updateRecording(rec.id, {
          status: 'ready',
          durationSec: a.durationSec || rec.durationSec,
          channels: a.channels,
          segments: a.segments,
          waveform: a.waveform,
          noiseFloorDb: a.noiseFloorDb,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[VC] analyse failed for ${rec.format}: ${msg}`);
        updateRecording(rec.id, { status: 'error', error: msg });
      }
    },
    [settings.vadThresholdDb, settings.vadWhisper, updateRecording],
  );

  const importFromPicker = useCallback(async () => {
    try {
      const assets = await pickRecordings();
      const added: Recording[] = [];
      for (const a of assets) {
        try {
          const rec = await importAsset(a);
          added.push(rec);
          setLib((l) => [rec, ...l]);
        } catch (e) {
          showError(e);
        }
      }
      for (const rec of added) await runAnalysis(rec);
      if (added.length === 1 && settings.auto.runOnImport) setStack((s) => [...s, { name: 'enhance', id: added[0].id, auto: true }]);
    } catch (e) {
      showError(e);
    }
  }, [runAnalysis, setLib, settings.auto.runOnImport, showError]);

  const reanalyse = useCallback(
    async (id: string) => {
      const r = libRef.current.find((x) => x.id === id);
      if (r) await runAnalysis(r);
    },
    [runAnalysis],
  );

  const addRecording = useCallback(
    async (rec: Recording) => {
      setLib((l) => [rec, ...l]);
      await runAnalysis(rec);
    },
    [runAnalysis, setLib],
  );

  const deleteRecording = useCallback(
    (id: string) => {
      try { deleteRecordingFiles(id); } catch { /* already gone */ }
      setLib((l) => l.filter((r) => r.id !== id));
      setStack([{ name: 'library' }]);
    },
    [setLib],
  );

  const playFromQueue = useCallback<Ctx['playFromQueue']>(
    async (items, index, opts = {}) => {
      const list = items ?? queueRef.current;
      const item = list?.[index];
      if (!list || !item) return;
      if (items) { queueRef.current = items; setQueue(items); }
      setQueueOpening(index);
      try {
        let rec = libRef.current.find((r) => r.sourceUri === item.uri && (!item.size || r.sizeBytes === item.size));
        if (!rec) {
          rec = await linkExternal({ uri: item.uri, name: item.name, size: item.size, folderUri: settings.playlist.folderUri, subfolder: item.subfolder });
          const added = rec;
          setLib((l) => [added, ...l]);
          void runAnalysis(added); // the player opens right away; speech sections appear when ready
        }
        const route: Route = { name: 'player', id: rec.id, queueIndex: index, autoplay: opts.autoplay };
        setStack((s) => (opts.replace && s[s.length - 1]?.name === 'player' ? [...s.slice(0, -1), route] : [...s, route]));
      } catch (e) {
        showError(e);
      } finally {
        setQueueOpening(null);
      }
    },
    [runAnalysis, setLib, showError, settings.playlist.folderUri],
  );

  const deleteFolderFile = useCallback(
    async (uri: string) => {
      try {
        const f = new File(uri);
        if (f.exists) f.delete();
      } catch (e) {
        showError(e);
        return false;
      }
      const gone = libRef.current.filter((r) => r.external && r.sourceUri === uri);
      for (const r of gone) { try { deleteRecordingFiles(r.id); } catch { /* already gone */ } }
      if (gone.length) setLib((l) => l.filter((r) => !(r.external && r.sourceUri === uri)));
      if (queueRef.current?.some((q) => q.uri === uri)) {
        queueRef.current = queueRef.current.filter((q) => q.uri !== uri);
        setQueue(queueRef.current);
      }
      return true;
    },
    [setLib, showError],
  );

  const resetAll = useCallback((lib: Recording[]) => { setLib(() => lib); setStack([{ name: 'library' }]); }, [setLib]);

  // Native parts (alerts, keyboard, pickers, dialogs) follow the app's theme too, not only the screens.
  // 'unspecified' goes back to following the phone (Android: MODE_NIGHT_FOLLOW_SYSTEM).
  useEffect(() => {
    if (!ready) return;
    Appearance.setColorScheme(settings.theme === 'system' ? 'unspecified' : settings.theme);
  }, [ready, settings.theme]);

  const dark = settings.theme === 'dark' || (settings.theme === 'system' && scheme === 'dark');
  const value = useMemo<Ctx>(
    () => ({
      ready,
      library,
      settings,
      route: stack[stack.length - 1],
      navigate: (r) => setStack((s) => [...s, r]),
      replace: (r) => setStack((s) => [...s.slice(0, -1), r]),
      queue,
      queueOpening,
      playFromQueue,
      goBack: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
      t,
      colors: dark ? DARK : LIGHT,
      fs: fontSizes(settings.textScale),
      rtl: I18nManager.isRTL,
      updateSettings,
      updateRecording,
      getRecording,
      importFromPicker,
      reanalyse,
      addRecording,
      deleteRecording,
      deleteFolderFile,
      showError,
      resetAll,
    }),
    [ready, library, settings, stack, queue, queueOpening, playFromQueue, t, dark, updateSettings, updateRecording, getRecording, importFromPicker, reanalyse, addRecording, deleteRecording, deleteFolderFile, showError, resetAll],
  );

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
