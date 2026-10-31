import { useEffect, useRef, useState } from 'react';
import { loopStep, loopValid, type LoopSpec } from './loop';

/**
 * Runs A-B repeat on a player: watches the position and goes back to A each time B is passed,
 * with the chosen pause between passes, until the number of passes is reached.
 */
export function useRepeat({ loop, duration, position, playing, seek, pause, play }: {
  loop: LoopSpec | null;
  duration: number;
  position: number;
  playing: boolean;
  seek: (sec: number) => void;
  pause: () => void;
  play: () => void;
}) {
  const [on, setOn] = useState(false);
  const [pass, setPass] = useState(1);
  const prev = useRef(position);
  const waiting = useRef<ReturnType<typeof setTimeout> | null>(null);
  // a player can report the old position once more after a seek: ignore updates for a moment
  const jumpedAt = useRef(0);
  const valid = loopValid(loop, duration);

  const cancelWait = () => { if (waiting.current) { clearTimeout(waiting.current); waiting.current = null; } };
  useEffect(() => cancelWait, []);

  const turn = (v: boolean) => {
    cancelWait();
    setOn(v && valid);
    setPass(1);
    if (v && valid && loop && (position < loop.a - 0.05 || position >= loop.b)) {
      prev.current = loop.a;
      jumpedAt.current = Date.now();
      seek(loop.a);
    }
  };

  useEffect(() => {
    const p = prev.current;
    prev.current = position;
    if (!on || !valid || !loop || !playing || waiting.current || Date.now() - jumpedAt.current < 600) return;
    const r = loopStep(p, position, loop, pass);
    if (r.done) { setOn(false); return; }
    if (r.seekTo === null) return;
    setPass(r.pass);
    prev.current = loop.a;
    jumpedAt.current = Date.now();
    if (loop.gapSec > 0) {
      pause();
      seek(loop.a);
      waiting.current = setTimeout(() => { waiting.current = null; play(); }, loop.gapSec * 1000);
    } else {
      seek(loop.a);
    }
  }, [position]); // eslint-disable-line react-hooks/exhaustive-deps

  // a part that becomes invalid (cleared, B before A) stops a pending pass; `on` reads false then
  useEffect(() => { if (!valid) cancelWait(); }, [valid]);

  return { on: on && valid, setOn: turn, pass };
}
