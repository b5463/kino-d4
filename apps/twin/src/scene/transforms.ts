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

function sameVec3(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * The camera-bar group's ONE shared explode offset (§5).
 *
 * This is deliberately computed once, from a single canonical member (the
 * first camera-bar instance in profile order), and then applied to every
 * camera-bar member — never by each instance re-deriving its own offset
 * from its own `explodeOrder`/`explodeDirMm`. That is the difference between
 * "the bar moves as one rigid group because the data happens to agree" and
 * "the bar moves as one rigid group because only one number ever describes
 * its explode travel": with a single source of truth, a profile edit cannot
 * make the four cameras silently diverge in the rendered scene.
 *
 * As a belt-and-suspenders check — this only guards against a *silent*
 * regression, the line above already makes divergence structurally
 * impossible in the output — this throws loudly if the profile's
 * camera-bar members don't actually agree on `explodeOrder`/`explodeDirMm`,
 * so a bad profile edit fails fast instead of quietly picking whichever
 * member happened to load first.
 */
export function cameraBarExplodeOffsetMm(profile: HardwareProfile, explode: number): [number, number, number] {
  const camBarInstances = profile.instances.filter((inst) => inst.group === 'camera-bar');
  const [canonical, ...rest] = camBarInstances;
  if (!canonical) return [0, 0, 0]; // no camera-bar group in this profile — nothing to offset

  for (const inst of rest) {
    if (inst.explodeOrder !== canonical.explodeOrder || !sameVec3(inst.explodeDirMm, canonical.explodeDirMm)) {
      throw new Error(
        `camera-bar rigidity violated (§5): instance "${inst.id}" has explodeOrder=${inst.explodeOrder} ` +
          `explodeDirMm=${JSON.stringify(inst.explodeDirMm)}, but "${canonical.id}" (the group's canonical ` +
          `member) has explodeOrder=${canonical.explodeOrder} explodeDirMm=${JSON.stringify(canonical.explodeDirMm)}. ` +
          'The four camera nodes must move as one rigid camera-bar assembly — give every camera-bar instance ' +
          'the same explodeOrder and explodeDirMm.',
      );
    }
  }

  const travelMm = canonical.explodeOrder * explode * EXPLODE_STEP_MM;
  const [dx, dy, dz] = canonical.explodeDirMm;
  return [dx * travelMm, dy * travelMm, dz * travelMm];
}

/**
 * World transform for every instance at the given pitch/explode.
 *
 * Camera-bar members ignore their profile-authored X (which only illustrates
 * the 22 mm default) and instead get `camBarX` for the *live* pitch. Their
 * explode travel comes from `cameraBarExplodeOffsetMm` — one value shared by
 * the whole group, not each instance's own `explodedPosition` — so the bar
 * is structurally rigid: it cannot fly apart even if a future profile edit
 * gives one camera a divergent `explodeOrder` (that throws instead, §5).
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

  // Computed once, outside the loop — every camera-bar member below reads
  // this same value; none of them ever call `explodedPosition` for
  // themselves (that would let per-instance data disagree again).
  const barOffset = cameraBarExplodeOffsetMm(profile, explode);

  for (const inst of profile.instances) {
    const camIndex = camIndexById.get(inst.id);

    if (camIndex !== undefined) {
      const [, by, bz] = inst.positionMm;
      const x = camBarX(camIndex, pitchMm) + barOffset[0];
      out.set(inst.id, { positionMm: [x, by + barOffset[1], bz + barOffset[2]], rotationDeg: inst.rotationDeg });
      continue;
    }

    out.set(inst.id, { positionMm: explodedPosition(inst, explode), rotationDeg: inst.rotationDeg });
  }

  return out;
}
