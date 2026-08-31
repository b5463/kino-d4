import { resolveDimensions } from '@kino/hardware-profiles';
import type { HardwareProfile, MeasuredOverride } from '@kino/hardware-profiles';
import { instanceTransforms } from '../scene/transforms';
import { wireCurve } from '../scene/wireGeometry';

export type FindingKind =
  | 'COLLISION'
  | 'HARD_CLEARANCE_UNDER_0_5'
  | 'CABLE_CLEARANCE_UNDER_1_0'
  | 'USB_ACCESS_BLOCKED'
  | 'SD_EJECT_BLOCKED';

export interface CollisionFinding {
  kind: FindingKind;
  a: string;
  b: string;
  distanceMm: number;
}

type Vec3 = readonly [number, number, number];
type Mat3 = readonly [Vec3, Vec3, Vec3];

interface Aabb {
  id: string;
  min: [number, number, number];
  max: [number, number, number];
}

const HARD_CLEARANCE_MM = 0.5;
const CABLE_CLEARANCE_MM = 1;

function rotationMatrix(rotationDeg: Vec3): Mat3 {
  const [x, y, z] = rotationDeg.map((angle) => (angle * Math.PI) / 180) as [number, number, number];
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cz = Math.cos(z);
  const sz = Math.sin(z);

  // Rz * Ry * Rx: the world-space matrix for the profile's XYZ Euler angles.
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

function multiply(matrix: Mat3, vector: Vec3): [number, number, number] {
  return matrix.map((row) => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]) as [
    number,
    number,
    number,
  ];
}

function box(id: string, center: Vec3, sizeMm: Vec3, rotationDeg: Vec3): Aabb {
  const matrix = rotationMatrix(rotationDeg);
  const localHalf: Vec3 = [sizeMm[0] / 2, sizeMm[1] / 2, sizeMm[2] / 2];
  const half = matrix.map(
    (row) => Math.abs(row[0]) * localHalf[0] + Math.abs(row[1]) * localHalf[1] + Math.abs(row[2]) * localHalf[2],
  ) as [number, number, number];

  return {
    id,
    min: [center[0] - half[0], center[1] - half[1], center[2] - half[2]],
    max: [center[0] + half[0], center[1] + half[1], center[2] + half[2]],
  };
}

function strictlyOverlaps(a: Aabb, b: Aabb): boolean {
  return [0, 1, 2].every((axis) => Math.min(a.max[axis]!, b.max[axis]!) - Math.max(a.min[axis]!, b.min[axis]!) > 0);
}

function intersects(a: Aabb, b: Aabb): boolean {
  return [0, 1, 2].every((axis) => a.max[axis]! >= b.min[axis]! && b.max[axis]! >= a.min[axis]!);
}

function boxDistance(a: Aabb, b: Aabb): number {
  const gaps = [0, 1, 2].map((axis) => Math.max(a.min[axis]! - b.max[axis]!, b.min[axis]! - a.max[axis]!, 0));
  return Math.hypot(...gaps);
}

function pointBoxDistance(point: Vec3, target: Aabb): number {
  const gaps = [0, 1, 2].map((axis) => Math.max(target.min[axis]! - point[axis]!, point[axis]! - target.max[axis]!, 0));
  return Math.hypot(...gaps);
}

function stableMm(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Shell instances (skeleton, acrylic panels) carry only the PROVISIONAL
 * whole-body envelope box. A solid 126×80×36 AABB contains every internal
 * part, so evaluating it reports COLLISION 0.00 mm against the entire
 * interior, the two panels against each other, and every keepout as blocked
 * (issue #82) — noise, not findings. Shells are excluded until measured
 * shell geometry (panel thickness, frame ribs) exists; the panel says so.
 */
export function shellExclusions(profile: HardwareProfile): string[] {
  return profile.instances.filter((instance) => instance.group === 'shell').map((instance) => instance.id);
}

function hardBoxes(profile: HardwareProfile, overrides: MeasuredOverride[], pitchMm: number): Aabb[] {
  const components = new Map(profile.components.map((component) => [component.id, component]));
  const transforms = instanceTransforms(profile, pitchMm, 0);
  const overrideByComponent = new Map(overrides.map((override) => [override.componentId, override]));
  const boxes: Aabb[] = [];

  for (const instance of profile.instances) {
    if (instance.group === 'shell') continue; // see shellExclusions
    const component = components.get(instance.component);
    const transform = transforms.get(instance.id);
    if (!component || !transform) continue;
    const dimensions = resolveDimensions(component, overrideByComponent.get(component.id)).sizeMm;
    if (dimensions.some((axis) => axis === null || !Number.isFinite(axis) || axis <= 0)) continue;
    boxes.push(box(instance.id, transform.positionMm, dimensions as [number, number, number], transform.rotationDeg));
  }

  return boxes;
}

function hardFindings(boxes: Aabb[]): CollisionFinding[] {
  const findings: CollisionFinding[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (strictlyOverlaps(a, b)) {
        findings.push({ kind: 'COLLISION', a: a.id, b: b.id, distanceMm: 0 });
        continue;
      }
      const distanceMm = boxDistance(a, b);
      if (distanceMm < HARD_CLEARANCE_MM) {
        findings.push({ kind: 'HARD_CLEARANCE_UNDER_0_5', a: a.id, b: b.id, distanceMm: stableMm(distanceMm) });
      }
    }
  }
  return findings;
}

function cableFindings(profile: HardwareProfile, boxes: Aabb[], pitchMm: number): CollisionFinding[] {
  const transforms = instanceTransforms(profile, pitchMm, 0);
  const findings: CollisionFinding[] = [];

  for (const net of profile.nets) {
    // A net can name an instance the profile no longer has (an assembly was
    // dropped, its nets were not). `wireCurve` throws on that, and this runs
    // during App render — the throw would take the app to the error boundary
    // instead of losing one cable-clearance row. Skip the net; the scene
    // views skip drawing it for the same reason.
    if (!transforms.has(net.from.instance) || !transforms.has(net.to.instance)) continue;
    const route = wireCurve(net, transforms);
    for (const target of boxes) {
      if (target.id === net.from.instance || target.id === net.to.instance) continue;
      const distanceMm = Math.min(...route.points.map((point) => pointBoxDistance(point, target)));
      if (distanceMm < CABLE_CLEARANCE_MM) {
        findings.push({
          kind: 'CABLE_CLEARANCE_UNDER_1_0',
          a: net.id,
          b: target.id,
          distanceMm: stableMm(distanceMm),
        });
      }
    }
  }

  return findings;
}

function keepoutFindings(profile: HardwareProfile, boxes: Aabb[], pitchMm: number): CollisionFinding[] {
  const components = new Map(profile.components.map((component) => [component.id, component]));
  const transforms = instanceTransforms(profile, pitchMm, 0);
  const findings: CollisionFinding[] = [];

  for (const instance of profile.instances) {
    const component = components.get(instance.component);
    const transform = transforms.get(instance.id);
    if (!component || !transform) continue;
    const matrix = rotationMatrix(transform.rotationDeg);

    for (const keepout of component.keepouts) {
      const kind: FindingKind | null =
        keepout.kind === 'ejection'
          ? 'SD_EJECT_BLOCKED'
          : keepout.kind === 'insertion' || keepout.kind === 'service'
            ? 'USB_ACCESS_BLOCKED'
            : null;
      if (!kind) continue;

      const offset = multiply(matrix, keepout.offsetMm);
      const center: [number, number, number] = [
        transform.positionMm[0] + offset[0],
        transform.positionMm[1] + offset[1],
        transform.positionMm[2] + offset[2],
      ];
      const keepoutBox = box(keepout.id, center, keepout.sizeMm, transform.rotationDeg);
      for (const target of boxes) {
        if (target.id !== instance.id && intersects(keepoutBox, target)) {
          findings.push({ kind, a: instance.id, b: target.id, distanceMm: 0 });
        }
      }
    }
  }

  return findings;
}

/**
 * Evaluates the assembled (explode=0) Twin profile with deterministic AABB
 * approximations. Rotated components and keepouts use their world-aligned
 * extents; wires use the same 24-point route that the viewport renders.
 */
export function collisionReport(
  profile: HardwareProfile,
  overrides: MeasuredOverride[],
  pitchMm: number,
): CollisionFinding[] {
  const boxes = hardBoxes(profile, overrides, pitchMm);
  return [...hardFindings(boxes), ...cableFindings(profile, boxes, pitchMm), ...keepoutFindings(profile, boxes, pitchMm)].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) || left.a.localeCompare(right.a) || left.b.localeCompare(right.b),
  );
}
