// The shutter: one printed part (the plunger B02), one 6 x 6 tactile
// switch with two leads, no fastener, no retainer. The face is the door.
//
// The pod is a block under the top wall from X podX0 into the right wall,
// at the deck's FRONT edge. In it, from the deck down: the guide, a 14.6
// slot in the deck open toward the plate's front (a U: round at the rear,
// straight sides out to the mouth) with four 0.2 ribs the cap runs on; the
// step, 2.0 of deck each side of the U that the flange rests under; the
// chamber, 18.6 wide, open through the plate's top-right corner; and the
// floor, with a 0.5 pocket the switch seats in and two leg channels through
// it running out to the front.
//
// Why the front, and why the switch first. The first front-entry pod put
// the plunger in before the switch and gave both 0.2 mm: the plunger (5.9
// tall) under a 6.1 ceiling, the switch (4.3) under the seated flange.
// Neither went in off the bed. With a closed guide the cap must pass under
// the deck to reach it, and its headroom there is the switch's height less
// the deck and the proud cap: 0.2 by arithmetic, whatever the chamber
// does. With the guide open to the front the cap never passes under
// anything: the switch goes in first along the floor (1.4 of headroom) and
// drops into its pocket; the plunger follows, deck down, hanging on the
// step with its cap already in the slot, and slides over the seated switch
// (0.8 over its body, free over the actuator) to the slot's round end. A
// switch on the floor, not in its pocket, is 0.5 too tall for the flange
// to pass: the plunger cannot go in first, and the generator sweeps every
// step. The face's back closes the slot and the mouth. The press goes into
// the floor; nothing is loaded in tension. Every bore is round; the
// chamber's rear end is a bridge inside the pod and the slot's round end
// has its own flat ceiling.
import { Manifold, cube, box, cylZ, coneZ, cylY, fuse, status } from "./lib.mjs";
import { P, Z, XY } from "./params.mjs";

export const SHUTTER = (() => {
  const [, , cx1, cy1] = XY.cavity;
  const [, , , oy1] = XY.outer;
  const X = P.shutterX;
  const rG = P.shutterActuatorGuideD / 2;
  const Zc = Z.plateFront - P.shutterPressCapD / 2 - P.shutterCapToFace;   // the cap's front edge shutterCapToFace behind the face's back
  const guideTop = oy1;                                   // the deck
  const guideBottom = oy1 - P.shutterGuideLen;            // the step the flange rests under
  const flangeBottomRest = guideBottom - P.shutterFlangeH;
  const switchTop = flangeBottomRest - P.shutterSwitchFree;   // the actuator at rest, a hair under the flange
  const seatTop = switchTop - P.shutterSwitchBody[2];     // the pocket's floor: the switch's base
  const floorTop = seatTop + P.shutterSwitchPocket;       // the floor the switch rides in on
  const podInnerY = seatTop - P.shutterFloor;             // the pod's face toward the cavity
  const chamberH = guideBottom - floorTop;                // the switch's headroom riding in
  const plungerH = P.shutterFlangeH + P.shutterProud + P.shutterGuideLen;   // flange bottom to cap top
  const podX0 = X - P.shutterPodLeft;
  const podX1 = cx1 + 0.5;                                // into the right wall: one block
  const rF = P.shutterActuatorFlangeD / 2 + P.shutterFlangeBoreClear;
  const chamberZ0 = Zc - rF;                              // the closed rear end
  const legStopZ = Zc + P.shutterLegZ + P.shutterLegClr;  // the front legs stop here: the switch centred under the cap
  const pocket = [X - P.shutterSwitchBody[0] / 2 - P.shutterSwitchPocketClr, Zc - P.shutterSwitchBody[1] / 2 - P.shutterSwitchPocketClr,
    X + P.shutterSwitchBody[0] / 2 + P.shutterSwitchPocketClr, Zc + P.shutterSwitchBody[1] / 2 + P.shutterSwitchPocketClr];   // x0, z0, x1, z1
  const lip = rF - P.shutterFlangeBoreClear - rG;         // the flange over the step, each side
  const stem = P.shutterProud + P.shutterGuideLen;        // cap top above the flange's top
  return Object.freeze({ X, Zc, rG, oy1, cy1, guideTop, guideBottom, flangeBottomRest, switchTop, seatTop, floorTop, podInnerY, chamberH, plungerH, podX0, podX1, rF, chamberZ0, legStopZ, pocket, lip, stem });
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
    // The guide: a U in the deck from the step up, open to the front; its
    // round end flat-ceilinged below, round for its last mm at the deck.
    slotY(X, S.guideBottom - 0.01, Zc, rG, P.shutterGuideLen - P.shutterGuideRound + 0.02, P.shutterGuideCeil, Z.plateFront + 1),
    slotY(X, S.guideTop - P.shutterGuideRound - 0.01, Zc, rG, P.shutterGuideRound + 1.0, 0, Z.plateFront + 1),
    // The collar recess round the cap, clipped by the deck's front edge.
    cylY(X, S.oy1 - P.shutterCollarDepth, Zc, P.shutterCollarD / 2, P.shutterCollarDepth + 0.2),
    // The chamber: from its closed rear end out through the plate's front.
    box(X - rF, S.floorTop, S.chamberZ0, X + rF, S.guideBottom + 0.01, Z.plateFront + 1),
    // The switch's pocket in the floor, under the cap.
    box(S.pocket[0], S.seatTop, S.pocket[1], S.pocket[2], S.floorTop + 0.01, S.pocket[3]),
  ];
  // Two leg channels through the floor, from the stop under the cap out to
  // the front; the legs ride in them, the leads hang through them.
  for (const s of [-1, 1]) {
    cuts.push(box(X + s * P.shutterLegX - P.shutterLegSlot[0] / 2, S.podInnerY - 1, S.legStopZ - (P.shutterLegZ * 2 + P.shutterLegClr * 2), X + s * P.shutterLegX + P.shutterLegSlot[0] / 2, S.floorTop + 0.5, Z.plateFront + 1));
  }
  // Four ribs along the slot, added back after the cuts: one on each
  // straight side at the cap's rest and two on the round end 60 degrees
  // each side of its apex (30 degrees of overhang in print, printable; the
  // apex itself is the bridge). The cap runs on four lines, 0.1 off each,
  // instead of ticking in a 0.6 gap; the face's back is the fifth wall.
  const ribs = [];
  {
    const [rh, rw] = P.shutterGuideRib;
    const y0 = S.guideBottom + 0.1, len = P.shutterGuideLen - P.shutterCollarDepth - 0.15;
    for (const phi of [-120, 120]) {   // 0 is +Z (toward the face); the round end is at -Z
      ribs.push(cube(-rw / 2, y0, rG - rh, rw, len, rh + 0.3).rotate([0, phi, 0]).translate([X, 0, Zc]));
    }
    for (const s of [-1, 1]) {
      ribs.push(cube(X + (s < 0 ? -(rG + 0.3) : rG - rh), y0, Zc - rw / 2, rh + 0.3, len, rw));
    }
  }
  return { adds, cuts, ribs };
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
  ]).translate([o, o, 0]);
  return status("shutter button", actuator.simplify(1e-5));
}
