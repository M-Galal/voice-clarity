import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useKeepAwake } from 'expo-keep-awake';
import { settingsForPreset, type EnhanceSummary as EnhanceResult, type EnhanceSettings, type Strength, type WarningCode } from '../dsp/pipeline';
import { dbToPercent, formatDb, formatLevel, percentToDb } from '../dsp/units';
import { audioUri, commitPreview, deleteEnhanced, discardPreview, EnhancePreviewer, enhanceToPreview, PREVIEW_SEC, type CancelToken } from '../services/processing';
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
  const { t, goBack, settings, updateSettings, updateRecording, showError, navigate, colors } = useApp();
  const [s, setS] = useState<EnhanceSettings>(settings.enhance);
  const [rate, setRate] = useState(settings.processingRate);
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const token = useRef<CancelToken>({ cancelled: false });

  const patch = (p: Partial<EnhanceSettings>) => setS((prev) => ({ ...prev, ...p, strength: p.strength ?? (Object.keys(p).some((k) => k !== 'gainMode' && k !== 'targetLufs' && k !== 'manualGainDb' && k !== 'removeSilence' && k !== 'keepGapMs' && k !== 'limiterCeilingDb') ? 'advanced' : prev.strength) }));

  const run = async () => {
    token.current = { cancelled: false };
    updateSettings({ enhance: s, processingRate: rate });
    updateRecording(rec.id, { status: 'enhancing' });
    setPhase({ kind: 'running', progress: 0, stage: 'decode' });
    try {
      const vadSettings = { ...s, vad: { ...s.vad, thresholdDb: settings.vadThresholdDb, whisper: settings.vadWhisper } };
      const { result, previewUri } = await enhanceToPreview(rec, vadSettings, rate, token.current, (p, stage) => setPhase({ kind: 'running', progress: p, stage }));
      setPhase({ kind: 'review', result, previewUri });
    } catch (e) {
      setPhase({ kind: 'setup' });
      showError(e);
    } finally {
      updateRecording(rec.id, { status: 'ready' });
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
              options={(['auto', 'light', 'balanced', 'strong', 'advanced'] as Strength[]).map((v) => ({ value: v, label: t(v) }))}
            />
            {s.strength === 'auto' ? (
              <Txt size="sm" testID="auto-hint">{t('auto_hint')}</Txt>
            ) : (
              <>
                <Toggle label={t('noise_suppression')} value={s.noiseSuppression} onChange={(v) => patch({ noiseSuppression: v })} />
                <Toggle label={t('hum_removal')} value={s.humRemoval} onChange={(v) => patch({ humRemoval: v })} />
                <Toggle testID="level-speech" label={t('level_speech')} value={s.levelSpeech} onChange={(v) => patch({ levelSpeech: v })} />
              </>
            )}
            {s.strength === 'advanced' ? (
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

          <PreviewPanel rec={rec} settings={s} rate={rate} />

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

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'working'; label: string; progress?: number }
  | { kind: 'ready'; originalUri: string; enhancedUri: string; report: EnhanceResult['report'] };

/**
 * Listen to a 15 s part processed with the current settings before running the whole file.
 * After the first preview, any settings change renders a new one (debounced).
 */
function PreviewPanel({ rec, settings, rate }: { rec: Recording; settings: EnhanceSettings; rate: number }) {
  const app = useApp();
  const { t } = app;
  const [pv] = useState(() => new EnhancePreviewer(rec));
  useEffect(() => () => pv.dispose(), [pv]);
  const maxStart = Math.max(0, Math.floor(rec.durationSec - PREVIEW_SEC));
  const [start, setStart] = useState(() => Math.min(maxStart, bestPreviewStart(rec.segments ?? [], rec.durationSec, PREVIEW_SEC)));
  const [state, setState] = useState<PreviewState>({ kind: 'idle' });
  const [which, setWhich] = useState<'original' | 'enhanced'>('enhanced');
  const [auto, setAuto] = useState(false);
  const player = useAudioPlayer(null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const gen = useRef(0);
  useEffect(() => () => { try { player.pause(); } catch { /* released */ } }, [player]);
  // loop the 15 s part so it can be heard while settings change
  useEffect(() => {
    if (status.didJustFinish) { void player.seekTo(0); player.play(); }
  }, [status.didJustFinish]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderNow = async () => {
    const my = ++gen.current;
    const stale = () => my !== gen.current;
    try {
      setState({ kind: 'working', label: t('pv_preparing'), progress: 0 });
      await pv.prepare(rate, (f) => { if (!stale()) setState({ kind: 'working', label: t('pv_preparing'), progress: f }); }, stale);
      if (stale()) return;
      setState({ kind: 'working', label: t('pv_rendering') });
      const vad = { ...settings, vad: { ...settings.vad, thresholdDb: app.settings.vadThresholdDb, whisper: app.settings.vadWhisper } };
      const r = await pv.render(start, vad, stale);
      if (stale()) return;
      const wasPlaying = player.playing;
      const pos = player.currentTime;
      player.replace({ uri: which === 'enhanced' ? r.enhancedUri : r.originalUri, name: rec.name });
      setTimeout(() => {
        if (pos > 0) void player.seekTo(pos);
        if (wasPlaying) player.play();
      }, 150);
      setState({ kind: 'ready', ...r });
      setAuto(true);
    } catch (e) {
      if (stale()) return;
      setState({ kind: 'idle' });
      app.showError(e);
    }
  };

  // after the first preview, follow every settings change
  useEffect(() => {
    if (!auto) return;
    const h = setTimeout(() => { void renderNow(); }, 600);
    return () => clearTimeout(h);
  }, [settings, rate, start]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchTo = (w: 'original' | 'enhanced') => {
    if (w === which || state.kind !== 'ready') { setWhich(w); return; }
    const pos = player.currentTime;
    const wasPlaying = player.playing;
    setWhich(w);
    player.replace({ uri: w === 'enhanced' ? state.enhancedUri : state.originalUri, name: rec.name });
    setTimeout(() => { void player.seekTo(pos); if (wasPlaying) player.play(); }, 150);
  };

  const r = state.kind === 'ready' ? state.report : null;
  return (
    <Section title={t('pv_title')}>
      <Txt size="sm" muted>{t('pv_hint')}</Txt>
      {maxStart > 0 ? (
        <LabeledSlider
          testID="pv-start"
          label={t('pv_part')}
          value={start}
          min={0}
          max={maxStart}
          step={1}
          onChange={setStart}
          format={(v) => `${clock(v)} – ${clock(Math.min(rec.durationSec, v + PREVIEW_SEC))}`}
        />
      ) : null}
      {state.kind === 'working' ? (
        <ProgressBar value={state.progress ?? 0.5} label={state.label} />
      ) : (
        <Button testID="pv-render" kind={state.kind === 'ready' ? 'secondary' : 'primary'} icon="🎧" label={state.kind === 'ready' ? t('pv_update') : t('pv_listen')} onPress={() => { void renderNow(); }} />
      )}
      {state.kind === 'ready' || (state.kind === 'working' && auto) ? (
        <>
          <Row>
            <IconButton
              testID="pv-play"
              icon={status.playing ? '❚❚' : '▶'}
              label={status.playing ? t('pause') : t('play')}
              onPress={() => (status.playing ? player.pause() : player.play())}
              disabled={state.kind !== 'ready'}
            />
            <View style={{ flex: 1 }}>
              <Choice
                testID="pv-ab"
                value={which}
                onChange={switchTo}
                options={[{ value: 'original', label: t('original') }, { value: 'enhanced', label: t('enhanced') }]}
              />
            </View>
          </Row>
          {r ? (
            <Txt size="sm" muted testID="pv-summary">
              {t('pv_result', { gain: `${r.appliedGainDb >= 0 ? '+' : ''}${r.appliedGainDb.toFixed(1)}`, lufs: Number.isFinite(r.output.speechLufs) ? r.output.speechLufs.toFixed(1) : '—' })}
              {settings.strength === 'auto' ? `\n${summary(r.appliedSettings, rate, t)}` : ''}
            </Txt>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function summary(s: EnhanceSettings, rate: number, t: ReturnType<typeof useApp>['t']) {
  if (s.strength === 'auto') {
    return [
      `${t('strength')}: ${t('auto')}`,
      t('auto_hint'),
      s.gainMode === 'target' ? `${t('target_lufs')}: ${s.targetLufs} LUFS` : `${t('manual_gain')}: ${formatDb(s.manualGainDb)} (${pct(s.manualGainDb)})`,
      `${t('limiter_ceiling')}: ${s.limiterCeilingDb} dBFS`,
      `${t('processing_rate')}: ${rate / 1000} kHz`,
      s.removeSilence ? `${t('remove_silence_export')}: ≤ ${(s.keepGapMs / 1000).toFixed(2)} s` : '',
    ].filter(Boolean).join('\n');
  }
  const parts = [
    `${t('strength')}: ${t(s.strength)}`,
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
