import { kdpLoopToMediaLoop, type LoopMode, type WiggleDirection } from '@kino/media';
import type { CapturePlayback } from '../api/client';

/** What every caller hands the player from a capture's stored playback choice. */
export interface PlayerPlayback {
  fps: number | undefined;
  loop: LoopMode;
  direction: WiggleDirection;
}

/**
 * One mapping for the feed, the capture page and the display: the stored loop
 * word is KDP's (`sweep` is the player's `once`), the direction passes through,
 * and null means the player's defaults. Three callers used to do this by hand
 * and the display forgot fps and loop entirely.
 */
export function playerPlayback(playback: CapturePlayback | null | undefined): PlayerPlayback {
  return {
    fps: playback?.fps,
    loop: kdpLoopToMediaLoop(playback?.loop ?? 'bounce'),
    direction: playback?.direction ?? 'ltr',
  };
}
