import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useKeepAwake } from 'expo-keep-awake';
import { isSituation, settingsForPreset, SITUATIONS, type EnhanceSummary as EnhanceResult, type EnhanceSettings, type Strength, type WarningCode } from '../dsp/pipeline';
import { dbToPercent, formatDb, formatLevel, percentToDb } from '../dsp/units';
import { audioUri, commitPreview, deleteEnhanced, discardPreview, EnhancePreviewer, enhanceToPreview, type CancelToken } from '../services/processing';
import { LivePlayer } from '../services/livePlayer';
import type { LiveContext } from '../dsp/live';
import { chooseSettings, countSections, type SectionKind, type SectionSetting } from '../dsp/autoTune';
import type { SmartAnalysis } from '../dsp/stream';
import type { Spectrum } from '../dsp/spectrum';
import { Waveform } from '../ui/Waveform';
import { bestPreviewStart } from '../dsp/stream';
import { useApp } from '../state/AppContext';
import { clock } from '../transcript/format';
import type { Recording } from '../types';
import {
  Button, Card, Choice, Header, IconButton, KeyValue, LabeledSlider, ProgressBar, Row, Section, Toggle, Txt, Warning,
} from '../ui/components';
import { radius, space, TOUCH } from '../ui/theme';

type Phase = { kind: 'setup' } | { kind: 'running'; progress: number; stage: string } | { kind: 'review'; result: EnhanceResult; previewUri: string };

const pct = (db: number) => {
  const p = dbToPercent(db);
  return `${p >= 0 ? '+' : ''}${p.toFixed(p > -10 && p < 10 ? 1 : 0)} %`;
};

export function EnhanceScreen({ id, auto }: { id: string; auto?: boolean }) {
  const { library } = useApp();
  const rec = library.find((r) => r.id === id);
  if (!rec) return null;
  return <Enhance rec={rec} auto={auto} />;
}

function Enhance({ rec, auto }: { rec: Recording; auto?: boolean }) {
  const { t, goBack, settings, updateSettings, updateRecording, showError, navigate, colors, isAnalysing } = useApp();
  const [s, setS] = useState<EnhanceSettings>(settings.enhance);
  const [rate, setRate] = useState(settings.processingRate);
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const token = useRef<CancelToken>({ cancelled: false });
  // decoded recording shared by the Smart analysis, the preview and the full run
  const [pv] = useState(() => new EnhancePreviewer(rec));
  useEffect(() => () => pv.dispose(), [pv]);
  const vadOf = (x: EnhanceSettings) => ({ ...x, vad: { ...x.vad, thresholdDb: settings.vadThresholdDb, whisper: settings.vadWhisper } });

  // Smart mode: analyse the whole recording as soon as the screen opens (and when the rate changes)
  const [smart, setSmart] = useState<SmartState>({ kind: 'idle' });
  const smartGen = useRef(0);
  const analyse = async () => {
    const my = ++smartGen.current;
    const stale = () => my !== smartGen.current;
    try {
      setSmart({ kind: 'running', label: t('smart_reading'), progress: 0 });
      // sections are always worked out, so the per-section switch needs no new analysis
      const analysis = await pv.analyseSmart(rate, { ...vadOf(s), perSection: true }, (f, stage) => {
        if (!stale()) setSmart({ kind: 'running', label: t(stage === 'reading' ? 'smart_reading' : 'smart_measuring'), progress: f });
      }, stale);
      if (!stale()) setSmart({ kind: 'ready', analysis });
    } catch (e) {
      if (!stale()) setSmart({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };
  const wantSmart = s.strength === 'auto';
  // the analysis also feeds live listening (speech, hum, levels), so it runs for every preset
  useEffect(() => {
    const h = setTimeout(() => { void analyse(); }, 0);
    return () => clearTimeout(h);
  }, [rate]); // eslint-disable-line react-hooks/exhaustive-deps
  // The preview uses the whole-file Smart measurements (file settings and the level that marks
  // distant speech), not a choice made from the previewed minute alone.
  const previewSettings: EnhanceSettings = wantSmart && smart.kind === 'ready' ? { ...s, autoMeasures: smart.analysis.measures } : s;
  const perSection = s.perSection !== false;
  const fileSections = wantSmart && perSection && smart.kind === 'ready' ? smart.analysis.sections : null;

  const patch = (p: Partial<EnhanceSettings>) => setS((prev) => ({ ...prev, ...p, strength: p.strength ?? (Object.keys(p).some((k) => k !== 'perSection' && k !== 'steadyNoise' && k !== 'gainMode' && k !== 'targetLufs' && k !== 'manualGainDb' && k !== 'removeSilence' && k !== 'keepGapMs' && k !== 'limiterCeilingDb') ? 'advanced' : prev.strength) }));

  const run = async () => {
    token.current = { cancelled: false };
    updateSettings({ enhance: s, processingRate: rate });
    updateRecording(rec.id, { status: 'enhancing' });
    setPhase({ kind: 'running', progress: 0, stage: 'decode' });
    try {
      const vadSettings = { ...s, vad: { ...s.vad, thresholdDb: settings.vadThresholdDb, whisper: settings.vadWhisper } };
      const { result, previewUri } = await enhanceToPreview(rec, vadSettings, rate, token.current, (p, stage) => setPhase({ kind: 'running', progress: p, stage }), pv.decodedFor(rate));
      setPhase({ kind: 'review', result, previewUri });
    } catch (e) {
      setPhase({ kind: 'setup' });
      showError(e);
    } finally {
      // speech detection may still be running for a file just imported
      updateRecording(rec.id, { status: isAnalysing(rec.id) ? 'analyzing' : 'ready' });
    }
  };

  const keep = () => {
    if (phase.kind !== 'review') return;
    const { fileName, sizeBytes } = commitPreview(rec, phase.previewUri);
    const { segments, ...report } = phase.result.report;
    const enhancedSegs = report.silenceMap ? remapSegments(segments, report.silenceMap) : segments;
    updateRecording(rec.id, {
      enhanced: { fileName, sizeBytes, sampleRate: phase.result.sampleRate, createdAt: new Date().toISOString(), settings: s, report, segments: enhancedSegs },
      lastPlayedSource: 'enhanced',
      // an older transcript may no longer match the new audio timeline
      ...(report.silenceMap && rec.transcript?.fromEnhanced ? { transcript: undefined } : {}),
    });
    goBack();
    if (auto && settings.auto.transcribe) navigate({ name: 'transcript', id: rec.id });
  };

  const discard = () => {
    if (phase.kind === 'review') discardPreview(phase.previewUri);
    setPhase({ kind: 'setup' });
  };

  return (
    <View style={{ flex: 1 }}>
      <Header
        title={`${auto ? t('auto_enhance') : t('enhance')} · ${rec.name}`}
        onBack={() => {
          if (phase.kind === 'running') token.current.cancelled = true;
          if (phase.kind === 'review') discardPreview(phase.previewUri);
          goBack();
        }}
      />
      {phase.kind === 'running' ? (
        <Running phase={phase} durationSec={rec.durationSec} onCancel={() => (token.current.cancelled = true)} />
      ) : phase.kind === 'review' ? (
        <Review rec={rec} result={phase.result} previewUri={phase.previewUri} onKeep={keep} onDiscard={discard} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
          <Txt size="sm" muted>{t('processing_local')}</Txt>
          {auto ? (
            <Section title={t('automation')}>
              <Toggle label={t('auto_detect')} value onChange={() => {}} disabled hint="✓" />
              <Toggle label={t('auto_enhance_step')} value={settings.auto.enhance} onChange={(v) => updateSettings({ auto: { ...settings.auto, enhance: v } })} />
              <Toggle label={t('auto_transcribe')} value={settings.auto.transcribe} onChange={(v) => updateSettings({ auto: { ...settings.auto, transcribe: v } })} />
            </Section>
          ) : null}

          <Section title={t('strength')}>
            <Choice<Strength>
              testID="strength"
              value={s.strength}
              onChange={(v) => setS((prev) => settingsForPreset(v, prev))}
              options={(['auto', 'light', 'balanced', 'strong', 'advanced'] as const).map((v) => ({ value: v as Strength, label: t(v) }))}
            />
            {s.strength === 'auto' ? (
              <>
                <Txt size="sm" testID="auto-hint">{t('auto_hint')}</Txt>
                <SmartCard state={smart} onRetry={() => { void analyse(); }} perSection={perSection} />
                <Toggle testID="per-section" label={t('per_section')} hint={t('per_section_hint')} value={perSection} onChange={(v) => patch({ perSection: v })} />
                <Toggle testID="steady-noise" label={t('steady_noise')} hint={t('steady_noise_hint')} value={s.steadyNoise !== false} onChange={(v) => patch({ steadyNoise: v })} />
              </>
            ) : (
              <>
                <Toggle label={t('noise_suppression')} value={s.noiseSuppression} onChange={(v) => patch({ noiseSuppression: v })} />
                <Toggle label={t('hum_removal')} value={s.humRemoval} onChange={(v) => patch({ humRemoval: v })} />
                <Toggle testID="level-speech" label={t('level_speech')} value={s.levelSpeech} onChange={(v) => patch({ levelSpeech: v })} />
              </>
            )}
            <Txt size="sm" bold>{t('situation_title')}</Txt>
            <Choice<Strength>
              testID="situation"
              value={s.strength}
              onChange={(v) => setS((prev) => settingsForPreset(v, prev))}
              options={SITUATIONS.map((v) => ({ value: v, label: t(`sit_${v}`) }))}
            />
            {isSituation(s.strength) ? <Txt size="sm" testID="situation-hint">{t(`sit_${s.strength}_hint`)}</Txt> : null}
            {s.strength === 'advanced' || isSituation(s.strength) ? (
              <>
                <LabeledSlider label={t('noise_amount')} value={s.noiseAmount} min={0.5} max={3} step={0.1} onChange={(v) => patch({ noiseAmount: v })} format={(v) => `${v.toFixed(1)}×`} disabled={!s.noiseSuppression} />
                <LabeledSlider label={t('noise_floor')} value={s.noiseFloorDb} min={-40} max={-3} step={1} onChange={(v) => patch({ noiseFloorDb: v })} format={(v) => formatDb(v, 0)} disabled={!s.noiseSuppression} />
                <LabeledSlider label={t('high_pass')} value={s.highPassHz} min={0} max={200} step={10} onChange={(v) => patch({ highPassHz: v })} format={(v) => (v === 0 ? '—' : `${v} Hz`)} />
                <LabeledSlider label={t('clarity')} value={s.clarityDb} min={0} max={8} step={0.5} onChange={(v) => patch({ clarityDb: v })} format={(v) => formatDb(v)} />
                <LabeledSlider label={t('pause_reduction')} value={s.pauseReductionDb} min={0} max={20} step={1} onChange={(v) => patch({ pauseReductionDb: v })} format={(v) => (v === 0 ? '—' : `${v} dB`)} />
                <LabeledSlider label={t('level_max_boost')} value={s.levelMaxBoostDb} min={0} max={30} step={1} onChange={(v) => patch({ levelMaxBoostDb: v })} format={(v) => `${v} dB`} disabled={!s.levelSpeech} />
              </>
            ) : null}
            <Toggle label={t('dereverb')} value={false} onChange={() => {}} disabled hint={t('not_available')} />
          </Section>

          <LoudnessSection s={s} patch={patch} />

          <Section title={t('processing_rate')}>
            <Choice
              value={rate}
              onChange={(v) => setRate(v)}
              options={[{ value: 16000 as const, label: t('rate_16') }, { value: 24000 as const, label: t('rate_24') }, { value: 48000 as const, label: t('rate_48') }]}
            />
            <Toggle label={t('remove_silence_export')} value={s.removeSilence} onChange={(v) => patch({ removeSilence: v })} />
            {s.removeSilence ? (
              <LabeledSlider label={t('keep_gap')} value={s.keepGapMs} min={100} max={1500} step={50} onChange={(v) => patch({ keepGapMs: v })} format={(v) => `${(v / 1000).toFixed(2)} s`} />
            ) : null}
          </Section>

          <LivePanel key={rate} rec={rec} pv={pv} settings={previewSettings} rate={rate} smart={smart.kind === 'ready' ? smart.analysis : null} sections={fileSections} />

          <Card style={{ borderColor: colors.primary, borderWidth: 2 }}>
            <Txt bold>{t('settings_summary')}</Txt>
            <Txt size="sm">{summary(s, rate, t)}</Txt>
            {rec.durationSec > 45 * 60 ? <Warning text={t('long_file_warning')} /> : null}
            <Button testID="start-enhance" label={auto ? t('auto_enhance') : t('start')} icon="✨" onPress={run} disabled={auto && !settings.auto.enhance} />
          </Card>

          {rec.enhanced ? (
            <Button
              kind="danger"
              label={t('delete_enhanced')}
              onPress={() => { deleteEnhanced(rec); updateRecording(rec.id, { enhanced: undefined, lastPlayedSource: 'original' }); }}
            />
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

type SmartState =
  | { kind: 'idle' }
  | { kind: 'running'; label: string; progress: number }
  | { kind: 'ready'; analysis: SmartAnalysis }
  | { kind: 'error'; message: string };

/** Smart mode: the whole recording is analysed when the screen opens; the result is shown here. */
function SmartCard({ state, onRetry, perSection }: { state: SmartState; onRetry: () => void; perSection: boolean }) {
  const { t } = useApp();
  if (state.kind === 'idle') return null;
  return (
    <Card>
      <Txt bold>{t('smart_title')}</Txt>
      {state.kind === 'running' ? <ProgressBar value={state.progress} label={state.label} /> : null}
      {state.kind === 'error' ? (
        <>
          <Warning text={state.message} />
          <Button compact kind="secondary" label={t('retry')} onPress={onRetry} />
        </>
      ) : null}
      {state.kind === 'ready' ? (
        <View testID="smart-ready" style={{ gap: 2 }}>
          <Txt size="sm" muted>{state.analysis.sampled ? t('smart_done_sampled', { parts: state.analysis.sampled.parts, min: Math.max(1, Math.round(state.analysis.sampled.seconds / 60)) }) : t('smart_done')}</Txt>
          {state.analysis.reasons.filter((x) => perSection || x.key !== 'auto_sections').map((x, i) => (
            <Txt key={i} size="sm" testID={`smart-${x.key}`}>{`• ${t(x.key, x.vars)}`}</Txt>
          ))}
          {state.analysis.humHz ? <Txt size="sm">{`• ${t('smart_hum', { hz: state.analysis.humHz })}`}</Txt> : null}
        </View>
      ) : null}
    </Card>
  );
}

/** Average spectrum of the previewed part, original (grey) behind enhanced (blue), log frequency. */
function SpectrumChart({ original, enhanced, height = 72 }: { original: Spectrum; enhanced: Spectrum; height?: number }) {
  const { t, colors } = useApp();
  const all = [...original.db, ...enhanced.db].filter(Number.isFinite);
  const top = Math.max(...all);
  const range = 60; // dB shown
  const h = (db: number) => Math.max(1, Math.min(1, (db - (top - range)) / range) * height);
  const f0 = original.freqs[0], f1 = original.freqs[original.freqs.length - 1];
  const xPct = (f: number) => `${(Math.log(f / f0) / Math.log(f1 / f0)) * 100}%` as const;
  return (
    <View testID="pv-spectrum" accessible accessibilityLabel={t('pv_spectrum')} style={{ gap: 2 }}>
      <View style={{ height, flexDirection: 'row', alignItems: 'flex-end', gap: 1, direction: 'ltr', backgroundColor: colors.surface2, borderRadius: 8, overflow: 'hidden', paddingHorizontal: 2 }}>
        {original.db.map((d, i) => (
          <View key={i} style={{ flex: 1, height, justifyContent: 'flex-end' }}>
            <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: h(d), backgroundColor: colors.waveDim, borderTopLeftRadius: 1, borderTopRightRadius: 1 }} />
            <View style={{ position: 'absolute', bottom: 0, left: '20%', right: '20%', height: h(enhanced.db[i]), backgroundColor: colors.primary, borderTopLeftRadius: 1, borderTopRightRadius: 1 }} />
          </View>
        ))}
      </View>
      <View style={{ height: 14, direction: 'ltr' }}>
        {[100, 1000, 10000].filter((f) => f >= f0 && f <= f1).map((f) => (
          <Txt key={f} size="xs" muted style={{ position: 'absolute', left: xPct(f) }}>{f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`}</Txt>
        ))}
      </View>
      <Row style={{ gap: 12 }}>
        <Row style={{ gap: 4 }}><View style={{ width: 10, height: 10, backgroundColor: colors.waveDim }} /><Txt size="xs" muted>{t('original')}</Txt></Row>
        <Row style={{ gap: 4 }}><View style={{ width: 10, height: 10, backgroundColor: colors.primary }} /><Txt size="xs" muted>{t('enhanced')}</Txt></Row>
      </Row>
    </View>
  );
}

const sectionColor = (k: SectionKind, colors: ReturnType<typeof useApp>['colors']) => (k === 'whisper' ? colors.primary : k === 'far' ? colors.warn : colors.ok);

/** Where the whispered, distant and close sections are (each tuned on its own), under the timeline. */
function SectionStrip({ sections, duration }: { sections: SectionSetting[]; duration: number }) {
  const { t, colors } = useApp();
  const n = countSections(sections);
  return (
    <View testID="pv-sections" accessible accessibilityLabel={t('sec_counts_value', n)} style={{ gap: 2 }}>
      <View style={{ height: 6, backgroundColor: colors.surface2, borderRadius: 3, overflow: 'hidden', direction: 'ltr' }}>
        {duration > 0 ? sections.map((s, i) => (
          <View key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: `${(s.start / duration) * 100}%`, width: `${Math.max(0.3, ((s.end - s.start) / duration) * 100)}%`, backgroundColor: sectionColor(s.kind, colors) }} />
        )) : null}
      </View>
      <Row style={{ gap: 12 }}>
        {(['whisper', 'far', 'near'] as SectionKind[]).map((k) => (
          <Row key={k} style={{ gap: 4 }}><View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: sectionColor(k, colors) }} /><Txt size="xs" muted>{`${t(`sec_${k}`)} ${n[k]}`}</Txt></Row>
        ))}
      </Row>
    </View>
  );
}

/**
 * Live listening: the recording plays with the current settings applied as it plays (changes
 * are heard within about a second), from any point of the timeline. Original/Enhanced switches
 * instantly. The saved file is made by the full run, which can differ slightly in loudness.
 */
function LivePanel({ rec, pv, settings, rate, smart, sections }: { rec: Recording; pv: EnhancePreviewer; settings: EnhanceSettings; rate: number; smart: SmartAnalysis | null; sections: SectionSetting[] | null }) {
  const app = useApp();
  const { t, colors } = app;
  const [player, setPlayer] = useState<LivePlayer | null>(null);
  const [prep, setPrep] = useState<number | null>(0);
  const [status, setStatus] = useState({ playing: false, position: bestPreviewStart(rec.segments ?? [], rec.durationSec, 15) });
  const [which, setWhich] = useState<'original' | 'enhanced'>('enhanced');
  const [spec, setSpec] = useState<{ original: Spectrum; enhanced: Spectrum } | null>(null);
  const [gainDb, setGainDb] = useState(0);

  // the source at this rate (shared decode for short recordings), and a player for it
  useEffect(() => {
    let alive = true;
    let made: LivePlayer | null = null;
    pv.liveSource(rate, (f) => { if (alive) setPrep(f); }, () => !alive)
      .then((src) => {
        if (!alive) return;
        made = new LivePlayer(src);
        made.onError = (e) => app.showError(e);
        made.onEnded = () => setStatus((x) => ({ ...x, playing: false }));
        setPlayer(made);
        setPrep(null);
      })
      .catch((e) => { if (alive) { setPrep(null); app.showError(e); } });
    return () => { alive = false; void made?.dispose(); };
  }, [pv, rate]); // eslint-disable-line react-hooks/exhaustive-deps

  // settings (and what the analysis found) go to the player as they change
  const live = useMemo(() => {
    if (!smart) return null;
    const vad = { ...settings.vad, thresholdDb: app.settings.vadThresholdDb, whisper: app.settings.vadWhisper };
    const resolved: EnhanceSettings = settings.strength === 'auto'
      ? { ...chooseSettings({ ...settings, vad }, settings.autoMeasures ?? smart.measures).settings }
      : { ...settings, vad };
    const ctx: LiveContext = {
      segments: smart.sampled ? rec.segments ?? [] : smart.segments,
      humHz: smart.humHz,
      sections: settings.strength === 'auto' ? sections : null,
      speechRefDb: smart.measures.speechRefDb,
      inputSpeechLufs: smart.input.speechLufs,
      humHarmonics: smart.humHarmonics,
      windows: smart.windows,
    };
    return { resolved, ctx };
  }, [settings, smart, sections, rec.segments, app.settings.vadThresholdDb, app.settings.vadWhisper]);
  useEffect(() => {
    if (player && live) player.configure(live.resolved, live.ctx);
  }, [player, live]);

  // playhead, spectrum and gain while playing
  useEffect(() => {
    if (!player) return;
    let n = 0;
    const h = setInterval(() => {
      setStatus({ playing: player.playing, position: player.position() });
      if (player.playing && ++n % 4 === 0) {
        const sp = player.spectrum();
        if (sp) setSpec(sp);
        setGainDb(player.gainDb);
      }
    }, 250);
    return () => clearInterval(h);
  }, [player]);
  useEffect(() => () => { void player?.pause(); }, [player]);

  const ready = !!player && !!live;
  const toggle = () => {
    if (!player) return;
    if (player.playing) void player.pause();
    else void player.play(player.ended ? 0 : status.position);
  };
  const onTimeline = (time: number) => {
    setStatus((x) => ({ ...x, position: time }));
    if (player?.playing) void player.play(time);
    else if (player) void player.seek(time);
  };
  const switchTo = (w: 'original' | 'enhanced') => { setWhich(w); player?.setMode(w); };
  const now = sections?.find((x) => status.position >= x.start && status.position <= x.end) ?? null;

  return (
    <Section title={t('pv_title')}>
      <Txt size="sm" muted>{t('pv_hint')}</Txt>
      <View testID="pv-timeline">
        <Waveform
          peaks={rec.waveform ?? []}
          duration={rec.durationSec}
          position={status.position}
          segments={rec.segments ?? []}
          bookmarks={[]}
          onSeek={onTimeline}
          height={48}
        />
      </View>
      {sections?.length ? <SectionStrip sections={sections} duration={rec.durationSec} /> : null}
      <Row style={{ justifyContent: 'space-between', direction: 'ltr' }}>
        <Txt size="xs" muted testID="pv-range">{clock(status.position)}</Txt>
        <Txt size="xs" muted>{clock(rec.durationSec)}</Txt>
      </Row>
      {prep !== null ? <ProgressBar value={prep} label={t('pv_preparing')} /> : !live ? <Txt size="sm" muted>{t('pv_waiting')}</Txt> : null}
      <Row>
        <IconButton testID="pv-play" icon={status.playing ? '❚❚' : '▶'} label={status.playing ? t('pause') : t('play')} onPress={toggle} disabled={!ready} />
        <View style={{ flex: 1 }}>
          <Choice testID="pv-ab" value={which} onChange={switchTo} options={[{ value: 'original', label: t('original') }, { value: 'enhanced', label: t('enhanced') }]} />
        </View>
      </Row>
      {now ? (
        <Txt size="sm" testID="pv-now-section" style={{ color: sectionColor(now.kind, colors) }}>
          {t('pv_now_section', { kind: t(`sec_${now.kind}`), noise: now.noiseAmount.toFixed(1), clarity: now.clarityDb })}
        </Txt>
      ) : null}
      {spec ? <SpectrumChart original={spec.original} enhanced={spec.enhanced} /> : null}
      {ready ? (
        <Txt size="sm" muted testID="pv-summary">
          {settings.gainMode === 'target' ? t('pv_live_gain', { gain: `${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)}` }) : t('pv_live_note')}
        </Txt>
      ) : null}
    </Section>
  );
}

function summary(s: EnhanceSettings, rate: number, t: ReturnType<typeof useApp>['t']) {
  if (s.strength === 'auto') {
    return [
      `${t('strength')}: ${t('auto')}`,
      t('auto_hint'),
      s.perSection !== false ? t('per_section') : '',
      s.steadyNoise !== false ? t('steady_noise') : '',
      s.gainMode === 'target' ? `${t('target_lufs')}: ${s.targetLufs} LUFS` : `${t('manual_gain')}: ${formatDb(s.manualGainDb)} (${pct(s.manualGainDb)})`,
      `${t('limiter_ceiling')}: ${s.limiterCeilingDb} dBFS`,
      `${t('processing_rate')}: ${rate / 1000} kHz`,
      s.removeSilence ? `${t('remove_silence_export')}: ≤ ${(s.keepGapMs / 1000).toFixed(2)} s` : '',
    ].filter(Boolean).join('\n');
  }
  const parts = [
    `${t('strength')}: ${t(isSituation(s.strength) ? `sit_${s.strength}` : s.strength)}`,
    `${t('noise_suppression')}: ${s.noiseSuppression ? `${s.noiseAmount.toFixed(1)}×, ${formatDb(s.noiseFloorDb, 0)}` : '—'}`,
    `${t('high_pass')}: ${s.highPassHz ? `${s.highPassHz} Hz` : '—'}`,
    `${t('clarity')}: ${s.clarityDb ? formatDb(s.clarityDb) : '—'}`,
    `${t('pause_reduction')}: ${s.pauseReductionDb ? `${s.pauseReductionDb} dB` : '—'}`,
    `${t('level_speech')}: ${s.levelSpeech ? `≤ ${s.levelMaxBoostDb} dB` : '—'}`,
    s.gainMode === 'target' ? `${t('target_lufs')}: ${s.targetLufs} LUFS` : `${t('manual_gain')}: ${formatDb(s.manualGainDb)} (${pct(s.manualGainDb)})`,
    `${t('limiter_ceiling')}: ${s.limiterCeilingDb} dBFS`,
    `${t('processing_rate')}: ${rate / 1000} kHz`,
    s.removeSilence ? `${t('remove_silence_export')}: ≤ ${(s.keepGapMs / 1000).toFixed(2)} s` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

function LoudnessSection({ s, patch }: { s: EnhanceSettings; patch: (p: Partial<EnhanceSettings>) => void }) {
  const { t, colors, fs } = useApp();
  // null = not editing; the field then shows the current gain as a percentage
  const [pctDraft, setPctDraft] = useState<string | null>(null);
  const pctText = pctDraft ?? dbToPercent(s.manualGainDb).toFixed(0);
  const applyPct = () => {
    const n = Number(pctText.replace(',', '.').replace('%', ''));
    setPctDraft(null);
    if (!isFinite(n) || n <= -100) return;
    patch({ manualGainDb: Math.max(-24, Math.min(30, Math.round(percentToDb(n) * 10) / 10)) });
  };
  return (
    <Section title={t('loudness')}>
      <Card style={{ backgroundColor: colors.surface2 }}>
        <Txt bold>{t('levels_help_title')}</Txt>
        <Txt size="sm">{t('levels_help')}</Txt>
      </Card>
      <Choice
        value={s.gainMode}
        onChange={(v) => patch({ gainMode: v })}
        options={[{ value: 'target' as const, label: t('gain_mode_target') }, { value: 'manual' as const, label: t('gain_mode_manual') }]}
      />
      {s.gainMode === 'target' ? (
        <LabeledSlider label={t('target_lufs')} value={s.targetLufs} min={-30} max={-10} step={1} onChange={(v) => patch({ targetLufs: v })} format={(v) => `${v} LUFS`} />
      ) : (
        <>
          <LabeledSlider label={t('manual_gain')} value={s.manualGainDb} min={-12} max={24} step={0.5} onChange={(v) => patch({ manualGainDb: v })} format={(v) => `${formatDb(v)} (${pct(v)})`} />
          <Row>
            <Txt style={{ flex: 1 }}>%</Txt>
            <TextInput
              value={pctText}
              onChangeText={setPctDraft}
              onEndEditing={applyPct}
              onSubmitEditing={applyPct}
              keyboardType="numbers-and-punctuation"
              accessibilityLabel={`${t('manual_gain')} %`}
              style={{ minWidth: 100, minHeight: TOUCH, borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: space.md, color: colors.text, fontSize: fs.md, writingDirection: 'ltr' }}
            />
          </Row>
          <Txt size="sm" muted>{t('percent_note')}</Txt>
        </>
      )}
      <LabeledSlider label={t('limiter_ceiling')} value={s.limiterCeilingDb} min={-6} max={-0.5} step={0.5} onChange={(v) => patch({ limiterCeilingDb: v })} format={(v) => `${v.toFixed(1)} dBFS`} />
    </Section>
  );
}

function Running({ phase, durationSec, onCancel }: { phase: { progress: number; stage: string }; durationSec: number; onCancel: () => void }) {
  const { t } = useApp();
  useKeepAwake();
  const stageKey = (`stage_${phase.stage}` as const) as 'stage_decode' | 'stage_process' | 'stage_write' | 'stage_done';
  return (
    <View style={{ padding: space.lg, gap: space.lg }}>
      <ProgressBar value={phase.progress} label={t(stageKey)} />
      {durationSec > 45 * 60 ? <Warning text={t('long_file_warning')} /> : null}
      <Txt size="sm" muted>{t('processing_local')}</Txt>
      <Button testID="cancel-enhance" kind="danger" label={t('cancel')} onPress={onCancel} />
    </View>
  );
}

const WARN_KEY: Record<WarningCode, 'w_low_snr' | 'w_very_low_snr' | 'w_input_clipping' | 'w_gain_capped' | 'w_heavy_limiting' | 'w_no_speech_found' | 'w_strong_suppression_low_snr'> = {
  low_snr: 'w_low_snr',
  very_low_snr: 'w_very_low_snr',
  input_clipping: 'w_input_clipping',
  gain_capped: 'w_gain_capped',
  heavy_limiting: 'w_heavy_limiting',
  no_speech_found: 'w_no_speech_found',
  strong_suppression_low_snr: 'w_strong_suppression_low_snr',
};

function Review({ rec, result, previewUri, onKeep, onDiscard }: { rec: Recording; result: EnhanceResult; previewUri: string; onKeep: () => void; onDiscard: () => void }) {
  const { t, settings, colors } = useApp();
  const r = result.report;
  const [which, setWhich] = useState<'original' | 'enhanced'>('enhanced');
  const [initial] = useState(previewUri);
  const player = useAudioPlayer({ uri: initial }, { updateInterval: 200 });
  const st = useAudioPlayerStatus(player);
  const sameTimeline = !r.silenceMap;

  const switchTo = (w: 'original' | 'enhanced') => {
    if (w === which) return;
    const keep = st.currentTime;
    const playing = st.playing;
    setWhich(w);
    player.replace({ uri: w === 'enhanced' ? previewUri : audioUri(rec, 'original') });
    setTimeout(() => { if (sameTimeline) void player.seekTo(keep); if (playing) player.play(); }, 150);
  };
  useEffect(() => () => { try { player.pause(); } catch { /* released */ } }, [player]);

  const lv = (v: number, u: 'LUFS' | 'dBFS' | 'dBTP') => formatLevel(v, u);
  return (
    <View style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      <Txt size="lg" bold>{t('review')}</Txt>
      {r.warnings.length ? (
        <View style={{ gap: space.sm }}>
          <Txt bold>{t('warnings')}</Txt>
          {r.warnings.map((w) => (
            <Warning
              key={w}
              text={t(WARN_KEY[w], {
                n: r.clipping.events,
                db: w === 'gain_capped' ? formatDb(settings.enhance.maxAutoGainDb, 0) : formatDb(r.limiterMaxReductionDb),
              })}
            />
          ))}
        </View>
      ) : null}

      <Card>
        <Choice testID="ab" label={t('listening_to')} value={which} onChange={switchTo} options={[{ value: 'original', label: t('original') }, { value: 'enhanced', label: t('enhanced') }]} />
        <Row style={{ justifyContent: 'center', direction: 'ltr' }}>
          <IconButton icon="↺" label={t('back_10')} onPress={() => player.seekTo(Math.max(0, st.currentTime - 10))} />
          <IconButton testID="review-play" big icon={st.playing ? '❚❚' : '▶'} label={st.playing ? t('pause') : t('play')} onPress={() => (st.playing ? player.pause() : player.play())} />
          <IconButton icon="↻" label={t('fwd_10')} onPress={() => player.seekTo(st.currentTime + 10)} />
        </Row>
        <Txt size="sm" muted style={{ textAlign: 'center' }}>{`${clock(st.currentTime)} / ${clock(st.duration)}`}</Txt>
      </Card>

      {r.autoReasons?.length ? (
        <Section title={t('auto_chosen')}>
          {r.autoReasons.map((x, i) => (
            <Txt key={i} size="sm" testID={`reason-${x.key}`}>{`• ${t(x.key, x.vars)}`}</Txt>
          ))}
        </Section>
      ) : null}

      <Section title={t('measured')}>
        <Txt size="sm" muted>{`${t('input')} → ${t('output')}`}</Txt>
        <LevelRow label={t('speech_loudness')} a={lv(r.input.speechLufs, 'LUFS')} b={lv(r.output.speechLufs, 'LUFS')} />
        <LevelRow label={t('integrated_loudness')} a={lv(r.input.integratedLufs, 'LUFS')} b={lv(r.output.integratedLufs, 'LUFS')} />
        <LevelRow label={t('sample_peak')} a={lv(r.input.samplePeakDb, 'dBFS')} b={lv(r.output.samplePeakDb, 'dBFS')} />
        <LevelRow label={t('true_peak')} a={lv(r.input.truePeakDb, 'dBTP')} b={lv(r.output.truePeakDb, 'dBTP')} />
        <KeyValue k={t('gain_applied')} v={`${formatDb(r.appliedGainDb)} (${pct(r.appliedGainDb)})`} />
        <KeyValue k={t('snr')} v={Number.isFinite(r.snrDb) ? `${r.snrDb.toFixed(0)} dB` : '—'} />
        {r.humHz ? <Txt size="sm">{t('hum_found', { hz: r.humHz })}</Txt> : null}
        {r.whisperSections > 0 ? <KeyValue k={t('whisper_sections')} v={String(r.whisperSections)} /> : null}
        {r.sectionCounts ? <View testID="sec-counts"><KeyValue k={t('sec_counts')} v={t('sec_counts_value', r.sectionCounts)} /></View> : null}
        {r.levelerMaxBoostDb > 0.5 ? <KeyValue k={t('leveller_boost')} v={formatDb(r.levelerMaxBoostDb, 0)} /> : null}
        <KeyValue k={t('duration')} v={`${clock(r.durationSec)} → ${clock(r.outputDurationSec)}`} />
      </Section>

    </ScrollView>
      {/* the decision stays on screen while reading the levels */}
      <Row style={{ padding: space.md, gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface }}>
        <Button testID="discard-enhanced" kind="secondary" label={t('discard')} onPress={() => { player.pause(); onDiscard(); }} style={{ flex: 1 }} />
        <Button testID="keep-enhanced" label={t('keep_enhanced')} icon="✓" onPress={() => { player.pause(); onKeep(); }} style={{ flex: 1.4 }} />
      </Row>
    </View>
  );
}

/** Label on its own line, then "input → output", so nothing wraps mid-word on narrow phones. */
function LevelRow({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <View accessible accessibilityLabel={`${label}: ${a} → ${b}`} style={{ gap: 2 }}>
      <Txt size="sm" muted>{label}</Txt>
      <Row wrap style={{ direction: 'ltr' }}>
        <Txt>{a}</Txt>
        <Txt muted>→</Txt>
        <Txt bold>{b}</Txt>
      </Row>
    </View>
  );
}

function remapSegments(segs: { start: number; end: number }[], map: [number, number, number][]) {
  const out: { start: number; end: number }[] = [];
  for (const s of segs) {
    for (const [a, b, o] of map) {
      if (s.end <= a || s.start >= b) continue;
      out.push({ start: o + Math.max(0, s.start - a), end: o + Math.min(b, s.end) - a });
    }
  }
  return out;
}
