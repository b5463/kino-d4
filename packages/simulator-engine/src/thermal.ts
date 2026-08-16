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

// thermalStep is stateless beyond `prev` — there's no hidden per-zone
// accumulator — so "one qualitative step per call" is scaled by how many
// nominal sample periods `dtMs` actually spans. At TwinSimulator's 2 Hz
// power sampling (500 ms/tick) that's one step per tick; a much larger
// dtMs (e.g. a fast-forwarded replay) advances proportionally more steps in
// the one call instead of losing progress between ticks.
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
  const steps = Math.max(1, Math.floor(dtMs / MS_PER_STEP));
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
