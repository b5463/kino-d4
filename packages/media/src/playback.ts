import type { LoopMode } from './sequence';

/**
 * The device's loop vocabulary (KDP `WiggleLoop`) mapped onto this package's.
 *
 * The two vocabularies genuinely differ and two of the three words collide:
 * KDP's `continuous` is a repeating one-way sweep — this package's `sweep` —
 * and KDP's `sweep` is 02 §9's "one sweep", which is `once` here. Passing a
 * stored KDP value straight into `wiggleSequence` would therefore typecheck
 * as the *wrong* mode for a third of the values, which is why the mapping is
 * a function and not a cast.
 */
export type KdpWiggleLoop = 'bounce' | 'continuous' | 'sweep';

const KDP_TO_MEDIA: Record<KdpWiggleLoop, LoopMode> = {
  bounce: 'bounce',
  continuous: 'sweep',
  sweep: 'once',
};

/**
 * `bounce` for anything unrecognised: the value arrives from a stored JSON
 * document, and a capture with a mangled playback block still deserves the
 * default wiggle rather than a dead render.
 */
export function kdpLoopToMediaLoop(loop: unknown): LoopMode {
  if (typeof loop === 'string' && loop in KDP_TO_MEDIA) {
    return KDP_TO_MEDIA[loop as KdpWiggleLoop];
  }
  // A caller may also hand over a value already in this package's vocabulary
  // (a UI that speaks LoopMode natively). `bounce` and `sweep` were caught
  // above — deliberately, with the KDP meaning — so only `once` remains.
  if (loop === 'once') return 'once';
  return 'bounce';
}
