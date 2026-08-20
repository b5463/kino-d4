import { describe, expect, it } from 'vitest';
import { bboxFromBodySizeMm, viewPose, type Box3Like } from '../src/scene/viewPoses';

// A simple 126x80x36 box centered on the origin — same shape as D4_V1's
// enclosure envelope (§4/§7), but written as a literal fixture so this test
// never depends on the real profile's exact numbers.
const BBOX: Box3Like = bboxFromBodySizeMm([126, 80, 36]);

describe('viewPose — axis views', () => {
  it('front looks down -Z from the +Z side, straight on (no X/Y offset)', () => {
    const pose = viewPose('front', BBOX, 22);
    expect(pose.position[2]).toBeGreaterThan(pose.target[2]);
    expect(pose.position[0]).toBeCloseTo(pose.target[0]);
    expect(pose.position[1]).toBeCloseTo(pose.target[1]);
    expect(pose.target).toEqual([0, 0, 0]); // bbox is centered on the origin (§4)
  });

  it('rear looks down +Z from the -Z side', () => {
    const pose = viewPose('rear', BBOX, 22);
    expect(pose.position[2]).toBeLessThan(pose.target[2]);
  });

  it('top looks down -Y from the +Y side', () => {
    const pose = viewPose('top', BBOX, 22);
    expect(pose.position[1]).toBeGreaterThan(pose.target[1]);
  });

  it('bottom looks up from the -Y side', () => {
    const pose = viewPose('bottom', BBOX, 22);
    expect(pose.position[1]).toBeLessThan(pose.target[1]);
  });

  it('left and right sit on opposite sides of the X axis', () => {
    const left = viewPose('left', BBOX, 22);
    const right = viewPose('right', BBOX, 22);
    expect(left.position[0]).toBeLessThan(left.target[0]);
    expect(right.position[0]).toBeGreaterThan(right.target[0]);
  });

  it('sits 1.8x the bbox diagonal away from the target (§3)', () => {
    const pose = viewPose('front', BBOX, 22);
    const diagonal = Math.hypot(126, 80, 36);
    const distance = Math.hypot(
      pose.position[0] - pose.target[0],
      pose.position[1] - pose.target[1],
      pose.position[2] - pose.target[2],
    );
    expect(distance).toBeCloseTo(1.8 * diagonal);
  });
});

describe('viewPose — lens', () => {
  it('sits at the cam2 lens center — X = -11 at 22 mm pitch', () => {
    const pose = viewPose('lens', BBOX, 22);
    expect(pose.position[0]).toBe(-11);
    expect(pose.position[1]).toBe(10);
    expect(pose.position[2]).toBe(18);
  });

  it('X = -10 at 20 mm pitch — reads pitch from the argument, not a hard-coded value', () => {
    const pose = viewPose('lens', BBOX, 20);
    expect(pose.position[0]).toBe(-10);
  });

  it('looks straight down +Z (target ahead of the lens on Z only)', () => {
    const pose = viewPose('lens', BBOX, 22);
    expect(pose.target[0]).toBe(pose.position[0]);
    expect(pose.target[1]).toBe(pose.position[1]);
    expect(pose.target[2]).toBeGreaterThan(pose.position[2]);
  });
});

describe('viewPose — fit', () => {
  it('preserves the current direction unit vector, only refitting distance', () => {
    const current = { position: [100, 50, 50] as [number, number, number], target: [10, 5, 5] as [number, number, number] };
    const rawDir = [90, 45, 45];
    const rawLen = Math.hypot(...rawDir);
    const expectedDir = rawDir.map((v) => v / rawLen);

    const pose = viewPose('fit', BBOX, 22, current);
    const gotDir = [
      pose.position[0] - pose.target[0],
      pose.position[1] - pose.target[1],
      pose.position[2] - pose.target[2],
    ];
    const gotLen = Math.hypot(...gotDir);
    const gotUnit = gotDir.map((v) => v / gotLen);

    expectedDir.forEach((v, i) => expect(gotUnit[i]).toBeCloseTo(v));
  });

  it('refits to a bigger bbox by moving farther away, direction unchanged', () => {
    const current = { position: [0, 0, 100] as [number, number, number], target: [0, 0, 0] as [number, number, number] };
    const small = viewPose('fit', BBOX, 22, current);
    const big = viewPose('fit', bboxFromBodySizeMm([252, 160, 72]), 22, current);

    const distSmall = Math.hypot(small.position[0], small.position[1], small.position[2]);
    const distBig = Math.hypot(big.position[0], big.position[1], big.position[2]);
    expect(distBig).toBeCloseTo(2 * distSmall);
  });

  it('falls back to the scene start-pose direction when no current pose is given', () => {
    const pose = viewPose('fit', BBOX, 22);
    expect(pose.position[0]).toBeGreaterThan(0);
    expect(pose.position[1]).toBeGreaterThan(0);
    expect(pose.position[2]).toBeGreaterThan(0);
  });
});

describe('bboxFromBodySizeMm', () => {
  it('centers the box on the origin (§4)', () => {
    const box = bboxFromBodySizeMm([126, 80, 36]);
    expect(box.min).toEqual([-63, -40, -18]);
    expect(box.max).toEqual([63, 40, 18]);
  });
});
