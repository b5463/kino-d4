// The shutter: one printed part (the plunger B02), one 6 x 6 tactile
// switch with two leads, no fastener, no retainer. The face is the door.
//
// The pod is a block under the top wall from X podX0 into the right wall.
// In it a chamber, 16.3 wide and as tall as the plunger lying in it, open
// toward the FRONT through the plate (and 2.2 mm into the wall's front end
// over it), closed at the rear. From the deck down: a 14.6 round guide
// (ribbed on its face side, round at the deck, flat-ceilinged below), the
// step the flange rests under, the chamber, and a 2 mm floor with two leg
// channels through it running out to the front.
//
// Why the front: the cap stands proud of the deck and 2.3 mm of guide
// above the step, so the plunger is 5.9 mm tall and must ride in with its
// cap under the step; from the rear it would have to pass under the top
// wall's inner face, 2.2 mm lower than the step, and there is no lifting it
// after. From the front the ride ceiling is the step itself. The chamber
// is 0.2 taller than the plunger: it rides in on the floor, and when it is
// under the guide it drops in by its own weight (the shell deck down on the
// bench) and its flange lands on the step. That lift is the switch's
// height and 0.2: the switch then slides in on the floor under the seated
// flange, legs in the two channels, leads trailing out through them into
// the cavity, and stops when its front legs reach the channels' ends,
// centred under the cap. The face goes on over the plate's hole and
// nothing can leave. The press goes into the floor. Every bore is round;
// the chamber's rear end is a 16 mm bridge inside the pod and the guide
// has its own flat ceiling.
import { Manifold, cube, box, cylZ, coneZ, cylY, fuse, status } from "./lib.mjs";
import { P, Z, XY } from "./params.mjs";

export const SHUTTER = (() => {
  const [, , cx1, cy1] = XY.cavity;
  const [, , , oy1] = XY.outer;
  const X = P.shutterX, Zc = P.shutterZ;
  const guideTop = oy1;                                   // the deck
  const guideBottom = oy1 - P.shutterGuideLen;            // the step the flange rests under, and the ride ceiling
  const flangeBottomRest = guideBottom - P.shutterFlangeH;
  const switchTop = flangeBottomRest - P.shutterSwitchFree;   // the actuator at rest, a hair under the flange
  const floorTop = switchTop - P.shutterSwitchBody[2];    // the switch's base, and the flange's ride level
  const podInnerY = floorTop - P.shutterFloor;            // the pod's face toward the cavity
  const chamberH = guideBottom - floorTop;
  const plungerH = P.shutterFlangeH + P.shutterProud + P.shutterGuideLen;   // flange bottom to cap top
  const lift = chamberH - P.shutterFlangeH;               // from the flange on the floor to the flange on the step
  const podX0 = X - P.shutterPodLeft;
  const podX1 = cx1 + 0.5;                                // into the right wall: one block
  const rF = P.shutterActuatorFlangeD / 2 + P.shutterFlangeBoreClear;
  const chamberZ0 = Zc - rF;                              // the closed rear end; the flange's rear edge rides 0.15 off it
  const legStopZ = Zc + P.shutterLegZ + P.shutterLegClr;  // the front legs stop here: the switch centred under the cap
  const notch = guideBottom - cy1;                        // how far the chamber reaches into the top wall's front end
  const stem = P.shutterProud + P.shutterGuideLen;        // cap top above the flange's top
  return Object.freeze({ X, Zc, oy1, cy1, guideTop, guideBottom, flangeBottomRest, switchTop, floorTop, podInnerY, chamberH, plungerH, lift, podX0, podX1, rF, chamberZ0, legStopZ, notch, stem });
})();

// A bore along Y with a flat ceiling `up` above the circle's top (-Z is up
// in the shell's print): the bridge clears the part that runs in it.
const slotY = (cx, y, cz, r, len, up) => fuse([cylY(cx, y, cz, r, len), box(cx - r, y, cz - r - up, cx + r, y + len, cz)]);

// What the pod adds to the shell and what it cuts from it. Added before the
// cuts, cut after everything else is fused.
export function shutterPod() {
  const S = SHUTTER, X = S.X, Zc = S.Zc, rF = S.rF;
  const adds = [cube(S.podX0, S.podInnerY, P.shutterPodBottomZ, S.podX1 - S.podX0, S.cy1 - S.podInnerY + 0.5, Z.plateInner + 0.3 - P.shutterPodBottomZ)];
  const rG = P.shutterActuatorGuideD / 2;
  const cuts = [
    // The guide: a flat-topped slot below, round for its last mm at the deck.
    slotY(X, S.guideBottom - 0.01, Zc, rG, P.shutterGuideLen - P.shutterGuideRound + 0.02, P.shutterGuideCeil),
    cylY(X, S.guideTop - P.shutterGuideRound - 0.01, Zc, rG, P.shutterGuideRound + 1.0),
    // The collar recess round the cap.
    cylY(X, S.oy1 - P.shutterCollarDepth, Zc, P.shutterCollarD / 2, P.shutterCollarDepth + 0.2),
    // The chamber: from its closed rear end out through the plate's front.
    box(X - rF, S.floorTop, S.chamberZ0, X + rF, S.guideBottom + 0.01, Z.plateFront + 1),
  ];
  // Two leg channels through the floor, from the stop under the cap out to
  // the front; the legs ride in them, the leads hang through them.
  for (const s of [-1, 1]) {
    cuts.push(box(X + s * P.shutterLegX - P.shutterLegSlot[0] / 2, S.podInnerY - 1, S.legStopZ - (P.shutterLegZ * 2 + P.shutterLegClr * 2), X + s * P.shutterLegX + P.shutterLegSlot[0] / 2, S.floorTop + 0.5, Z.plateFront + 1));
  }
  // A detent in each channel, added back after the cuts: a rib on the
  // channel's outer wall just in front of the switch's front legs, a 45
  // degree ramp toward the front and a square face toward the switch. The
  // legs are 0.3 mm strips 3.5 long: they flex inward past the rib on the
  // way in and sit behind it, so the switch cannot walk forward out from
  // under the cap; a tug pulls it out for service. The rib stays under the
  // floor's top so the body never touches it.
  const legRibs = [];
  {
    const z0 = S.legStopZ - P.shutterLegClr + P.shutterLegT / 2 + P.shutterLegClr;   // the front legs' front face plus the clearance
    const rib = P.shutterLegRib, y0 = S.podInnerY - 0.5, y1 = S.floorTop - 0.01;
    for (const s of [-1, 1]) {
      const xw = X + s * (P.shutterLegX + P.shutterLegSlot[0] / 2) + s * 0.05;   // 0.05 into the wall, so the union never leaves a sliver
      const tip = X + s * (P.shutterLegX + P.shutterLegSlot[0] / 2 - rib - 0.01);  // the 0.01 overshoot in the width: the ramp stays at 45 degrees
      const pts = s < 0 ? [[xw, z0], [tip, z0], [xw, z0 + rib]] : [[xw, z0], [xw, z0 + rib], [tip, z0]];
      legRibs.push(Manifold.extrude(pts, y1 - y0).rotate([90, 0, 0]).translate([0, y1, 0]));
    }
  }
  return { adds, cuts, legRibs };
}

// The cap as it stands in the collar, for the colour previews: the rim
// shutterProud above the top face. Body frame.
export function capPreview() {
  const S = SHUTTER;
  const h = P.shutterCollarDepth + P.shutterProud, e = P.shutterCapEdge;
  const cap = fuse([
    cylZ(0, 0, 0, P.shutterPressCapD / 2, h - e, 64),
    coneZ(0, 0, h - e - 0.01, P.shutterPressCapD / 2, P.shutterPressCapD / 2 - e, e + 0.01, 64),
  ]);
  return cap.rotate([-90, 0, 0]).translate([P.shutterX, S.oy1 - P.shutterCollarDepth, P.shutterZ]);
}

// The plunger at rest in the body frame (flange on the step, cap through
// the deck), for the order-of-operations gates.
export function plungerAtRest() {
  const S = SHUTTER;
  return buildShutterButton().translate([-9, -9, 0]).rotate([-90, 0, 0]).translate([S.X, S.flangeBottomRest, S.Zc]);
}

// The plunger (B02), in its own print frame: the flange on the bed.
export function buildShutterButton() {
  const S = SHUTTER;
  const flangeH = P.shutterFlangeH, e = P.shutterCapEdge;
  const noseStraightH = S.stem - e;
  const actuator = fuse([
    // The flange's bed edge chamfered against the elephant foot.
    coneZ(0, 0, 0, P.shutterActuatorFlangeD / 2 - 0.3, P.shutterActuatorFlangeD / 2, 0.3),
    cylZ(0, 0, 0.29, P.shutterActuatorFlangeD / 2, flangeH - 0.29),
    cylZ(0, 0, flangeH, P.shutterPressCapD / 2, noseStraightH),
    coneZ(0, 0, flangeH + noseStraightH - 0.01, P.shutterPressCapD / 2, P.shutterPressCapD / 2 - e, e + 0.01, 64),
  ]).translate([9, 9, 0]);
  return status("shutter button", actuator.simplify(1e-5));
}
