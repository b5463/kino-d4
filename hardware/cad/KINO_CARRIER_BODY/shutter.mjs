// The shutter: the field body's pod, plunger and retainer, restated. The pod
// is a pilaster on the shell's top wall between the plate and the carrier;
// the plunger passes out through the top face; the 6 x 6 x 4.3 tactile switch
// sits in a retainer cup pushed into the pod from inside the cavity, and its
// two leads run down to J103 on the carrier.
//
// Every bore along Y carries a teardrop roof pointing -Z, which is UP in the
// shell's print (face down). The actuator and retainer register on the round
// lower halves, so the roof clearance is inert.
import { Manifold, cube, cylZ, coneZ, cylY, fuse, prismY, teardropY, status, blockText } from "./lib.mjs";
import { P, Z, XY, IDS } from "./params.mjs";

export const SHUTTER = (() => {
  const [, , , cy1] = XY.cavity;
  const [, , , oy1] = XY.outer;
  const podInnerY = cy1 - P.shutterPodReach;
  const wallTop = oy1 - cy1;
  const switchPocketDepth = P.shutterSwitchBody[2] + 0.5;
  const switchPocketY = podInnerY - 0.4;
  // Plunger length, so the press face lands shutterProud above the top face:
  //   proud = stem - (oy1 - podInnerY) - 0.4 + switchPocketDepth + 1.4
  const stem = P.shutterProud + (oy1 - podInnerY) + 0.4 - switchPocketDepth - 1.4;
  return Object.freeze({ podInnerY, wallTop, switchPocketDepth, switchPocketY, stem, oy1, cy1 });
})();

// What the pod adds to the shell and what it cuts from it. Added before the
// cuts, cut after everything else is fused.
export function shutterPod() {
  const S = SHUTTER, X = P.shutterX, Zc = P.shutterZ;
  const adds = [cube(X - P.shutterPodW / 2, S.podInnerY, P.shutterPodBottomZ, P.shutterPodW, S.cy1 - S.podInnerY + 0.5, Z.plateInner + 0.3 - P.shutterPodBottomZ)];
  const cuts = [
    teardropY(X, S.switchPocketY, Zc, P.shutterAssemblyAccessD / 2, S.switchPocketDepth + 1.0),
    teardropY(X, S.switchPocketY + S.switchPocketDepth - 0.2, Zc, P.shutterActuatorFlangeD / 2 + P.shutterFlangeBoreClear, S.oy1 - 2.2 - (S.switchPocketY + S.switchPocketDepth - 0.2)),
    // The guide: gabled below the collar, round for its last 0.6 mm so the
    // gable's apex does not poke out of the deck above the cap (it showed as
    // a 3 mm point in the top view); a 0.6 mm ceiling bridges.
    teardropY(X, S.oy1 - 2.3, Zc, P.shutterActuatorGuideD / 2, 2.3 - P.shutterCollarDepth - 0.2),
    cylY(X, S.oy1 - P.shutterCollarDepth - 0.3, Zc, P.shutterActuatorGuideD / 2, P.shutterCollarDepth + 1.0),
    // The collar recess round: at 0.4 deep its ceiling is a two-layer ledge
    // the printer bridges; gabled, it was a drop icon on the deck.
    cylY(X, S.oy1 - P.shutterCollarDepth, Zc, P.shutterCollarD / 2, P.shutterCollarDepth + 0.2),
  ];
  // One lead route off each of the switch's opposite faces, out into the
  // cavity toward -Y, gabled toward -Z.
  const wireLen = P.shutterPodReach + 1.4;
  for (const s of [-1, 1]) {
    const sx = X + s * (P.shutterSwitchBody[0] + P.shutterSwitchClearance) / 2;
    const sw = P.shutterSideWireW, zTop = Zc - sw / 2;
    cuts.push(fuse([
      cube(sx - sw / 2, S.podInnerY - 1.2, Zc - sw / 2, sw, wireLen, sw),
      prismY(S.podInnerY - 1.2, wireLen, [sx - sw / 2, zTop], [sx + sw / 2, zTop], [sx, zTop - sw / 2]),
    ]));
  }
  return { adds, cuts };
}

// The cap as it stands in the collar, for the colour previews: the rim
// shutterProud above the top face, the dome on it. Body frame.
export function capPreview() {
  const S = SHUTTER;
  const h = P.shutterCollarDepth + P.shutterProud, e = P.shutterCapEdge;
  const cap = fuse([
    cylZ(0, 0, 0, P.shutterPressCapD / 2, h - e, 64),
    coneZ(0, 0, h - e - 0.01, P.shutterPressCapD / 2, P.shutterPressCapD / 2 - e, e + 0.01, 64),
  ]);
  return cap.rotate([-90, 0, 0]).translate([P.shutterX, S.oy1 - P.shutterCollarDepth, P.shutterZ]);
}

// The plunger and the retainer, in their own print frame (flange on the bed).
export function buildShutterButton() {
  const S = SHUTTER;
  const flangeH = 1.6;
  // A flat cap with a 45 degree edge, as the brand's concept draws it: the
  // R18 dome at 0.08 layers was a 3.4 mm flat disc and 0.5 mm rings under
  // the index finger; the chamfer is six even rings.
  const e = P.shutterCapEdge;
  const noseStraightH = S.stem - e;
  const actuatorHeight = flangeH + S.stem;
  const actuator = fuse([
    // The flange's bed edge chamfered against the elephant foot.
    coneZ(0, 0, 0, P.shutterActuatorFlangeD / 2 - 0.3, P.shutterActuatorFlangeD / 2, 0.3),
    cylZ(0, 0, 0.29, P.shutterActuatorFlangeD / 2, flangeH - 0.29),
    cylZ(0, 0, flangeH, P.shutterPressCapD / 2, noseStraightH),
    coneZ(0, 0, flangeH + noseStraightH - 0.01, P.shutterPressCapD / 2, P.shutterPressCapD / 2 - e, e + 0.01, 64),
  ]).translate([9, 9, 0]);

  const rcx = 32, rcy = P.shutterRetainerPlateD / 2, plateH = 1.6;
  const retainerBlank = fuse([
    cylZ(rcx, rcy, 0, P.shutterRetainerPlateD / 2, plateH),
    cylZ(rcx, rcy, plateH, P.shutterRetainerCupD / 2, P.shutterRetainerCupH),
  ]);
  const cradleW = P.shutterSwitchBody[0] + P.shutterSwitchClearance;
  const cradle = cube(rcx - cradleW / 2, rcy - cradleW / 2, plateH - 0.1, cradleW, cradleW, P.shutterRetainerCupH + 0.3);
  const notchDepth = (P.shutterRetainerCupD - P.shutterSwitchBody[1]) / 2 + 0.6;
  const notches = [-1, 1].map((s) => cube(rcx - P.shutterWireBayW / 2,
    s < 0 ? rcy - P.shutterRetainerCupD / 2 - 0.3 : rcy + P.shutterSwitchBody[1] / 2 - 0.6,
    plateH - 0.1, P.shutterWireBayW, notchDepth, P.shutterRetainerCupH + 0.3));
  const legSlotW = cradleW - 2.0;
  const legSlot = cube(rcx - P.shutterRetainerCupD / 2 - 0.3, rcy - legSlotW / 2, plateH - 0.1, P.shutterRetainerCupD + 0.6, legSlotW, P.shutterSwitchLegBand);
  const legSink = cube(rcx - cradleW / 2, rcy - cradleW / 2, plateH - P.shutterSwitchLegSink, cradleW, cradleW, P.shutterSwitchLegSink + 0.1);
  // B02 and B03 engraved in the bed faces, mirrored (read from below).
  const idA = blockText(IDS.plunger, 9 - 4.5, 9 - 1.75, -1, 0.5, P.idDepth + 1, true);
  const idR = blockText(IDS.retainer, rcx - 4.5, rcy - 1.75, -1, 0.5, P.idDepth + 1, true);
  return status("shutter button", fuse([actuator.subtract(idA), retainerBlank.subtract(fuse([cradle, ...notches, legSlot, legSink, idR]))]).simplify(1e-5));
}
