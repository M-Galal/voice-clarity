import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { nextSegmentStart, previousSegmentStart, skipSilenceTarget } from '../dsp/vad';
import { audioUri, shareAudio, shareTranscript } from '../services/processing';
import { formatBytes, useApp } from '../state/AppContext';
import { clock } from '../transcript/format';
import type { Bookmark, Recording } from '../types';
import { Button, Card, Choice, Header, IconButton, KeyValue, Row, Section, Toggle, Txt } from '../ui/components';
import { radius, space, TOUCH } from '../ui/theme';
import { Waveform } from '../ui/Waveform';
import { statusText } from './LibraryScreen';
import { newId } from '../services/storage';

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

export function PlayerScreen({ id }: { id: string }) {
  const { library } = useApp();
  const rec = library.find((r) => r.id === id);
  if (!rec) return null;
  return <Player key={rec.id} rec={rec} />;
}

function Player({ rec }: { rec: Recording }) {
    const app = useApp();
    const { t, goBack, navigate, settings, updateSettings, updateRecording, colors } = app;
    const [source, setSource] = useState<'original' | 'enhanced'>(rec.enhanced ? rec.lastPlayedSource : 'original');
    // fixed initial source; later switches go through player.replace()
    const [initialUri] = useState(() => audioUri(rec, source));
    const player = useAudioPlayer({ uri: initialUri, name: rec.name }, { updateInterval: 100 });
    const status = useAudioPlayerStatus(player);
    const [editing, setEditing] = useState<Bookmark | null>(null);
    const [exportOpen, setExportOpen] = useState(false);
    const restored = useRef(false);
    const lastSaved = useRef(0);

    const duration = status.duration || rec.durationSec;
    const position = status.currentTime;
    const segments = (source === 'enhanced' ? rec.enhanced?.segments : rec.segments) ?? [];
    // bookmarks are stored on the original timeline; hide them on a silence-shortened copy
    const bookmarksVisible = source === 'original' || !rec.enhanced?.report.silenceMap;
    const bookmarks = useMemo(() => [...rec.bookmarks].sort((a, b) => a.time - b.time), [rec.bookmarks]);

    // restore position once loaded
    useEffect(() => {
      if (status.isLoaded && !restored.current) {
        restored.current = true;
        player.setPlaybackRate(settings.playbackRate, 'high');
        if (rec.lastPositionSec > 0 && rec.lastPositionSec < duration - 1) player.seekTo(rec.lastPositionSec);
      }
    }, [status.isLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

    // save position every 5 s and when leaving
    useEffect(() => {
      if (Math.abs(position - lastSaved.current) >= 5) {
        lastSaved.current = position;
        updateRecording(rec.id, { lastPositionSec: position, lastPlayedSource: source });
      }
    }, [position]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => () => {
      try { updateRecording(rec.id, { lastPositionSec: player.currentTime, lastPlayedSource: source }); } catch { /* released */ }
    }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

    // skip-silence playback
    useEffect(() => {
      if (!settings.skipSilence || !status.playing || segments.length === 0) return;
      const target = skipSilenceTarget(segments, position, settings.skipSilenceMinGapSec);
      if (target !== null) player.seekTo(Math.max(0, target - 0.15));
    }, [position, settings.skipSilence]); // eslint-disable-line react-hooks/exhaustive-deps

    const seek = (time: number) => player.seekTo(Math.max(0, Math.min(duration, time)));
    const toggle = () => {
      if (status.playing) player.pause();
      else {
        if (status.didJustFinish || position >= duration - 0.2) player.seekTo(0);
        player.setActiveForLockScreen(true, { title: rec.name, artist: t('app_name') }, { showSeekBackward: true, showSeekForward: true });
        player.play();
      }
    };
    const switchSource = (s: 'original' | 'enhanced') => {
      if (s === source) return;
      const keep = position;
      const wasPlaying = status.playing;
      setSource(s);
      player.replace({ uri: audioUri(rec, s), name: rec.name });
      // same-length files: keep the spot so the two versions can be compared
      const sameTimeline = !rec.enhanced?.report.silenceMap;
      setTimeout(() => {
        if (sameTimeline) player.seekTo(keep);
        if (wasPlaying) player.play();
      }, 150);
    };

    const addBookmark = () => {
      const b: Bookmark = { id: newId(), time: Math.round(position * 10) / 10, label: t('bookmark_n', { n: rec.bookmarks.length + 1 }), createdAt: new Date().toISOString() };
      updateRecording(rec.id, (r) => ({ bookmarks: [...r.bookmarks, b] }));
      Alert.alert(t('add_bookmark'), `${b.label} · ${clock(b.time)}`);
    };
    const nextBookmark = () => { const b = bookmarks.find((x) => x.time > position + 0.3); if (b) seek(b.time); };
    const prevBookmark = () => { const b = [...bookmarks].reverse().find((x) => x.time < position - 1); if (b) seek(b.time); };

    const confirmDelete = () =>
      Alert.alert(t('delete_recording'), t('delete_confirm', { name: rec.name }), [
        { text: t('cancel'), style: 'cancel' },
        { text: t('delete'), style: 'destructive', onPress: () => { player.pause(); app.deleteRecording(rec.id); } },
      ]);

    const busy = rec.status === 'analyzing' || rec.status === 'enhancing' || rec.status === 'transcribing';

    return (
      <View style={{ flex: 1 }}>
        <Header title={rec.name} onBack={goBack} right={<IconButton icon="🗑" label={t('delete_recording')} onPress={confirmDelete} />} />
        <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
          <Card>
            <KeyValue k={t('duration')} v={clock(rec.durationSec)} />
            <KeyValue k={t('format')} v={rec.format} />
            <KeyValue k={t('size')} v={formatBytes(rec.sizeBytes)} />
            <KeyValue k={t('status')} v={statusText(rec, t)} />
            {rec.status === 'error' ? <Button kind="secondary" label={t('retry')} onPress={() => app.reanalyse(rec.id)} /> : null}
          </Card>

          {rec.enhanced ? (
            <Choice
              label={t('playing_from')}
              value={source}
              onChange={switchSource}
              options={[{ value: 'original', label: t('original') }, { value: 'enhanced', label: t('enhanced') }]}
            />
          ) : null}

          <Waveform
            peaks={source === 'original' ? rec.waveform ?? [] : []}
            duration={duration}
            position={position}
            segments={segments}
            bookmarks={bookmarksVisible ? bookmarks : []}
            onSeek={seek}
          />
          <Row style={{ justifyContent: 'space-between', direction: 'ltr' }}>
            <Txt size="sm" muted>{clock(position)}</Txt>
            <Txt size="sm" muted>{t('speech_count', { n: segments.length })}</Txt>
            <Txt size="sm" muted>{clock(duration)}</Txt>
          </Row>
          {status.error ? <Txt style={{ color: colors.danger }}>{status.error}</Txt> : null}

          <Row style={{ justifyContent: 'space-between', direction: 'ltr' }}>
            <IconButton icon="⏮" label={t('prev_speech')} onPress={() => { const s = previousSegmentStart(segments, position); if (s !== null) seek(s); }} disabled={!segments.length} />
            <IconButton icon="↺" label={t('back_10')} onPress={() => seek(position - 10)} />
            <IconButton big icon={status.playing ? '❚❚' : '▶'} label={status.playing ? t('pause') : t('play')} onPress={toggle} disabled={!status.isLoaded} />
            <IconButton icon="↻" label={t('fwd_10')} onPress={() => seek(position + 10)} />
            <IconButton icon="⏭" label={t('next_speech')} onPress={() => { const s = nextSegmentStart(segments, position); if (s !== null) seek(s); }} disabled={!segments.length} />
          </Row>
          <Row style={{ justifyContent: 'center', direction: 'ltr' }}>
            <IconButton icon="◀︎⚑" label={t('prev_bookmark')} onPress={prevBookmark} disabled={!bookmarks.length || !bookmarksVisible} />
            <Button label={t('add_bookmark')} icon="⚑" kind="secondary" onPress={addBookmark} disabled={source === 'enhanced' && !bookmarksVisible} />
            <IconButton icon="⚑▶︎" label={t('next_bookmark')} onPress={nextBookmark} disabled={!bookmarks.length || !bookmarksVisible} />
          </Row>

          <Choice
            label={t('speed')}
            value={settings.playbackRate}
            onChange={(v) => { updateSettings({ playbackRate: v }); player.setPlaybackRate(v, 'high'); }}
            options={SPEEDS.map((s) => ({ value: s, label: `${s}×` }))}
          />
          <Toggle label={t('skip_silence')} value={settings.skipSilence} onChange={(v) => updateSettings({ skipSilence: v })} hint={`${t('silence_gap')} ${settings.skipSilenceMinGapSec} s`} />

          <Row wrap>
            <Button label={t('auto_enhance')} icon="✨" onPress={() => { player.pause(); navigate({ name: 'enhance', id: rec.id, auto: true }); }} disabled={busy} style={{ flexGrow: 1 }} />
            <Button label={t('enhance')} icon="🎚" kind="secondary" onPress={() => { player.pause(); navigate({ name: 'enhance', id: rec.id }); }} disabled={busy} style={{ flexGrow: 1 }} />
            <Button label={t('transcript')} icon="📝" kind="secondary" onPress={() => { player.pause(); navigate({ name: 'transcript', id: rec.id }); }} disabled={busy && rec.status !== 'transcribing'} style={{ flexGrow: 1 }} />
            <Button label={t('export')} icon="⇪" kind="secondary" onPress={() => setExportOpen(true)} style={{ flexGrow: 1 }} />
          </Row>

          <Section title={t('bookmarks')}>
            {bookmarks.length === 0 ? <Txt muted>{t('no_bookmarks')}</Txt> : null}
            {bookmarks.map((b) => (
              <Row key={b.id} style={{ minHeight: TOUCH }}>
                <Pressable accessibilityRole="button" accessibilityLabel={`${b.label}, ${clock(b.time)}`} onPress={() => seek(b.time)} style={{ flex: 1, minHeight: TOUCH, justifyContent: 'center' }}>
                  <Txt>{b.label}</Txt>
                  <Txt size="sm" muted>{clock(b.time)}</Txt>
                </Pressable>
                <IconButton icon="✎" label={`${t('edit')} ${b.label}`} onPress={() => setEditing(b)} />
                <IconButton icon="✕" label={`${t('delete')} ${b.label}`} onPress={() => updateRecording(rec.id, (r) => ({ bookmarks: r.bookmarks.filter((x) => x.id !== b.id) }))} />
              </Row>
            ))}
          </Section>

          <Section title={t('speech_sections')}>
            <Button kind="ghost" label={t('reanalyse')} onPress={() => app.reanalyse(rec.id)} disabled={busy} accessibilityHint={t('vad_note')} />
            {segments.length === 0 ? <Txt muted>{rec.status === 'analyzing' ? t('status_analyzing') : t('w_no_speech_found')}</Txt> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, direction: 'ltr' }}>
              {segments.map((s, i) => {
                const active = position >= s.start && position < s.end;
                return (
                  <Pressable
                    key={i}
                    onPress={() => seek(s.start)}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('speech_sections')} ${i + 1}: ${clock(s.start)} – ${clock(s.end)}`}
                    style={{ paddingHorizontal: space.md, minHeight: TOUCH, justifyContent: 'center', borderRadius: radius, backgroundColor: active ? colors.primary : colors.surface2 }}
                  >
                    <Txt size="sm" style={{ color: active ? colors.onPrimary : colors.text }}>{clock(s.start)}</Txt>
                  </Pressable>
                );
              })}
            </View>
          </Section>
        </ScrollView>

        <BookmarkEditor
          bookmark={editing}
          onClose={() => setEditing(null)}
          onSave={(b) => { updateRecording(rec.id, (r) => ({ bookmarks: r.bookmarks.map((x) => (x.id === b.id ? b : x)) })); setEditing(null); }}
          duration={duration}
        />
        <Modal visible={exportOpen} transparent animationType="slide" onRequestClose={() => setExportOpen(false)}>
          <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
            <View style={{ backgroundColor: colors.surface, padding: space.lg, gap: space.md, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
              <Txt size="lg" bold>{t('export')}</Txt>
              <Txt muted>{t('export_audio')}</Txt>
              <Button kind="secondary" label={`${t('export_original')} (${rec.format})`} onPress={() => shareAudio(rec, 'original').catch(app.showError)} />
              {rec.enhanced ? <Button kind="secondary" label={t('export_enhanced')} onPress={() => shareAudio(rec, 'enhanced').catch(app.showError)} /> : <Txt size="sm" muted>{t('no_enhanced_yet')}</Txt>}
              <Txt muted>{t('export_transcript')}</Txt>
              {rec.transcript ? (
                <Row wrap>
                  {(['txt', 'srt', 'vtt', 'json'] as const).map((f) => (
                    <Button key={f} compact kind="secondary" label={f.toUpperCase()} onPress={() => shareTranscript(rec, rec.transcript!, f).catch(app.showError)} />
                  ))}
                </Row>
              ) : <Txt size="sm" muted>{t('no_transcript')}</Txt>}
              <Button kind="ghost" label={t('close')} onPress={() => setExportOpen(false)} />
            </View>
          </View>
        </Modal>
      </View>
    );
}

function parseClock(s: string): number | null {
  const parts = s.trim().split(':').map((p) => p.trim());
  if (parts.some((p) => p === '' || isNaN(Number(p)))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

function BookmarkEditor({ bookmark, onClose, onSave, duration }: { bookmark: Bookmark | null; onClose: () => void; onSave: (b: Bookmark) => void; duration: number }) {
  const { t, colors, fs } = useApp();
  const [label, setLabel] = useState('');
  const [time, setTime] = useState('');
  useEffect(() => {
    if (bookmark) { setLabel(bookmark.label); setTime(clock(bookmark.time)); }
  }, [bookmark]);
  const parsed = parseClock(time);
  const valid = label.trim().length > 0 && parsed !== null && parsed >= 0 && parsed <= duration;
  const input = { borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: space.md, color: colors.text, fontSize: fs.md, minHeight: TOUCH, textAlign: 'auto' as const };
  return (
    <Modal visible={!!bookmark} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'center', padding: space.xl, backgroundColor: 'rgba(0,0,0,0.4)' }}>
        <Card>
          <Txt size="lg" bold>{t('edit')}</Txt>
          <Txt size="sm" muted>{t('bookmark_label')}</Txt>
          <TextInput value={label} onChangeText={setLabel} style={input} accessibilityLabel={t('bookmark_label')} />
          <Txt size="sm" muted>{t('bookmark_time')}</Txt>
          <TextInput value={time} onChangeText={setTime} style={[input, { writingDirection: 'ltr' }]} keyboardType="numbers-and-punctuation" accessibilityLabel={t('bookmark_time')} />
          <Row>
            <Button kind="ghost" label={t('cancel')} onPress={onClose} style={{ flex: 1 }} />
            <Button label={t('save')} disabled={!valid} onPress={() => bookmark && parsed !== null && onSave({ ...bookmark, label: label.trim(), time: parsed })} style={{ flex: 1 }} />
          </Row>
        </Card>
      </View>
    </Modal>
  );
}
