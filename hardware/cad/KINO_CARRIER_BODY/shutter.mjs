// The shutter, after the first printed pod (2026-11-21): the plunger did not
// reach the switch, the retainer cup had nothing to hold it, the two leads
// had no way out, and the teardrop bores were there for the printer, not
// the part. Now:
//
// The pod is a block under the top wall from X podX0 to the right wall.
// A round guide bore for the cap through the deck, a wider round bore
// under it for the plunger's flange (the step between them is what keeps
// the plunger in), and under that a square pocket the 6 x 6 tactile switch
// sits in, actuator up against the flange. The pocket's floor is a flat
// plate (B03) slid into a slit from the pod's left face and locked by one
// of the body's filament pins through the lower lip, the plate and into
// the upper lip: the press goes into solid pod, the pin only stops the
// plate sliding. The switch's legs and its two leads pass down through two
// slots in the plate into the cavity, to J103. Every bore is round; the
// guide's ceiling is flat 0.4 above the circle so the print's bridge never
// touches the cap, and its last 1 mm at the deck is round.
//
// Assembly, with the stack out: plunger into the pod from the cavity, cap
// first, out through the deck (its flange cannot pass the guide); switch
// in behind it, legs down; leads through the plate's slots; plate into the
// slit; pin up through the pod's inner face.
import { Manifold, cube, box, cylZ, coneZ, cylY, fuse, status } from "./lib.mjs";
import { P, Z, XY } from "./params.mjs";

export const SHUTTER = (() => {
  const [, , cx1, cy1] = XY.cavity;
  const [, , , oy1] = XY.outer;
  const X = P.shutterX, Zc = P.shutterZ;
  const guideTop = oy1;                                   // the deck
  const guideBottom = oy1 - P.shutterGuideLen;            // the step the flange rests under
  const flangeTopRest = guideBottom;
  const flangeBottomRest = flangeTopRest - P.shutterFlangeH;
  const flangeBoreBottom = flangeBottomRest - P.shutterTravelClr;   // the flange never reaches it: the switch stops first
  const switchTop = flangeBottomRest;                     // actuator top at rest, just touching
  const floorTop = switchTop - P.shutterSwitchBody[2];    // the switch's base, on the plate
  const floorBottom = floorTop - P.shutterFloorT;
  const slitBottom = floorBottom - P.shutterFloorClr;     // the slit is floorT + clr tall
  const slitTop = floorTop + 0.01;
  const podInnerY = slitBottom - P.shutterFloorLip;       // the pod's face toward the cavity
  const podX0 = X - P.shutterPodLeft;
  const podX1 = cx1 + 0.5;                                // into the right wall: one block
  const slitX1 = X + P.shutterPocketX / 2 + P.shutterFloorPast;   // the plate's far stop
  const plateLen = slitX1 - podX0;
  const pinX = podX0 + P.shutterFloorPinX;
  const stem = P.shutterProud + P.shutterGuideLen;        // cap top above the flange's top
  return Object.freeze({
    X, Zc, oy1, cy1, guideTop, guideBottom, flangeTopRest, flangeBottomRest, flangeBoreBottom, switchTop, floorTop, floorBottom,
    slitBottom, slitTop, podInnerY, podX0, podX1, slitX1, plateLen, pinX, stem,
  });
})();

// A bore along Y with a flat ceiling `up` above the circle's top (-Z is up
// in the shell's print): the bridge clears the part that runs in it.
const slotY = (cx, y, cz, r, len, up) => fuse([cylY(cx, y, cz, r, len), box(cx - r, y, cz - r - up, cx + r, y + len, cz)]);

// What the pod adds to the shell and what it cuts from it. Added before the
// cuts, cut after everything else is fused.
export function shutterPod() {
  const S = SHUTTER, X = S.X, Zc = S.Zc;
  const adds = [cube(S.podX0, S.podInnerY, P.shutterPodBottomZ, S.podX1 - S.podX0, S.cy1 - S.podInnerY + 0.5, Z.plateInner + 0.3 - P.shutterPodBottomZ)];
  const rG = P.shutterActuatorGuideD / 2, rF = P.shutterActuatorFlangeD / 2 + P.shutterFlangeBoreClear;
  const pw = P.shutterPocketX, pz = P.shutterSwitchBody[1] + P.shutterSwitchClearance;
  const cuts = [
    // The guide: a flat-topped slot below, round for its last mm at the deck.
    slotY(X, S.guideBottom - 0.01, Zc, rG, P.shutterGuideLen - P.shutterGuideRound + 0.02, P.shutterGuideCeil),
    cylY(X, S.guideTop - P.shutterGuideRound - 0.01, Zc, rG, P.shutterGuideRound + 1.0),
    // The collar recess round the cap.
    cylY(X, S.oy1 - P.shutterCollarDepth, Zc, P.shutterCollarD / 2, P.shutterCollarDepth + 0.2),
    // The flange bore, from the pocket up to the step.
    slotY(X, S.flangeBoreBottom - 0.01, Zc, rF, S.guideBottom - S.flangeBoreBottom + 0.02, P.shutterGuideCeil),
    // The switch pocket, from the plate up into the flange bore: wide in X
    // for the legs (the flange locates the press, the pocket only the body).
    box(X - pw / 2, S.floorTop - 0.01, Zc - pz / 2, X + pw / 2, S.flangeBoreBottom + 0.02, Zc + pz / 2),
    // The slit for the floor plate, open at the pod's left face.
    box(S.podX0 - 1, S.slitBottom, Zc - P.shutterFloorW / 2 - P.shutterFloorClr, S.slitX1, S.slitTop, Zc + P.shutterFloorW / 2 + P.shutterFloorClr),
    // The pin: from the pod's inner face up through the lower lip, the slit
    // and facePinWall of upper lip.
    cylY(S.pinX, S.podInnerY - 1, Zc, P.facePinD / 2, 1 + P.pinLen + P.shutterFloorClr, 24),
  ];
  return { adds, cuts };
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

// The plunger (B02) and the floor plate (B03), in their own print frame:
// the flange and the plate flat on the bed.
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

  // The floor plate: plateLen along X (the slide), floorW across, floorT
  // thick; two slots for the switch's legs and leads under the pocket, one
  // pin hole near the mouth end. Its bed edge chamfered 0.3 all round.
  const px0 = 24, py0 = 2, L = S.plateLen, W = P.shutterFloorW, T = P.shutterFloorT;
  const plate = Manifold.hull([
    box(px0 + 0.3, py0 + 0.3, 0, px0 + L - 0.3, py0 + W - 0.3, 0.01),
    box(px0, py0, 0.3, px0 + L, py0 + W, T),
  ]);
  const cuts = [];
  const cxPlate = px0 + (S.X - S.podX0), cyPlate = py0 + W / 2;
  const [sw, sl] = P.shutterLegSlot;
  for (const s of [-1, 1]) cuts.push(box(cxPlate + s * P.shutterLegX - sw / 2, cyPlate - sl / 2, -1, cxPlate + s * P.shutterLegX + sw / 2, cyPlate + sl / 2, T + 1));
  cuts.push(cylZ(px0 + P.shutterFloorPinX, cyPlate, -1, P.facePinD / 2, T + 2, 24));
  const floor = plate.subtract(fuse(cuts));
  return status("shutter button", fuse([actuator, floor]).simplify(1e-5));
}
