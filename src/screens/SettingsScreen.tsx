import { useState } from 'react';
import { Alert, ScrollView } from 'react-native';
import { releaseWhisper, deleteModel, downloadModel, isModelReady, MODELS } from '../services/transcription';
import { deleteAllData } from '../services/storage';
import { useApp } from '../state/AppContext';
import { Button, Choice, Header, LabeledSlider, ProgressBar, Row, Section, Toggle, Txt } from '../ui/components';
import { space } from '../ui/theme';
import { SkipPicker } from '../ui/SkipPicker';
import { clampSkip } from '../playback/controls';

export function SettingsScreen() {
  const { t, goBack, settings, updateSettings, showError, resetAll, colors } = useApp();
  const [dl, setDl] = useState<{ id: string; p: number } | null>(null);
  const [, force] = useState(0);
  const tr = settings.transcription;

  const download = async (id: string) => {
    const m = MODELS.find((x) => x.id === id)!;
    setDl({ id, p: 0 });
    try { await downloadModel(m, (p) => setDl({ id, p })); } catch (e) { showError(e); } finally { setDl(null); }
  };

  return (
    <ScrollView contentContainerStyle={{ gap: space.lg, paddingBottom: space.xl }}>
      <Header title={t('settings')} onBack={goBack} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.lg }} scrollEnabled={false}>
        <Section title={t('privacy')}>
          <Txt>{t('privacy_text')}</Txt>
        </Section>

        <Section title={t('appearance')}>
          <Choice testID="ui-lang" label={t('ui_language')} value={settings.uiLanguage} onChange={(v) => updateSettings({ uiLanguage: v })} options={[{ value: 'en', label: 'English' }, { value: 'ar', label: 'العربية' }]} />
          <Choice value={settings.theme} onChange={(v) => updateSettings({ theme: v })} options={[{ value: 'system', label: t('theme_system') }, { value: 'light', label: t('theme_light') }, { value: 'dark', label: t('theme_dark') }]} />
          <LabeledSlider label={t('text_size')} value={settings.textScale} min={0.85} max={1.6} step={0.05} onChange={(v) => updateSettings({ textScale: v })} format={(v) => `${Math.round(v * 100)} %`} />
        </Section>

        <Section title={t('playback')}>
          <Toggle label={t('skip_silence')} value={settings.skipSilence} onChange={(v) => updateSettings({ skipSilence: v })} />
          <SkipPicker testID="skip-back" label={t('skip_back')} value={settings.skipBackSec} onChange={(v) => updateSettings({ skipBackSec: clampSkip(v) })} />
          <SkipPicker testID="skip-forward" label={t('skip_forward')} value={settings.skipForwardSec} onChange={(v) => updateSettings({ skipForwardSec: clampSkip(v) })} />
          <LabeledSlider label={t('silence_gap')} value={settings.skipSilenceMinGapSec} min={0.3} max={5} step={0.1} onChange={(v) => updateSettings({ skipSilenceMinGapSec: v })} format={(v) => `${v.toFixed(1)} s`} />
        </Section>

        <Section title={t('speech_detection')}>
          <Toggle testID="detect-whispers" label={t('detect_whispers')} value={settings.vadWhisper} onChange={(v) => updateSettings({ vadWhisper: v })} hint={t('detect_whispers_hint')} />
          <LabeledSlider label={t('vad_threshold')} value={settings.vadThresholdDb} min={4} max={20} step={1} onChange={(v) => updateSettings({ vadThresholdDb: v })} format={(v) => `${v} dB`} hint={t('vad_note')} />
        </Section>

        <Section title={t('automation')}>
          <Toggle label={t('auto_enhance_step')} value={settings.auto.enhance} onChange={(v) => updateSettings({ auto: { ...settings.auto, enhance: v } })} />
          <Toggle label={t('auto_transcribe')} value={settings.auto.transcribe} onChange={(v) => updateSettings({ auto: { ...settings.auto, transcribe: v } })} />
          <Toggle label={t('auto_on_import')} value={settings.auto.runOnImport} onChange={(v) => updateSettings({ auto: { ...settings.auto, runOnImport: v } })} />
        </Section>

        <Section title={t('transcription')}>
          <Txt size="sm" muted>{t('model_download_note')}</Txt>
          {MODELS.map((m) => {
            const ready = isModelReady(m);
            return (
              <Row key={m.id} wrap style={{ justifyContent: 'space-between' }}>
                <Txt style={{ flex: 1, minWidth: 180 }}>{t(m.labelKey)}</Txt>
                {dl?.id === m.id ? (
                  <ProgressBar value={dl.p} label={t('downloading')} />
                ) : ready ? (
                  <Row>
                    <Txt size="sm" style={{ color: colors.ok }}>✓ {t('downloaded')}</Txt>
                    <Button compact kind="danger" label={t('delete')} onPress={async () => { await releaseWhisper(); deleteModel(m); force((x) => x + 1); }} />
                  </Row>
                ) : (
                  <Button compact kind="secondary" label={t('download')} onPress={() => download(m.id)} disabled={!!dl} />
                )}
              </Row>
            );
          })}
          <Choice label={t('model')} value={tr.modelId} onChange={(v) => updateSettings({ transcription: { ...tr, modelId: v } })} options={MODELS.map((m) => ({ value: m.id, label: m.id }))} />
          <Txt size="sm" muted>{t('dialect_note')}</Txt>
        </Section>

        <Section title={t('storage')}>
          <Button
            kind="danger"
            label={t('delete_all')}
            onPress={() =>
              Alert.alert(t('delete_all'), t('delete_all_confirm'), [
                { text: t('cancel'), style: 'cancel' },
                { text: t('delete'), style: 'destructive', onPress: async () => { await releaseWhisper(); deleteAllData(); resetAll([]); } },
              ])
            }
          />
        </Section>
      </ScrollView>
    </ScrollView>
  );
}
