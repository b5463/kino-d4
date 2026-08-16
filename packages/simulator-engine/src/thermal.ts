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

// thermalStep is stateless beyond `prev` (a discrete ThermalState per zone
// has no room for a fractional-progress accumulator, and the brief's given
// signature doesn't carry one either), so a step only registers once a full
// MS_PER_STEP has actually elapsed *in this one call*. At TwinSimulator's
// 2 Hz power sampling (500 ms/tick) that's one step per tick; a much larger
// dtMs (e.g. a fast-forwarded replay) advances proportionally more steps in
// the one call. task-7 review finding #3: this used to floor a *minimum* of
// one step regardless of dtMs, so a consumer calling this once per animation
// frame (~16 ms) would race COOL -> CRITICAL in 3 calls — dozens of times
// faster than intended, silently. There's no cross-call accumulator here, so
// a sub-period dtMs now correctly contributes zero steps rather than a
// forced one; a caller that wants this to actually respond at a cadence
// faster than MS_PER_STEP needs to accumulate its own elapsed time and only
// call once enough of it has passed (the same way TwinSimulator does at
// 2 Hz), since there's nowhere in this discrete-state contract to bank a
// partial step between calls.
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

export function thermalStep(
  prev: Record<ThermalZone, ThermalState>,
  sample: PowerSample,
  activity: ActivityState,
  dtMs: number,
): Record<ThermalZone, ThermalState> {
  const steps = Math.floor(dtMs / MS_PER_STEP);
  const next = {} as Record<ThermalZone, ThermalState>;

  for (const zone of ZONES) {
    const current = LEVELS.indexOf(prev[zone]);
    const target = LEVELS.indexOf(targetFor(zone, sample, activity));
    const idx = target > current ? Math.min(target, current + steps)
      : target < current ? Math.max(target, current - steps)
      : current;
    next[zone] = LEVELS[idx];
  }

  return next;
}
