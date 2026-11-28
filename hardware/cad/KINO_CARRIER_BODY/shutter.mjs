// The shutter: one printed part (the plunger B02), one 6 x 6 tactile
// switch with two leads, no fastener, no retainer. The shell holds all of
// it; the face is only a cover over the mouth.
//
// The pod is a block under the top wall from X podX0 into the right wall,
// at the deck's front. In it, from the deck down: the guide, a closed round
// bore through the deck with six 0.2 ribs the cap runs on; the step, the
// deck all round the bore that the flange rests under; the chamber, 18.6
// wide, open through the plate's top-right corner (the mouth); and the
// floor the switch sits on, with two leg channels through it running out
// to the front, narrowed at their rear ends into crush ribs for the rear
// legs.
//
// Why the plunger first. The bore is closed, so the cap reaches it only
// from below: the plunger rides in on the floor, deck down, its cap under
// the step, and lifts into the bore at the axis until its flange hangs on
// the step. The chamber is set by the switch (its height, the 0.3 free
// travel and the flange), so the plunger must fit it: flange + guide +
// proud + 0.2. Then the switch rides in flat on the floor under the hanging
// flange, 0.3 under it, until its rear legs meet the channels' ends, where
// the crush ribs take them. A switch already seated would block the
// plunger's ride: the order is forced, and the generator sweeps each step.
// The flange's front stops 0.3 short of the face's back (the round flange
// ran 1.4 into it when the face was the slot's front wall); the press goes
// into the floor; nothing is loaded in tension.
import { Manifold, cube, box, cylZ, coneZ, cylY, fuse, status } from "./lib.mjs";
import { P, Z, XY } from "./params.mjs";

export const SHUTTER = (() => {
  const [, , cx1, cy1] = XY.cavity;
  const [, , , oy1] = XY.outer;
  const X = P.shutterX;
  const rG = P.shutterActuatorGuideD / 2;
  const Zc = Z.plateFront - P.shutterActuatorFlangeD / 2 - P.shutterFlangeToFace;   // the flange's front shutterFlangeToFace behind the face's back
  const guideTop = oy1;                                   // the deck
  const guideBottom = oy1 - P.shutterGuideLen;            // the step the flange rests under
  const flangeBottomRest = guideBottom - P.shutterFlangeH;
  const switchTop = flangeBottomRest - P.shutterSwitchFree;   // the actuator at rest, a hair under the flange
  const seatTop = switchTop - P.shutterSwitchBody[2];     // the switch's base: the floor itself, flat
  const floorTop = seatTop;                               // the floor the plunger rides in on and the switch sits on
  const podInnerY = seatTop - P.shutterFloor;             // the pod's face toward the cavity
  const plungerRideTop = floorTop + P.shutterFlangeH + P.shutterGuideLen + P.shutterProud;   // the cap's top riding in on the floor
  const chamberH = guideBottom - floorTop;                // flange + free + switch
  const plungerH = P.shutterFlangeH + P.shutterProud + P.shutterGuideLen;   // flange bottom to cap top
  const podX0 = X - P.shutterPodLeft;
  const podX1 = cx1 + 0.5;                                // into the right wall: one block
  const rF = P.shutterActuatorFlangeD / 2 + P.shutterFlangeBoreClear;
  const chamberZ0 = Zc - rF;                              // the closed rear end
  const legStopZ = Zc + P.shutterLegZ + P.shutterLegClr;  // the front legs stop here: the switch centred under the cap
  const seat = [X - P.shutterSwitchBody[0] / 2, Zc - P.shutterSwitchBody[1] / 2, X + P.shutterSwitchBody[0] / 2, Zc + P.shutterSwitchBody[1] / 2];   // x0, z0, x1, z1: the switch's body seated
  const lip = rF - P.shutterFlangeBoreClear - rG;         // the flange over the step, each side
  const stem = P.shutterProud + P.shutterGuideLen;        // cap top above the flange's top
  return Object.freeze({ X, Zc, rG, oy1, cy1, guideTop, guideBottom, flangeBottomRest, switchTop, seatTop, floorTop, podInnerY, chamberH, plungerH, podX0, podX1, rF, chamberZ0, legStopZ, seat, lip, stem, plungerRideTop, legEndZ: legStopZ - 2 * P.shutterLegZ - 2 * P.shutterLegClr });
})();

// A slot along Y open toward +Z: a round end at cz, straight sides from
// there out to zEnd; with `up`, a flat ceiling that far above the round
// end's top (-Z is up in the shell's print, so the bridge clears the part
// that runs in it).
const slotY = (cx, y, cz, r, len, up, zEnd) => fuse([
  cylY(cx, y, cz, r, len),
  box(cx - r, y, cz, cx + r, y + len, zEnd),
  ...(up > 0 ? [box(cx - r, y, cz - r - up, cx + r, y + len, cz)] : []),
]);

// What the pod adds to the shell and what it cuts from it. Added before the
// cuts, cut after everything else is fused.
export function shutterPod() {
  const S = SHUTTER, X = S.X, Zc = S.Zc, rF = S.rF, rG = S.rG;
  const adds = [cube(S.podX0, S.podInnerY, P.shutterPodBottomZ, S.podX1 - S.podX0, S.cy1 - S.podInnerY + 0.5, Z.plateInner + 0.3 - P.shutterPodBottomZ)];
  const cuts = [
    // The guide: a closed round bore through the deck from the step up. In
    // print (the front plate on the bed) its rear half is the overhang: a
    // flat ceiling shutterGuideCeil behind it, round only for its last mm
    // at the deck; its front half prints as a floor.
    cylY(X, S.guideBottom - 0.01, Zc, rG, P.shutterGuideLen + 1.0),
    box(X - rG, S.guideBottom - 0.01, Zc - rG - P.shutterGuideCeil, X + rG, S.guideTop - P.shutterGuideRound, Zc),
    // The collar recess round the cap, clipped by the deck's front edge.
    cylY(X, S.oy1 - P.shutterCollarDepth, Zc, P.shutterCollarD / 2, P.shutterCollarDepth + 0.2),
    // The chamber: from its closed rear end out through the plate's front.
    box(X - rF, S.floorTop, S.chamberZ0, X + rF, S.guideBottom + 0.01, Z.plateFront + 1),
  ];
  // Two leg channels through the floor, from the rear legs' stop out to
  // the front; the legs ride in them, the leads hang through them.
  for (const s of [-1, 1]) {
    cuts.push(box(X + s * P.shutterLegX - P.shutterLegSlot[0] / 2, S.podInnerY - 1, S.legEndZ, X + s * P.shutterLegX + P.shutterLegSlot[0] / 2, S.floorTop + 0.01, Z.plateFront + 1));
  }
  // Six ribs round the bore, added back after the cuts: one on each side and
  // two 60 degrees each side of its front and of its rear (the rear pair 30
  // degrees of overhang in print, printable). The cap runs on six lines,
  // 0.1 off each, instead of ticking in a 0.6 gap.
  const ribs = [];
  {
    const [rh, rw] = P.shutterGuideRib;
    const y0 = S.guideBottom + 0.1, len = P.shutterGuideLen - P.shutterCollarDepth - 0.15;
    for (const phi of [-120, -60, 60, 120]) {   // 0 is +Z (toward the face)
      ribs.push(cube(-rw / 2, y0, rG - rh, rw, len, rh + 0.3).rotate([0, phi, 0]).translate([X, 0, Zc]));
    }
    for (const s of [-1, 1]) {
      ribs.push(cube(X + (s < 0 ? -(rG + 0.3) : rG - rh), y0, Zc - rw / 2, rh + 0.3, len, rw));
    }
  }
  // The crush ribs: each leg channel narrows, over its last 0.8, to the
  // leg's thickness less shutterLegCrush; the rear legs are pressed in as
  // the switch is pushed home, with a 45 degree lead-in.
  for (const s of [-1, 1]) {
    const cx = X + s * P.shutterLegX, half = (P.shutterLegT - P.shutterLegCrush) / 2, w = P.shutterLegSlot[0] / 2;
    for (const side of [-1, 1]) {
      const xin = cx + side * half, xwall = cx + side * (w + 0.05);
      const [xa, xb] = xin < xwall ? [xin, xwall] : [xwall, xin];
      const lead = w - half;
      ribs.push(Manifold.hull([
        box(xa, S.podInnerY - 0.01, S.legEndZ - 0.01, xb, S.floorTop - 0.05, S.legEndZ + 0.8),
        box(side > 0 ? xb - 0.01 : xa, S.podInnerY - 0.01, S.legEndZ + 0.8, side > 0 ? xb : xa + 0.01, S.floorTop - 0.05, S.legEndZ + 0.8 + lead),
      ]));
    }
  }
  return { adds, cuts, ribs };
}

// The dish in the cap's top: a sphere whose cap is shutterCapDish wide and
// deep, centred on the axis, its rim at zTop. Print frame (Z up).
const dish = (cx, cy, zTop) => {
  const [d, depth] = P.shutterCapDish, r = d / 2;
  const R = (r * r + depth * depth) / (2 * depth);
  return Manifold.sphere(R, 96).translate([cx, cy, zTop + R - depth]);
};

// The cap as it stands in the collar, for the colour previews: the rim
// shutterProud above the top face. Body frame.
export function capPreview() {
  const S = SHUTTER;
  const h = P.shutterCollarDepth + P.shutterProud, e = P.shutterCapEdge;
  const cap = fuse([
    cylZ(0, 0, 0, P.shutterPressCapD / 2, h - e, 64),
    coneZ(0, 0, h - e - 0.01, P.shutterPressCapD / 2, P.shutterPressCapD / 2 - e, e + 0.01, 64),
  ]).subtract(dish(0, 0, h));
  return cap.rotate([-90, 0, 0]).translate([S.X, S.oy1 - P.shutterCollarDepth, S.Zc]);
}

// The plunger's print-frame offset: the flange's radius and a margin.
const printOff = () => P.shutterActuatorFlangeD / 2 + 1.0;

// The plunger at rest in the body frame (flange on the step, cap through
// the deck against the slot's round end), for the order-of-operations gates.
export function plungerAtRest() {
  const S = SHUTTER, o = printOff();
  return buildShutterButton().translate([-o, -o, 0]).rotate([-90, 0, 0]).translate([S.X, S.flangeBottomRest, S.Zc]);
}

// The plunger (B02), in its own print frame: the flange on the bed.
export function buildShutterButton() {
  const S = SHUTTER, o = printOff();
  const flangeH = P.shutterFlangeH, e = P.shutterCapEdge;
  const noseStraightH = S.stem - e;
  const actuator = fuse([
    // The flange's bed edge chamfered against the elephant foot.
    coneZ(0, 0, 0, P.shutterActuatorFlangeD / 2 - 0.3, P.shutterActuatorFlangeD / 2, 0.3),
    cylZ(0, 0, 0.29, P.shutterActuatorFlangeD / 2, flangeH - 0.29),
    cylZ(0, 0, flangeH, P.shutterPressCapD / 2, noseStraightH),
    coneZ(0, 0, flangeH + noseStraightH - 0.01, P.shutterPressCapD / 2, P.shutterPressCapD / 2 - e, e + 0.01, 64),
  ]).subtract(dish(0, 0, flangeH + S.stem)).translate([o, o, 0]);   // the dish in the top, inside the chamfered rim
  return status("shutter button", actuator.simplify(1e-5));
}
