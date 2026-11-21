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
import { Manifold, CrossSection, cube, box, cylZ, coneZ, cylY, fuse, rbox, status } from "./lib.mjs";
import { P, Z, XY } from "./params.mjs";
import { shutterPod, SHUTTER } from "./shutter.mjs";

const SYMBOL = JSON.parse(fs.readFileSync(new URL("../../pcb/kino-d4-carrier-a0/brand/odd-jobs-symbol.json", import.meta.url), "utf8"));
const MODEL = JSON.parse(fs.readFileSync(new URL("../KINO_FIELD_BODY/brand/kino-d4-mark.json", import.meta.url), "utf8"));

export const SHELL = (() => {
  const [cx0, cy0, cx1, cy1] = XY.cavity;
  const [ox0, oy0, ox1, oy1] = XY.outer;
  // Strap: two slots per lower corner through the frame, over a channel in
  // the bottom wall's end between them. Slot X from the body's left edge,
  // mirrored at the right; Y inside the bottom wall's width.
  // A second pair at the top corners when strapTop: a neck cord then hangs
  // the camera upright, button up; the bottom pair is the wrist loop.
  const slotYs = [[oy0 + P.frameEdgeR + 0.2, oy0 + P.frameEdgeR + 0.2 + P.strapSlot[1]]];
  if (P.strapTop) slotYs.push([oy1 - P.frameEdgeR - 0.2 - P.strapSlot[1], oy1 - P.frameEdgeR - 0.2]);
  const strapSlots = [], strapChannels = [];
  for (const slotY of slotYs) {
    for (const side of [-1, 1]) for (const sx of P.strapSlotXs) {
      const x0 = side < 0 ? ox0 + sx : ox1 - sx - P.strapSlot[0];
      strapSlots.push([x0, slotY[0], x0 + P.strapSlot[0], slotY[1]]);
    }
    strapChannels.push([ox0 + P.strapSlotXs[0], slotY[0], ox0 + P.strapSlotXs[1] + P.strapSlot[0], slotY[1]]);
    strapChannels.push([ox1 - P.strapSlotXs[1] - P.strapSlot[0], slotY[0], ox1 - P.strapSlotXs[0], slotY[1]]);
  }
  const pinXY = [
    ...P.facePinsTop.map((x) => [x, XY.wallMidY[1]]), ...P.facePinsBottom.map((x) => [x, XY.wallMidY[0]]),
    [ox0 + P.wall / 2, P.facePinsSideY], [ox1 - P.wall / 2, P.facePinsSideY],
  ];
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
  return Object.freeze({ strapSlots, strapChannels, pinXY, rimFront, pocket, bossTopZ, bossFootZ, shaftFloorZ, usbOpenZ, usbOpenW, windowHalf,
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
    // All the way round, the deck included: the body is one thing, one idea
    // carried through. One smooth ring of deckRing round the shutter collar.
    const ring = cylY(P.shutterX, oy1 - P.wall - 2, P.shutterZ, P.shutterCollarD / 2 + P.deckRing, P.wall + 4);
    void MODEL;
    shell = shell.subtract(fuse(grooves).subtract(ring));
    // The horizon carried round the LEFT wall only, from the front to the rear
    // frame at the bar's height. On the right the band erased the ribs under
    // the two fingers that hold the camera: the line ends where the hand begins.
    // At the rear it runs out in a 45 degree ramp that ends at the joint's
    // chamfer (a 0.01 mm skin over its end was a 27 mm^2 ceiling at the top
    // of the print; an open end would notch the joint under the frame).
    const [hy0, hy1] = [XY.lensY - P.sliderH / 2 - P.horizonPad, XY.lensY + P.sliderH / 2 + P.horizonPad];
    const hStop = Z.glass + P.bedChamfer + P.horizonWallD + 0.02;
    shell = shell.subtract(box(ox0 - 1, hy0, hStop, ox0 + P.horizonWallD, hy1, Z.plateFront + 1));
    shell = shell.subtract(Manifold.hull([
      box(ox0 - 1, hy0, hStop - 0.01, ox0 + P.horizonWallD, hy1, hStop + 0.01),
      box(ox0 - 1, hy0, Z.glass + P.bedChamfer - 0.01, ox0, hy1, Z.glass + P.bedChamfer + 0.01),
    ]));
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
  shell = shell.add(fuse(adds));
  // No engraving on the deck: a 0.6 mm stroke in a vertical wall is one
  // wobbling perimeter and the top wall of every letter droops. The deck
  // carries the button and nothing else; the name is inside, on the face.

  const cuts = [...pod.cuts];
  for (const [hx, hy] of P.carrierHoles) {
    cuts.push(cylZ(hx, hy, S.shaftFloorZ, P.accessShaftD / 2, Z.plateFront + 1 - S.shaftFloorZ, 48));
    cuts.push(cylZ(hx, hy, S.bossFootZ - 0.5, P.screwBore / 2, P.bossFoot + 1, 32));
  }
  for (const [lx, ly] of S.lensXY) {
    const h = S.headPocket / 2;
    cuts.push(cube(lx - h, ly - h, Z.plateInner - 0.01, S.headPocket, S.headPocket, Z.camPocketDepth + 0.01));
    // Round reliefs in the four corners: a printed inside corner has its own
    // radius and the square head would land on it before the ribs.
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      cuts.push(cylZ(lx + sx * h, ly + sy * h, Z.plateInner - 0.01, P.camPocketCornerRelief, Z.camPocketDepth + 0.01, 24));
    }
    cuts.push(cylZ(lx, ly, Z.lensFront - 0.01, P.lensBoreD / 2, P.platePocketAhead + 1, 64));
    // Exactly 45 degrees (the 0.01 overshoot in the radius, not the height).
    cuts.push(coneZ(lx, ly, Z.plateFront - P.lensBoreChamfer, P.lensBoreD / 2, P.lensBoreD / 2 + P.lensBoreChamfer + 0.01, P.lensBoreChamfer + 0.01, 64));
  }
  // The rear outer edge chamfered bedChamfer too (the top edge in print,
  // uniform steps): with the frame's bed edge chamfered the same, the joint
  // is a drawn V on the groove rhythm instead of a 0.2 mm step under the palm.
  cuts.push(outerAt(-1, Z.glass - 1, Z.glass + P.bedChamfer + 0.01).subtract(Manifold.hull([
    outerAt(P.bedChamfer, Z.glass - 1, Z.glass), outerAt(0, Z.glass + P.bedChamfer, Z.glass + P.bedChamfer + 0.01)])));
  // The front outer edge chamfered: the bed edge, under the face's reveal.
  cuts.push(outerAt(-1, Z.plateFront - P.bedChamfer, Z.plateFront + 1).subtract(Manifold.hull([
    outerAt(P.bedChamfer, Z.plateFront, Z.plateFront + 0.01), outerAt(0, Z.plateFront - P.bedChamfer - 0.01, Z.plateFront - P.bedChamfer)])));
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
  // The strap tunnels inside the bottom wall's end, under a skin of wall: the
  // cord loops the shell's own wall, so a drop never loads the frame's
  // screws. Each tunnel opens through the skin at the two slots.
  for (const [x0, y0, x1, y1] of S.strapChannels) {
    cuts.push(box(x0, y0, Z.glass + P.strapTunnelSkin, x1, y1, Z.glass + P.strapTunnelSkin + P.strapChannelD));
  }
  for (const [x0, y0, x1, y1] of S.strapSlots) cuts.push(box(x0, y0, Z.glass - 1, x1, y1, Z.glass + P.strapTunnelSkin + 0.5));
  // Blind holes in the walls' front ends for the six filament pins that hold
  // the face, countersunk at the mouth (the bed face) against the elephant foot.
  for (const [px, py] of S.pinXY) {
    cuts.push(cylZ(px, py, Z.plateFront - P.facePinWall, P.facePinD / 2, P.facePinWall + 1, 24));
    cuts.push(coneZ(px, py, Z.plateFront - P.facePinSink, P.facePinD / 2, P.facePinD / 2 + P.facePinSink + 0.01, P.facePinSink + 0.01, 24));
  }
  const bare = shell.subtract(fuse(cuts));
  // Three ribs along the shutter's guide bore on its face side (the floor of
  // the bore in print): the cap runs on three lines instead of ticking in a
  // 0.6 mm gap.
  const guideRibs = [];
  {
    const [rh, rw] = P.shutterGuideRib, rg = P.shutterActuatorGuideD / 2;
    const y0 = SHUTTER.oy1 - 2.3, len = 2.3 - P.shutterCollarDepth - 0.05;
    for (const phi of [-50, 0, 50]) {
      guideRibs.push(cube(-rw / 2, y0, rg - rh, rw, len, rh + 0.3).rotate([0, phi, 0]).translate([P.shutterX, 0, P.shutterZ]));
    }
  }
  // Pinch ribs: triangular, camRibBase wide at the wall, camRibProud at the
  // tip, the full pocket depth. Two extrusion lines at the base.
  const ribs = [];
  const tri = (pts) => { const cs = new CrossSection([pts], "Positive"); return (cs.area() > 0 ? cs : new CrossSection([pts.slice().reverse()], "Positive")).extrude(Z.camPocketDepth).translate([0, 0, Z.plateInner]); };
  for (const [lx, ly] of S.lensXY) for (const t of P.camRibSpan) {
    const wx = lx - S.headPocket / 2, wy = ly - S.headPocket / 2, b = P.camRibBase / 2, p = P.camRibProud;
    const ry = wy + S.headPocket * t, rx = wx + S.headPocket * t;
    ribs.push(tri([[wx - 0.01, ry - b], [wx + p, ry], [wx - 0.01, ry + b]]));
    ribs.push(tri([[rx - b, wy - 0.01], [rx, wy + p], [rx + b, wy - 0.01]]));
  }
  return { bare, shell: status("shell", bare.add(fuse([...ribs, ...guideRibs]))) };
}

export function buildFrame() {
  const S = SHELL;
  const [ox0, oy0, ox1, oy1] = XY.outer;
  const [pcx, pcy] = XY.p4Centre;
  // The outer edge chamfered frameEdgeR toward the rear and bedChamfer toward
  // the shell: one hull of four slices. Printed rear face UP, so the rear
  // chamfer faces up in even 0.2 steps and the engraving and grooves are
  // top-surface recesses; the bed chamfer meets the shell's rear chamfer as
  // a drawn V.
  const R = P.frameEdgeR, bc = P.bedChamfer;
  const slices = [
    rbox(ox0 + R, oy0 + R, Z.frameRear, ox1 - R, oy1 - R, Z.frameRear + 0.01, Math.max(0.5, P.cornerR - R)),
    rbox(ox0, oy0, Z.frameRear + R, ox1, oy1, Z.frameRear + R + 0.01, P.cornerR),
    rbox(ox0, oy0, Z.glass - bc - 0.02, ox1, oy1, Z.glass - bc - 0.01, P.cornerR),   // rise exactly bc to the inset slice: 44 degrees counts as overhang
    rbox(ox0 + bc, oy0 + bc, Z.glass - 0.01, ox1 - bc, oy1 - bc, Z.glass, Math.max(0.5, P.cornerR - bc)),
  ];
  // The thumb pad stands off the rear face (raised is free: the rear is up
  // in print), with the body's own grooves across it: texture, not a rocker.
  const padZ0 = Z.frameRear - P.thumbPadProud;
  const frame = Manifold.hull(slices).add(rbox(P.thumbPadX[0], P.thumbPadY[0], padZ0, P.thumbPadX[1], P.thumbPadY[1], Z.frameRear + 0.3, 3.0));
  const [wx0, wy0, wx1, wy1] = [pcx - S.windowHalf[0], pcy - S.windowHalf[1], pcx + S.windowHalf[0], pcy + S.windowHalf[1]];
  const c = P.frameWindowChamfer;
  const cuts = [
    box(wx0, wy0, Z.frameRear - 2, wx1, wy1, Z.glass + 1),
    // The window's inner edge chamfered toward the rear, so the thumb slides
    // onto the glass's edge targets instead of climbing a wall.
    Manifold.hull([box(wx0, wy0, Z.frameRear + c, wx1, wy1, Z.frameRear + c + 0.01), box(wx0 - c, wy0 - c, Z.frameRear - 0.01, wx1 + c, wy1 + c, Z.frameRear)]),
    box(wx0 - c, wy0 - c, Z.frameRear - 2, wx1 + c, wy1 + c, Z.frameRear),
  ];
  for (const x of P.frameScrewXs) for (const y of XY.wallMidY) {
    cuts.push(cylZ(x, y, Z.frameRear - 3, P.frameScrewHoleD / 2, P.rearFrameT + 4, 24));
  }
  // The gasket groove in the inner face round the window: the P4 module is
  // held at the rear by foam in it, squeezed on the glass's margin by the
  // frame screws; the frame itself stands glassClear off the glass. In the
  // rear-up print the groove is in the bed face, its ceiling a 1.5 mm bridge.
  {
    const [gIn, gW, , gD] = P.gasket;
    cuts.push(box(wx0 - gIn - gW, wy0 - gIn - gW, Z.glass - gD, wx1 + gIn + gW, wy1 + gIn + gW, Z.glass + 1)
      .subtract(box(wx0 - gIn, wy0 - gIn, Z.glass - gD - 1, wx1 + gIn, wy1 + gIn, Z.glass + 2)));
  }
  for (let y = P.thumbPadY[0] + 2.4; y + P.thumbGroove[0] <= P.thumbPadY[1] - 2.0; y += P.grooveP) {
    cuts.push(box(P.thumbPadX[0] - 1, y, padZ0 - 1, P.thumbPadX[1] + 1, y + P.thumbGroove[0], padZ0 + P.thumbGroove[1]));
  }
  // The strap slots through the frame's border at the corners.
  for (const [x0, y0, x1, y1] of S.strapSlots) cuts.push(box(x0, y0, Z.frameRear - 3, x1, y1, Z.glass + 1));
  // The ODD JOBS symbol, engraved on the left border, deep enough to read as
  // shadow, with a shallower step outside its outline. Pixel rows run down.
  {
    const [bx0, by0, bx1, by1] = SYMBOL.pixel_bounds;
    const s = P.symbolRearH / (by1 - by0);
    const pts = SYMBOL.points.map(([px, py]) => [P.symbolRearAt[0] + (px - bx0) * s, P.symbolRearAt[1] + (by1 - py) * s]);
    const cs0 = new CrossSection([pts], "Positive");
    const cs = cs0.area() > 0 ? cs0 : new CrossSection([pts.slice().reverse()], "Positive");
    cuts.push(cs.extrude(P.symbolRearD + 1).translate([0, 0, Z.frameRear - 1]));
    cuts.push(cs.offset(P.symbolRearBevel, "Round").extrude(P.symbolRearD * 0.4 + 1).translate([0, 0, Z.frameRear - 1]));
  }
  return status("frame", frame.subtract(fuse(cuts)).simplify(1e-3));
}
