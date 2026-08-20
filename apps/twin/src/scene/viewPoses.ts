import { camBarX } from './transforms';

/**
 * Minimal THREE.Box3-compatible shape — this module stays pure/node-testable
 * (no three.js import), the same convention `transforms.ts` uses.
 */
export interface Box3Like {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ViewPoseResult {
  position: [number, number, number];
  target: [number, number, number];
}

export type ViewPoseName = 'front' | 'rear' | 'top' | 'bottom' | 'left' | 'right' | 'fit' | 'lens';

/** §3: every orthodox axis view sits this many bbox-diagonals back from its target. */
const VIEW_DISTANCE_FACTOR = 1.8;

/**
 * Arbitrary forward offset (mm) used only to give the lens pose's "looking
 * +Z" target a direction — its magnitude is not load-bearing, only that the
 * target sits ahead of the lens on +Z.
 */
const LENS_LOOK_AHEAD_MM = 100;

function normalize([x, y, z]: [number, number, number]): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/** Fallback direction for `fit` when no current camera pose is supplied — the scene's initial start pose (§3), normalized. */
const DEFAULT_DIRECTION: [number, number, number] = normalize([180, 120, 220]);

function bboxCenter(bbox: Box3Like): [number, number, number] {
  return [(bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2];
}

function bboxDiagonal(bbox: Box3Like): number {
  const dx = bbox.max[0] - bbox.min[0];
  const dy = bbox.max[1] - bbox.min[1];
  const dz = bbox.max[2] - bbox.min[2];
  return Math.hypot(dx, dy, dz);
}

const AXIS_DIRECTIONS: Record<Exclude<ViewPoseName, 'fit' | 'lens'>, [number, number, number]> = {
  front: [0, 0, 1],
  rear: [0, 0, -1],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};

/**
 * The profile's overall bounding box for the standard axis views/`fit`,
 * centered on the enclosure's geometric origin (§4) — reads the body size
 * straight off the profile rather than hard-coding an assembly dimension
 * (§25).
 */
export function bboxFromBodySizeMm(sizeMm: [number, number, number]): Box3Like {
  const [w, h, d] = sizeMm;
  return { min: [-w / 2, -h / 2, -d / 2], max: [w / 2, h / 2, d / 2] };
}

/**
 * Camera pose for one viewport-bar button (§3).
 *
 * The six axis views look at the assembly bbox's center from
 * `VIEW_DISTANCE_FACTOR` diagonals away, straight down one world axis.
 * `fit` keeps whatever direction the camera is already looking from
 * (`current`, position minus target) and only refits the distance to the
 * current bbox — falling back to the scene's initial start-pose direction
 * when no current pose is given (e.g. before the controls ref exists).
 * `lens` ignores `bboxMm` entirely: it is the cam2 lens-center viewpoint
 * (§3 camera-lens view), positioned at that lens and looking straight
 * down +Z.
 */
export function viewPose(
  name: ViewPoseName,
  bboxMm: Box3Like,
  pitchMm: number,
  current?: ViewPoseResult,
): ViewPoseResult {
  if (name === 'lens') {
    const position: [number, number, number] = [camBarX(2, pitchMm), 10, 18];
    const target: [number, number, number] = [position[0], position[1], position[2] + LENS_LOOK_AHEAD_MM];
    return { position, target };
  }

  const center = bboxCenter(bboxMm);
  const distance = VIEW_DISTANCE_FACTOR * bboxDiagonal(bboxMm);

  const direction =
    name === 'fit'
      ? current
        ? normalize([
            current.position[0] - current.target[0],
            current.position[1] - current.target[1],
            current.position[2] - current.target[2],
          ])
        : DEFAULT_DIRECTION
      : AXIS_DIRECTIONS[name];

  const position: [number, number, number] = [
    center[0] + direction[0] * distance,
    center[1] + direction[1] * distance,
    center[2] + direction[2] * distance,
  ];

  return { position, target: center };
}
