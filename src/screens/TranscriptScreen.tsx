import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useKeepAwake } from 'expo-keep-awake';
import { KeyboardAwareScrollView } from '../ui/KeyboardAwareScrollView';
import { audioUri, shareTranscript } from '../services/processing';
import { downloadModel, isModelReady, MODELS, releaseWhisper, startTranscription, type TranscribeJob } from '../services/transcription';
import { useApp } from '../state/AppContext';
import { clock, isMostlyArabic, searchTranscript, toTxt, type TranscriptSegment } from '../transcript/format';
import type { Recording } from '../types';
import { Button, Choice, Dialog, Header, IconButton, ProgressBar, Row, Section, Toggle, Txt, Warning } from '../ui/components';
import { radius, space, TOUCH } from '../ui/theme';

export const LANGS = ['auto', 'ar', 'en', 'fr', 'ur', 'hi'] as const;

export function TranscriptScreen({ id }: { id: string }) {
  const { library } = useApp();
  const rec = library.find((r) => r.id === id);
  if (!rec) return null;
  return <TranscriptView rec={rec} />;
}

function TranscriptView({ rec }: { rec: Recording }) {
  const { t, goBack, settings, updateSettings, updateRecording, showError, colors, fs, isAnalysing, getRecording } = useApp();
  const [running, setRunning] = useState<number | null>(null);
  const [live, setLive] = useState<TranscriptSegment[]>([]);
  const [redo, setRedo] = useState(false);
  const job = useRef<TranscribeJob | null>(null);
  const [waiting, setWaiting] = useState(false);
  const stopWait = useRef(false);
  const tr = settings.transcription;
  const model = MODELS.find((m) => m.id === tr.modelId) ?? MODELS[1];
  const [dl, setDl] = useState<number | null>(null);
  // bumped after a download so the file check runs again
  const [modelCheck, setModelCheck] = useState(0);
  const modelReady = useMemo(() => isModelReady(model), [model, modelCheck]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setRunning(0);
    setLive([]);
    // transcription skips pauses using the speech sections: if they are still being found
    // (in parallel, after import), wait for them here instead of blocking the button
    if (isAnalysing(rec.id)) {
      stopWait.current = false;
      setWaiting(true);
      while (isAnalysing(rec.id) && !stopWait.current) await new Promise((r) => setTimeout(r, 400));
      setWaiting(false);
      if (stopWait.current) { setRunning(null); return; }
    }
    const current = getRecording(rec.id) ?? rec;
    updateRecording(rec.id, { status: 'transcribing' });
    try {
      job.current = await startTranscription(current, { modelId: tr.modelId, language: tr.language, useEnhanced: tr.useEnhancedAudio, prompt: tr.prompt }, (p) => setRunning(p), setLive);
      const transcript = await job.current.promise;
      updateRecording(rec.id, { transcript, status: isAnalysing(rec.id) ? 'analyzing' : 'ready' });
      setRedo(false);
    } catch (e) {
      updateRecording(rec.id, { status: isAnalysing(rec.id) ? 'analyzing' : 'ready' });
      if (!(e instanceof Error && e.message === 'aborted')) showError(e);
    } finally {
      job.current = null;
      setRunning(null);
      // free the speech model (hundreds of MB) instead of keeping it loaded; it reloads next time
      releaseWhisper().catch(() => {});
    }
  };

  const download = async () => {
    setDl(0);
    try {
      await downloadModel(model, setDl);
      setModelCheck((n) => n + 1);
    } catch (e) {
      showError(e);
    } finally {
      setDl(null);
    }
  };

  const showSetup = !rec.transcript || redo;
  return (
    <View style={{ flex: 1 }}>
      <Header title={`${t('transcript')} · ${rec.name}`} onBack={() => { stopWait.current = true; void job.current?.stop(); goBack(); }} />
      {running !== null ? (
        <RunningView progress={running} live={live} waiting={waiting} onCancel={() => { stopWait.current = true; void job.current?.stop(); }} />
      ) : showSetup ? (
        <KeyboardAwareScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
            <View style={{ gap: space.lg }}>
              <Txt size="sm" muted>{t('processing_local')}</Txt>
              <Section title={t('transcript_language')}>
                <Choice testID="lang" value={tr.language} onChange={(v) => updateSettings({ transcription: { ...tr, language: v } })} options={LANGS.map((l) => ({ value: l, label: t(`lang_${l}` as 'lang_ar') }))} />
                <Txt size="sm" muted>{t('dialect_note')}</Txt>
                <Txt size="sm" muted>{t('speakers_note')}</Txt>
              </Section>
              <Section title={t('model')}>
                <Choice testID="model" value={tr.modelId} onChange={(v) => updateSettings({ transcription: { ...tr, modelId: v } })} options={MODELS.map((m) => ({ value: m.id, label: t(m.labelKey) }))} />
                {modelReady ? <Txt size="sm" style={{ color: colors.ok }}>✓ {t('downloaded')}</Txt> : dl !== null ? <ProgressBar value={dl} label={t('downloading')} /> : (
                  <>
                    <Txt size="sm" muted>{t('model_download_note')}</Txt>
                    <Button testID="download-model" kind="secondary" label={`${t('download')} (${model.sizeMB} MB)`} onPress={download} />
                  </>
                )}
              </Section>
              <Section title={t('transcription')}>
                <Toggle testID="use-enhanced" label={t('use_enhanced_audio')} value={tr.useEnhancedAudio} onChange={(v) => updateSettings({ transcription: { ...tr, useEnhancedAudio: v } })} disabled={!rec.enhanced} />
                <Txt>{t('prompt')}</Txt>
                <TextInput
                  value={tr.prompt}
                  onChangeText={(v) => updateSettings({ transcription: { ...tr, prompt: v } })}
                  placeholder={t('prompt_hint')}
                  placeholderTextColor={colors.textMuted}
                  multiline
                  accessibilityLabel={t('prompt')}
                  style={{ minHeight: TOUCH * 1.5, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: space.md, color: colors.text, fontSize: fs.md, textAlign: 'auto' }}
                />
              </Section>
              <Button testID="start-transcribe" label={t('transcribe')} icon="📝" onPress={start} disabled={!modelReady} />
              {rec.transcript ? <Button kind="ghost" label={t('cancel')} onPress={() => setRedo(false)} /> : null}
            </View>
        </KeyboardAwareScrollView>
      ) : (
        <TranscriptBody rec={rec} onRedo={() => setRedo(true)} />
      )}
    </View>
  );
}

/** Progress, and the text found so far (newest at the bottom, followed while it grows). */
function RunningView({ progress, live, waiting, onCancel }: { progress: number; live: TranscriptSegment[]; waiting: boolean; onCancel: () => void }) {
  const { t, colors, fs } = useApp();
  useKeepAwake();
  const list = useRef<FlatList<TranscriptSegment>>(null);
  return (
    <View style={{ flex: 1, padding: space.lg, gap: space.md }}>
      <ProgressBar value={waiting ? 0 : progress} label={waiting ? t('transcribe_wait_analysis') : t('stage_transcribe')} />
      <Txt size="sm" muted testID="live-status">{live.length ? t('live_found', { n: live.length, time: clock(live[live.length - 1].end) }) : t('live_waiting')}</Txt>
      <FlatList
        ref={list}
        testID="live-segments"
        data={live}
        keyExtractor={(s) => s.id}
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: space.sm, paddingBottom: space.md }}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => {
          const rtl = isMostlyArabic(item.text);
          return (
            <View testID={`live-${item.id}`} style={{ padding: space.md, borderRadius: radius, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, gap: space.xs }}>
              <Txt size="xs" muted style={{ direction: 'ltr' }}>{`${clock(item.start)} – ${clock(item.end)}`}</Txt>
              <Txt size="lg" style={{ writingDirection: rtl ? 'rtl' : 'ltr', textAlign: rtl ? 'right' : 'left', lineHeight: fs.lg * 1.6 }}>{item.text}</Txt>
            </View>
          );
        }}
      />
      <Txt size="xs" muted>{t('processing_local')}</Txt>
      <Button kind="danger" label={t('cancel')} onPress={onCancel} />
    </View>
  );
}

function TranscriptBody({ rec, onRedo }: { rec: Recording; onRedo: () => void }) {
  const { t, settings, updateSettings, updateRecording, showError, colors, fs } = useApp();
  const transcript = rec.transcript!;
  const src = transcript.fromEnhanced && rec.enhanced ? 'enhanced' : 'original';
  const [initial] = useState(() => audioUri(rec, src));
  const player = useAudioPlayer({ uri: initial }, { updateInterval: 150 });
  const status = useAudioPlayerStatus(player);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<TranscriptSegment | null>(null);
  const [copied, setCopied] = useState(false);
  const [more, setMore] = useState(false);
  const matches = useMemo(() => new Set(searchTranscript(transcript, query)), [transcript, query]);
  const visible = query.trim() ? transcript.segments.filter((s) => matches.has(s.id)) : transcript.segments;
  const flagged = transcript.segments.filter((s) => s.flag && s.flag !== 'edited').length;

  const playSeg = (s: TranscriptSegment) => {
    void player.seekTo(s.start);
    player.play();
  };
  useEffect(() => () => { try { player.pause(); } catch { /* released */ } }, [player]);

  const saveEdit = (text: string) => {
    if (!editing) return;
    updateRecording(rec.id, (r) => ({
      transcript: r.transcript && { ...r.transcript, segments: r.transcript.segments.map((s) => (s.id === editing.id ? { ...s, text, flag: 'edited', edited: true } : s)) },
    }));
    setEditing(null);
  };

  const langName = (code: string) => (LANGS as readonly string[]).includes(code) ? t(`lang_${code}` as 'lang_ar') : code;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: space.lg, gap: space.sm }}>
        <Txt size="sm" muted>{t('detected_language', { lang: langName(transcript.language) })} · {t('transcript_from', { src: t(src), model: transcript.model })}</Txt>
        {flagged ? <Warning text={`${t('uncertain')}: ${flagged}`} /> : null}
        {transcript.removedSilencePhrases ? (
          <Txt size="sm" muted testID="removed-silence">{t(transcript.segments.length ? 'silence_phrases_removed' : 'silence_phrases_only', { n: transcript.removedSilencePhrases })}</Txt>
        ) : null}
        <TextInput
          testID="search"
          value={query}
          onChangeText={setQuery}
          placeholder={t('search')}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel={t('search')}
          style={{ minHeight: TOUCH, borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: space.md, color: colors.text, fontSize: fs.md, textAlign: 'auto' }}
        />
        {query.trim() ? <Txt size="sm" muted>{t('results', { n: matches.size })}</Txt> : <Txt size="sm" muted>{t('tap_to_play')}</Txt>}
      </View>
      <FlatList
        data={visible}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm, paddingBottom: space.xl }}
        ListEmptyComponent={<Txt muted>{t('no_transcript')}</Txt>}
        renderItem={({ item }) => {
          const active = status.currentTime >= item.start && status.currentTime < item.end;
          const rtlText = isMostlyArabic(item.text);
          const warn = item.flag && item.flag !== 'edited';
          return (
            <Pressable
              testID={`seg-${item.id}`}
              onPress={() => playSeg(item)}
              onLongPress={() => setEditing(item)}
              accessibilityRole="button"
              accessibilityLabel={`${clock(item.start)}. ${item.text}${warn ? `. ${t('uncertain')}` : ''}`}
              accessibilityHint={t('tap_to_play')}
              style={{
                padding: space.md, borderRadius: radius, gap: space.xs,
                backgroundColor: active ? colors.speech : colors.surface,
                borderWidth: warn ? 2 : 1, borderColor: warn ? colors.warn : colors.border,
                borderStyle: warn ? 'dashed' : 'solid',
              }}
            >
              <Row style={{ justifyContent: 'space-between', direction: 'ltr' }}>
                <Txt size="xs" muted>{`${clock(item.start)} – ${clock(item.end)}`}</Txt>
                {item.flag ? <Txt size="xs" style={{ color: item.flag === 'edited' ? colors.textMuted : colors.warn }}>{item.flag === 'edited' ? t('flag_edited') : t('uncertain')}</Txt> : null}
              </Row>
              <Txt size="lg" selectable style={{ writingDirection: rtlText ? 'rtl' : 'ltr', textAlign: rtlText ? 'right' : 'left', lineHeight: fs.lg * 1.6 }}>{item.text}</Txt>
              {warn ? <Txt size="xs" style={{ color: colors.warn }}>{t(`flag_${item.flag}` as 'flag_low_audio_quality')}</Txt> : null}
            </Pressable>
          );
        }}
      />
      {/* one compact row so most of the screen stays for the transcript */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm, borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, direction: 'ltr' }}>
        <IconButton testID="tr-play" icon={status.playing ? '❚❚' : '▶'} label={status.playing ? t('pause') : t('play')} onPress={() => (status.playing ? player.pause() : player.play())} />
        <Txt size="sm" muted style={{ flex: 1 }}>{`${clock(status.currentTime)} / ${clock(status.duration)}`}</Txt>
        <Button compact kind="secondary" testID="tr-copy" label={copied ? t('copied') : t('copy')} onPress={async () => { await Clipboard.setStringAsync(toTxt(transcript, false)); setCopied(true); setTimeout(() => setCopied(false), 1500); }} />
        <Button compact kind="secondary" testID="tr-more" label="⋯" accessibilityHint={t('export_transcript')} onPress={() => setMore(true)} />
      </View>
      {more ? (
        <Dialog onClose={() => setMore(false)}>
          <Txt bold>{t('export_transcript')}</Txt>
          <Choice testID="tr-format" label={t('transcript_format')} value={settings.export.transcriptFormat} onChange={(v) => updateSettings({ export: { transcriptFormat: v } })} options={(['txt', 'srt', 'vtt', 'json'] as const).map((f) => ({ value: f, label: f.toUpperCase() }))} />
          <Button testID="tr-export" label={t('export')} onPress={() => { setMore(false); shareTranscript(rec, transcript, settings.export.transcriptFormat).catch(showError); }} />
          <Button kind="secondary" testID="tr-redo" label={t('transcribe')} onPress={() => { setMore(false); onRedo(); }} />
          <Button kind="danger" testID="tr-delete" label={t('delete_transcript')} onPress={() => { setMore(false); updateRecording(rec.id, { transcript: undefined }); }} />
          <Button kind="ghost" label={t('close')} onPress={() => setMore(false)} />
        </Dialog>
      ) : null}
      {editing ? <EditModal key={editing.id} seg={editing} onClose={() => setEditing(null)} onSave={saveEdit} /> : null}
    </View>
  );
}

function EditModal({ seg, onClose, onSave }: { seg: TranscriptSegment; onClose: () => void; onSave: (text: string) => void }) {
  const { t, colors, fs } = useApp();
  const [text, setText] = useState(seg.text);
  const rtl = isMostlyArabic(text);
  return (
    <Dialog onClose={onClose}>
          <Txt bold>{`${t('edit')} · ${clock(seg.start)}`}</Txt>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            accessibilityLabel={t('edit')}
            style={{ minHeight: 120, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: space.md, color: colors.text, fontSize: fs.lg, writingDirection: rtl ? 'rtl' : 'ltr', textAlign: rtl ? 'right' : 'left', textAlignVertical: 'top' }}
          />
          <Row>
            <Button kind="ghost" label={t('cancel')} onPress={onClose} style={{ flex: 1 }} />
            <Button testID="seg-save" label={t('save')} onPress={() => onSave(text.trim())} style={{ flex: 1 }} />
          </Row>
    </Dialog>
  );
}
