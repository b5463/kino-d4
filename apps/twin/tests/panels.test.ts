import { describe, expect, it } from 'vitest';
import type { TwinSnapshot } from '@kino/test-fixtures';
import { syncRows, tagLabel } from '../src/panels/SyncPanel';

function snapshot(): TwinSnapshot {
  const phases = { cam1: 0, cam2: 7_420, cam3: 21_880, cam4: 2_910 };
  return {
    sessionId: 'boot-1',
    maintenance: false,
    batteryV: 3.86,
    sdPresent: true,
    sdFreeMB: 1_024,
    uartBaud: 1_500_000,
    frameIntervalUs: 33_333,
    phaseAligned: false,
    p4Fw: '0.9.0',
    firmwareProfile: 'd4-sim-full',
    simulatedFuture: true,
    cams: Object.fromEntries(
      Object.entries(phases).map(([cam, phaseUs], index) => [
        cam,
        {
          fw: '0.1.0',
          phaseUs,
          uartErrors: 0,
          jpegKB: 1_000,
          durationMs: 100,
          gpioSkewUs: index * 100,
          fault: null,
          updating: false,
    exposureUs: 16_667,
    focus: null,
        },
      ]),
    ) as TwinSnapshot['cams'],
    roll: { joined: false, name: null },
    uploads: { pending: 0, uploading: 0, failed: 0, uploaded: 0 },
    wifi: 'connected',
    scenarios: {} as TwinSnapshot['scenarios'],
  };
}

describe('Task 19 panel helpers', () => {
  it('returns exactly three distinct sync metrics and grades VSYNC spread', () => {
    const rows = syncRows(snapshot());
    expect(rows.map((row) => row.metric)).toEqual([
      'GPIO DISTRIBUTION SKEW',
      'VSYNC PHASE SKEW',
      'EFFECTIVE EXPOSURE SKEW',
    ]);
    expect(rows[1]).toMatchObject({ spreadUs: 21_880, grade: { grade: 'unacceptable' } });
  });

  it('keeps provenance labels blunt', () => {
    expect(tagLabel('ESTIMATED')).toBe('ESTIMATED');
    expect(tagLabel('SIMULATED')).toBe('SIMULATED');
  });
});
