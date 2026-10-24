import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { nextSegmentStart, previousSegmentStart, skipSilenceTarget } from '../dsp/vad';
import { audioUri, shareAudio, shareTranscript } from '../services/processing';
import { formatBytes, useApp } from '../state/AppContext';
import { clock } from '../transcript/format';
import type { Bookmark, Recording } from '../types';
import { Button, Card, Choice, Dialog, Header, IconButton, KeyValue, LabeledSlider, Row, Section, Toggle, Txt } from '../ui/components';
import { clampRate, formatSkip, RATE_MAX, RATE_MIN, RATE_PRESETS, shortSkip } from '../playback/controls';
import { radius, space, TOUCH } from '../ui/theme';
import { Waveform } from '../ui/Waveform';
import { statusText } from './LibraryScreen';
import { newId } from '../services/storage';
import { secureFolderLikely } from '../services/playlist';
import { stepIndex } from '../playlist/filter';


export function PlayerScreen({ id, queueIndex, autoplay }: { id: string; queueIndex?: number; autoplay?: boolean }) {
  const { library } = useApp();
  const rec = library.find((r) => r.id === id);
  if (!rec) return null;
  return <Player key={rec.id} rec={rec} queueIndex={queueIndex} autoplay={autoplay} />;
}

function Player({ rec, queueIndex, autoplay }: { rec: Recording; queueIndex?: number; autoplay?: boolean }) {
    const app = useApp();
    const { t, goBack, navigate, settings, updateSettings, updateRecording, colors, queue, queueOpening, playFromQueue } = app;
    const inQueue = queue && queueIndex !== undefined && queue[queueIndex] ? queueIndex : null;
    const prevIndex = inQueue !== null ? stepIndex(inQueue, queue!.length, -1) : null;
    const nextIndex = inQueue !== null ? stepIndex(inQueue, queue!.length, 1) : null;
    const openQueue = (i: number | null, play: boolean) => {
      if (i === null || queueOpening !== null) return;
      player.pause();
      void playFromQueue(null, i, { replace: true, autoplay: play });
    };
    const [source, setSource] = useState<'original' | 'enhanced'>(rec.enhanced ? rec.lastPlayedSource : 'original');
    // fixed initial source; later switches go through player.replace()
    const [initialUri] = useState(() => audioUri(rec, source));
    const player = useAudioPlayer({ uri: initialUri, name: rec.name }, { updateInterval: 100 });
    const status = useAudioPlayerStatus(player);
    const [mountedAt] = useState(() => Date.now());

    // Diagnostics, and one retry: if the player has not loaded the source after 5 s, the source is
    // set again. (Seen once on the emulator with a folder file; the cause is not known yet.)
    useEffect(() => {
      if (status.isLoaded) console.log(`[VC] player loaded ${rec.format}${rec.external ? ' (folder)' : ''} in ${Date.now() - mountedAt} ms`);
    }, [status.isLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
      if (status.error) console.warn(`[VC] player error ${rec.format}: ${status.error}`);
    }, [status.error]); // eslint-disable-line react-hooks/exhaustive-deps
    const retried = useRef(false);
    useEffect(() => {
      if (status.isLoaded || retried.current) return;
      const h = setTimeout(() => {
        if (player.isLoaded || retried.current) return;
        retried.current = true;
        console.warn(`[VC] player not loaded after 5 s, setting the source again (${rec.external ? 'folder' : 'app'} file)`);
        player.replace({ uri: audioUri(rec, source), name: rec.name });
      }, 5000);
      return () => clearTimeout(h);
    }, [status.isLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
    const [editing, setEditing] = useState<Bookmark | null>(null);
    const [exportOpen, setExportOpen] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const restored = useRef(false);
    const lastSaved = useRef(0);

    const duration = status.duration || rec.durationSec;
    // While paused the player only reports its position when it jumps; show the requested
    // position right away so the time label and playhead follow every tap.
    const [pausedAt, setPausedAt] = useState<number | null>(null);
    const position = pausedAt !== null && !status.playing ? pausedAt : status.currentTime;
    const segments = (source === 'enhanced' ? rec.enhanced?.segments : rec.segments) ?? [];
    // bookmarks are stored on the original timeline; hide them on a silence-shortened copy
    const bookmarksVisible = source === 'original' || !rec.enhanced?.report.silenceMap;
    const bookmarks = useMemo(() => [...rec.bookmarks].sort((a, b) => a.time - b.time), [rec.bookmarks]);

    // restore position once loaded
    useEffect(() => {
      if (status.isLoaded && !restored.current) {
        restored.current = true;
        // 'medium' = AVFoundation timeDomain on iOS (voice-oriented, 1/32x-32x); ignored on Android
        player.setPlaybackRate(clampRate(settings.playbackRate), 'medium');
        if (rec.lastPositionSec > 0 && rec.lastPositionSec < duration - 1) player.seekTo(rec.lastPositionSec);
        if (autoplay) {
          player.setActiveForLockScreen(true, { title: rec.name, artist: t('app_name') }, { showSeekBackward: true, showSeekForward: true });
          player.play();
        }
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

    // play list: start the next file when this one ends
    useEffect(() => {
      if (status.didJustFinish && settings.playlist.autoNext && nextIndex !== null) openQueue(nextIndex, true);
    }, [status.didJustFinish]); // eslint-disable-line react-hooks/exhaustive-deps

    // Relative jumps (±10 s, next/previous) start from the last requested position for a moment
    // after a seek, because the reported position lags by up to one status update.
    const lastSeek = useRef({ to: 0, at: 0 });
    const here = () => (Date.now() - lastSeek.current.at < 600 ? lastSeek.current.to : position);
    const units = { s: t('unit_s'), min: t('unit_min'), h: t('unit_h') };
    const setRate = (v: number) => {
      const r = clampRate(v);
      updateSettings({ playbackRate: r });
      player.setPlaybackRate(r, 'medium');
    };
    const seek = (time: number) => {
      // stop just short of the end: seeking onto the last sample puts the player in its
      // "ended" state, where later jumps back are not reported until playback resumes
      const to = Math.max(0, Math.min(Math.max(0, duration - 0.25), time));
      lastSeek.current = { to, at: Date.now() };
      setPausedAt(to);
      player.seekTo(to);
    };
    const toggle = () => {
      if (status.playing) { setPausedAt(null); player.pause(); }
      else {
        if (status.didJustFinish || position >= duration - 0.3) seek(0);
        setPausedAt(null);
        player.setActiveForLockScreen(true, { title: rec.name, artist: t('app_name') }, { showSeekBackward: true, showSeekForward: true });
        player.play();
      }
    };
    const switchSource = (s: 'original' | 'enhanced') => {
      if (s === source) return;
      const keep = position;
      const wasPlaying = status.playing;
      setSource(s);
      setPausedAt(null);
      player.replace({ uri: audioUri(rec, s), name: rec.name });
      // same-length files: keep the spot so the two versions can be compared
      const sameTimeline = !rec.enhanced?.report.silenceMap;
      setTimeout(() => {
        if (sameTimeline) player.seekTo(keep);
        if (wasPlaying) player.play();
      }, 150);
    };

    const addBookmark = () => {
      const b: Bookmark = { id: newId(), time: Math.round(here() * 10) / 10, label: t('bookmark_n', { n: rec.bookmarks.length + 1 }), createdAt: new Date().toISOString() };
      updateRecording(rec.id, (r) => ({ bookmarks: [...r.bookmarks, b] }));
      const msg = t('bookmark_added', { label: b.label, time: clock(b.time) });
      setNotice(msg);
      AccessibilityInfo.announceForAccessibility(msg);
      setTimeout(() => setNotice(null), 2500);
    };
    const nextBookmark = () => { const p = here(); const b = bookmarks.find((x) => x.time > p + 0.3); if (b) seek(b.time); };
    const prevBookmark = () => { const p = here(); const b = [...bookmarks].reverse().find((x) => x.time < p - 1); if (b) seek(b.time); };

    const confirmDelete = () =>
      rec.external && rec.sourceUri
        ? Alert.alert(t('delete_recording'), t('delete_external_choice', { file: rec.originalFileName }), [
            { text: t('cancel'), style: 'cancel' },
            { text: t('remove_from_app'), onPress: () => { player.pause(); app.deleteRecording(rec.id); } },
            {
              text: t('delete_file'),
              style: 'destructive',
              onPress: async () => {
                player.pause();
                if (await app.deleteFolderFile(rec.sourceUri!)) goBack();
              },
            },
          ])
        : Alert.alert(t('delete_recording'), t('delete_confirm', { name: rec.name }), [
            { text: t('cancel'), style: 'cancel' },
            { text: t('delete'), style: 'destructive', onPress: () => { player.pause(); app.deleteRecording(rec.id); } },
          ]);

    const sendToSecureFolder = (which: 'original' | 'enhanced') =>
      Alert.alert(t('secure_folder'), t('secure_folder_steps'), [
        { text: t('cancel'), style: 'cancel' },
        { text: t('continue'), onPress: () => { shareAudio(rec, which, t('secure_folder')).catch(app.showError); } },
      ]);

    const busy = rec.status === 'analyzing' || rec.status === 'enhancing' || rec.status === 'transcribing';

    return (
      <View style={{ flex: 1 }}>
        <Header title={rec.name} onBack={goBack} right={<IconButton testID="delete-recording" icon="🗑" label={t('delete_recording')} onPress={confirmDelete} />} />
        <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
          <Card>
            <KeyValue k={t('duration')} v={clock(rec.durationSec)} />
            <KeyValue k={t('format')} v={rec.format} />
            <KeyValue k={t('size')} v={formatBytes(rec.sizeBytes)} />
            <KeyValue k={t('status')} v={statusText(rec, t)} />
            {rec.external ? <Txt testID="in-folder" size="sm" muted>{t('in_folder')}</Txt> : null}
            {rec.status === 'error' && rec.error && rec.error !== 'interrupted' ? (
              <Txt size="sm" testID="error-detail" style={{ color: colors.danger }}>{`${t('err_decode')} (${rec.error})`}</Txt>
            ) : null}
            {rec.status === 'error' ? <Button testID="retry" kind="secondary" label={t('retry')} onPress={() => app.reanalyse(rec.id)} /> : null}
          </Card>

          {inQueue !== null ? (
            <Row style={{ justifyContent: 'space-between', direction: 'ltr' }}>
              <IconButton testID="pl-prev" icon="⏪" label={t('pl_prev')} onPress={() => openQueue(prevIndex, status.playing)} disabled={prevIndex === null || queueOpening !== null} />
              <Txt testID="pl-track" muted>{queueOpening !== null ? t('pl_opening') : t('pl_track', { i: inQueue + 1, n: queue!.length })}</Txt>
              <IconButton testID="pl-next" icon="⏩" label={t('pl_next')} onPress={() => openQueue(nextIndex, status.playing)} disabled={nextIndex === null || queueOpening !== null} />
            </Row>
          ) : null}

          {rec.enhanced ? (
            <Choice
              testID="source"
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
            <Txt size="sm" muted testID="elapsed">{clock(position)}</Txt>
            <Txt size="sm" muted>{t('speech_count', { n: segments.length })}</Txt>
            <Txt size="sm" muted>{clock(duration)}</Txt>
          </Row>
          {status.error ? <Txt style={{ color: colors.danger }}>{status.error}</Txt> : null}

          <Row style={{ justifyContent: 'space-between', direction: 'ltr', gap: 0 }}>
            <IconButton testID="prev-speech" icon="⏮" label={t('prev_speech')} onPress={() => { const s = previousSegmentStart(segments, here()); if (s !== null) seek(s); }} disabled={!segments.length} />
            <IconButton testID="back-10" icon={`−${shortSkip(settings.skipBackSec)}`} label={t('back_by', { t: formatSkip(settings.skipBackSec, units) })} onPress={() => seek(here() - settings.skipBackSec)} />
            <IconButton testID="play-pause" big icon={status.playing ? '❚❚' : '▶'} label={status.playing ? t('pause') : t('play')} onPress={toggle} disabled={!status.isLoaded} />
            <IconButton testID="fwd-10" icon={`+${shortSkip(settings.skipForwardSec)}`} label={t('fwd_by', { t: formatSkip(settings.skipForwardSec, units) })} onPress={() => seek(here() + settings.skipForwardSec)} />
            <IconButton testID="next-speech" icon="⏭" label={t('next_speech')} onPress={() => { const s = nextSegmentStart(segments, here()); if (s !== null) seek(s); }} disabled={!segments.length} />
          </Row>
          <Row style={{ justifyContent: 'center', direction: 'ltr' }}>
            <IconButton testID="prev-bookmark" icon="◀︎⚑" label={t('prev_bookmark')} onPress={prevBookmark} disabled={!bookmarks.length || !bookmarksVisible} />
            <Button testID="add-bookmark" label={t('add_bookmark')} icon="⚑" kind="secondary" onPress={addBookmark} disabled={source === 'enhanced' && !bookmarksVisible} />
            <IconButton testID="next-bookmark" icon="⚑▶︎" label={t('next_bookmark')} onPress={nextBookmark} disabled={!bookmarks.length || !bookmarksVisible} />
          </Row>

          {notice ? <Txt testID="bookmark-notice" style={{ textAlign: 'center', color: colors.ok }}>{notice}</Txt> : null}
          <LabeledSlider
            label={t('speed')}
            value={settings.playbackRate}
            min={RATE_MIN}
            max={RATE_MAX}
            step={0.05}
            onChange={setRate}
            format={(v) => `${v.toFixed(2)}×`}
            hint={t('speed_hint')}
          />
          <Choice
            testID="speed"
            value={settings.playbackRate}
            onChange={setRate}
            options={RATE_PRESETS.map((s) => ({ value: s, label: `${s}×` }))}
          />
          <Toggle testID="skip-silence" label={t('skip_silence')} value={settings.skipSilence} onChange={(v) => updateSettings({ skipSilence: v })} hint={`${t('silence_gap')} ${settings.skipSilenceMinGapSec} s`} />

          <Row wrap>
            <Button testID="auto-enhance" label={t('auto_enhance')} icon="✨" onPress={() => { player.pause(); navigate({ name: 'enhance', id: rec.id, auto: true }); }} disabled={busy} style={{ flexGrow: 1 }} />
            <Button testID="enhance" label={t('enhance')} icon="🎚" kind="secondary" onPress={() => { player.pause(); navigate({ name: 'enhance', id: rec.id }); }} disabled={busy} style={{ flexGrow: 1 }} />
            <Button testID="transcript" label={t('transcript')} icon="📝" kind="secondary" onPress={() => { player.pause(); navigate({ name: 'transcript', id: rec.id }); }} disabled={busy && rec.status !== 'transcribing'} style={{ flexGrow: 1 }} />
            <Button testID="edit-audio" label={t('edit_audio')} icon="✂︎" kind="secondary" onPress={() => { player.pause(); navigate({ name: 'edit', id: rec.id }); }} disabled={busy} style={{ flexGrow: 1 }} />
            <Button testID="export" label={t('export')} icon="⇪" kind="secondary" onPress={() => setExportOpen(true)} style={{ flexGrow: 1 }} />
          </Row>

          <Section title={t('bookmarks')}>
            {bookmarks.length === 0 ? <Txt muted>{t('no_bookmarks')}</Txt> : null}
            {bookmarks.map((b) => (
              <Row key={b.id} style={{ minHeight: TOUCH }}>
                <Pressable accessibilityRole="button" accessibilityLabel={`${b.label}, ${clock(b.time)}`} onPress={() => seek(b.time)} style={{ flex: 1, minHeight: TOUCH, justifyContent: 'center' }}>
                  <Txt>{b.label}</Txt>
                  <Txt size="sm" muted>{clock(b.time)}</Txt>
                </Pressable>
                <IconButton testID={`edit-bm-${b.label}`} icon="✎" label={`${t('edit')} ${b.label}`} onPress={() => setEditing(b)} />
                <IconButton testID={`del-bm-${b.label}`} icon="✕" label={`${t('delete')} ${b.label}`} onPress={() => updateRecording(rec.id, (r) => ({ bookmarks: r.bookmarks.filter((x) => x.id !== b.id) }))} />
              </Row>
            ))}
          </Section>

          <Section title={t('speech_sections')}>
            <Button testID="reanalyse" kind="ghost" label={t('reanalyse')} onPress={() => app.reanalyse(rec.id)} disabled={busy} accessibilityHint={t('vad_note')} />
            {segments.length === 0 ? <Txt muted>{rec.status === 'analyzing' ? t('status_analyzing') : t('w_no_speech_found')}</Txt> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, direction: 'ltr' }}>
              {segments.map((s, i) => {
                const active = position >= s.start && position < s.end;
                return (
                  <Pressable
                    key={i}
                    onPress={() => seek(s.start)}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('speech_sections')} ${i + 1}: ${clock(s.start)} – ${clock(s.end)}${s.kind === 'whisper' ? `, ${t('whisper_tag')}` : ''}`}
                    style={{ paddingHorizontal: space.md, minHeight: TOUCH, justifyContent: 'center', borderRadius: radius, backgroundColor: active ? colors.primary : colors.surface2 }}
                  >
                    <Txt size="sm" style={{ color: active ? colors.onPrimary : colors.text }}>{s.kind === 'whisper' ? `${clock(s.start)} · ${t('whisper_tag')}` : clock(s.start)}</Txt>
                  </Pressable>
                );
              })}
            </View>
          </Section>
        </ScrollView>

        {editing ? <BookmarkEditor
          key={editing.id}
          bookmark={editing}
          onClose={() => setEditing(null)}
          onSave={(b) => { updateRecording(rec.id, (r) => ({ bookmarks: r.bookmarks.map((x) => (x.id === b.id ? b : x)) })); setEditing(null); }}
          duration={duration}
        /> : null}
        <Modal visible={exportOpen} transparent animationType="slide" onRequestClose={() => setExportOpen(false)}>
          <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
            <View style={{ backgroundColor: colors.surface, padding: space.lg, gap: space.md, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
              <Txt size="lg" bold>{t('export')}</Txt>
              <Txt muted>{t('export_audio')}</Txt>
              <Button kind="secondary" label={`${t('export_original')} (${rec.format})`} onPress={() => shareAudio(rec, 'original').catch(app.showError)} />
              {rec.enhanced ? <Button kind="secondary" label={t('export_enhanced')} onPress={() => shareAudio(rec, 'enhanced').catch(app.showError)} /> : <Txt size="sm" muted>{t('no_enhanced_yet')}</Txt>}
              {secureFolderLikely() ? (
                <>
                  <Txt muted>{t('secure_folder')}</Txt>
                  <Row wrap>
                    <Button testID="secure-original" compact kind="secondary" icon="🔒" label={`${t('original')} (${rec.format})`} onPress={() => sendToSecureFolder('original')} />
                    {rec.enhanced ? <Button testID="secure-enhanced" compact kind="secondary" icon="🔒" label={`${t('enhanced')} (WAV)`} onPress={() => sendToSecureFolder('enhanced')} /> : null}
                  </Row>
                </>
              ) : null}
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

/** Mounted per bookmark (keyed by id), so its fields start from that bookmark. */
function BookmarkEditor({ bookmark, onClose, onSave, duration }: { bookmark: Bookmark; onClose: () => void; onSave: (b: Bookmark) => void; duration: number }) {
  const { t, colors, fs } = useApp();
  const [label, setLabel] = useState(bookmark.label);
  const [time, setTime] = useState(clock(bookmark.time));
  const parsed = parseClock(time);
  const valid = label.trim().length > 0 && parsed !== null && parsed >= 0 && parsed <= duration;
  const input = { borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: space.md, color: colors.text, fontSize: fs.md, minHeight: TOUCH, textAlign: 'auto' as const };
  const submit = () => { if (valid && parsed !== null) onSave({ ...bookmark, label: label.trim(), time: parsed }); };
  return (
    <Dialog onClose={onClose}>
      <Txt size="lg" bold>{t('edit')}</Txt>
      <Txt size="sm" muted>{t('bookmark_label')}</Txt>
      <TextInput testID="bm-label" value={label} onChangeText={setLabel} style={input} accessibilityLabel={t('bookmark_label')} returnKeyType="done" onSubmitEditing={submit} />
      <Txt size="sm" muted>{t('bookmark_time')}</Txt>
      <TextInput testID="bm-time" value={time} onChangeText={setTime} style={[input, { writingDirection: 'ltr' }]} keyboardType="numbers-and-punctuation" accessibilityLabel={t('bookmark_time')} returnKeyType="done" onSubmitEditing={submit} />
      <Row>
        <Button kind="ghost" label={t('cancel')} onPress={onClose} style={{ flex: 1 }} />
        <Button testID="bm-save" label={t('save')} disabled={!valid} onPress={submit} style={{ flex: 1 }} />
      </Row>
    </Dialog>
  );
}
