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

/** Lens front relative to the camera-node center: half the module depth
 * (15 mm) plus the protruding barrel. */
const LENS_FORWARD_MM = 12;

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
    cams.push({ cam: `cam${cams.length + 1}` as CamId, positionMm: [x, y, z + LENS_FORWARD_MM] });
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
