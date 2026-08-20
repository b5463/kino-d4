// flashBandRisk is pure — no timers, no device, no RNG. These build a
// hand-rolled phase map (the same default free-running phases as
// choreography.test.ts) and assert the §16 coverage/banding math directly.
import { describe, expect, it } from 'vitest';
import type { CamId } from '@kino/kdp';
import { flashBandRisk } from '../src/flashRisk';

// Matches MockKinoDevice's default free-running cam phases (same constants
// as choreography.test.ts's DEFAULT_PHASES) and the D4's default frame
// interval.
const PHASES_US: Record<CamId, number> = { cam1: 7_420, cam2: 0, cam3: 21_880, cam4: 2_910 };
const FRAME_INTERVAL_US = 33_333;
const READOUT_US = 4_000;

describe('flashBandRisk', () => {
  it('a full-frame flash pulse covers every readout window completely — not banded', () => {
    const risk = flashBandRisk(PHASES_US, FRAME_INTERVAL_US, READOUT_US, 0, FRAME_INTERVAL_US);

    for (const cam of Object.keys(PHASES_US) as CamId[]) {
      expect(risk.perCamCoverage[cam]).toBeCloseTo(1, 6);
    }
    expect(risk.banded).toBe(false);
  });

  it('no flash at all leaves every readout window dark — not banded', () => {
    const risk = flashBandRisk(PHASES_US, FRAME_INTERVAL_US, READOUT_US, 0, 0);

    for (const cam of Object.keys(PHASES_US) as CamId[]) {
      expect(risk.perCamCoverage[cam]).toBe(0);
    }
    expect(risk.banded).toBe(false);
  });

  it("a short pulse landing on half of cam3's readout window bands the shot", () => {
    // The pulse [20_880, 23_880) overlaps only the first half of cam3's
    // [21_880, 25_880) readout window; the other three cams' windows
    // ([7_420, 11_420), [0, 4_000), [2_910, 6_910)) don't overlap it at all.
    const risk = flashBandRisk(PHASES_US, FRAME_INTERVAL_US, READOUT_US, 20_880, 3_000);

    expect(risk.perCamCoverage.cam3).toBeCloseTo(0.5, 6);
    expect(risk.perCamCoverage.cam1).toBe(0);
    expect(risk.perCamCoverage.cam2).toBe(0);
    expect(risk.perCamCoverage.cam4).toBe(0);
    expect(risk.banded).toBe(true);
  });

  it('treats exactly 5% and 95% coverage as safe boundary values', () => {
    const aligned: Record<CamId, number> = { cam1: 0, cam2: 0, cam3: 0, cam4: 0 };

    expect(flashBandRisk(aligned, 10_000, 1_000, 0, 50).banded).toBe(false);
    expect(flashBandRisk(aligned, 10_000, 1_000, 0, 51).banded).toBe(true);
    expect(flashBandRisk(aligned, 10_000, 1_000, 0, 949).banded).toBe(true);
    expect(flashBandRisk(aligned, 10_000, 1_000, 0, 950).banded).toBe(false);
  });
});
