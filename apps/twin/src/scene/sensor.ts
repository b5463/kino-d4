// Virtual sensor math (issue #72) — pure and node-testable, like
// transforms.ts. Where each camera's eye sits and what it sees derive from
// the hardware profile's instances and the configured camera pitch, exactly
// as the optics overlays do; the lens FOV is a stated bench scenario
// (69–75° target band) because the physical lens is MEASURE_REQUIRED.
import type { CamId } from '@kino/kdp';
import type { HardwareProfile } from '@kino/hardware-profiles';
import { instanceTransforms } from './transforms';

/** three.js layer the virtual sensors photograph: stage subjects, room and
 * stage lights enable it; device geometry and engineering overlays do not. */
export const SENSOR_LAYER = 2;

/** The eye sits this far in front of the lens face, so the sensor's near
 * plane clears the barrel and the face shell's cell wall. */
const EYE_AHEAD_OF_LENS_MM = 2;

export interface SensorPose {
  cam: CamId;
  positionMm: [number, number, number];
}

/**
 * One eye-point per camera node, in profile order (CAM1..CAM4 left to
 * right), at explode 0 — the physical sensors do not move when the user
 * explodes the assembly view.
 */
export function sensorPoses(profile: HardwareProfile, pitchMm: number): SensorPose[] {
  const transforms = instanceTransforms(profile, pitchMm, 0);
  const cams: SensorPose[] = [];
  for (const instance of profile.instances) {
    if (instance.component !== 'camera-node') continue;
    const transform = transforms.get(instance.id);
    if (!transform) continue;
    const [x, y, z] = transform.positionMm;
    // The lens, not the board centre: the XIAO Sense carries its camera at
    // one end of the board (the profile's opticalCenterOffsetMm, from the CAD).
    const [ox, oy, oz] = instance.opticalCenterOffsetMm ?? [0, 0, 0];
    cams.push({ cam: `cam${cams.length + 1}` as CamId, positionMm: [x + ox, y + oy, z + oz + EYE_AHEAD_OF_LENS_MM] });
    if (cams.length === 4) break;
  }
  return cams;
}

/** Vertical FOV for a horizontal FOV at an aspect ratio (both degrees). */
export function verticalFovDeg(horizontalFovDeg: number, aspect: number): number {
  const h = (horizontalFovDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(h / 2) / aspect) * 180) / Math.PI;
}

/**
 * Angular parallax between neighboring cameras toward the same subject
 * point, in degrees. Closer subject → larger angle → more parallax; the
 * acceptance test asserts exactly this monotonic relationship.
 */
export function neighborParallaxDeg(pitchMm: number, subjectDistanceMm: number): number {
  return (Math.atan2(pitchMm, subjectDistanceMm) * 180) / Math.PI;
}

/**
 * Where the external light sits: the `top-light` instance on the body's
 * 1/4-20 stud, or null in a profile without one. The emitter is its +Z face.
 */
export function topLightPositionMm(profile: HardwareProfile, pitchMm: number): [number, number, number] | null {
  const light = profile.instances.find((i) => i.component === 'top-light');
  if (!light) return null;
  const t = instanceTransforms(profile, pitchMm, 0).get(light.id);
  if (!t) return null;
  const component = profile.components.find((c) => c.id === light.component);
  const depth = component?.sources[0]?.sizeMm[2] ?? 0;
  return [t.positionMm[0], t.positionMm[1], t.positionMm[2] + depth / 2 + 1];
}
