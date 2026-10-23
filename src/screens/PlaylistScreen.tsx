import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Alert, FlatList, Pressable, TextInput, View } from 'react-native';
import { applyFilter, folderLabel, parseExtensions, type PlaylistItem } from '../playlist/filter';
import { SUPPORTED_EXTENSIONS } from '../services/audio';
import { pickFolder, scanFolder } from '../services/playlist';
import { formatBytes, useApp } from '../state/AppContext';
import type { PlaylistSettings } from '../types';
import { Button, Card, Choice, Header, IconButton, Row, Toggle, Txt, Warning } from '../ui/components';
import { radius, space, TOUCH } from '../ui/theme';

interface ScanResult {
  key: string;
  items: PlaylistItem[];
  error?: unknown;
}

export function PlaylistScreen() {
  const { t, goBack, settings, updateSettings, colors, fs, library, playFromQueue, queueOpening, showError, deleteFolderFile } = useApp();
  const pl = settings.playlist;
  const setPl = (patch: Partial<PlaylistSettings>) => updateSettings({ playlist: { ...pl, ...patch } });

  // typed filters apply to the list right away and are saved shortly after typing stops
  const [nameFilter, setNameFilter] = useState(pl.nameFilter);
  const [extText, setExtText] = useState(pl.extensions);
  useEffect(() => {
    if (nameFilter === pl.nameFilter && extText === pl.extensions) return;
    const h = setTimeout(() => updateSettings({ playlist: { ...pl, nameFilter, extensions: extText } }), 500);
    return () => clearTimeout(h);
  }, [nameFilter, extText]); // eslint-disable-line react-hooks/exhaustive-deps

  // The folder is read again whenever the folder, the subfolder option or `nonce` changes.
  const [nonce, setNonce] = useState(0);
  const scanKey = `${pl.folderUri}|${pl.includeSubfolders}|${nonce}`;
  const [scan, setScan] = useState<ScanResult | null>(null);
  useEffect(() => {
    if (!pl.folderUri) return;
    let live = true;
    scanFolder(pl.folderUri, pl.includeSubfolders)
      .then((items) => { if (live) setScan({ key: scanKey, items }); })
      .catch((error) => { if (live) setScan({ key: scanKey, items: [], error }); });
    return () => { live = false; };
  }, [scanKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const loading = !!pl.folderUri && scan?.key !== scanKey;

  const extensions = parseExtensions(extText);
  const all = useMemo(() => (scan && scan.key === scanKey ? scan.items : []), [scan, scanKey]);
  const files = useMemo(
    () => applyFilter(all, { name: nameFilter, extensions, sort: pl.sort }, SUPPORTED_EXTENSIONS),
    [all, nameFilter, extText, pl.sort], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const unknownExt = extensions.filter((e) => !(SUPPORTED_EXTENSIONS as readonly string[]).includes(e));
  const inLibrary = useMemo(() => new Set(library.map((r) => r.sourceUri).filter(Boolean)), [library]);

  const confirmDelete = (item: PlaylistItem) =>
    Alert.alert(t('delete_file'), t('pl_delete_confirm', { file: item.name }), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('delete_file'),
        style: 'destructive',
        onPress: async () => {
          if (await deleteFolderFile(item.uri)) {
            AccessibilityInfo.announceForAccessibility(t('pl_deleted', { file: item.name }));
            setNonce((n) => n + 1);
          }
        },
      },
    ]);

  const choose = async () => {
    try {
      const uri = await pickFolder(pl.folderUri || undefined);
      if (uri) setPl({ folderUri: uri });
    } catch (e) {
      showError(e);
    }
  };

  const input = {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: space.md, color: colors.text,
    fontSize: fs.md, minHeight: TOUCH, writingDirection: 'ltr' as const, textAlign: 'left' as const,
  };

  const header = (
    <View style={{ gap: space.md, paddingBottom: space.md }}>
      <Card>
        <Txt size="sm" muted>{t('pl_folder')}</Txt>
        <Txt testID="pl-folder" bold style={{ writingDirection: 'ltr' }}>
          {pl.folderUri ? folderLabel(pl.folderUri, t('pl_internal'), t('pl_sd_card')) : t('pl_no_folder')}
        </Txt>
        {loading ? (
          <Row><ActivityIndicator color={colors.primary} /><Txt muted>{t('pl_scanning')}</Txt></Row>
        ) : scan?.error ? (
          <Warning text={t('pl_folder_unavailable')} />
        ) : pl.folderUri ? (
          <Txt testID="pl-count" bold>{t('pl_count', { n: files.length, total: all.length })}</Txt>
        ) : null}
        <Button testID="pl-pick" kind={pl.folderUri ? 'secondary' : 'primary'} icon="📁" label={pl.folderUri ? t('pl_change') : t('pl_choose')} onPress={choose} />
        <Txt size="sm" muted>{t('pl_folder_note')}</Txt>
      </Card>
      <Toggle testID="pl-subfolders" label={t('pl_subfolders')} value={pl.includeSubfolders} onChange={(v) => setPl({ includeSubfolders: v })} />
      <View style={{ gap: space.xs }}>
        <Txt size="sm" muted>{t('pl_name')}</Txt>
        <TextInput
          testID="pl-name"
          value={nameFilter}
          onChangeText={setNameFilter}
          placeholder="call_*.m4a"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t('pl_name')}
          accessibilityHint={t('pl_name_hint')}
          style={input}
        />
        <Txt size="sm" muted>{t('pl_name_hint')}</Txt>
      </View>
      <View style={{ gap: space.xs }}>
        <Txt size="sm" muted>{t('pl_ext')}</Txt>
        <TextInput
          testID="pl-ext"
          value={extText}
          onChangeText={setExtText}
          placeholder="m4a, mp3"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t('pl_ext')}
          accessibilityHint={t('pl_ext_hint')}
          style={input}
        />
        <Txt size="sm" muted>{t('pl_ext_hint')}</Txt>
        {unknownExt.length ? <Warning text={t('err_unsupported', { ext: unknownExt.join(', ') })} /> : null}
      </View>
      <Choice
        testID="pl-sort"
        label={t('pl_sort')}
        value={pl.sort}
        onChange={(v) => setPl({ sort: v })}
        options={[
          { value: 'name', label: t('pl_sort_name') },
          { value: 'newest', label: t('pl_sort_newest') },
          { value: 'oldest', label: t('pl_sort_oldest') },
        ]}
      />
      <Toggle testID="pl-auto-next" label={t('pl_auto_next')} value={pl.autoNext} onChange={(v) => setPl({ autoNext: v })} />
      <Toggle testID="pl-skip-silence" label={t('skip_silence')} value={settings.skipSilence} onChange={(v) => updateSettings({ skipSilence: v })} hint={`${t('silence_gap')} ${settings.skipSilenceMinGapSec} s`} />
      <Txt size="sm" muted>{t('pl_copy_note')}</Txt>
      {pl.folderUri ? (
        <Row wrap>
          <Button testID="pl-play-all" label={t('pl_play_all')} icon="▶" onPress={() => playFromQueue(files, 0, { autoplay: true })} disabled={!files.length || queueOpening !== null} style={{ flexGrow: 1 }} />
          <Button testID="pl-refresh" kind="secondary" label={t('pl_refresh')} icon="↻" onPress={() => setNonce((n) => n + 1)} disabled={loading} style={{ flexGrow: 1 }} />
        </Row>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <Header title={t('pl_title')} onBack={goBack} />
      <FlatList
        data={loading ? [] : files}
        keyExtractor={(f) => f.uri}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.lg, gap: space.xs }}
        ListHeaderComponent={header}
        ListEmptyComponent={pl.folderUri && !loading && !scan?.error ? <Txt muted>{t('pl_empty')}</Txt> : undefined}
        renderItem={({ item, index }) => {
          const opening = queueOpening === index;
          const meta = [item.subfolder, formatBytes(item.size), item.modified ? new Date(item.modified).toLocaleDateString() : ''].filter(Boolean).join(' · ');
          return (
            <Pressable
              testID={`pl-item-${item.name}`}
              accessibilityRole="button"
              accessibilityLabel={`${item.name}. ${meta}`}
              disabled={queueOpening !== null}
              onPress={() => playFromQueue(files, index, { autoplay: true })}
              onLongPress={() => confirmDelete(item)}
              accessibilityActions={[{ name: 'delete', label: t('pl_delete', { file: item.name }) }]}
              onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'delete') confirmDelete(item); }}
              style={({ pressed }) => ({
                minHeight: TOUCH, paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius, borderWidth: 1,
                borderColor: colors.border, backgroundColor: colors.surface, opacity: pressed ? 0.85 : 1,
                flexDirection: 'row', alignItems: 'center', gap: space.sm,
              })}
            >
              <View style={{ flex: 1 }}>
                <Txt bold numberOfLines={1} style={{ writingDirection: 'auto' }}>{item.name}</Txt>
                <Txt size="sm" muted numberOfLines={1}>{opening ? t('pl_opening') : meta}</Txt>
              </View>
              {opening ? <ActivityIndicator color={colors.primary} /> : inLibrary.has(item.uri) ? <Txt size="sm" style={{ color: colors.ok }}>✓</Txt> : null}
              <IconButton testID={`pl-del-${item.name}`} icon="🗑" label={t('pl_delete', { file: item.name })} onPress={() => confirmDelete(item)} disabled={queueOpening !== null} />
            </Pressable>
          );
        }}
      />
    </View>
  );
}
