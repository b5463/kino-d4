import { describe, expect, it } from 'vitest';
import {
  captureOffsets,
  computeOverlapCrop,
  hasAnyOffset,
  SENSOR_BASE_W,
} from '../src/utils/wiggleRender';
import type { CaptureInfo } from '@kino/kdp';

// The pure geometry moved to @kino/media (audit #59) and its tests moved with
// it — packages/media/tests/alignment.test.ts owns the numbers now. What this
// suite keeps is Studio's own surface: the re-exports the rest of the app
// imports, and the capture-vs-live offset preference.
describe('wiggleRender re-exports', () => {
  it('still hands out the shared math', () => {
    expect(SENSOR_BASE_W).toBe(1600);
    expect(hasAnyOffset([{ x: 0, y: 0, rot: 0 }])).toBe(false);
    expect(hasAnyOffset([{ x: 2, y: 0, rot: 0 }])).toBe(true);
    const crop = computeOverlapCrop(800, 600, [{ x: -6, y: 3, rot: 0 }], 0.5);
    expect(crop.w).toBe(790);
    expect(crop.h).toBe(592);
  });
});

const LIVE = {
  cams: {
    cam1: { x: 1, y: 0, rot: 0 },
    cam2: { x: 0, y: 0, rot: 0 },
    cam3: { x: -1, y: 0, rot: 0 },
    cam4: { x: 2, y: 1, rot: 0.2 },
  },
};

function infoWith(calibration: NonNullable<CaptureInfo['meta']>['calibration']): Pick<CaptureInfo, 'meta'> {
  return {
    meta: {
      flash: false,
      batteryV: 3.9,
      p4Firmware: '0.1.0',
      cameraFirmware: [],
      gpioSkewUs: 0,
      exposure: [],
      calibration,
    },
  };
}

describe('captureOffsets', () => {
  it('prefers offsets recorded on the capture over live calibration', () => {
    const info = infoWith({
      version: 'cal-7',
      cams: { cam1: { x: 5, y: -2, rot: 0.5 } },
    });
    const offsets = captureOffsets(info, LIVE);
    expect(offsets[0]).toEqual({ x: 5, y: -2, rot: 0.5 });
    // Cams the recorded block omits are neutral, not backfilled from live —
    // mixing two calibration states would align with numbers no rig ever had.
    expect(offsets[1]).toEqual({ x: 0, y: 0, rot: 0 });
    expect(offsets[3]).toEqual({ x: 0, y: 0, rot: 0 });
  });

  it('falls back to live calibration when the capture carries none', () => {
    const offsets = captureOffsets(infoWith(undefined), LIVE);
    expect(offsets[0]).toEqual({ x: 1, y: 0, rot: 0 });
    expect(offsets[3]).toEqual({ x: 2, y: 1, rot: 0.2 });
  });

  it('is neutral with no info and no live calibration', () => {
    expect(captureOffsets(null, null)).toEqual([
      { x: 0, y: 0, rot: 0 },
      { x: 0, y: 0, rot: 0 },
      { x: 0, y: 0, rot: 0 },
      { x: 0, y: 0, rot: 0 },
    ]);
  });
});
