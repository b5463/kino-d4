import type { CaptureRow } from './capture';

/**
 * The capture-time alignment calibration, read back out of
 * `captures.provenance`.
 *
 * Provenance is the passthrough remainder of the device's capture document
 * (see `apps/api/src/routes/device-captures.ts`): a firmware build that
 * records calibration sends it as `meta.calibration` on `kino.capture`, the
 * API lands it here untyped, and this is the one place the worker turns that
 * untrusted JSON back into numbers a render may act on.
 *
 * **No firmware records it yet** (firmware-contract/commands.md). Until one
 * does, this returns null for every real capture and the renders stay
 * untouched — a render must never invent offsets, and in particular must not
 * fall back to the *current* device calibration, which was measured for a
 * mechanical state the old capture may not have had.
 */

/** Alignment bounds, from docs/audit/CALIBRATION.md: offsets are clamped to
 * ±20 px / ±2° everywhere they are edited, so anything the wire delivers
 * outside that is clamped back rather than trusted. */
const MAX_OFFSET_PX = 20;
const MAX_ROT_DEG = 2;

export interface CaptureCalibration {
  /** Identifies the calibration state that produced the offsets. */
  version: string;
  /** Per-camera offsets, keyed `cam1`..`camN`, in sensor pixels / degrees. */
  cams: Record<string, { x: number; y: number; rot: number }>;
}

function clamp(value: number, bound: number): number {
  return Math.min(bound, Math.max(-bound, value));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `provenance.meta.calibration`, validated and clamped, or null.
 *
 * Null on *anything* malformed — a version that is not a non-empty string, a
 * cams block that is not an object, any offset that is not a finite number.
 * Partial trust would mean rendering with half a calibration, which is worse
 * than rendering with none: the crop would be computed for offsets that were
 * never applied.
 */
export function captureCalibration(
  capture: Pick<CaptureRow, 'provenance'>,
): CaptureCalibration | null {
  const provenance = asObject(capture.provenance);
  const meta = asObject(provenance?.['meta']);
  const calibration = asObject(meta?.['calibration']);
  if (calibration === null) return null;

  const version = calibration['version'];
  if (typeof version !== 'string' || version === '') return null;

  const rawCams = asObject(calibration['cams']);
  if (rawCams === null || Object.keys(rawCams).length === 0) return null;

  const cams: Record<string, { x: number; y: number; rot: number }> = {};
  for (const [cam, entry] of Object.entries(rawCams)) {
    const offsets = asObject(entry);
    if (offsets === null) return null;
    const x = offsets['x'];
    const y = offsets['y'];
    const rot = offsets['rot'];
    if (
      typeof x !== 'number' || !Number.isFinite(x) ||
      typeof y !== 'number' || !Number.isFinite(y) ||
      typeof rot !== 'number' || !Number.isFinite(rot)
    ) {
      return null;
    }
    cams[cam] = {
      x: clamp(x, MAX_OFFSET_PX),
      y: clamp(y, MAX_OFFSET_PX),
      rot: clamp(rot, MAX_ROT_DEG),
    };
  }

  return { version, cams };
}
