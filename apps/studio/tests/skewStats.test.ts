import { describe, expect, it } from 'vitest';
import { bandForSpreadMs, skewStats, spreadUs } from '../src/skew/skewStats';
import type { SkewBand, SkewRun } from '../src/skew/skewStats';

describe('skewStats', () => {
  it('computes mean, median, max and count', () => {
    const stats = skewStats([100, 200, 300, 400]);
    expect(stats.mean).toBe(250);
    expect(stats.median).toBe(250);
    expect(stats.max).toBe(400);
    expect(stats.count).toBe(4);
  });

  it('takes the median of the middle value for an odd sample count', () => {
    expect(skewStats([30, 10, 20]).median).toBe(20);
  });

  it('takes p95 by nearest rank — the 95th sorted value of 100 samples', () => {
    // 100..1, so an unsorted input proves the function sorts before ranking.
    const descending = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(skewStats(descending).p95).toBe(95);
  });

  it('takes p95 by nearest rank for sample counts that do not divide evenly', () => {
    // n=20 -> ceil(0.95 * 20) - 1 = 18 -> the 19th sorted value.
    const samples = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(skewStats(samples).p95).toBe(19);
    // n=4 -> ceil(3.8) - 1 = 3 -> the 4th sorted value.
    expect(skewStats([100, 200, 300, 400]).p95).toBe(400);
  });

  it('reports every statistic as the sample itself for a single sample', () => {
    expect(skewStats([137])).toEqual({ mean: 137, median: 137, p95: 137, max: 137, count: 1 });
  });

  it('throws on empty input', () => {
    expect(() => skewStats([])).toThrow();
  });

  it('throws on a non-finite sample rather than sorting it to an arbitrary position', () => {
    // A NaN makes the (a,b) => a-b comparator inconsistent, so sort order is
    // arbitrary: this used to report max 120, hiding a 9 ms outlier as 'excellent'.
    expect(() => skewStats([9000, NaN, 120])).toThrow();
    expect(() => skewStats([100, Infinity])).toThrow();
    expect(() => skewStats([100, -Infinity])).toThrow();
  });

  it('throws when an array hole yields an undefined sample', () => {
    expect(() => skewStats([10, undefined as unknown as number, 30])).toThrow();
  });

  it('does not mutate the caller array', () => {
    const samples = [400, 100, 300, 200];
    skewStats(samples);
    expect(samples).toEqual([400, 100, 300, 200]);
  });
});

describe('bandForSpreadMs', () => {
  // 02§10 / 07§18: <0.5 excellent, 0.5-1 very good, 1-2 good target,
  // 2-5 warning, 5-10 poor, >10 fail. Bands are half-open [lower, upper),
  // except the last: the spec says ">10" fails, so exactly 10 is still poor.
  const boundaries: Array<[number, SkewBand]> = [
    [0, 'excellent'],
    [0.49, 'excellent'],
    [0.499, 'excellent'],
    [0.5, 'very-good'],
    [0.999, 'very-good'],
    [1, 'good'],
    [1.999, 'good'],
    [2, 'warning'],
    [4.999, 'warning'],
    [5, 'poor'],
    [10, 'poor'],
    [10.01, 'fail'],
    [250, 'fail'],
  ];

  for (const [spreadMs, band] of boundaries) {
    it(`maps ${spreadMs} ms to '${band}'`, () => {
      expect(bandForSpreadMs(spreadMs)).toBe(band);
    });
  }

  it('throws on a negative spread instead of reading it as excellent', () => {
    // A spread is max - min, so it is never negative; a signed offset that
    // reached here is a caller bug, not a 'excellent' sync result.
    expect(() => bandForSpreadMs(-5)).toThrow();
    expect(() => bandForSpreadMs(-0.001)).toThrow();
  });

  it('throws on a non-finite spread instead of falling through to fail', () => {
    expect(() => bandForSpreadMs(NaN)).toThrow();
    expect(() => bandForSpreadMs(Infinity)).toThrow();
    expect(() => bandForSpreadMs(undefined as unknown as number)).toThrow();
  });
});

describe('spreadUs', () => {
  it('returns max minus min within one trigger', () => {
    expect(spreadUs([0, 90, 140, 110])).toBe(140);
  });

  it('handles negative offsets', () => {
    expect(spreadUs([-200, 0, 300])).toBe(500);
  });

  it('returns zero for a single camera', () => {
    expect(spreadUs([420])).toBe(0);
  });

  it('throws on empty input rather than reporting a fabricated zero spread', () => {
    expect(() => spreadUs([])).toThrow();
  });

  it('throws on a non-finite offset instead of silently dropping a camera', () => {
    expect(() => spreadUs([0, NaN, 300])).toThrow();
    expect(() => spreadUs([0, Infinity, 300])).toThrow();
    expect(() => spreadUs([0, -Infinity, 300])).toThrow();
  });

  it('throws when an array hole yields an undefined offset', () => {
    expect(() => spreadUs([0, undefined as unknown as number, 300])).toThrow();
  });

  it('does not mutate the caller array', () => {
    const offsets = [140, 0, 110, 90];
    spreadUs(offsets);
    expect(offsets).toEqual([140, 0, 110, 90]);
  });
});

describe('SkewRun', () => {
  it('carries per-camera offsets for a camera count that is not four', () => {
    const threeCameras: SkewRun = {
      metric: 'vsync',
      perCameraUs: [
        { camera: 1, offsetsUs: [0, 10] },
        { camera: 2, offsetsUs: [610, 600] },
        { camera: 3, offsetsUs: [1200, 1210] },
      ],
    };
    const firstTrigger = threeCameras.perCameraUs.map((cam) => cam.offsetsUs[0]);
    expect(firstTrigger).toHaveLength(3);
    expect(spreadUs(firstTrigger)).toBe(1200);
    expect(bandForSpreadMs(spreadUs(firstTrigger) / 1000)).toBe('good');

    const sixCameras: SkewRun = {
      metric: 'gpio',
      perCameraUs: Array.from({ length: 6 }, (_, i) => ({
        camera: i + 1,
        offsetsUs: [i * 30],
      })),
    };
    const gpioTrigger = sixCameras.perCameraUs.map((cam) => cam.offsetsUs[0]);
    expect(spreadUs(gpioTrigger)).toBe(150);
    expect(bandForSpreadMs(spreadUs(gpioTrigger) / 1000)).toBe('excellent');
  });

  it('represents a metric the device could not measure (04§13: null + reason)', () => {
    const unavailable: SkewRun = {
      metric: 'exposure',
      perCameraUs: [],
      unavailableReason: 'sensor does not expose exposure timestamps',
    };
    expect(unavailable.perCameraUs).toHaveLength(0);
    expect(unavailable.unavailableReason).toBe('sensor does not expose exposure timestamps');
  });
});
