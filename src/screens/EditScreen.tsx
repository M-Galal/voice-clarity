import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, TextInput, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useKeepAwake } from 'expo-keep-awake';
import { editedDuration, MAX_SPEED, MIN_SPEED, normalizeSpec, type EditSpec } from '../dsp/edit';
import {
  audioUri, discardPreview, editSaveTarget, renderEdit, saveEditAsNew, saveEditReplace, type CancelToken, type EditRender,
} from '../services/processing';
import { useApp } from '../state/AppContext';
import { nextVersionName } from '../edit/saveFormat';
import { clock, clockTenths } from '../transcript/format';
import type { Recording } from '../types';
import { Button, Card, Choice, Dialog, Header, IconButton, LabeledSlider, ProgressBar, Row, Section, Txt, Warning } from '../ui/components';
import { radius, space, TOUCH } from '../ui/theme';
import { Waveform } from '../ui/Waveform';


export function EditScreen({ id }: { id: string }) {
  const { library } = useApp();
  const rec = library.find((r) => r.id === id);
  if (!rec) return null;
  return <Editor key={rec.id} rec={rec} />;
}

function Editor({ rec }: { rec: Recording }) {
  const { t, goBack, navigate, updateRecording, reanalyse, addRecording, showError, colors, fs, library } = useApp();
  const [source, setSource] = useState<'original' | 'enhanced'>(rec.enhanced ? rec.lastPlayedSource : 'original');
  const [mode, setMode] = useState<EditSpec['mode']>('keep');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(rec.durationSec);
  const [speed, setSpeed] = useState(1);
  const [render, setRender] = useState<EditRender | null>(null);
  const [renderKey, setRenderKey] = useState('');
  const [listening, setListening] = useState<'current' | 'preview'>('current');
  const [progress, setProgress] = useState<number | null>(null);
  const [askName, setAskName] = useState(false);
  const [newName, setNewName] = useState(() => nextVersionName(rec.name, library.map((r) => r.name)));
  const [saving, setSaving] = useState(false);
  const target = editSaveTarget(rec);
  // true while 'Play selection' is running; a ref, so stopping does not re-render
  const selectionPlay = useRef(false);
  const token = useRef<CancelToken>({ cancelled: false });
  const renderRef = useRef<EditRender | null>(null);

  const [initialUri] = useState(() => audioUri(rec, source));
  const player = useAudioPlayer({ uri: initialUri }, { updateInterval: 100 });
  const st = useAudioPlayerStatus(player);
  const sourceDuration = (source === 'enhanced' ? rec.enhanced?.report.outputDurationSec : rec.durationSec) ?? rec.durationSec;
  const duration = listening === 'preview' && render ? render.durationSec : st.duration || sourceDuration;
  const position = st.currentTime;

  // same lag guard as the player: relative jumps and "set start/end" use the requested position
  const lastSeek = useRef({ to: 0, at: 0 });
  const here = () => (Date.now() - lastSeek.current.at < 600 ? lastSeek.current.to : position);
  const seekTo = (v: number) => {
    const to = Math.max(0, Math.min(duration, v));
    lastSeek.current = { to, at: Date.now() };
    player.seekTo(to);
  };

  const spec = normalizeSpec({ mode, start, end, speed }, sourceDuration);
  const key = JSON.stringify({ ...spec, source });
  const newLen = editedDuration(spec, sourceDuration);
  const trims =
    mode === 'keep' ? spec.start > 0.01 || spec.end < sourceDuration - 0.01 : mode === 'cut' ? spec.end - spec.start > 0.01 : false;
  const changed = trims || Math.abs(spec.speed - 1) > 1e-6;
  const tooShort = newLen < 0.5;
  const dirty = !!render && renderKey !== key;

  // delete an unused preview when leaving
  useEffect(() => { renderRef.current = render; }, [render]);
  useEffect(() => () => { if (renderRef.current) discardPreview(renderRef.current.previewUri); }, []);

  // stop at the end of the selection when playing it
  useEffect(() => {
    if (selectionPlay.current && st.playing && position >= spec.end) {
      player.pause();
      selectionPlay.current = false;
    }
  }, [position]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchListening = (w: 'current' | 'preview') => {
    if (w === listening || (w === 'preview' && !render)) return;
    player.pause();
    setListening(w);
    player.replace({ uri: w === 'preview' && render ? render.previewUri : audioUri(rec, source) });
  };
  const switchSource = (s: 'original' | 'enhanced') => {
    if (s === source) return;
    player.pause();
    setSource(s);
    setListening('current');
    const d = (s === 'enhanced' ? rec.enhanced?.report.outputDurationSec : rec.durationSec) ?? rec.durationSec;
    setStart(0);
    setEnd(d);
    player.replace({ uri: audioUri(rec, s) });
  };

  const doRender = async (): Promise<EditRender | null> => {
    if (render && !dirty) return render;
    if (render) discardPreview(render.previewUri);
    token.current = { cancelled: false };
    setProgress(0);
    player.pause();
    try {
      const r = await renderEdit(rec, source, spec, token.current, setProgress);
      setRender(r);
      setRenderKey(key);
      return r;
    } catch (e) {
      showError(e);
      return null;
    } finally {
      setProgress(null);
    }
  };

  const preview = async () => {
    const r = await doRender();
    if (!r) return;
    setListening('preview');
    player.replace({ uri: r.previewUri });
    setTimeout(() => player.play(), 150);
  };

  const save = () =>
    Alert.alert(t('save_replace_title'), t('save_replace_body', { name: rec.name }), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('replace'),
        style: 'destructive',
        onPress: async () => {
          const r = await doRender();
          if (!r) return;
          player.pause();
          setSaving(true);
          try {
            const patch = await saveEditReplace(rec, r);
            renderRef.current = null;
            setRender(null);
            updateRecording(rec.id, patch);
            goBack();
            reanalyse(rec.id);
          } catch (e) {
            showError(e);
          } finally {
            setSaving(false);
          }
        },
      },
    ]);

  const saveAs = async () => {
    setAskName(false);
    const r = await doRender();
    if (!r) return;
    player.pause();
    setSaving(true);
    try {
      const created = await saveEditAsNew(rec, r, newName);
      renderRef.current = null;
      setRender(null);
      goBack();
      navigate({ name: 'player', id: created.id });
      await addRecording(created);
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  };

  const playSelection = () => {
    if (listening !== 'current') switchListening('current');
    seekTo(spec.start);
    selectionPlay.current = true;
    player.play();
  };

  const nudge = (which: 'start' | 'end', d: number) => {
    if (which === 'start') setStart((v) => Math.max(0, Math.min(end, v + d)));
    else setEnd((v) => Math.min(sourceDuration, Math.max(start, v + d)));
  };

  const busy = progress !== null || saving;
  const segments = listening === 'current' ? (source === 'enhanced' ? rec.enhanced?.segments : rec.segments) ?? [] : [];

  return (
    <View style={{ flex: 1 }}>
      <Header title={`${t('edit_title')} · ${rec.name}`} onBack={() => { token.current.cancelled = true; player.pause(); goBack(); }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        {rec.enhanced ? (
          <Choice testID="edit-source" label={t('edit_source')} value={source} onChange={switchSource}
            options={[{ value: 'original', label: t('original') }, { value: 'enhanced', label: t('enhanced') }]} />
        ) : null}

        {render ? (
          <Choice testID="edit-listen" label={t('listening_to')} value={listening} onChange={switchListening}
            options={[{ value: 'current', label: t(source) }, { value: 'preview', label: t('preview') }]} />
        ) : null}

        <Waveform
          peaks={listening === 'current' && source === 'original' ? rec.waveform ?? [] : []}
          duration={duration}
          position={position}
          segments={segments}
          bookmarks={[]}
          onSeek={seekTo}
          selection={listening === 'current' ? { start: spec.start, end: spec.end } : undefined}
          selectionMode={mode}
        />
        <Row style={{ justifyContent: 'center', direction: 'ltr' }}>
          <IconButton testID="edit-back-10" icon="↺" label={t('back_10')} onPress={() => seekTo(here() - 10)} />
          <IconButton testID="edit-play" big icon={st.playing ? '❚❚' : '▶'} label={st.playing ? t('pause') : t('play')} onPress={() => { selectionPlay.current = false; if (st.playing) player.pause(); else player.play(); }} />
          <IconButton testID="edit-fwd-10" icon="↻" label={t('fwd_10')} onPress={() => seekTo(here() + 10)} />
        </Row>
        <Txt size="sm" muted style={{ textAlign: 'center', writingDirection: 'ltr' }}>{`${clockTenths(position)} / ${clockTenths(duration)}`}</Txt>

        <Section title={t('trim_mode')}>
          <Choice testID="trim-mode" value={mode} onChange={setMode}
            options={[{ value: 'none', label: t('mode_none') }, { value: 'keep', label: t('mode_keep') }, { value: 'cut', label: t('mode_cut') }]} />
          {mode !== 'none' ? (
            <>
              {(['start', 'end'] as const).map((which) => (
                <View key={which} style={{ gap: space.xs }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Txt>{t(which === 'start' ? 'sel_start' : 'sel_end')}</Txt>
                    <Txt bold testID={`sel-${which}-value`} style={{ writingDirection: 'ltr' }}>{clockTenths(which === 'start' ? spec.start : spec.end)}</Txt>
                  </Row>
                  <Row wrap>
                    <Button compact kind="secondary" testID={`set-${which}`} label={t(which === 'start' ? 'set_start_here' : 'set_end_here')}
                      onPress={() => { const p = here(); if (which === 'start') setStart(Math.min(p, end)); else setEnd(Math.max(p, start)); }} disabled={listening !== 'current'} />
                    <Button compact kind="ghost" testID={`${which}-minus`} label={t('nudge_back')} onPress={() => nudge(which, -0.1)} />
                    <Button compact kind="ghost" testID={`${which}-plus`} label={t('nudge_fwd')} onPress={() => nudge(which, 0.1)} />
                  </Row>
                </View>
              ))}
              <Button kind="secondary" testID="play-selection" label={t('play_selection')} icon="▶" onPress={playSelection} />
            </>
          ) : null}
        </Section>

        <Section title={t('speed_change')}>
          <LabeledSlider label={t('speed_change')} value={speed} min={MIN_SPEED} max={MAX_SPEED} step={0.05}
            onChange={setSpeed} format={(v) => `${v.toFixed(2)}×`} hint={t('speed_change_hint')} />
          <Row wrap>
            {[0.75, 1, 1.25, 1.5].map((v) => (
              <Button key={v} compact kind={Math.abs(speed - v) < 1e-6 ? 'primary' : 'secondary'} testID={`edit-speed-${v}`} label={`${v}×`} onPress={() => setSpeed(v)} />
            ))}
          </Row>
        </Section>

        <Card>
          <Txt bold testID="new-length">{t('new_length', { len: clock(newLen), old: clock(sourceDuration) })}</Txt>
          {!changed ? <Txt size="sm" muted>{t('edit_nothing')}</Txt> : null}
          {changed && tooShort ? <Warning text={t('edit_too_short')} /> : null}
          {dirty ? <Txt size="sm" style={{ color: colors.warn }}>{t('edit_dirty')}</Txt> : null}
          <Txt size="sm" muted testID="saves-as">
            {target.changed
              ? t('edit_saves_as_changed', { orig: rec.format, ext: target.ext.toUpperCase() })
              : t('edit_saves_as', { ext: target.ext.toUpperCase() })}
          </Txt>
          {rec.durationSec > 20 * 60 ? <Txt size="sm" muted>{t('edit_long_note')}</Txt> : null}
          {busy ? (
            <>
              <ProgressBar value={saving ? 1 : progress ?? 0} label={saving ? t('saving') : t('rendering')} />
              <Button kind="danger" testID="cancel-edit" label={t('cancel')} onPress={() => (token.current.cancelled = true)} />
            </>
          ) : (
            <>
              <Button kind="secondary" testID="edit-preview" label={t('preview')} icon="▶" onPress={preview} disabled={!changed || tooShort} />
              <Row>
                <Button testID="edit-save" label={t('save')} onPress={save} disabled={!changed || tooShort} style={{ flex: 1 }} />
                <Button testID="edit-save-as" kind="secondary" label={t('save_as')} onPress={() => setAskName(true)} disabled={!changed || tooShort} style={{ flex: 1 }} />
              </Row>
            </>
          )}
        </Card>
      </ScrollView>

      {askName ? (
        <Dialog onClose={() => setAskName(false)}>
              <Txt bold>{t('save_as_name')}</Txt>
              <TextInput
                testID="save-as-name"
                value={newName}
                onChangeText={setNewName}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={() => newName.trim() && saveAs()}
                accessibilityLabel={t('save_as_name')}
                style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: space.md, color: colors.text, fontSize: fs.md, minHeight: TOUCH, textAlign: 'auto' }}
              />
              <Row>
                <Button kind="ghost" label={t('cancel')} onPress={() => setAskName(false)} style={{ flex: 1 }} />
                <Button testID="save-as-confirm" label={t('save')} onPress={saveAs} disabled={!newName.trim()} style={{ flex: 1 }} />
              </Row>
        </Dialog>
      ) : null}
      <KeepAwakeWhile active={busy} />
    </View>
  );
}

function KeepAwakeWhile({ active }: { active: boolean }) {
  return active ? <KeepAwakeOn /> : null;
}
function KeepAwakeOn() {
  useKeepAwake();
  return null;
}
