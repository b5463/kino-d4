// Calibration-aware wiggle rendering: apply each camera's stored x/y/rot
// correction, then crop all four frames to the common overlap region so
// exports don't show swimming edges. Offsets are in sensor pixels at the
// 1600-wide capture base.

export const SENSOR_BASE_W = 1600;

export interface CamOffset {
  x: number;
  y: number;
  rot: number; // degrees
}

export function hasAnyOffset(offsets: CamOffset[]): boolean {
  return offsets.some((o) => o.x !== 0 || o.y !== 0 || o.rot !== 0);
}

/** Common crop (inset per side), even-sized for video encoders. */
export function computeOverlapCrop(
  w: number,
  h: number,
  offsets: CamOffset[],
  scale: number,
): { x: number; y: number; w: number; h: number } {
  const maxX = Math.max(...offsets.map((o) => Math.abs(o.x)), 0) * scale;
  const maxY = Math.max(...offsets.map((o) => Math.abs(o.y)), 0) * scale;
  const maxRot = Math.max(...offsets.map((o) => Math.abs(o.rot)), 0);
  // Rotation sweeps corners by ~sin(rot) × half-diagonal.
  const slack = Math.sin((maxRot * Math.PI) / 180) * (Math.hypot(w, h) / 2);
  const insetX = Math.ceil(maxX + slack) + 2;
  const insetY = Math.ceil(maxY + slack) + 2;
  const cw = Math.max(16, w - 2 * insetX) & ~1;
  const ch = Math.max(16, h - 2 * insetY) & ~1;
  return { x: Math.floor((w - cw) / 2), y: Math.floor((h - ch) / 2), w: cw, h: ch };
}

/**
 * Produce four aligned, cropped canvases from the original frames.
 * Returns null when there are no offsets to apply.
 */
export function buildAlignedFrames(
  images: HTMLImageElement[],
  offsets: CamOffset[],
): HTMLCanvasElement[] | null {
  if (!hasAnyOffset(offsets)) return null;
  const w = images[0].naturalWidth;
  const h = images[0].naturalHeight;
  const scale = w / SENSOR_BASE_W;
  const crop = computeOverlapCrop(w, h, offsets, scale);

  const work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  const wctx = work.getContext('2d')!;

  return images.map((img, i) => {
    const o = offsets[i] ?? { x: 0, y: 0, rot: 0 };
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.clearRect(0, 0, w, h);
    wctx.translate(w / 2 + o.x * scale, h / 2 + o.y * scale);
    wctx.rotate((o.rot * Math.PI) / 180);
    wctx.drawImage(img, -w / 2, -h / 2);
    wctx.setTransform(1, 0, 0, 1, 0, 0);

    const out = document.createElement('canvas');
    out.width = crop.w;
    out.height = crop.h;
    out.getContext('2d')!.drawImage(work, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    return out;
  });
}
