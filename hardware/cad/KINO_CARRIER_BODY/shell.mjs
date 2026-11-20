// The shell and the rear frame: the charcoal parts.
//
// The shell is the front plate with the camera pockets, all four walls down
// to the display plane and forward past the plate by faceBase, so the face
// sits inside a charcoal rim; four pillars that stand on the carrier at its
// M2 holes; the shutter pod on the top wall; the strap lug on the right wall;
// V-grooves around the side and bottom walls, parallel to the print's layers,
// the brand's layer texture; the LED slots, the USB-C opening and the frame
// pilots. Printed face down.
//
// The rear frame is a 3 mm plate around the display with the thumb pad as
// grooves on its right border and the ODD JOBS symbol engraved on its left,
// both recesses because its rear face is the bed.
import fs from "node:fs";
import { Manifold, CrossSection, cube, box, cylZ, fuse, rbox, status } from "./lib.mjs";
import { P, Z, XY } from "./params.mjs";
import { shutterPod } from "./shutter.mjs";

const SYMBOL = JSON.parse(fs.readFileSync(new URL("../../pcb/kino-d4-carrier-a0/brand/odd-jobs-symbol.json", import.meta.url), "utf8"));

export const SHELL = (() => {
  const [cx0, cy0, cx1, cy1] = XY.cavity;
  const [ox0, oy0, ox1, oy1] = XY.outer;
  const lugProud = 2 * P.strapLugWall + P.strapHoleD;
  const lugHole = [ox1 + lugProud - P.strapLugWall - P.strapHoleD / 2, P.strapLugY0 + P.strapLugLen / 2];
  // The face sits ON the plate inside a flat charcoal margin the width of the
  // wall. Walls running past the plate to pocket the face were tried first:
  // printed face down, the recessed plate hung 2.5 mm over the bed as
  // 10,000 mm^2 of overhang.
  const rimFront = Z.plateFront;
  const pocket = [cx0, cy0, cx1, cy1];        // the face's plan, the cavity's
  const bossTopZ = Z.plateInner + 0.3;
  const bossFootZ = Z.carrierFront;
  const shaftFloorZ = bossFootZ + P.bossFoot;
  const usbOpenH = P.usbPlug[1] + 2 * P.usbPlugClear;
  const usbOpenW = P.usbPlug[0] + 2 * P.usbPlugClear;
  const usbOpenZ = [Z.carrierBack - P.usbShellH / 2 - usbOpenH / 2, Z.carrierBack - P.usbShellH / 2 + usbOpenH / 2];
  const windowHalf = [P.activeArea[0] / 2 + P.windowMargin, P.activeArea[1] / 2 + P.windowMargin];
  return Object.freeze({ lugProud, lugHole, rimFront, pocket, bossTopZ, bossFootZ, shaftFloorZ, usbOpenZ, usbOpenW, windowHalf,
    lensXY: P.cameraXs.map((x) => [x, XY.lensY]), headPocket: P.camBody + P.camBodySlack });
})();

// An rbox of the outer outline inset by `d` (negative grows it), between z0 and z1.
const outerAt = (d, z0, z1) => {
  const [ox0, oy0, ox1, oy1] = XY.outer;
  return rbox(ox0 + d, oy0 + d, z0, ox1 - d, oy1 - d, z1, Math.max(0.5, P.cornerR - d));
};

export function buildShell() {
  const S = SHELL;
  const [cx0, cy0, cx1, cy1] = XY.cavity;
  const [ox0, oy0, ox1, oy1] = XY.outer;
  const outer = outerAt(0, Z.glass, Z.plateFront);
  const cavity = rbox(cx0, cy0, Z.glass - 1, cx1, cy1, Z.plateInner, P.carrierR + P.carrierClear);
  let shell = outer.subtract(cavity);

  // Layer texture: V-grooves around the walls, stopped short of the top deck
  // so the deck reads as a cap. Cut before the lug goes on.
  {
    // Each groove: the hull of a slab inset d at z and two slabs on the outline
    // 1.05 d above and below, less the inset prism, so a V whose faces are a
    // hair steeper than 45 degrees. (Growing the outer slabs by 1 mm made an
    // 11 degree V and 10,000 mm^2 of overhang.)
    // The cutter is what lies OUTSIDE the V: a thin prism on the outline, less
    // the double pyramid whose waist is the inset slab at z. Hulls taken as
    // the cutter themselves (big-small-big, or two wedges) both cut a flat
    // ceiling at z + h, 1,900 mm^2 of overhang between them.
    // h / d sets the V's angle: with the outer slabs 0.02 outside the outline
    // and the waist 0.01 thick, 1.05 came out at 43.6 degrees; 1.25 is 49.
    const d = P.grooveD, h = d * 1.25, grooves = [];
    for (let z = P.grooveZ[0]; z <= P.grooveZ[1] + 1e-9; z += P.grooveP) {
      const waist = outerAt(d, z - 0.005, z + 0.005);
      const diamond = fuse([
        Manifold.hull([outerAt(-0.02, z - h, z - h + 0.01), waist]),
        Manifold.hull([waist, outerAt(-0.02, z + h - 0.01, z + h)]),
      ]);
      grooves.push(outerAt(-0.01, z - h, z + h).subtract(diamond));
    }
    shell = shell.subtract(fuse(grooves).intersect(box(ox0 - 2, oy0 - 2, Z.glass - 1, ox1 + 2, oy1 - 8.0, Z.plateFront + 1)));
  }

  const pod = shutterPod();
  const adds = [...pod.adds];
  for (const [hx, hy] of P.carrierHoles) {
    adds.push(cylZ(hx, hy, S.bossFootZ, P.bossD / 2, S.bossTopZ - S.bossFootZ));
    const toTop = hy > P.carrierH / 2;
    adds.push(box(hx - P.bossRib / 2, toTop ? hy : cy0 - 0.5, S.bossFootZ, hx + P.bossRib / 2, toTop ? cy1 + 0.5 : hy, S.bossTopZ));
  }
  // The strap lug on the right wall, its +Z side sloped past 45 degrees back
  // to the wall so the print (face down) has nothing hanging.
  adds.push(Manifold.hull([
    box(ox1 - 0.5, P.strapLugY0, P.strapLugZ0, ox1 + S.lugProud, P.strapLugY0 + P.strapLugLen, P.strapLugZ0 + P.strapLugH),
    box(ox1 - 0.5, P.strapLugY0, P.strapLugZ0, ox1 + 0.01, P.strapLugY0 + P.strapLugLen, P.strapLugZ0 + P.strapLugH + S.lugProud * 1.05),
  ]));
  shell = shell.add(fuse(adds));

  const cuts = [...pod.cuts];
  for (const [hx, hy] of P.carrierHoles) {
    cuts.push(cylZ(hx, hy, S.shaftFloorZ, P.accessShaftD / 2, Z.plateFront + 1 - S.shaftFloorZ, 48));
    cuts.push(cylZ(hx, hy, S.bossFootZ - 0.5, P.screwBore / 2, P.bossFoot + 1, 32));
  }
  for (const [lx, ly] of S.lensXY) {
    cuts.push(cube(lx - S.headPocket / 2, ly - S.headPocket / 2, Z.plateInner - 0.01, S.headPocket, S.headPocket, Z.camPocketDepth + 0.01));
    cuts.push(cylZ(lx, ly, Z.lensFront - 0.01, P.lensBoreD / 2, P.platePocketAhead + 1, 64));
  }
  for (const lx of P.ledXs) {
    cuts.push(box(lx - P.ledSlot[0] / 2, oy0 - 1, Z.carrierBack - P.ledSlot[1], lx + P.ledSlot[0] / 2, cy0 + 1, Z.carrierBack));
  }
  {
    const [x0, x1] = [P.usbCX - S.usbOpenW / 2, P.usbCX + S.usbOpenW / 2];
    const gable = (S.usbOpenW / 2) * Math.tan((P.usbGable * Math.PI) / 180);
    cuts.push(status("USB opening", Manifold.extrude(
      [[x0, S.usbOpenZ[0]], [(x0 + x1) / 2, S.usbOpenZ[0] - gable], [x1, S.usbOpenZ[0]], [x1, S.usbOpenZ[1]], [x0, S.usbOpenZ[1]]],
      cy0 - oy0 + 2).rotate([90, 0, 0]).translate([0, cy0 + 1, 0])));
  }
  for (const x of P.frameScrewXs) for (const y of XY.wallMidY) {
    cuts.push(cylZ(x, y, Z.glass - 0.5, P.framePilotD / 2, P.framePilotDepth + 0.5, 24));
  }
  cuts.push(cylZ(S.lugHole[0], S.lugHole[1], P.strapLugZ0 - 1, P.strapHoleD / 2, P.strapLugH + S.lugProud * 1.05 + 2, 32));
  const bare = shell.subtract(fuse(cuts));
  const ribs = [];
  for (const [lx, ly] of S.lensXY) for (const t of P.camRibSpan) {
    ribs.push(cylZ(lx - S.headPocket / 2 + P.camRibProud / 2, ly - S.headPocket / 2 + S.headPocket * t, Z.plateInner, P.camRibProud, Z.camPocketDepth, 12));
    ribs.push(cylZ(lx - S.headPocket / 2 + S.headPocket * t, ly - S.headPocket / 2 + P.camRibProud / 2, Z.plateInner, P.camRibProud, Z.camPocketDepth, 12));
  }
  return { bare, shell: status("shell", bare.add(fuse(ribs))) };
}

export function buildFrame() {
  const S = SHELL;
  const [ox0, oy0, ox1, oy1] = XY.outer;
  const [pcx, pcy] = XY.p4Centre;
  const frame = rbox(ox0, oy0, Z.frameRear, ox1, oy1, Z.glass, P.cornerR);
  const cuts = [box(pcx - S.windowHalf[0], pcy - S.windowHalf[1], Z.frameRear - 1, pcx + S.windowHalf[0], pcy + S.windowHalf[1], Z.glass + 1)];
  for (const x of P.frameScrewXs) for (const y of XY.wallMidY) {
    cuts.push(cylZ(x, y, Z.frameRear - 1, P.frameScrewHoleD / 2, P.rearFrameT + 2, 24));
    cuts.push(cylZ(x, y, Z.frameRear - 1, P.frameHeadD / 2, P.frameHeadDepth + 1, 32));
  }
  // Thumb pad: grooves across the right border, where the right thumb rests
  // beside the glass.
  for (let y = P.thumbPadY[0]; y + P.thumbGrooveW <= P.thumbPadY[1] + 1e-9; y += P.thumbGroovePitch) {
    cuts.push(box(P.thumbPadX[0], y, Z.frameRear - 1, P.thumbPadX[1], y + P.thumbGrooveW, Z.frameRear + P.thumbGrooveD));
  }
  // The ODD JOBS symbol, engraved on the left border. Pixel rows run down.
  {
    const [bx0, by0, bx1, by1] = SYMBOL.pixel_bounds;
    const s = P.symbolRearH / (by1 - by0);
    const pts = SYMBOL.points.map(([px, py]) => [P.symbolRearAt[0] + (px - bx0) * s, P.symbolRearAt[1] + (by1 - py) * s]);
    const cs = new CrossSection([pts], "Positive");
    cuts.push((cs.area() > 0 ? cs : new CrossSection([pts.slice().reverse()], "Positive")).extrude(P.symbolRearD + 1).translate([0, 0, Z.frameRear - 1]));
  }
  return status("frame", frame.subtract(fuse(cuts)));
}
