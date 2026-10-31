import { useState } from 'react';
import { AccessibilityActionEvent, GestureResponderEvent, LayoutChangeEvent, Pressable, View } from 'react-native';
import type { Segment } from '../dsp/vad';
import { clock } from '../transcript/format';
import type { Bookmark } from '../types';
import { useApp } from '../state/AppContext';

/**
 * Waveform with speech sections shaded, bookmark ticks and a playhead. Tap to seek.
 * Kept left-to-right in Arabic layout too: time runs left to right on media scrubbers.
 */
export function Waveform({
  peaks, duration, position, segments, bookmarks, onSeek, height = 72, selection, selectionMode = 'keep', loop,
}: {
  peaks: number[]; duration: number; position: number; segments: Segment[]; bookmarks: Bookmark[];
  onSeek: (t: number) => void; height?: number;
  /** Edit range: 'keep' dims everything outside it, 'cut' hatches the range itself. */
  selection?: { start: number; end: number }; selectionMode?: 'keep' | 'cut' | 'none';
  /** A-B repeat part, tinted. */
  loop?: { a: number; b: number } | null;
}) {
  const { colors, t } = useApp();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const toTime = (e: GestureResponderEvent) => (width > 0 && duration > 0 ? Math.max(0, Math.min(duration, (e.nativeEvent.locationX / width) * duration)) : 0);
  const x = (time: number) => (duration > 0 ? (time / duration) * width : 0);
  const bars = peaks.length ? peaks : new Array(120).fill(0.05);
  const barW = width > 0 ? width / bars.length : 0;
  const posX = x(position);

  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'increment') onSeek(Math.min(duration, position + 5));
    if (e.nativeEvent.actionName === 'decrement') onSeek(Math.max(0, position - 5));
  };

  return (
    <Pressable
      onLayout={onLayout}
      onPress={(e) => onSeek(toTime(e))}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={t('timeline_label')}
      accessibilityValue={{ text: `${clock(position)} / ${clock(duration)}` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={onAction}
      style={{ height, width: '100%', direction: 'ltr', backgroundColor: colors.surface2, borderRadius: 10, overflow: 'hidden' }}
    >
      {width > 0 &&
        segments.map((s, i) => (
          <View key={`s${i}`} style={{ position: 'absolute', left: x(s.start), width: Math.max(2, x(s.end) - x(s.start)), top: 0, bottom: 0, backgroundColor: s.kind === 'whisper' ? colors.whisper : colors.speech }} />
        ))}
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center' }} pointerEvents="none">
        {bars.map((p, i) => {
          const played = (i + 0.5) * barW <= posX;
          return (
            <View
              key={i}
              style={{ width: Math.max(1, barW - 1), marginRight: barW > 2 ? 1 : 0, height: Math.max(2, p * (height - 12)), backgroundColor: played ? colors.wave : colors.waveDim, borderRadius: 1 }}
            />
          );
        })}
      </View>
      {width > 0 && selection && selectionMode === 'keep' ? (
        <>
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, width: x(selection.start), top: 0, bottom: 0, backgroundColor: colors.bg, opacity: 0.75 }} />
          <View pointerEvents="none" style={{ position: 'absolute', left: x(selection.end), right: 0, top: 0, bottom: 0, backgroundColor: colors.bg, opacity: 0.75 }} />
        </>
      ) : null}
      {width > 0 && selection && selectionMode === 'cut' ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: x(selection.start), width: Math.max(2, x(selection.end) - x(selection.start)), top: 0, bottom: 0, backgroundColor: colors.danger, opacity: 0.35 }} />
      ) : null}
      {width > 0 && selection && selectionMode !== 'none'
        ? [selection.start, selection.end].map((v, i) => (
            <View key={`h${i}`} pointerEvents="none" style={{ position: 'absolute', left: x(v) - 2, width: 4, top: 0, bottom: 0, backgroundColor: colors.primary }} />
          ))
        : null}
      {width > 0 && loop ? (
        <View testID="wave-loop" pointerEvents="none" style={{ position: 'absolute', left: x(loop.a), width: Math.max(2, x(loop.b) - x(loop.a)), top: 0, bottom: 0, backgroundColor: colors.primary, opacity: 0.22, borderLeftWidth: 2, borderRightWidth: 2, borderColor: colors.primary }} />
      ) : null}
      {width > 0 &&
        bookmarks.map((b) => (
          <View key={b.id} pointerEvents="none" style={{ position: 'absolute', left: x(b.time) - 1, top: 0, bottom: 0, width: 3, backgroundColor: colors.bookmark }} />
        ))}
      {width > 0 && <View pointerEvents="none" style={{ position: 'absolute', left: posX - 1, top: 0, bottom: 0, width: 2, backgroundColor: colors.playhead }} />}
    </Pressable>
  );
}
