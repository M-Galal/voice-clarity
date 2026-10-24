import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Keyboard, ScrollView, TextInput, type ScrollViewProps } from 'react-native';

/**
 * A ScrollView that keeps the focused text field above the on-screen keyboard.
 *
 * With Android edge-to-edge (the default in this Expo SDK) the window is not resized for the
 * keyboard, so a field near the bottom stayed hidden under it (seen on the emulator in Settings).
 * When the keyboard opens this adds bottom room equal to its height and scrolls the focused field
 * (TextInput.State.currentlyFocusedInput) so its bottom sits just above the keyboard.
 */
export function KeyboardAwareScrollView({ children, contentContainerStyle, ...rest }: ScrollViewProps) {
  const ref = useRef<ComponentRef<typeof ScrollView>>(null);
  const scrollY = useRef(0);
  const [keyboard, setKeyboard] = useState(0);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboard(e.endCoordinates.height);
      const keyboardTop = e.endCoordinates.screenY;
      // wait a frame so the extra bottom room exists before scrolling into it
      requestAnimationFrame(() => {
        const input = TextInput.State.currentlyFocusedInput();
        input?.measureInWindow((_x, y, _w, h) => {
          const overlap = y + h + 24 - keyboardTop;
          if (overlap > 0) ref.current?.scrollTo({ y: scrollY.current + overlap, animated: true });
        });
      });
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  return (
    <ScrollView
      ref={ref}
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={32}
      {...rest}
      onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; rest.onScroll?.(e); }}
      contentContainerStyle={[contentContainerStyle, keyboard ? { paddingBottom: keyboard + 24 } : null]}
    >
      {children}
    </ScrollView>
  );
}
