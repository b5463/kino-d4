// B03, the card door, and what the shell gives it: a recess in the top wall
// over the P4's microSD slot, an opening through the wall's floor to the
// cavity, a snap groove in the recess's two side walls and a nail notch in
// its front wall. Body frame: X right, Y up, Z toward the viewer.
//
// The card's seated end is 8.4 below the deck, too deep for a finger
// through a card-sized slot; the opening is a fingertip wide (21 x 8 at
// the floor) so the card can be pushed home until it clicks and pinched out
// once it springs up. The door closes it flush, the deck's grooves carried
// across its top, held by two in-plane PETG spring arms whose bumps snap
// into the groove: the lens cover's arms again. A nail under its front
// edge lifts it.
import { Manifold, cube, box, cylY, fuse, status } from "./lib.mjs";
import { P, XY } from "./params.mjs";

export const DOOR = (() => {
  const oy1 = XY.outer[3], cy1 = XY.cavity[3];
  const cx = (P.tfSlotX[0] + P.tfSlotX[1]) / 2;
  const x0 = cx - P.tfDoorW / 2, x1 = cx + P.tfDoorW / 2, [z0, z1] = P.tfDoorZ;
  const recY = oy1 - P.tfDoorT;                               // the recess's floor, where the door rests
  const L = P.tfDoorLedge;
  const open = [x0 + L, z0 + L, x1 - L, z1 - L];              // the opening through the floor, x0 z0 x1 z1
  const c = P.tfDoorClr;
  const door = [x0 + c, z0 + c, x1 - c, z1 - c];              // the door in plan
  const gYc = recY + P.tfDoorT / 2;                           // the groove's and the bumps' centre height
  const rD = P.tfDoorR - c;                                   // the door's corners
  const bumpZ = door[1] + rD + 1.0;                           // the bumps on the arms' straight flank, near their free ends
  const rootZ = door[3] - P.tfDoorArmRoot;                    // the slits' ends: the arms' roots
  const armL = rootZ - P.tfDoorArmSlit / 2 - bumpZ;           // root to bump
  const cardEnd = P.tfSlotMouthY + P.tfCardProud, cardOut = cardEnd + P.tfCardEject;
  return Object.freeze({ oy1, cy1, cx, x0, x1, z0, z1, recY, open, door, gYc, rD, bumpZ, rootZ, armL, cardEnd, cardOut });
})();

// A rounded rectangle in the XZ plane, from y0 up to y1.
const rrXZ = (xa, za, xb, zb, r, y0, y1) => Manifold.hull([[xa + r, za + r], [xb - r, za + r], [xa + r, zb - r], [xb - r, zb - r]]
  .map(([x, z]) => cylY(x, y0, z, r, y1 - y0, 32)));
// Convex prisms from points: along Z through [x, y] points, along X through [y, z] points.
const prismZ = (z0, len, ...pts) => Manifold.hull(pts.map(([x, y]) => cube(x - 0.005, y - 0.005, z0, 0.01, 0.01, len)));
const prismX = (x0, len, ...pts) => Manifold.hull(pts.map(([y, z]) => cube(x0, y - 0.005, z - 0.005, len, 0.01, 0.01)));

// What the shell loses: cut after everything else is fused.
export function doorCuts() {
  const D = DOOR, cuts = [];
  cuts.push(rrXZ(D.x0, D.z0, D.x1, D.z1, P.tfDoorR, D.recY, D.oy1 + 1));                                   // the recess
  cuts.push(rrXZ(D.open[0], D.open[1], D.open[2], D.open[3], Math.max(0.5, P.tfDoorR - P.tfDoorLedge), D.cy1 - 1, D.recY + 0.01));   // the opening
  const [gD, gH] = P.tfDoorGroove, zA = D.z0 + P.tfDoorR, len = D.z1 - D.z0 - 2 * P.tfDoorR;
  for (const [xw, s] of [[D.x0, -1], [D.x1, 1]]) {                                                         // s points into the side wall
    cuts.push(prismZ(zA, len, [xw - s * 0.01, D.gYc - gH / 2], [xw + s * gD, D.gYc - gH / 2 + gD], [xw + s * gD, D.gYc + gH / 2 - gD], [xw - s * 0.01, D.gYc + gH / 2]));   // the snap groove, 45 degree flanks
    cuts.push(prismZ(zA, len, [xw - s * 0.01, D.oy1 + 0.01], [xw + s * 0.5, D.oy1 + 0.01], [xw - s * 0.01, D.oy1 - 0.5]));   // the wall's top edge chamfered: the bumps ride in
  }
  const [nW, nD] = P.tfDoorNotch;
  // The nail notch: through the front wall's top down to the recess's
  // floor, and a pit 0.6 below the door's underside reaching 0.4 under its
  // front edge, its back sloped 0.8 forward for each 0.6 down, so in print
  // (the front plate on the bed) it is a wall and not a roof.
  cuts.push(box(D.cx - nW / 2, D.recY, D.z1 - 0.01, D.cx + nW / 2, D.oy1 + 1, D.z1 + nD));
  cuts.push(prismX(D.cx - nW / 2, nW, [D.recY + 0.01, D.z1 - P.tfDoorClr - 0.8], [D.recY + 0.01, D.z1 + nD], [D.recY - 0.6, D.z1 + nD], [D.recY - 0.6, D.z1 - P.tfDoorClr]));
  return cuts;
}

// B03 in the body frame, closed in its recess.
export function buildDoor() {
  const D = DOOR, [dx0, dz0, dx1, dz1] = D.door, bc = P.bedChamfer;
  const plate = Manifold.hull([
    rrXZ(dx0 + bc, dz0 + bc, dx1 - bc, dz1 - bc, Math.max(0.3, D.rD - bc), D.recY, D.recY + 0.01),           // its underside is the bed: chamfered against the elephant foot
    rrXZ(dx0, dz0, dx1, dz1, D.rD, D.recY + bc, D.oy1),
  ]);
  // The bumps: on each arm's outer flank, tfDoorBumpOut past the door's
  // edge; the upper flank 45 degrees so it cams out of the groove, the lower
  // one rising from the bed so it prints.
  const out = P.tfDoorBumpOut, tip = 0.2, bumps = [];
  for (const [edge, s] of [[dx0, -1], [dx1, 1]]) {
    bumps.push(prismZ(D.bumpZ - 1.0, 2.0, [edge - s * 0.01, D.recY + 0.02], [edge + s * out, D.gYc - tip], [edge + s * out, D.gYc + tip], [edge - s * 0.01, D.gYc + tip + out]));   // its lower flank from the bed, steeper than 45 degrees
  }
  const cuts = [];
  // The deck's V-grooves carried across its top, on the body's rhythm.
  const d = P.grooveD, h = d * 1.25;
  for (let z = P.grooveZ[0]; z <= P.grooveZ[1] + 1e-9; z += P.grooveP) {
    if (z > dz0 - h && z < dz1 + h) cuts.push(prismX(dx0 - 1, dx1 - dx0 + 2, [D.oy1 + 0.01, z - h], [D.oy1 + 0.01, z + h], [D.oy1 - d, z]));
  }
  // The slits: at each end, from the rear edge forward to the arm's root,
  // with a round end; the arm is the strip outside it, flexing in X.
  const at = P.tfDoorArmT, sw = P.tfDoorArmSlit;
  for (const [edge, s] of [[dx0, 1], [dx1, -1]]) {
    const xa = edge + s * at, xb = edge + s * (at + sw);
    cuts.push(box(Math.min(xa, xb), D.recY - 1, dz0 - 1, Math.max(xa, xb), D.oy1 + 1, D.rootZ - sw / 2));
    cuts.push(cylY((xa + xb) / 2, D.recY - 1, D.rootZ - sw / 2, sw / 2, P.tfDoorT + 2, 24));
  }
  return status("card door", fuse([plate, ...bumps]).subtract(fuse(cuts)).simplify(1e-3));
}
