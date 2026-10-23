import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, I18nManager, useColorScheme } from 'react-native';
import { STRINGS, type StringKey } from '../i18n/strings';
import { analyse, importAsset, LowStorageError, pickRecordings } from '../services/processing';
import { UnsupportedFormatError } from '../services/audio';
import {
  DEFAULT_APP_SETTINGS, clearTemp, deleteRecordingFiles, loadLibrary, loadSettings, saveLibrary, saveSettings,
} from '../services/storage';
import type { AppSettings, Recording } from '../types';
import { DARK, LIGHT, fontSizes, type Palette } from '../ui/theme';

export type Route =
  | { name: 'library' }
  | { name: 'player'; id: string }
  | { name: 'enhance'; id: string; auto?: boolean }
  | { name: 'transcript'; id: string }
  | { name: 'settings' };

interface Ctx {
  ready: boolean;
  library: Recording[];
  settings: AppSettings;
  route: Route;
  navigate: (r: Route) => void;
  goBack: () => void;
  t: (k: StringKey, vars?: Record<string, string | number>) => string;
  colors: Palette;
  fs: ReturnType<typeof fontSizes>;
  rtl: boolean;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateRecording: (id: string, patch: Partial<Recording> | ((r: Recording) => Partial<Recording>)) => void;
  getRecording: (id: string) => Recording | undefined;
  importFromPicker: () => Promise<void>;
  reanalyse: (id: string) => Promise<void>;
  deleteRecording: (id: string) => void;
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
  const libRef = useRef<Recording[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheme = useColorScheme();

  useEffect(() => {
    (async () => {
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
        const a = await analyse(rec, settings.vadThresholdDb);
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
    [settings.vadThresholdDb, updateRecording],
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

  const deleteRecording = useCallback(
    (id: string) => {
      try { deleteRecordingFiles(id); } catch { /* already gone */ }
      setLib((l) => l.filter((r) => r.id !== id));
      setStack([{ name: 'library' }]);
    },
    [setLib],
  );

  const resetAll = useCallback((lib: Recording[]) => { setLib(() => lib); setStack([{ name: 'library' }]); }, [setLib]);

  const dark = settings.theme === 'dark' || (settings.theme === 'system' && scheme === 'dark');
  const value = useMemo<Ctx>(
    () => ({
      ready,
      library,
      settings,
      route: stack[stack.length - 1],
      navigate: (r) => setStack((s) => [...s, r]),
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
      deleteRecording,
      showError,
      resetAll,
    }),
    [ready, library, settings, stack, t, dark, updateSettings, updateRecording, getRecording, importFromPicker, reanalyse, deleteRecording, showError, resetAll],
  );

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
