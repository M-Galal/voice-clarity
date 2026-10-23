import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { formatSkip, parseSkip, SKIP_PRESETS } from '../playback/controls';
import { useApp } from '../state/AppContext';
import { Button, Choice, Row, Txt } from './components';
import { radius, space, TOUCH } from './theme';

/** Preset jumps from 1 s to 1 h plus a free entry ("45 s", "2 min", "1:30"). */
export function SkipPicker({ label, value, onChange, testID }: { label: string; value: number; onChange: (sec: number) => void; testID: string }) {
  const { t, colors, fs } = useApp();
  const units = { s: t('unit_s'), min: t('unit_min'), h: t('unit_h') };
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(false);
  const isPreset = SKIP_PRESETS.includes(value);
  const apply = () => {
    const sec = parseSkip(draft);
    if (sec === null) { setError(true); return; }
    setError(false);
    setDraft('');
    onChange(sec);
  };
  return (
    <View style={{ gap: space.xs }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Txt style={{ flex: 1 }}>{label}</Txt>
        <Txt bold testID={`${testID}-value`}>{formatSkip(value, units)}</Txt>
      </Row>
      <Choice testID={testID} value={isPreset ? value : -1} onChange={onChange}
        options={SKIP_PRESETS.map((v) => ({ value: v, label: formatSkip(v, units) }))} />
      <Row>
        <TextInput
          testID={`${testID}-custom`}
          value={draft}
          onChangeText={(v) => { setDraft(v); setError(false); }}
          onSubmitEditing={apply}
          returnKeyType="done"
          placeholder={t('skip_custom')}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel={`${label}, ${t('skip_custom')}`}
          style={{ flex: 1, minHeight: TOUCH, borderWidth: 1, borderColor: error ? colors.danger : colors.border, borderRadius: radius, paddingHorizontal: space.md, color: colors.text, fontSize: fs.md }}
        />
        <Button compact kind="secondary" testID={`${testID}-apply`} label={t('done')} onPress={apply} disabled={!draft.trim()} />
      </Row>
      <Txt size="sm" muted style={error ? { color: colors.danger } : undefined}>{error ? t('skip_invalid') : t('skip_custom_hint')}</Txt>
    </View>
  );
}
