import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { formatTime, LOOP_GAPS, LOOP_TIMES, loopValid, parseTime, type LoopSpec } from '../playback/loop';
import { useApp } from '../state/AppContext';
import { Button, Choice, Row, Toggle, Txt } from './components';
import { radius, space, TOUCH } from './theme';

function useFieldStyle() {
  const { colors, fs } = useApp();
  return { flex: 1, minWidth: 56, borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: space.sm, paddingVertical: 0, height: TOUCH, color: colors.text, fontSize: fs.md, writingDirection: 'ltr' as const, textAlign: 'left' as const };
}

/** Time field (m:ss) that keeps what is being typed and reports a valid time on submit or blur. */
function TimeField({ testID, value, duration, onValue, label, onBad }: { testID: string; value: number | null; duration: number; onValue: (sec: number) => void; label: string; onBad: (bad: boolean) => void }) {
  const { colors } = useApp();
  const style = useFieldStyle();
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? (value === null ? '' : formatTime(value));
  const commit = () => {
    if (draft === null) return;
    const v = parseTime(draft, duration);
    onBad(v === null && draft.trim() !== '');
    if (v !== null) onValue(v);
    setDraft(null);
  };
  return (
    <TextInput
      testID={testID}
      value={text}
      onChangeText={setDraft}
      onEndEditing={commit}
      onSubmitEditing={commit}
      placeholder="1:30"
      placeholderTextColor={colors.textMuted}
      keyboardType="numbers-and-punctuation"
      returnKeyType="done"
      accessibilityLabel={label}
      style={style}
    />
  );
}

/**
 * Jump to a typed time, and repeat a part (A-B) a set number of times with an optional pause
 * between passes. The jump time and the part stay with the recording (the caller saves them), so
 * they are there again in the player and in live listening of the same file. The screen that
 * plays does the seeking and runs loopStep on its position.
 */
export function PlaybackTools({ duration, position, jumpAt, onJump, loop, onLoop, repeatOn, onRepeat, pass, prefix = '' }: {
  duration: number;
  /** Current position, read when a Now button is pressed. */
  position: () => number;
  /** The last time jumped to in this file (shown in the field), or null. */
  jumpAt: number | null;
  onJump: (sec: number) => void;
  loop: LoopSpec | null;
  onLoop: (l: LoopSpec | null) => void;
  repeatOn: boolean;
  onRepeat: (on: boolean) => void;
  /** Pass being played while repeating (from 1). */
  pass: number;
  /** testID prefix, so two of these can be told apart. */
  prefix?: string;
}) {
  const { t, colors } = useApp();
  const field = useFieldStyle();
  const id = (s: string) => `${prefix}${s}`;
  const [draft, setDraft] = useState<string | null>(null);
  const jump = draft ?? (jumpAt === null ? '' : formatTime(jumpAt));
  const [jumpBad, setJumpBad] = useState(false);
  const [bad, setBad] = useState(false);
  const spec: LoopSpec = loop ?? { a: 0, b: 0, times: 3, gapSec: 0 };
  const has = loop !== null;
  const valid = loopValid(loop, duration);
  const set = (p: Partial<LoopSpec>) => onLoop({ ...spec, ...p });
  const go = () => {
    const v = parseTime(jump, duration);
    setJumpBad(v === null);
    if (v !== null) { setDraft(null); onJump(v); }
  };
  return (
    <View style={{ gap: space.sm }}>
      <Row>
        <Txt bold>{t('jump_title')}</Txt>
        <TextInput
          testID={id('jump-input')}
          value={jump}
          onChangeText={(v) => { setDraft(v); setJumpBad(false); }}
          onSubmitEditing={go}
          placeholder="1:30"
          placeholderTextColor={colors.textMuted}
          keyboardType="numbers-and-punctuation"
          returnKeyType="go"
          accessibilityLabel={t('jump_title')}
          accessibilityHint={t('jump_hint')}
          style={field}
        />
        <Button testID={id('jump-go')} compact label={t('jump_go')} onPress={go} disabled={!jump.trim()} />
      </Row>
      {jumpBad ? <Txt size="xs" testID={id('jump-bad')} style={{ color: colors.danger }}>{t('jump_invalid')}</Txt> : null}

      <Toggle testID={id('rep-on')} label={t('rep_title')} value={repeatOn && valid} onChange={onRepeat} disabled={!valid} />
      <Row>
        {(['a', 'b'] as const).map((k) => (
          <Row key={k} style={{ flex: 1, gap: space.xs }}>
            <Txt bold>{t(k === 'a' ? 'rep_a' : 'rep_b')}</Txt>
            <TimeField
              testID={id(`rep-${k}`)}
              value={has ? spec[k] : null}
              duration={duration}
              label={t(k === 'a' ? 'rep_a' : 'rep_b')}
              onBad={setBad}
              onValue={(v) => set(k === 'a' ? { a: v, b: has ? spec.b : Math.min(duration, v + 5) } : { b: v, a: has ? spec.a : Math.max(0, v - 5) })}
            />
            <Button
              testID={id(`rep-${k}-now`)}
              compact
              kind="secondary"
              label={t('rep_now')}
              onPress={() => {
                const p = Math.round(position() * 10) / 10;
                set(k === 'a' ? { a: p, b: has && spec.b > p ? spec.b : Math.min(duration, p + 5) } : { b: p, a: has && spec.a < p ? spec.a : Math.max(0, p - 5) });
              }}
            />
          </Row>
        ))}
      </Row>
      {bad ? <Txt size="xs" style={{ color: colors.danger }}>{t('jump_invalid')}</Txt> : null}
      {has && !valid ? <Txt size="xs" testID={id('rep-invalid')} style={{ color: colors.danger }}>{t('rep_invalid')}</Txt> : null}
      <Choice
        inline
        testID={id('rep-times')}
        label={t('rep_times')}
        value={spec.times}
        onChange={(v) => set({ times: v })}
        options={LOOP_TIMES.map((n) => ({ value: n, label: n === 0 ? '∞' : `${n}×` }))}
      />
      <Choice
        inline
        testID={id('rep-gap')}
        label={t('rep_gap')}
        value={spec.gapSec}
        onChange={(v) => set({ gapSec: v })}
        options={LOOP_GAPS.map((n) => ({ value: n, label: `${n} s` }))}
      />
      {repeatOn && valid ? (
        <Txt size="sm" testID={id('rep-progress')} style={{ color: colors.primary }}>{spec.times > 0 ? t('rep_progress', { i: Math.min(pass, spec.times), n: spec.times }) : t('rep_progress_forever', { i: pass })}</Txt>
      ) : null}
      {has ? <Button testID={id('rep-clear')} compact kind="ghost" label={t('rep_clear')} onPress={() => { onRepeat(false); onLoop(null); }} style={{ alignSelf: 'flex-start' }} /> : null}
    </View>
  );
}
