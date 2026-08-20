import type { HardwareProfile } from '@kino/hardware-profiles';

export type FovResult =
  | { hDeg: number; vDeg: number; source: 'MEASURED' | 'SCENARIO' }
  | { source: 'MEASURE_REQUIRED' };

function validFovDeg(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 180;
}

function derivedVerticalFovDeg(horizontalDeg: number): number {
  const horizontalRad = (horizontalDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(horizontalRad / 2) * (1536 / 2048)) * 180) / Math.PI;
}

/** Resolve measured module optics, or an explicitly labelled design scenario. */
export function fovForCam(profile: HardwareProfile, scenarioDeg: number | null): FovResult {
  if (scenarioDeg !== null) {
    if (!validFovDeg(scenarioDeg)) throw new RangeError(`FOV scenario must be between 0° and 180°; got ${scenarioDeg}`);
    return { hDeg: scenarioDeg, vDeg: derivedVerticalFovDeg(scenarioDeg), source: 'SCENARIO' };
  }

  const camera = profile.components.find((component) => component.id === 'camera-node');
  const horizontal = camera?.specs?.horizontalFovDeg;
  const vertical = camera?.specs?.verticalFovDeg;
  if (validFovDeg(horizontal) && validFovDeg(vertical)) {
    return { hDeg: horizontal, vDeg: vertical, source: 'MEASURED' };
  }
  return { source: 'MEASURE_REQUIRED' };
}

function halfSpanMm(fovDeg: number, distMm: number): number {
  if (!validFovDeg(fovDeg) || !Number.isFinite(distMm) || distMm <= 0) return 0;
  return distMm * Math.tan((fovDeg * Math.PI) / 360);
}

function cleanCoordinate(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** Four corners on a plane perpendicular to the optical axis (+Z). */
export function frustumCorners(
  originMm: [number, number, number],
  hDeg: number,
  vDeg: number,
  distMm: number,
): [number, number, number][] {
  const [x, y, z] = originMm;
  const halfW = halfSpanMm(hDeg, distMm);
  const halfH = halfSpanMm(vDeg, distMm);
  const planeZ = z + Math.max(0, distMm);
  return [
    [cleanCoordinate(x - halfW), cleanCoordinate(y + halfH), cleanCoordinate(planeZ)],
    [cleanCoordinate(x + halfW), cleanCoordinate(y + halfH), cleanCoordinate(planeZ)],
    [cleanCoordinate(x + halfW), cleanCoordinate(y - halfH), cleanCoordinate(planeZ)],
    [cleanCoordinate(x - halfW), cleanCoordinate(y - halfH), cleanCoordinate(planeZ)],
  ];
}

/** Horizontal overlap shared by neighboring cameras, as a percentage of one camera's width. */
export function pairOverlapPct(pitchMm: number, hDeg: number, distMm: number): number {
  const width = halfSpanMm(hDeg, distMm) * 2;
  if (width <= 0) return 0;
  return (Math.max(0, width - Math.max(0, pitchMm)) / width) * 100;
}

/** Horizontal width visible to all four cameras on the plane at `distMm`. */
export function commonWidthMm(pitchMm: number, hDeg: number, distMm: number): number {
  const width = halfSpanMm(hDeg, distMm) * 2;
  return Math.max(0, width - Math.max(0, pitchMm) * 3);
}

/** Enabled distance planes, normalized for stable rendering and readouts. */
export function opticsDistancesM(distancesM: number[], customM: number | null): number[] {
  const values = customM === null ? distancesM : [...distancesM, customM];
  return [...new Set(values.filter((distance) => Number.isFinite(distance) && distance > 0))].sort((a, b) => a - b);
}
