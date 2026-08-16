// KINO Twin §7/§15: bus + battery power model. A sample is the sum of
// whatever's currently drawing current (§15's activity states), converted
// through the boost converter back to what the battery actually has to
// supply. Battery-side current and voltage are mutually dependent — more
// current means more IR drop, which lowers battery voltage, which raises
// the current needed for the same bus power — so that pair is solved with a
// short fixed-point relaxation rather than a closed form. Nothing here reads
// a clock or RNG: `prev` carries whatever timestamp bookkeeping the caller
// (TwinSimulator) wants evaluated, so replay stays deterministic (§21).
import type { CamId } from '@kino/kdp';
import { CAM_IDS } from '@kino/kdp';
import type { PowerProfile, ProvenanceTag } from '@kino/hardware-profiles';

export interface ActivityState {
  p4On: boolean;
  camsOn: CamId[];
  camsCapturing: CamId[];
  uartActive: CamId[];
  flashA: 0 | 0.35 | 0.5 | 0.65;
  wifiUploading: boolean;
  chargingA: number; // 0 = not charging
}

export type PowerWarning =
  | 'SUSTAINED_OVER_3A'
  | 'TRANSIENT_3_6A'
  | 'CRITICAL_OVER_6A'
  | 'CHARGE_ABOVE_PREFERRED'
  | 'CHARGE_OVER_MAX'
  | 'BUS_SAG';

export interface PowerSample {
  batteryV: number;
  batteryA: number;
  busV: number;
  busA: number;
  boostLossW: number;
  fuse: 'ok' | 'warm' | 'blown';
  warnings: PowerWarning[];
  tags: Record<'batteryA' | 'busV' | 'boostLossW' | 'batteryV', ProvenanceTag>; // every number tagged (§15)
}

// §15: the carrier regulates a 5 V rail off the boost converter (net names
// 5V_SW/5V_BUS/5V_OUT in the hardware profile) — no field in PowerProfile
// carries this voltage, so it's a fixed engine constant rather than a
// provenance-tagged measurement.
const BUS_NOMINAL_V = 5;

// §7.4/§15 Global Constraints, verbatim: "sustained = >3 A for >5 s".
const SUSTAINED_MS = 5_000;
// §7.5: no real fuse I²t curve is modeled — this is a straight dwell-time
// approximation (rated current + a fixed warm-up time), not a datasheet
// blow-time curve. Say so here rather than dressing it up as more than it is.
const FUSE_WARM_MS = 10_000;

// The battery is always evaluated at a fixed 80% state of charge for this
// task — there's no discharge-over-session model yet (§7.5).
const START_SOC = 0.8;

const TAG_SEVERITY: Record<ProvenanceTag, number> = {
  MEASURED: 0,
  MANUFACTURER: 1,
  SELLER: 2,
  ESTIMATED: 3,
  SIMULATED: 4,
};

/** The least-confident tag among the given tags (empty input reads as ungrounded — SIMULATED). */
function worstTag(tags: ProvenanceTag[]): ProvenanceTag {
  if (tags.length === 0) return 'SIMULATED';
  return tags.reduce((worst, tag) => (TAG_SEVERITY[tag] > TAG_SEVERITY[worst] ? tag : worst));
}

/**
 * A deliberately simplified LiPo open-circuit-voltage shape, normalized so
 * ~100% SoC reads a bit above the 3.7 V nominal cell and it sags hard near
 * empty, with a flat plateau through the middle (§7.5 — this is a SIMULATED
 * curve, not a measured discharge profile). Only ever called with the fixed
 * START_SOC in this task; the general shape is kept so a future task can
 * feed it a real state of charge without reshaping this function.
 */
function socCurve(soc: number): number {
  if (soc >= 0.9) return 1.03 + (soc - 0.9) * 0.32; // knee near full charge
  if (soc <= 0.2) return 0.85 - (0.2 - soc) * 0.75; // steep drop near empty
  return 0.97 + (soc - 0.2) * (0.06 / 0.7); // flat plateau through the middle
}

/** Sums every load `activity` currently has switched on, and collects each one's provenance tag. */
function activeLoads(loads: PowerProfile['loads'], activity: ActivityState): { busA: number; tags: ProvenanceTag[] } {
  let busA = 0;
  const tags: ProvenanceTag[] = [];
  const addLoad = (key: string) => {
    const load = loads[key];
    busA += load.amps;
    tags.push(load.tag);
  };

  if (activity.p4On) addLoad('p4Display');

  // A powered cam that's exposing this frame or still flushing its JPEG over
  // UART draws the active current; any other powered cam is idle.
  for (const cam of activity.camsOn) {
    const busy = activity.camsCapturing.includes(cam) || activity.uartActive.includes(cam);
    addLoad(busy ? 'camActive' : 'camIdle');
  }

  if (activity.flashA !== 0) {
    // ActivityState.flashA already IS the drawn current (350/500/650 mA) —
    // not a loads-table lookup — so it's added directly. The matching
    // preset load's tag is still borrowed for provenance purposes.
    const flashKey = activity.flashA === 0.35 ? 'flash350' : activity.flashA === 0.5 ? 'flash500' : 'flash650';
    busA += activity.flashA;
    tags.push(loads[flashKey].tag);
  }

  if (activity.wifiUploading) addLoad('wifiTx');

  return { busA, tags };
}

export function computePower(
  profile: PowerProfile,
  loads: PowerProfile['loads'],
  activity: ActivityState,
  prev?: { overAsinceMs: number | null; nowMs: number },
): PowerSample {
  const { busA, tags: loadTags } = activeLoads(loads, activity);
  const busW = BUS_NOMINAL_V * busA;

  const openCircuitV = profile.battery.nominalV * socCurve(START_SOC);
  let batteryV = openCircuitV;
  let batteryA = 0;
  // Fixed-point relaxation for the mutually-dependent batteryA/batteryV
  // pair described up top. This converges in a handful of iterations for
  // any current this hardware could plausibly draw; the loop count is just
  // a safety margin, not a tuned constant. `Math.max(..., 0.5)` guards
  // against the loop diverging to a non-physical voltage for pathological
  // (e.g. test-only) inputs — it's a numerical safety rail, not a battery
  // cutoff model.
  for (let i = 0; i < 50; i++) {
    batteryA = busW / (batteryV * profile.boost.efficiency.value);
    batteryV = Math.max(openCircuitV - batteryA * profile.battery.internalOhm.value, 0.5);
  }

  const boostLossW = batteryA * batteryV - busW;

  const warnings: PowerWarning[] = [];

  // §7.4/§15: discharge safety bands against the harness limits (safe
  // continuous vs. very-short-pulse).
  const overSafeContinuous = batteryA > profile.battery.safeContinuousA;
  const overShortPulse = batteryA > profile.battery.shortPulseMaxA;
  const overDurationMs =
    overSafeContinuous && prev?.overAsinceMs != null ? prev.nowMs - prev.overAsinceMs : 0;

  if (overShortPulse) {
    warnings.push('CRITICAL_OVER_6A');
  } else if (overSafeContinuous) {
    warnings.push(overDurationMs > SUSTAINED_MS ? 'SUSTAINED_OVER_3A' : 'TRANSIENT_3_6A');
  }

  let fuse: PowerSample['fuse'] = 'ok';
  if (overShortPulse) fuse = 'blown';
  else if (overSafeContinuous && overDurationMs > FUSE_WARM_MS) fuse = 'warm';

  // Charging is the opposite direction through the same battery — its own
  // independent limits (§7.4/§16), never mixed into the discharge warnings
  // above. Never modeled as acceptable at the harness's 3 A/1C rate (§7.4).
  if (activity.chargingA > profile.battery.chargeMaxA) warnings.push('CHARGE_OVER_MAX');
  else if (activity.chargingA > profile.battery.chargePreferredA) warnings.push('CHARGE_ABOVE_PREFERRED');

  // §7.5: the boost converter's regulation/dropout behavior isn't modeled —
  // this is a "can't hold the rail past a short pulse" approximation, not a
  // measured dropout curve.
  const busSag = overShortPulse;
  const busV = busSag ? BUS_NOMINAL_V * (profile.battery.shortPulseMaxA / batteryA) : BUS_NOMINAL_V;
  if (busSag) warnings.push('BUS_SAG');

  const tag = worstTag(loadTags);

  return {
    batteryV,
    batteryA,
    busV,
    busA,
    boostLossW,
    fuse,
    warnings,
    tags: {
      // Grounded in whichever active loads are least-confidently sourced.
      batteryA: tag,
      boostLossW: tag,
      // The regulated rail is a manufacturer spec (SW6106 boost target)
      // right up until the model says it can't hold that — at that point
      // the reported sag is this engine's own approximation, not the chip's.
      busV: busSag ? 'SIMULATED' : 'MANUFACTURER',
      // §14: this is the sag-model's output alone — no measured V1 pack
      // ever backs this number, regardless of which loads are active — so
      // it is always tagged SIMULATED, never presented as measured.
      batteryV: 'SIMULATED',
    },
  };
}

const ALL_CAMS: CamId[] = [...CAM_IDS];

// §15 power states used to exercise computePower with realistic combinations
// of the D4's own activity, from nothing running to every subsystem racing
// at once.
export const ACTIVITY_PRESETS: Record<
  'idle' | 'preview' | 'quadCapture' | 'captureFlash' | 'uartTransfer' | 'wifiUpload' | 'worstOverlap',
  ActivityState
> = {
  // P4 display running, nothing else drawing power.
  idle: { p4On: true, camsOn: [], camsCapturing: [], uartActive: [], flashA: 0, wifiUploading: false, chargingA: 0 },

  // Live view: only CAM2 is powered for metering/preview (KINO hardware V1),
  // streaming rather than capturing, so it draws idle-level current.
  preview: {
    p4On: true,
    camsOn: ['cam2'],
    camsCapturing: [],
    uartActive: [],
    flashA: 0,
    wifiUploading: false,
    chargingA: 0,
  },

  // All four cams mid-exposure, no flash.
  quadCapture: {
    p4On: true,
    camsOn: ALL_CAMS,
    camsCapturing: ALL_CAMS,
    uartActive: [],
    flashA: 0,
    wifiUploading: false,
    chargingA: 0,
  },

  // Same, with the default 350 mA flash current (§7.10/§16).
  captureFlash: {
    p4On: true,
    camsOn: ALL_CAMS,
    camsCapturing: ALL_CAMS,
    uartActive: [],
    flashA: 0.35,
    wifiUploading: false,
    chargingA: 0,
  },

  // Post-capture: all four cams pushing JPEGs over UART, no longer exposing.
  uartTransfer: {
    p4On: true,
    camsOn: ALL_CAMS,
    camsCapturing: [],
    uartActive: ALL_CAMS,
    flashA: 0,
    wifiUploading: false,
    chargingA: 0,
  },

  // Roll upload running in the background, cams powered down between shots.
  wifiUpload: {
    p4On: true,
    camsOn: [],
    camsCapturing: [],
    uartActive: [],
    flashA: 0,
    wifiUploading: true,
    chargingA: 0,
  },

  // §15 worst-case overlap: quad capture + experimental 500 mA flash + wifi
  // upload + UART transfer all racing at once.
  worstOverlap: {
    p4On: true,
    camsOn: ALL_CAMS,
    camsCapturing: ALL_CAMS,
    uartActive: ALL_CAMS,
    flashA: 0.5,
    wifiUploading: true,
    chargingA: 0,
  },
};
