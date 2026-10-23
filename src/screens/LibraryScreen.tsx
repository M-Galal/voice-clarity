import { FlatList, Pressable, Text, View } from 'react-native';
import { clock } from '../transcript/format';
import { formatBytes, useApp } from '../state/AppContext';
import type { Recording } from '../types';
import { Button, Header, IconButton, Row, Txt } from '../ui/components';
import { radius, space, TOUCH } from '../ui/theme';

export function LibraryScreen() {
  const { t, library, importFromPicker, navigate, colors, settings, updateSettings } = useApp();
  // one tap cycles Match system → Light → Dark
  const nextTheme = { system: 'light', light: 'dark', dark: 'system' } as const;
  const themeIcon = { system: '◐', light: '☀︎', dark: '☾' }[settings.theme];
  const themeName = t(settings.theme === 'system' ? 'theme_system' : settings.theme === 'light' ? 'theme_light' : 'theme_dark');
  return (
    <View style={{ flex: 1 }}>
      <Header
        title={t('library')}
        right={
          <Row>
            <IconButton testID="theme-toggle" icon={themeIcon} label={`${t('appearance')}: ${themeName}`} onPress={() => updateSettings({ theme: nextTheme[settings.theme] })} />
            <IconButton testID="open-settings" icon="⚙︎" label={t('settings')} onPress={() => navigate({ name: 'settings' })} />
          </Row>
        }
      />
      <View style={{ padding: space.lg, gap: space.xs }}>
        <Button testID="import" label={t('import')} icon="＋" onPress={importFromPicker} />
        <Button testID="open-playlist" kind="secondary" label={t('pl_open')} icon="📁" onPress={() => navigate({ name: 'playlist' })} />
        <Txt size="sm" muted>{t('import_hint')}</Txt>
      </View>
      <FlatList
        data={library}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ padding: space.lg, paddingTop: 0, gap: space.sm }}
        ListEmptyComponent={<Txt muted>{t('empty_library')}</Txt>}
        renderItem={({ item }) => <RecordingRow rec={item} onOpen={() => navigate({ name: 'player', id: item.id })} colorsBg={colors.surface} border={colors.border} />}
      />
    </View>
  );
}

export function statusText(rec: Recording, t: ReturnType<typeof useApp>['t']) {
  switch (rec.status) {
    case 'analyzing': return t('status_analyzing');
    case 'enhancing': return t('status_enhancing');
    case 'transcribing': return t('status_transcribing');
    case 'error': return rec.error === 'interrupted' ? t('err_interrupted') : t('status_error');
    default: return t('status_ready');
  }
}

function RecordingRow({ rec, onOpen, colorsBg, border }: { rec: Recording; onOpen: () => void; colorsBg: string; border: string }) {
  const { t, colors } = useApp();
  const badges = [rec.external ? t('in_folder') : null, rec.enhanced ? t('has_enhanced') : null, rec.transcript ? t('has_transcript') : null].filter(Boolean).join(' · ');
  const summary = `${rec.name}. ${t('duration')} ${clock(rec.durationSec)}. ${rec.format}. ${formatBytes(rec.sizeBytes)}. ${statusText(rec, t)}. ${badges}`;
  return (
    <Pressable
      onPress={onOpen}
      testID={`rec-${rec.name}`}
      accessibilityRole="button"
      accessibilityLabel={summary}
      style={({ pressed }) => ({
        backgroundColor: colorsBg, borderRadius: radius, borderWidth: 1, borderColor: border,
        paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: TOUCH, justifyContent: 'center', gap: 2,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Txt bold numberOfLines={1}>{rec.name}</Txt>
      <Txt size="sm" muted numberOfLines={1}>
        {`${clock(rec.durationSec)} · ${rec.format} · ${formatBytes(rec.sizeBytes)} · `}
        <Text style={{ color: rec.status === 'error' ? colors.danger : rec.status === 'ready' ? colors.ok : colors.primary }}>{statusText(rec, t)}</Text>
        {badges ? ` · ${badges}` : ''}
      </Txt>
    </Pressable>
  );
}
