// Power-load ladder: what the Twin's power model says an activity costs,
// next to what the device's own ADC read while that activity ran.
//
// There is exactly one power model in this repo — `computePower` in
// @kino/simulator-engine, against the `power` block of the hardware profile.
// Nothing here re-derives a current or a voltage; every ESTIMATED number in a
// row comes straight out of that call.
//
// The comparison is battery volts, not amps, because GET_POWER_STATUS has no
// current field: the firmware reports batteryV (and busV when it has a rail
// ADC), so volts is the only quantity where a measurement and a prediction
// exist for the same rung. The estimated current is still printed, as the
// input that produced the predicted voltage.
import { computePower, ACTIVITY_PRESETS } from '@kino/simulator-engine';
import type { ActivityState, PowerSample } from '@kino/simulator-engine';
import type { PowerProfile } from '@kino/hardware-profiles';
import type { FlashLevel } from '@kino/kdp';

export type PowerRungId =
  | 'idle'
  | 'preview'
  | 'quad'
  | 'flash-low'
  | 'flash-medium'
  | 'flash-high'
  | 'uart';

export interface PowerRung {
  id: PowerRungId;
  /** Bench label, printed as the row name. */
  label: string;
  /** The KDP command that drives this rung. Printed, so the row can be reproduced by hand. */
  command: string;
  /** Fed verbatim to `computePower`. */
  activity: ActivityState;
}

/** Everything GET_POWER_STATUS answered while one rung was on the wire. */
export interface PowerRungSamples {
  id: PowerRungId;
  /** Battery volts, one entry per answered poll. Empty means the device never answered. */
  batteryV: number[];
  /** 5 V rail volts. Shorter than `batteryV` on firmware without a rail ADC. */
  busV: number[];
  /** Why the rung's drive command failed, when it did. */
  error?: string | null;
}

export interface PowerMeasured {
  /** Deepest sag seen while the rung ran — the load's actual cost. */
  minBatteryV: number;
  meanBatteryV: number;
  /** null when the firmware reports no rail voltage. */
  minBusV: number | null;
  samples: number;
}

export interface PowerLoadRow {
  id: PowerRungId;
  label: string;
  command: string;
  /** Straight from `computePower` — ESTIMATED. */
  estimated: PowerSample;
  /** null when the device answered nothing for this rung. Never a zero stand-in. */
  measured: PowerMeasured | null;
  /**
   * MEASURED minus ESTIMATED battery volts. Negative means the pack sagged
   * deeper than the model predicted — the model is under-counting the load.
   */
  divergenceV: number | null;
  /** `divergenceV` as a percentage of the estimated voltage. */
  divergencePct: number | null;
  error: string | null;
}

/** §7.10/§16 flash currents, the same three the profile carries loads for. */
const FLASH_AMPS: Record<FlashLevel, 0.35 | 0.5 | 0.65> = {
  low: 0.35,
  medium: 0.5,
  high: 0.65,
};

const FLASH_RUNG_ID: Record<FlashLevel, PowerRungId> = {
  low: 'flash-low',
  medium: 'flash-medium',
  high: 'flash-high',
};

/**
 * The ladder, in the order it is driven: nothing running, then one more
 * subsystem at a time. `flash` and `uart` are capability-gated by the caller —
 * a rung the firmware cannot drive is left out rather than reported empty.
 */
export function powerLoadRungs(opts: { flash: FlashLevel[]; uart: boolean }): PowerRung[] {
  const rungs: PowerRung[] = [
    {
      id: 'idle',
      label: 'IDLE',
      command: 'GET_POWER_STATUS only',
      activity: ACTIVITY_PRESETS.idle,
    },
    {
      id: 'preview',
      label: 'CAM2 PREVIEW',
      command: 'CAMERA_PREVIEW cam2',
      activity: ACTIVITY_PRESETS.preview,
    },
    {
      id: 'quad',
      label: 'QUAD CAPTURE',
      command: 'CAMERA_CAPTURE timing-test',
      activity: ACTIVITY_PRESETS.quadCapture,
    },
  ];

  for (const level of opts.flash) {
    rungs.push({
      id: FLASH_RUNG_ID[level],
      label: `CAPTURE + FLASH ${level.toUpperCase()} (${FLASH_AMPS[level] * 1000} mA)`,
      command: `CAMERA_CALIBRATE flash-test ${level}`,
      // The only difference from the quad rung is the flash current, so the
      // preset is reused rather than restated.
      activity: { ...ACTIVITY_PRESETS.quadCapture, flashA: FLASH_AMPS[level] },
    });
  }

  if (opts.uart) {
    rungs.push({
      id: 'uart',
      label: 'UART TRANSFER',
      command: 'LINK_BENCH at the current baud',
      activity: ACTIVITY_PRESETS.uartTransfer,
    });
  }

  return rungs;
}

function summarize(samples: PowerRungSamples | undefined): PowerMeasured | null {
  if (!samples || samples.batteryV.length === 0) return null;
  const sum = samples.batteryV.reduce((a, v) => a + v, 0);
  return {
    minBatteryV: Math.min(...samples.batteryV),
    meanBatteryV: sum / samples.batteryV.length,
    minBusV: samples.busV.length > 0 ? Math.min(...samples.busV) : null,
    samples: samples.batteryV.length,
  };
}

/**
 * One row per rung: the engine's prediction, the device's samples, and the
 * gap between them. Pure — no device, no clock, no React.
 */
export function buildPowerLoadSeries(
  profile: PowerProfile,
  rungs: PowerRung[],
  samples: PowerRungSamples[],
): PowerLoadRow[] {
  const byId = new Map(samples.map((s) => [s.id, s]));

  return rungs.map((rung) => {
    const entry = byId.get(rung.id);
    const estimated = computePower(profile, profile.loads, rung.activity);
    const measured = summarize(entry);
    const divergenceV = measured === null ? null : measured.minBatteryV - estimated.batteryV;

    return {
      id: rung.id,
      label: rung.label,
      command: rung.command,
      estimated,
      measured,
      divergenceV,
      divergencePct:
        divergenceV === null || estimated.batteryV === 0
          ? null
          : (divergenceV / estimated.batteryV) * 100,
      error: entry?.error ?? null,
    };
  });
}

/** Largest absolute divergence across the measured rungs, or null when nothing was measured. */
export function worstDivergence(rows: PowerLoadRow[]): PowerLoadRow | null {
  let worst: PowerLoadRow | null = null;
  let worstAbs = -1;
  for (const row of rows) {
    if (row.divergenceV === null) continue;
    const abs = Math.abs(row.divergenceV);
    if (abs > worstAbs) {
      worstAbs = abs;
      worst = row;
    }
  }
  return worst;
}
