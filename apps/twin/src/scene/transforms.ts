import type { HardwareProfile, InstanceDef } from '@kino/hardware-profiles';

/** mm of travel per `explodeOrder` step, at full explode (§8). */
const EXPLODE_STEP_MM = 12;

export interface InstanceTransform {
  positionMm: [number, number, number];
  rotationDeg: [number, number, number];
}

/**
 * X position of one camera-bar lens center (§5). At the 22 mm default pitch
 * the row sits at -33/-11/+11/+33 — camIndex 1..4 maps onto that evenly
 * spaced, symmetric row (2.5 is the row's own midpoint, between indices 2
 * and 3, so the whole bar stays centered on X=0 at any pitch).
 */
export function camBarX(camIndex: 1 | 2 | 3 | 4, pitchMm: number): number {
  return (camIndex - 2.5) * pitchMm;
}

/**
 * One instance's exploded-view position: it slides along its own
 * `explodeDirMm` by `explodeOrder` steps of `EXPLODE_STEP_MM`, scaled by
 * `explode` (0..1, §8). `explode === 0` always returns the base `positionMm`
 * unchanged, regardless of order/direction.
 */
export function explodedPosition(inst: InstanceDef, explode: number): [number, number, number] {
  const [bx, by, bz] = inst.positionMm;
  const [dx, dy, dz] = inst.explodeDirMm;
  const travelMm = inst.explodeOrder * explode * EXPLODE_STEP_MM;
  return [bx + dx * travelMm, by + dy * travelMm, bz + dz * travelMm];
}

/**
 * World transform for every instance at the given pitch/explode.
 *
 * Camera-bar members ignore their profile-authored X (which only illustrates
 * the 22 mm default) and instead get `camBarX` for the *live* pitch; Y/Z —
 * and the explode travel — still come straight from the profile. Every
 * camera-bar instance in `D4_V1` shares the same `explodeOrder` and
 * `explodeDirMm`, so they all pick up an identical explode offset: the four
 * camera nodes ride their one rigid camera-bar assembly as a single group,
 * even though this function only ever emits per-instance positions (§5).
 */
export function instanceTransforms(
  profile: HardwareProfile,
  pitchMm: number,
  explode: number,
): Map<string, InstanceTransform> {
  const out = new Map<string, InstanceTransform>();

  // Camera index is assigned by position within the camera-bar group (left
  // to right in profile order), not by parsing instance ids — a future
  // profile only needs to order its camera-bar instances correctly, not
  // name them "camN" (§25).
  const camBarInstances = profile.instances.filter((inst) => inst.group === 'camera-bar');
  const camIndexById = new Map<string, 1 | 2 | 3 | 4>(
    camBarInstances.map((inst, i) => [inst.id, (i + 1) as 1 | 2 | 3 | 4]),
  );

  for (const inst of profile.instances) {
    const [ex, ey, ez] = explodedPosition(inst, explode);
    const camIndex = camIndexById.get(inst.id);
    const x = camIndex !== undefined ? camBarX(camIndex, pitchMm) : ex;
    out.set(inst.id, { positionMm: [x, ey, ez], rotationDeg: inst.rotationDeg });
  }

  return out;
}
