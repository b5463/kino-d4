import { useEffect, useState } from 'react';
import type { WiggleDirection, WiggleLoop } from '@kino/kdp';
import { useReducedMotion } from '../../hooks/useReducedMotion';

/**
 * Feel names and the frame rate each one means on the camera. The names are
 * the control; the number is a delayed tooltip. The values are the firmware's
 * own 5..15 range, so what plays here is what the camera will play.
 */
export const FEELS = [
  { name: 'Dreamy', fps: 6 },
  { name: 'Slow', fps: 8 },
  { name: 'Normal', fps: 10 },
  { name: 'Fast', fps: 12 },
  { name: 'Hyper', fps: 14 },
] as const;

export type FeelName = (typeof FEELS)[number]['name'];

/** The feel a stored fps belongs to. */
export function feelForFps(fps: number): FeelName {
  if (fps <= 6) return 'Dreamy';
  if (fps <= 8) return 'Slow';
  if (fps <= 11) return 'Normal';
  if (fps <= 13) return 'Fast';
  return 'Hyper';
}

export function fpsForFeel(name: FeelName): number {
  return FEELS.find((f) => f.name === name)?.fps ?? 10;
}

/** Which lens starts the sequence when an end cell is clicked; inner cells say nothing. */
export function directionForCell(index: number): WiggleDirection | null {
  if (index === 0) return 'ltr';
  if (index === 3) return 'rtl';
  return null;
}

export function sequenceOrder(loop: WiggleLoop, direction: WiggleDirection, count = 4): number[] {
  const up = Array.from({ length: count }, (_, i) => i);
  const base = loop === 'bounce' ? [...up, ...up.slice(1, -1).reverse()] : up;
  return direction === 'rtl' ? base.map((i) => count - 1 - i) : base;
}

/**
 * Which lens is "on" right now, stepping at the feel's rate with hard cuts.
 * One sequencer feeds both the cells and the photograph, so the ringed cell
 * and the frame shown are always the same lens.
 *
 * Reduced motion: a 10 Hz strobe is exactly what that setting turns off, so
 * the sequence holds on its first frame and the setting stays editable.
 */
export function useWiggleStep(fps: number, loop: WiggleLoop, direction: WiggleDirection, count = 4, paused = false): number {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  const sequence = sequenceOrder(loop, direction, count);

  useEffect(() => {
    setStep(0);
    if (reduced || paused || count < 2) return;
    const frameMs = Math.max(1000 / Math.max(fps, 1), 40);
    const seq = sequenceOrder(loop, direction, count);
    let current = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      current = (current + 1) % seq.length;
      setStep(current);
      timer = setTimeout(tick, frameMs);
    };
    timer = setTimeout(tick, frameMs);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [fps, loop, direction, reduced, paused, count]);

  return sequence[step % sequence.length] ?? 0;
}
