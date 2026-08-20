// KINO Twin §16: qualitative thermal zones for the Twin's dashboard. None of
// this is a measured thermal model — every threshold below is a rough,
// documented guess (SIMULATED), meant to give the 3D view *some* signal for
// "this is getting warm," not a datasheet-accurate temperature curve. Say so
// here rather than dressing these numbers up as anything more (§7.5/§14).
import type { ActivityState, PowerSample } from './power';

export type ThermalState = 'COOL' | 'WARM' | 'HOT' | 'CRITICAL';
export type ThermalZone = 'battery' | 'sw6106' | 'led' | 'heatsink' | 'batteryConnector';

const LEVELS: ThermalState[] = ['COOL', 'WARM', 'HOT', 'CRITICAL'];
const ZONES: ThermalZone[] = ['battery', 'sw6106', 'led', 'heatsink', 'batteryConnector'];

// One qualitative step registers per full MS_PER_STEP of real time, however
// that time arrives — one 500 ms call, or many smaller ones. At
// TwinSimulator's 2 Hz power sampling that's one step per tick; a much
// larger dtMs (e.g. a fast-forwarded replay) advances proportionally more
// steps in a single call.
//
// task-7 review, round 1 (finding #3): the original version floored a
// *minimum* of one step regardless of dtMs, so a consumer calling this once
// per animation frame (~16 ms) would race COOL -> CRITICAL in 3 calls —
// dozens of times faster than intended, silently.
//
// task-7 review, round 2: simply flooring dtMs/MS_PER_STEP without a
// minimum swapped that bug for a different one — every sub-period call
// independently floored to zero steps, so a per-frame caller would NEVER
// advance, no matter how much real time actually elapsed. Fixed by carrying
// the leftover sub-period time forward as `carryMs` (see ThermalStepResult
// below), controller-authorized to extend the brief's given
// `Record<ThermalZone, ThermalState>` shape for exactly this reason — a
// discrete per-zone state has no room to bank a fractional step, so the
// carry has to live somewhere else. `carryMs` defaults to 0 so a caller
// that always passes dtMs >= MS_PER_STEP (every existing call site) doesn't
// need to change anything about how it calls this function, only how it
// reads the result back (see thermalStep's return type).
const MS_PER_STEP = 500;

/** Where a zone's temperature is heading given the current power sample and activity — not where it already is. */
function targetFor(zone: ThermalZone, sample: PowerSample, activity: ActivityState): ThermalState {
  switch (zone) {
    case 'battery':
      // Discharge current is the pack's own heat source.
      if (sample.warnings.includes('CRITICAL_OVER_6A')) return 'CRITICAL';
      if (sample.fuse === 'warm' || sample.warnings.includes('SUSTAINED_OVER_3A')) return 'HOT';
      if (sample.warnings.includes('TRANSIENT_3_6A')) return 'WARM';
      return 'COOL';

    case 'batteryConnector':
      // Resistive heating at the connector — same discharge current as the
      // pack, plus whatever's coming in through the same lead while charging.
      if (sample.warnings.includes('CRITICAL_OVER_6A') || sample.warnings.includes('CHARGE_OVER_MAX')) {
        return 'CRITICAL';
      }
      if (
        sample.fuse === 'warm' ||
        sample.warnings.includes('SUSTAINED_OVER_3A') ||
        sample.warnings.includes('CHARGE_ABOVE_PREFERRED')
      ) {
        return 'HOT';
      }
      if (sample.warnings.includes('TRANSIENT_3_6A')) return 'WARM';
      return 'COOL';

    case 'sw6106':
      // Boost-converter loss is what's actually heating this chip.
      if (sample.boostLossW > 4) return 'CRITICAL';
      if (sample.boostLossW > 2) return 'HOT';
      if (sample.boostLossW > 0.8) return 'WARM';
      return 'COOL';

    case 'heatsink':
      // Same heat path as sw6106 (thermally bonded), but with more mass —
      // needs a hotter driver before it visibly follows.
      if (sample.boostLossW > 5) return 'CRITICAL';
      if (sample.boostLossW > 3) return 'HOT';
      if (sample.boostLossW > 1.5) return 'WARM';
      return 'COOL';

    case 'led':
      // The controlled-testing-only current (§7.10) is the one that risks
      // real heat; the default/experimental currents just run warm.
      if (activity.flashA >= 0.65) return 'CRITICAL';
      if (activity.flashA >= 0.5) return 'HOT';
      if (activity.flashA > 0) return 'WARM';
      return 'COOL';
  }
}

export interface ThermalStepResult {
  zones: Record<ThermalZone, ThermalState>;
  /** Sub-period real time (< MS_PER_STEP) not yet spent on a step — feed this back in as the next call's `carryMs`. */
  carryMs: number;
}

export function thermalStep(
  prev: Record<ThermalZone, ThermalState>,
  sample: PowerSample,
  activity: ActivityState,
  dtMs: number,
  carryMs = 0,
): ThermalStepResult {
  const totalMs = carryMs + dtMs;
  const steps = Math.floor(totalMs / MS_PER_STEP);
  const nextCarryMs = totalMs - steps * MS_PER_STEP;

  const zones = {} as Record<ThermalZone, ThermalState>;
  for (const zone of ZONES) {
    const current = LEVELS.indexOf(prev[zone]);
    const target = LEVELS.indexOf(targetFor(zone, sample, activity));
    const idx = target > current ? Math.min(target, current + steps)
      : target < current ? Math.max(target, current - steps)
      : current;
    zones[zone] = LEVELS[idx];
  }

  return { zones, carryMs: nextCarryMs };
}
