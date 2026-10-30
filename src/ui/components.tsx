import React, { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet,
  Switch, Text, TextStyle, View, ViewStyle,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { useApp } from '../state/AppContext';
import { HIT_SLOP, radius, space, TOUCH } from './theme';

export function Txt({
  children, size = 'md', muted, bold, style, numberOfLines, selectable, testID,
}: {
  testID?: string;
  children: React.ReactNode;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';
  muted?: boolean;
  bold?: boolean;
  style?: TextStyle | TextStyle[];
  numberOfLines?: number;
  selectable?: boolean;
}) {
  const { colors, fs } = useApp();
  return (
    <Text
      testID={testID}
      selectable={selectable}
      numberOfLines={numberOfLines}
      style={[{ color: muted ? colors.textMuted : colors.text, fontSize: fs[size], fontWeight: bold ? '700' : '400', textAlign: 'auto' }, style as TextStyle]}
    >
      {children}
    </Text>
  );
}

/**
 * Android draws symbols such as ▶ ⏮ ⏩ as colour emoji, which ignore the text colour (a white ▶ on
 * the light-blue dark-theme button). U+FE0E asks for the plain text form, so icons take the theme
 * colour. Symbols that only exist as emoji are unaffected.
 */
export const textGlyph = (icon: string) => icon.replace(/([\u2190-\u21FF\u2300-\u2BFF])(?![\uFE0E\uFE0F])/g, '$1\uFE0E');

export function Button({
  label, onPress, kind = 'primary', disabled, icon, accessibilityHint, style, compact, testID,
}: {
  testID?: string;
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  icon?: string;
  accessibilityHint?: string;
  style?: ViewStyle;
  compact?: boolean;
}) {
  const { colors, fs } = useApp();
  const bg = kind === 'primary' ? colors.primary : kind === 'secondary' ? colors.surface2 : 'transparent';
  const fg = kind === 'primary' ? colors.onPrimary : kind === 'danger' ? colors.danger : colors.text;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={HIT_SLOP}
      style={({ pressed }) => [
        {
          minHeight: TOUCH,
          paddingHorizontal: compact ? space.md : space.lg,
          borderRadius: radius,
          backgroundColor: bg,
          borderWidth: kind === 'danger' || kind === 'ghost' ? 1 : 0,
          borderColor: kind === 'danger' ? colors.danger : colors.border,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: space.sm,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {icon ? <Text style={{ color: fg, fontSize: fs.lg }} accessible={false}>{textGlyph(icon)}</Text> : null}
      <Text style={{ color: fg, fontSize: fs.md, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

/** Round icon button with a spoken label. */
export function IconButton({ icon, label, onPress, big, disabled, testID }: { icon: string; label: string; onPress: () => void; big?: boolean; disabled?: boolean; testID?: string }) {
  // longer text labels (e.g. "−1m30") use a smaller font so they fit the round button
  const long = !big && icon.length > 3;
  const { colors, fs } = useApp();
  // 40 dp (48 dp touch area with hitSlop) and 52 dp for the main button: five fit a 320 dp screen
  const size = big ? 52 : 40;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={big ? 2 : 4}
      style={({ pressed }) => ({
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: big ? colors.primary : colors.surface2,
        alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      <Text numberOfLines={1} adjustsFontSizeToFit style={{ fontSize: big ? fs.xxl : long ? fs.xs : fs.lg, fontWeight: long ? '700' : '400', color: big ? colors.onPrimary : colors.text }}>{textGlyph(icon)}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const { colors } = useApp();
  return (
    <View style={[{ backgroundColor: colors.surface, borderRadius: radius, padding: space.lg, gap: space.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }, style]}>
      {children}
    </View>
  );
}

export function Row({ children, style, wrap, accessible, accessibilityLabel }: { children: React.ReactNode; style?: ViewStyle; wrap?: boolean; accessible?: boolean; accessibilityLabel?: string }) {
  return <View accessible={accessible} accessibilityLabel={accessibilityLabel} style={[{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: wrap ? 'wrap' : 'nowrap' }, style]}>{children}</View>;
}

export function Toggle({ label, value, onChange, hint, disabled, testID }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string; disabled?: boolean; testID?: string }) {
  const { colors } = useApp();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value, disabled }}
      onPress={() => !disabled && onChange(!value)}
      hitSlop={HIT_SLOP}
      style={{ flexDirection: 'row', alignItems: 'center', minHeight: TOUCH, gap: space.md, opacity: disabled ? 0.5 : 1 }}
    >
      <View style={{ flex: 1 }}>
        <Txt>{label}</Txt>
        {hint ? <Txt size="sm" muted>{hint}</Txt> : null}
      </View>
      <Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: colors.primary, false: colors.border }} accessibilityElementsHidden importantForAccessibility="no" />
    </Pressable>
  );
}

/** Segmented choice. */
export function Choice<T extends string | number>({
  options, value, onChange, label, testID,
}: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label?: string; testID?: string }) {
  const { colors, fs } = useApp();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ gap: space.xs }}>
      {label ? <Txt size="sm" muted>{label}</Txt> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable
              key={String(o.value)}
              testID={testID ? `${testID}-${o.value}` : undefined}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={o.label}
              onPress={() => onChange(o.value)}
              hitSlop={HIT_SLOP}
              style={{
                minHeight: TOUCH - 4, paddingHorizontal: space.md, justifyContent: 'center', borderRadius: radius,
                backgroundColor: on ? colors.primary : colors.surface2,
              }}
            >
              <Text style={{ color: on ? colors.onPrimary : colors.text, fontSize: fs.sm, fontWeight: on ? '700' : '500' }}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Labelled slider. Screen readers get increment/decrement actions in `step`s and hear the
 * formatted value.
 */
export function LabeledSlider({
  label, value, min, max, step, onChange, format, hint, disabled, onLive, testID, compact,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format: (v: number) => string; hint?: string; disabled?: boolean;
  /** Called while dragging; onChange is called on release. */
  onLive?: (v: number) => void;
  testID?: string;
  /** Label, slider and value on one line (no hint shown). */
  compact?: boolean;
}) {
  const { colors } = useApp();
  // value shown while the thumb is being dragged
  const [dragging, setDragging] = useState<number | null>(null);
  const clampStep = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const shown = dragging ?? value;
  // The native slider (Android SeekBar, iOS UISlider) is adjustable with TalkBack/VoiceOver;
  // it carries the label and value itself, so it stays reachable for screen readers and tests.
  const slider = (
    <Slider
      value={value}
      minimumValue={min}
      maximumValue={max}
      step={step}
      disabled={disabled}
      onValueChange={(v) => {
        const c = clampStep(v);
        setDragging(c);
        onLive?.(c);
      }}
      onSlidingComplete={(v) => { setDragging(null); onChange(clampStep(v)); }}
      testID={testID ? `${testID}-track` : undefined}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityValue={{ text: format(shown) }}
      minimumTrackTintColor={colors.primary}
      maximumTrackTintColor={colors.border}
      thumbTintColor={colors.primary}
      style={compact ? { height: 32, flex: 1 } : { height: 32 }}
    />
  );
  if (compact) {
    return (
      <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, opacity: disabled ? 0.5 : 1 }}>
        <Txt size="sm">{label}</Txt>
        {slider}
        <Txt size="sm" bold testID={testID ? `${testID}-value` : undefined} style={{ minWidth: 48, textAlign: 'right' }}>{format(shown)}</Txt>
      </View>
    );
  }
  return (
    <View style={{ gap: space.xs, opacity: disabled ? 0.5 : 1 }} testID={testID}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Txt style={{ flex: 1 }}>{label}</Txt>
        <Txt bold testID={testID ? `${testID}-value` : undefined}>{format(shown)}</Txt>
      </Row>
      {slider}
      {hint ? <Txt size="sm" muted>{hint}</Txt> : null}
    </View>
  );
}

export function Warning({ text }: { text: string }) {
  const { colors } = useApp();
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: colors.warnBg, borderRadius: radius, padding: space.md, flexDirection: 'row', gap: space.sm }}>
      <Text style={{ color: colors.warn }} accessible={false}>⚠︎</Text>
      <Text style={{ color: colors.warn, flex: 1 }}>{text}</Text>
    </View>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const { colors } = useApp();
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: pct }} style={{ gap: space.xs }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row><ActivityIndicator color={colors.primary} /><Txt size="sm">{label}</Txt></Row>
        <Txt size="sm" bold>{pct}%</Txt>
      </Row>
      <View style={{ height: 8, backgroundColor: colors.surface2, borderRadius: 4, overflow: 'hidden' }}>
        <View style={{ width: `${pct}%`, height: 8, backgroundColor: colors.primary }} />
      </View>
    </View>
  );
}

export function Header({ title, onBack, right }: { title: string; onBack?: () => void; right?: React.ReactNode }) {
  const { t, colors, rtl } = useApp();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
      {onBack ? <IconButton icon={rtl ? '→' : '←'} label={t('back')} onPress={onBack} /> : null}
      <Txt size="lg" bold numberOfLines={1} style={{ flex: 1 }}>{title}</Txt>
      {right}
    </View>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <Txt size="md" bold>{title}</Txt>
      {children}
    </Card>
  );
}

export function KeyValue({ k, v }: { k: string; v: string }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <Txt muted style={{ flex: 1 }}>{k}</Txt>
      <Txt bold>{v}</Txt>
    </Row>
  );
}

/**
 * Centred dialog that stays usable with the keyboard open: it moves up with the keyboard and
 * scrolls, so its buttons can always be reached.
 */
export function Dialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: space.xl }}
        >
          <Card>{children}</Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
