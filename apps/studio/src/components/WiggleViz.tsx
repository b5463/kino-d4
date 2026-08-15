import { useEffect, useRef, useState } from 'react';
import type { WiggleDirection, WiggleLoop } from '@kino/kdp';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { Button } from './Button';

// Playback orders per loop mode (camera indexes 0..3, left to right).
// Bounce never jumps CAM4 → CAM1; continuous does, deliberately.
const ORDERS: Record<WiggleLoop, number[]> = {
  bounce: [0, 1, 2, 3, 2, 1],
  continuous: [0, 1, 2, 3],
  sweep: [0, 1, 2, 3],
};

function sequenceFor(loop: WiggleLoop, direction: WiggleDirection): number[] {
  const base = ORDERS[loop];
  return direction === 'rtl' ? base.map((i) => 3 - i) : base;
}

/**
 * Live playback-order visualization for wiggle mode. Steps at the actual
 * configured frame rate so speed, loop and direction changes are felt
 * immediately — no fake photographs, just the cadence. Sweep mode holds
 * briefly after the last frame, like the camera's own playback.
 *
 * A 10 Hz loop is exactly what someone with a motion sensitivity has turned
 * off at the OS level, and a setInterval cannot be reached from the CSS
 * reduced-motion block — so it starts stopped there, with STEP and PLAY.
 */
export function WiggleViz({
  fps,
  loop = 'bounce',
  direction = 'ltr',
}: {
  fps: number;
  loop?: WiggleLoop;
  direction?: WiggleDirection;
}) {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(!reduced);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = sequenceFor(loop, direction);

  // Follow a live OS change in either direction.
  const seenReduced = useRef(reduced);
  if (seenReduced.current !== reduced) {
    seenReduced.current = reduced;
    setPlaying(!reduced);
  }

  useEffect(() => {
    if (!playing) return;
    setStep(0);
    const frameMs = Math.max(1000 / Math.max(fps, 1), 40);
    let current = 0;
    const tick = () => {
      current = (current + 1) % sequence.length;
      setStep(current);
      const holdEnd = loop === 'sweep' && current === sequence.length - 1;
      timerRef.current = setTimeout(tick, holdEnd ? frameMs + 650 : frameMs);
    };
    timerRef.current = setTimeout(tick, frameMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fps, loop, direction, playing]);

  const active = sequence[step] ?? sequence[0];
  const tail =
    loop === 'bounce' ? ' → …' : loop === 'continuous' ? ` → ${direction === 'rtl' ? 4 : 1} …` : ' · hold';

  return (
    <div className="wiggleviz">
      <div className="wiggleviz-cams" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`wigglecam${i === active ? ' wigglecam--active' : ''}`}>
            CAM{i + 1}
          </span>
        ))}
      </div>
      <div
        className="wiggleviz-seq"
        role="img"
        aria-label={`Playback order ${sequence.map((c) => c + 1).join(' then ')} at ${fps} frames per second, ${loop} loop, ${direction === 'ltr' ? 'left to right' : 'right to left'}. Showing camera ${active + 1}.`}
      >
        {sequence.map((cam, i) => (
          <span key={i}>
            {i > 0 ? ' → ' : ''}
            {i === step ? <b>{cam + 1}</b> : cam + 1}
          </span>
        ))}
        <span className="faint">
          {tail} · {fps} FPS
        </span>
      </div>
      <div className="wiggleviz-controls">
        <Button size="sm" onClick={() => setPlaying(!playing)}>
          {playing ? 'STOP' : 'PLAY'}
        </Button>
        <Button
          size="sm"
          disabled={playing}
          onClick={() => setStep((s) => (s + 1) % sequence.length)}
        >
          STEP
        </Button>
      </div>
    </div>
  );
}
