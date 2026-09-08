// Calibration-aware wiggle rendering: apply each camera's stored x/y/rot
// correction, then crop all four frames to the common overlap region so
// exports don't show swimming edges. Offsets are in sensor pixels at the
// 1600-wide capture base.
//
// The geometry itself lives in @kino/media (audit #59): the worker bakes the
// same alignment into the WebP/MP4 a guest gets, and two copies of the math
// would drift. This file keeps only the canvas execution.

import { alignmentPlan, hasAnyOffset, type CamOffset } from '@kino/media';
import { CAM_IDS, type CamId, type CaptureInfo } from '@kino/kdp';
import { slotIndex } from './camSlots';

export { SENSOR_BASE_W, computeOverlapCrop, hasAnyOffset } from '@kino/media';
export type { CamOffset } from '@kino/media';

/** Live calibration, as the inspector holds it: per-cam offsets or nothing. */
export interface LiveCamOffsets {
  cams: Partial<Record<CamId, { x: number; y: number; rot: number }>>;
}

/**
 * The offsets a capture renders with, in CAM order.
 *
 * Offsets recorded **on the capture** win: they are the calibration the rig
 * actually had at the shutter press, and re-aligning an old capture with
 * today's calibration corrects it with numbers measured for a different
 * mechanical state. Live device calibration is the fallback for captures that
 * carry none — which is every capture until firmware stamps them
 * (firmware-contract/commands.md, CaptureInfo meta).
 */
export function captureOffsets(
  info: Pick<CaptureInfo, 'meta'> | null,
  live: LiveCamOffsets | null,
): CamOffset[] {
  // `meta` itself is optional: a capture folder with no readable META.JSON
  // answers MEDIA_INFO without it (contract D20). Absent meta means no
  // recorded calibration, which is the live-calibration fallback below.
  const recorded = info?.meta?.calibration?.cams;
  return CAM_IDS.map((id) => {
    const c = recorded !== undefined ? recorded[id] : live?.cams[id];
    return { x: c?.x ?? 0, y: c?.y ?? 0, rot: c?.rot ?? 0 };
  });
}

const NEUTRAL_OFFSET: CamOffset = { x: 0, y: 0, rot: 0 };

/**
 * `captureOffsets` in **frame** order — each frame paired with the calibration
 * of the camera that actually took it.
 *
 * `captureOffsets` is indexed in CAM order, and the frames on a card are only
 * the cameras that answered (contract D23). Applying `offsets[i]` to
 * `images[i]` therefore handed camera 3's frame camera 2's correction the
 * moment CAM2 was missing. A frame whose name states no slot gets no
 * correction rather than the next one in line.
 */
export function offsetsForFrames(
  camOffsets: CamOffset[],
  frames: readonly { slot: CamId | null }[],
): CamOffset[] {
  return frames.map((frame) => {
    const at = slotIndex(frame.slot);
    return at >= 0 && at < camOffsets.length ? camOffsets[at] : NEUTRAL_OFFSET;
  });
}

/**
 * Produce one aligned, cropped canvas per frame supplied. `offsets` is in
 * frame order — see `offsetsForFrames`, never CAM order.
 * Returns null when there are no offsets to apply.
 */
export function buildAlignedFrames(
  images: HTMLImageElement[],
  offsets: CamOffset[],
): HTMLCanvasElement[] | null {
  if (!hasAnyOffset(offsets)) return null;
  const w = images[0].naturalWidth;
  const h = images[0].naturalHeight;
  const { crop, perFrame } = alignmentPlan(w, h, offsets);

  const work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  const wctx = work.getContext('2d')!;

  return images.map((img, i) => {
    const move = perFrame[i] ?? { dx: 0, dy: 0, rotDeg: 0 };
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.clearRect(0, 0, w, h);
    wctx.translate(w / 2 + move.dx, h / 2 + move.dy);
    wctx.rotate((move.rotDeg * Math.PI) / 180);
    wctx.drawImage(img, -w / 2, -h / 2);
    wctx.setTransform(1, 0, 0, 1, 0, 0);

    const out = document.createElement('canvas');
    out.width = crop.w;
    out.height = crop.h;
    out.getContext('2d')!.drawImage(work, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    return out;
  });
}
