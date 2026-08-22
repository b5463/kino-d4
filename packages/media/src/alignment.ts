/**
 * Calibration alignment geometry — one answer to "where does each frame move,
 * and what crop survives it".
 *
 * Studio previews a wiggle with per-camera x/y/rotation corrections and a
 * common overlap crop; the worker bakes the WebP and MP4 a guest gets. Those
 * two must be the same photograph, so the geometry lives here — the package
 * both of them already share for frame order — rather than being computed once
 * in a canvas and once in sharp. The *execution* stays with each consumer
 * (canvas 2D in Studio, sharp in the worker): this module has no pixels, only
 * numbers, which is what keeps it importable from a browser (see the
 * dependency note in `sequence.ts`).
 *
 * Offsets are measured in sensor pixels at the 1600-wide capture base and
 * scaled to whatever resolution the consumer actually holds.
 */

/** The sensor width the stored x/y offsets are measured against. */
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

/** One frame's move, in source pixels: translate by (dx, dy), rotate rotDeg about its centre. */
export interface FrameTransform {
  dx: number;
  dy: number;
  rotDeg: number;
}

export interface AlignmentPlan {
  /** The common crop, in source pixels, after every frame has moved. */
  crop: { x: number; y: number; w: number; h: number };
  /** Per-frame transforms, in `offsets` order. */
  perFrame: FrameTransform[];
}

/**
 * The whole alignment, as numbers a renderer executes verbatim: scale the
 * stored sensor-base offsets to this source's resolution, and inset a crop
 * that every moved frame still covers. Rotation is resolution-independent and
 * passes through unscaled.
 */
export function alignmentPlan(
  sourceW: number,
  sourceH: number,
  offsets: CamOffset[],
): AlignmentPlan {
  const scale = sourceW / SENSOR_BASE_W;
  return {
    crop: computeOverlapCrop(sourceW, sourceH, offsets, scale),
    perFrame: offsets.map((o) => ({ dx: o.x * scale, dy: o.y * scale, rotDeg: o.rot })),
  };
}
