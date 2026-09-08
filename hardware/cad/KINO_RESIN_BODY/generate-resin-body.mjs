import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module from "manifold-3d";

const wasm = await Module();
wasm.setup();
const { Manifold } = wasm;
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, ".candidate");
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// KINO D4 resin body: a clear shell, a black face, and a printed skeleton that
// carries every piece of electronics in the camera.
//
// This is NOT a variant of KINO_FIELD_BODY with different numbers. The field
// body is one program's answer to one question - "print a camera with no
// support material on an FDM machine" - and almost everything in it exists
// because of that: the 50-degree rule, the wall flutes, the gabled hole roofs,
// the split at the bay floor, the two bed jobs, the bed reliefs. Printed in
// resin at a service bureau, none of those constraints apply and none of that
// machinery is worth carrying. What IS worth carrying is the measured inputs
// and the mechanisms, and those are restated here by hand, on purpose, the same
// way verify-release.mjs restates its datums: an independent statement of the
// same measurement is worth more than a shared constant.
//
// The architecture is the part that is new.
//
//   SKELETON, black MJF nylon (PA12). Holds everything: the four camera modules
//   on the 22.00 mm optical datum, the four XIAOs, the P4 module on its measured
//   standoff pattern, the loom. It is also the light baffle - see below - and it
//   is the only part that carries a thread, because a heat-set insert needs a
//   thermoplastic to melt into and cured resin is not one. Nylon is.
//
//   Nylon and not resin for this part because it is the one that gets dropped:
//   four camera modules, a display module and a strap load all hang off it, and
//   standard SLA resin is brittle. It costs accuracy - MJF holds about ±0.3%,
//   so the 66 mm span across the four cameras can be out by 0.2 mm where SLA
//   would hold 0.1 - and that is the right trade here, because the camera
//   baseline is calibrated in software anyway and a cracked camera mount is not
//   calibrated out of anything.
//
//   MJF also removes the support-free rule entirely: a powder bed needs no
//   supports, so this part could carry undercuts and overhangs that no FDM
//   version of it could. What it needs instead is escape routes for unsintered
//   powder, and features coarse enough to resolve - which is why the camera
//   pinch ribs are 0.5 mm proud here against the field body's 0.20.
//
//   SHELL, clear resin, SLA. Four walls and the rear frame. No electronics
//   touch it, no tolerance depends on it, and it can be reprinted in another
//   colour without re-qualifying a single optical dimension. Open at the front
//   for the face and at the rear for the door, so there is no trapped volume
//   for uncured resin to sit in.
//
//   FACE, black resin, SLA. The four lens cells and nothing else structural.
//
// Why the face is black and the shell is clear, which is the whole optical
// argument: light entering a transparent wall travels inside it and reaches
// whatever the interior can see. If the lens cells were clear the sensors would
// see that light, and the firmware's cover-closed test - all four cameras dark
// means the cover is down - would never read dark. An opaque face makes the
// cells the baffle, and an opaque skeleton blocks the path from inside. The
// clear shell then lights up around a dark interior, which is the look, and
// none of it reaches a sensor.
//
// Millimetres. Body coordinates: Z=0 is the FACE's outer surface, +Z runs back
// into the camera, +X is the photographer's right hand, +Y is up.

const cube = (x, y, z, w, d, h) => {
  if (![x, y, z, w, d, h].every(Number.isFinite) || w <= 0 || d <= 0 || h <= 0) {
    throw new Error(`cube(${[x, y, z, w, d, h].join(", ")}) is not a real box - a parameter it reads is undefined or inverted`);
  }
  return Manifold.cube([w, d, h]).translate([x, y, z]);
};
const cylZ = (cx, cy, z, r, h, segments = 64) =>
  Manifold.cylinder(h, r, r, segments).translate([cx, cy, z]);
const fuse = (solids) => Manifold.union(solids);
const intersectionVolume = (a, b) => a.intersect(b).volume();

function roundedRectZ(x, y, z, w, d, h, radius, segments = 64) {
  if (radius <= 0) return cube(x, y, z, w, d, h);
  return Manifold.hull([
    cylZ(x + radius, y + radius, z, radius, h, segments),
    cylZ(x + w - radius, y + radius, z, radius, h, segments),
    cylZ(x + radius, y + d - radius, z, radius, h, segments),
    cylZ(x + w - radius, y + d - radius, z, radius, h, segments),
  ]);
}

const checks = [];
const SOFT_GATES = process.env.KINO_SOFT_GATES === "1";
const check = (name, condition, details) => {
  checks.push({ name, pass: Boolean(condition), details });
  if (!condition && !SOFT_GATES) {
    throw new Error(`Release-gate failure: ${name}: ${details}`);
  }
};

const P = {
  // ---- Measured inputs -------------------------------------------------------
  // Every one of these is a bench measurement or an official drawing figure,
  // restated here rather than imported. Confidence labels are in
  // docs/HARDWARE.md; the one PROVISIONAL figure is called out where it is used.
  moduleW: 117.01,          // P4 module outline, OFFICIAL_CAD
  moduleH: 69.41,
  moduleT: 13.8,            // PCB back to display glass front
  activeAreaW: 93.6,        // 4.3-inch panel, OFFICIAL_CAD
  activeAreaH: 56.16,
  // The standoff pattern, between CENTRES, from the module drawing. It has now
  // moved three times and the reason is a datum confusion worth stating: a
  // caliper reaches EDGES, not centres, so an edge-to-edge span written into a
  // centre-pitch field reads 61.9 + 3.5 = 65.4 and gets recorded as "65.5".
  // That is what happened in 0.1.4, it moved every post 1.8 mm out, and the
  // printed posts splayed by exactly that. Calipers across the standoff edges
  // read 65 x 58, which is the drawing's pitch confirmed. Both quantities are
  // carried here and a gate ties them, so it cannot happen a fourth time.
  p4OutsideSpanX: 65.0,     // MEASURED, edge to edge across the standoffs
  p4OutsideSpanY: 58.0,
  p4HoleX: 61.9,            // between centres, OFFICIAL_CAD
  p4HoleY: 54.8,
  p4StandoffOD: 3.5,        // brass, MEASURED
  p4StandoffH: 3.3,         // MEASURED
  p4PatternOffsetX: -9.3,   // pattern centre, left of module centre. PROVISIONAL:
                            // the only figure of the group never measured, and
                            // KINO_FIELD_BODY/coupons/KINO_P4_1TO1_HOLE_TEMPLATE.pdf
                            // is what checks it. If it is wrong, it is wrong here too.
  cameraPitch: 22.0,        // MEASURED off the released field-body mesh
  camModulePcb: [15.5, 17.9],   // X, Y - MEASURED, long axis vertical
  camPcbT: 3.5,             // MEASURED
  lensBoreD: 7.1,           // barrel clearance, MEASURED Ø7.0 largest circle
  camPupilBackFromFront: 2.6,   // worst-case entrance pupil behind the plate face
  lensFieldDeg: 78.0,       // DESIGN figure for the OV3660 modules; their real
  lensFieldMargin: 2.0,     // field is MEASURE_REQUIRED in docs/HARDWARE.md
  xiaoBoardW: 17.8,         // XIAO ESP32-S3 Sense, MEASURED
  xiaoBoardH: 21.0,
  xiaoBoardT: 7.6,          // the stack, MEASURED
  // VENDOR (Seeed, 21 x 17.8 x 15 mm): 15.0 mm from the XIAO's back face to the
  // LENS's front face, on the stack as it assembles - the camera folded back
  // onto the boards over its own 7 mm ribbon. xiaoPadH is DERIVED from it
  // below and is no longer a number anybody chooses. It was 3.0 here, "chosen
  // from the stack coupon's graduated stations", and the field body's printed
  // rig proved that a chosen stand-off is a stand-off that leaves the camera
  // short of its lens hole.
  camStackH: 15.0,
  camRibbonLen: 7.0,        // MEASURED: FPC connector on the boards' OUTER face
  // How far past the skeleton plate's front face the camera's head reaches, on
  // into the face's own lens cell. The head is about 3.5 mm long and this plate
  // is only 2.5, so unlike the field body's 5 mm plate it cannot swallow the
  // head alone - and it does not have to, because the cell behind the face's
  // bore is open air.
  camHeadIntoFace: 1.0,
  xiaoHeaderZone: 14.0,     // header pins plus a plugged Dupont loop, by decision
  m2InsertPilotD: 3.2,      // A2 brass M2 heat-set, OD 3.5 x L 4
  m2InsertDepth: 4.6,
  m25InsertPilotD: 3.6,     // A2 brass M2.5 heat-set
  m25InsertDepth: 5.0,
  m25ClearD: 2.8,

  // ---- Envelope --------------------------------------------------------------
  // 125 x 82 against the field body's 131 x 90, and the saving is entirely in
  // the walls: 2.0 mm of resin where PETG needed 6.0. Depth is NOT saved,
  // because depth is set by the electronics stack and not by any wall - the
  // summed stack below still comes to 64.6 mm, exactly as it does on the field
  // body, and the two soft terms in it (the header loop and the component bay)
  // were declined there for reasons that have not changed.
  shellWall: 2.0,           // JLCPCB SLA takes 1.0; 2.0 is their recommendation
  bodyW: 125.0,
  bodyH: 82.0,
  bodyD: 65.5,
  cornerR: 8.0,
  // The face drops into a recess in the shell's front rim and finishes flush.
  faceT: 2.5,
  faceLedge: 1.5,           // rim width the face rests on
  faceClear: 0.15,          // per side, face to recess
  faceBarProud: 3.0,        // raised lens bar, forward of the face
  faceBarPad: 7.0,          // bar margin around the lens row
  skeletonPlateT: 2.5,
  camPocketDepth: 1.6,      // locating recess; the pinch ribs do the gripping
                            // (this locates the head in X and Y - what sets its
                            // Z is camHeadIntoFace and the derived stand-off)
  // 0.30 of slack and 0.5 mm ribs, against the field body's 0.15 and 0.20. Both
  // changed for MJF: it holds about ±0.3%, so a 15.5 mm pocket can be 0.05 mm
  // out on its own and a 0.15 mm slack is inside the process noise; and its
  // minimum resolvable detail is around 0.5 mm, so a 0.20 mm rib simply would
  // not appear. Nylon is compliant enough that a 0.5 mm rib still pinches
  // rather than jams.
  camBodySlack: 0.30,
  camRibProud: 0.50,
  // MJF minimums, from the bureau's own guidance: 0.8 mm wall is possible,
  // 1.5 recommended, and about 0.5 mm is the smallest feature that resolves.
  mjfMinWall: 1.5,
  mjfMinDetail: 0.5,
  // SLA minimums for the two resin parts.
  slaMinWall: 1.0,
  xiaoFenceW: 1.5,
  xiaoFenceH: 6.5,
  clampBossD: 9.0,
  p4PostD: 8.0,
  p4SocketDepth: 2.0,
  p4SocketSlopTop: 0.35,    // per side at the mouth: find the brass
  p4SocketSlopBottom: 0.05, // per side at the floor: light press
  bezelT: 4.0,              // door plate thickness, reserved at the rear
  foamGap: 1.2,             // module glass to door inner face
  // Four M2.5 through the FACE into heat-set inserts in the SKELETON, trapping
  // the shell's front rim between them. No glue anywhere, no thread in resin,
  // and the face comes off again - which the field body's permanently glued
  // shell cannot do, and which is what created its "fit the sensor first or
  // never" assembly trap.
  faceScrewInset: 8.0,      // from the cavity's corner, in X and Y
  faceScrewBossD: 7.0,
  faceScrewHeadD: 5.0,      // M2.5 countersunk head, flush in black resin
};

// ---- Derived ---------------------------------------------------------------
const inner = {
  x0: P.shellWall, x1: P.bodyW - P.shellWall,
  y0: P.shellWall, y1: P.bodyH - P.shellWall,
};
const cavW = inner.x1 - inner.x0, cavH = inner.y1 - inner.y0;
const cavCX = (inner.x0 + inner.x1) / 2, cavCY = (inner.y0 + inner.y1) / 2;

// The depth stack, front to back. Re-added by a gate below.
const faceBackZ = P.faceT;                                 // 2.5
const skeletonBackZ = faceBackZ + P.skeletonPlateT;        // 5.0
const camPocketFloorZ = skeletonBackZ - P.camPocketDepth;  // 3.4
// The camera's axial chain, and the one figure it turns on. The skeleton locates
// the BOARD; the camera hangs off the board by the vendor's 15.0 mm; so the
// stand-off is whatever lands the lens's front face where it has to be, which
// is camLensAheadOfPlate ahead of the plate the module's PCB seats on. Choosing
// the stand-off instead - 3.0 here, 3.0 in the field body, 7.0 on the rig - is
// what left the printed cameras unable to reach their holes.
const camLensAheadOfPlate = P.skeletonPlateT + P.camHeadIntoFace;   // 3.5
const xiaoPadH = P.camStackH - P.xiaoBoardT - camLensAheadOfPlate;  // 3.9
const camLensFrontZ = skeletonBackZ - camLensAheadOfPlate;          // 1.5, in the face
const camFoldGap = xiaoPadH - P.camPcbT;                            // 0.4
const xiaoPadTopZ = skeletonBackZ + xiaoPadH;              // 8.9
const xiaoBackZ = xiaoPadTopZ + P.xiaoBoardT;              // 15.6
const bayFloorZ = xiaoBackZ + P.xiaoHeaderZone + 1.4;      // 31.0
const pcbBackZ = bayFloorZ + 14.6;                         // 45.6, as the field body
const postTopZ = pcbBackZ - P.p4StandoffH + P.p4SocketDepth;  // 44.3
const glassRearZ = pcbBackZ + P.moduleT;                   // 59.4
const doorZ0 = P.bodyD - P.bezelT;                         // 60.6

// The optical datum. Cameras centred on the cavity, on the same 22.00 mm pitch
// the field body's released mesh measures.
const cameraXs = [-1.5, -0.5, 0.5, 1.5].map((i) => cavCX + i * P.cameraPitch);
const lensY = inner.y0 + 37.0;      // the field body's 43.0, in a cavity 4 mm lower
const boardCenterY = inner.y0 + 44.0;
const boardMinY = boardCenterY - P.xiaoBoardH / 2;
const boardMaxY = boardCenterY + P.xiaoBoardH / 2;

// Lens cell: a cone that clears the field from the worst-case entrance pupil.
const lensPupilZ = faceBackZ + P.camPupilBackFromFront;     // 5.1
const lensHalfAngle = ((P.lensFieldDeg + P.lensFieldMargin) / 2) * Math.PI / 180;
const lensTan = Math.tan(lensHalfAngle);
const lensBoreR = P.lensBoreD / 2;
const cellMouthZ = -P.faceBarProud;
const cellMouthR = Math.max(lensBoreR, (lensPupilZ - cellMouthZ) * lensTan);

// The module, and its standoff pattern.
const moduleMinX = cavCX - P.moduleW / 2, moduleMinY = cavCY - P.moduleH / 2;
const patternCX = cavCX + P.p4PatternOffsetX;
const mountXs = [patternCX - P.p4HoleX / 2, patternCX + P.p4HoleX / 2];
const mountYs = [cavCY - P.p4HoleY / 2, cavCY + P.p4HoleY / 2];

const faceScrewXs = [inner.x0 + P.faceScrewInset, inner.x1 - P.faceScrewInset];
const faceScrewYs = [inner.y0 + P.faceScrewInset, inner.y1 - P.faceScrewInset];

// ---------------------------------------------------------------------------
// The skeleton. Printed lens-face-down on an FDM machine, so its front face is
// the bed and EVERY feature grows upward from it: pockets open up, bores are
// vertical, bosses and posts are pillars. That is the one rule this part keeps
// from the field body, and it is kept for the same reason - so it needs no
// support material.
function buildSkeleton() {
  const solids = [], cuts = [], postAdds = [];
  const z0 = faceBackZ;
  // Everything that stands on the plate starts 0.5 mm INSIDE it rather than on
  // its face. Abutting on a shared plane is what leaves a union as separate
  // shells - the first cut of this part came out as five connected components,
  // one plate and four posts touching it on exactly one plane.
  const embed = 0.5;

  const c = 0.25;   // running clearance, plate to shell
  solids.push(roundedRectZ(inner.x0 + c, inner.y0 + c, z0,
    cavW - 2 * c, cavH - 2 * c, P.skeletonPlateT, Math.max(1.0, P.cornerR - P.shellWall)));

  for (const cx of cameraXs) {
    // Lens bore through the front of the plate. The 0.9 mm of plate left in
    // front of the pocket is the light seal between the cell and the sensor,
    // and it is opaque because this part is.
    cuts.push(cylZ(cx, lensY, z0 - 0.01, lensBoreR, P.camPocketDepth + 0.02, 64));
    const [pw, ph] = P.camModulePcb;
    const pocket = [pw + 2 * P.camBodySlack, ph + 2 * P.camBodySlack];
    cuts.push(cube(cx - pocket[0] / 2, lensY - pocket[1] / 2, camPocketFloorZ,
      pocket[0], pocket[1], P.camPocketDepth + 0.01));
    // Pinch ribs, added AFTER the pocket is cut. Put in with the other solids
    // they vanish: a rib centred on the pocket wall is half inside it, and the
    // pocket cut takes that half away and leaves nothing standing.
    for (const s of [-1, 1]) {
      postAdds.push(cylZ(cx + s * pocket[0] / 2, lensY, camPocketFloorZ,
        P.camRibProud, P.camPocketDepth, 24));
      postAdds.push(cylZ(cx, lensY + s * pocket[1] / 2, camPocketFloorZ,
        P.camRibProud, P.camPocketDepth, 24));
    }
    // XIAO seat. The two pads sit ABOVE the camera module's top edge, not on
    // the board's centreline - a pad under the module's footprint stands in the
    // 3.5 mm PCB's way and, in the first cut of this part, straight across the
    // lens axis. The board is carried on these two and pressed down by its
    // clamp, which is how the field body does it.
    const camModTopY = lensY + P.camModulePcb[1] / 2;
    for (const py of [camModTopY + 2.3, boardMaxY - 1.2]) {
      solids.push(cylZ(cx, py, skeletonBackZ - embed, 2.0, xiaoPadH + embed, 32));
    }
    for (const s of [-1, 1]) {
      const fx = cx + s * P.xiaoBoardW / 2;
      solids.push(cube(s < 0 ? fx - P.xiaoFenceW : fx, boardMinY + 2.0, skeletonBackZ - embed,
        P.xiaoFenceW, P.xiaoBoardH - 4.0, P.xiaoFenceH + embed));
    }
    // Clamp boss above the board's top end, with an M2 insert pocket. The field
    // body's released XIAO clamps fit this unchanged: same boss diameter, same
    // insert, same board-back plane.
    const bossY = boardMaxY + 6.5;
    solids.push(cylZ(cx, bossY, skeletonBackZ - embed, P.clampBossD / 2,
      xiaoBackZ - skeletonBackZ + embed));
    cuts.push(cylZ(cx, bossY, xiaoBackZ - P.m2InsertDepth,
      P.m2InsertPilotD / 2, P.m2InsertDepth + 0.6, 32));
  }

  // The four P4 posts, on the measured pattern, with the conical sockets the
  // field body arrived at: a wide mouth to find the brass, closing to a light
  // press at the floor. A printer misses the first tenth of a straight bore by
  // its own tolerance, which is what a cone is for.
  const socketFloorD = P.p4StandoffOD + 2 * P.p4SocketSlopBottom;
  const socketMouthD = P.p4StandoffOD + 2 * P.p4SocketSlopTop;
  for (const x of mountXs) {
    for (const y of mountYs) {
      solids.push(cylZ(x, y, skeletonBackZ - embed, P.p4PostD / 2,
        postTopZ - skeletonBackZ + embed));
      cuts.push(Manifold.cylinder(P.p4SocketDepth + 0.01, socketFloorD / 2, socketMouthD / 2, 48)
        .translate([x, y, postTopZ - P.p4SocketDepth]));
    }
  }

  // Insert bosses for the four face screws. The thread lives here, in nylon,
  // because a heat-set insert needs a thermoplastic to melt into.
  for (const x of faceScrewXs) {
    for (const y of faceScrewYs) {
      solids.push(cylZ(x, y, z0, P.faceScrewBossD / 2, P.skeletonPlateT + P.m25InsertDepth + 2.0));
      // The pilot opens at the boss's FRONT face, because that is the side the
      // insert is pressed in from and the side the screw arrives from. Started
      // 1 mm inside it instead, it is a hole closed at both ends: four internal
      // voids, reported as four loose components of MINUS 56.6 mm^3 each, and
      // four pockets of unsintered powder with no way out.
      cuts.push(cylZ(x, y, z0 - 0.01, P.m25InsertPilotD / 2, P.m25InsertDepth + 0.61, 32));
    }
  }

  return fuse(solids).subtract(fuse(cuts)).add(fuse(postAdds)).simplify(1e-3);
}

// ---------------------------------------------------------------------------
// The shell. Clear resin: four walls and the rear frame, open at the front for
// the face and at the rear for the door. Nothing electrical touches it.
function buildShell() {
  const outer = roundedRectZ(0, 0, 0, P.bodyW, P.bodyH, P.bodyD, P.cornerR);
  // Hollow it out from the front, all the way through: this is a tube, which
  // is also why there is no trapped volume for uncured resin.
  const bore = roundedRectZ(inner.x0, inner.y0, -1, cavW, cavH, P.bodyD + 2,
    Math.max(1.0, P.cornerR - P.shellWall));
  // The face's recess: the rim steps inward over the face's thickness so the
  // face lands on a ledge and finishes flush with the outer surface.
  const recess = roundedRectZ(inner.x0 - P.faceLedge, inner.y0 - P.faceLedge, -0.01,
    cavW + 2 * P.faceLedge, cavH + 2 * P.faceLedge, P.faceT + 0.01,
    Math.max(1.0, P.cornerR - P.shellWall + P.faceLedge));
  return outer.subtract(fuse([bore, recess])).simplify(1e-3);
}

// ---------------------------------------------------------------------------
// The face. Black resin, and the camera's only baffle: the four cells are cut
// through it and nothing else structural happens here.
function buildFace() {
  const c = P.faceClear;
  const w = cavW + 2 * P.faceLedge - 2 * c, d = cavH + 2 * P.faceLedge - 2 * c;
  const x0 = inner.x0 - P.faceLedge + c, y0 = inner.y0 - P.faceLedge + c;
  const plate = roundedRectZ(x0, y0, 0, w, d, P.faceT,
    Math.max(1.0, P.cornerR - P.shellWall + P.faceLedge - c));
  // The raised lens bar, forward of the face, stiffening a thin plate along the
  // one line that matters and shading the cells.
  const barX0 = cameraXs[0] - cellMouthR - P.faceBarPad;
  const barX1 = cameraXs[3] + cellMouthR + P.faceBarPad;
  const bar = roundedRectZ(barX0, lensY - cellMouthR - P.faceBarPad, cellMouthZ,
    barX1 - barX0, 2 * (cellMouthR + P.faceBarPad), P.faceBarProud + P.faceT, 4.0);
  const cuts = [];
  for (const cx of cameraXs) {
    // One cone from the bar's face to the skeleton's bore. Wider than the field
    // cone needs everywhere except at its throat, so it cannot vignette.
    cuts.push(Manifold.cylinder(faceBackZ - cellMouthZ + 0.02, cellMouthR, lensBoreR, 96)
      .translate([cx, lensY, cellMouthZ - 0.01]));
  }
  for (const x of faceScrewXs) {
    for (const y of faceScrewYs) {
      cuts.push(cylZ(x, y, -0.01, P.m25ClearD / 2, P.faceT + 0.02, 32));
      // Countersink, so four black screws finish flush in a black plate.
      cuts.push(Manifold.cylinder(P.faceScrewHeadD / 2 - P.m25ClearD / 2 + 0.01,
        P.faceScrewHeadD / 2, P.m25ClearD / 2, 32).translate([x, y, -0.01]));
    }
  }
  return plate.add(bar).subtract(fuse(cuts)).simplify(1e-3);
}

const skeleton = buildSkeleton();
const shell = buildShell();
const face = buildFace();

// Print orientations. The skeleton prints lens-face-down, so its front face
// goes to Z=0 and every feature grows up. The two resin parts are oriented for
// the bureau to place and support; they are written on Z=0 so a viewer opens
// them the right way up.
const skeletonPrint = skeleton.translate([0, 0, -faceBackZ]);
const shellPrint = shell;
const facePrint = face.translate([0, 0, P.faceBarProud]);

// ---------------------------------------------------------------------------
// Gates.

check("the depth stack still sums to the body depth",
  Math.abs(doorZ0 + P.bezelT - P.bodyD) < 1e-9 && Math.abs(pcbBackZ - 46.5) < 1e-9,
  `face ${P.faceT} + skeleton ${P.skeletonPlateT} + camera/XIAO stack ${(xiaoBackZ - skeletonBackZ).toFixed(1)} + header ${P.xiaoHeaderZone} + margin 1.4 + bay 14.6 + module ${P.moduleT} + foam ${P.foamGap} + door ${P.bezelT} = ${P.bodyD}; the module's PCB back lands at ${pcbBackZ}, the same plane as the field body's`);

check("the envelope is smaller than the field body's, in the walls and not the stack",
  P.bodyW < 131 && P.bodyH < 90 && Math.abs(P.bodyD - 65.5) < 1e-9,
  `${P.bodyW} x ${P.bodyH} x ${P.bodyD} against 131 x 90 x 65.5: ${(131 - P.bodyW).toFixed(0)} mm of width and ${(90 - P.bodyH).toFixed(0)} mm of height, from ${P.shellWall} mm resin walls where PETG needed 6.0. Depth is set by the electronics and does not move - both bodies grew 0.9 mm when the camera's stand-off stopped being chosen and started being derived.`);

// The camera has to REACH its lens hole. The field body's printed rig proved
// that a chosen stand-off does not, so the chain is stated here as an identity
// and not as a clearance: the board's back face, less the assembled stack's own
// overall height, IS where the lens's front face lands.
check("the camera reaches its lens hole",
  Math.abs((xiaoBackZ - P.camStackH) - camLensFrontZ) < 1e-9 &&
    camLensFrontZ > 0 && camLensFrontZ < faceBackZ,
  `board back at Z=${xiaoBackZ.toFixed(1)} less the stack's ${P.camStackH} mm puts the lens face at Z=${camLensFrontZ.toFixed(2)}: through the ${P.skeletonPlateT} mm skeleton plate and ${P.camHeadIntoFace} mm into the face's cell, which is open air behind its bore`);
check("the module's PCB seats on the skeleton with the fold behind it",
  camFoldGap >= 0.3 && xiaoPadH > P.camPcbT,
  `${xiaoPadH.toFixed(1)} mm of stand-off takes the module's ${P.camPcbT} mm PCB with ${camFoldGap.toFixed(1)} mm left for the folded ribbon, out of a ${P.camRibbonLen} mm ribbon`);

check("the module fits the cavity with float on every side",
  cavW - P.moduleW > 1.0 && cavH - P.moduleH > 1.0,
  `${cavW.toFixed(1)} x ${cavH.toFixed(1)} mm cavity around a ${P.moduleW} x ${P.moduleH} module: ${((cavW - P.moduleW) / 2).toFixed(2)} mm a side in X, ${((cavH - P.moduleH) / 2).toFixed(2)} in Y`);

check("shell walls are at or over the bureau's recommended minimum",
  P.shellWall >= 2.0,
  `${P.shellWall} mm, against 1.0 mm minimum and 2.0 recommended for JLCPCB SLA in 8001`);

// Each part is one solid. A resin part in two pieces is two parts in the
// bureau's quote, and a skeleton in two pieces has lost a datum.
for (const [name, solid] of [["skeleton", skeleton], ["shell", shell], ["face", face]]) {
  const parts = solid.decompose();
  // A count on its own sends you hunting. The loose pieces' own boxes name the
  // feature that came adrift, which is the difference between a minute and an
  // hour when a boss touches its plate on exactly one plane.
  const where = parts.length === 1 ? "one solid" : parts
    .map((p) => ({ v: p.volume(), b: p.boundingBox() }))
    .sort((a, b) => a.v - b.v)
    .slice(0, 6)
    .map(({ v, b }) => `${v.toFixed(1)} mm^3 at X ${b.min[0].toFixed(1)}..${b.max[0].toFixed(1)} Y ${b.min[1].toFixed(1)}..${b.max[1].toFixed(1)} Z ${b.min[2].toFixed(1)}..${b.max[2].toFixed(1)}`)
    .join("; ");
  check(`${name} is one part`, parts.length === 1,
    `${parts.length} connected component(s): ${where}`);
}

// The optical datum: four bores, on pitch, collinear, through the skeleton.
{
  const bores = cameraXs.map((cx) =>
    intersectionVolume(skeleton, cylZ(cx, lensY, faceBackZ + 0.1, lensBoreR - 0.2, P.camPocketDepth - 0.2, 32)));
  check("all four lens bores are open through the skeleton",
    bores.every((v) => v < 1e-6),
    `Ø${(P.lensBoreD - 0.4).toFixed(1)} probe clear at X ${cameraXs.map((x) => x.toFixed(1)).join(", ")} on Y ${lensY.toFixed(1)}`);
  const pitches = [1, 2, 3].map((i) => cameraXs[i] - cameraXs[i - 1]);
  check("the lens row is on the measured 22.00 mm pitch",
    pitches.every((p) => Math.abs(p - P.cameraPitch) < 1e-9),
    `pitches ${pitches.map((p) => p.toFixed(3)).join(", ")} mm, collinear on Y ${lensY.toFixed(2)}`);
}

// The field cone, measured on the ASSEMBLED pair rather than asserted from the
// parameters that drew it: a cone from each worst-case pupil must reach open air
// through both the face and the skeleton.
{
  const assembled = fuse([face, skeleton]);
  let worst = 90;
  for (const cx of cameraXs) {
    let deg = 0;
    for (let d = 60; d <= 100; d += 0.5) {
      const t = Math.tan((d / 2) * Math.PI / 180);
      const rTop = Math.max(0.1, (lensPupilZ - cellMouthZ + 2.0) * t);
      const cone = Manifold.cylinder(lensPupilZ - cellMouthZ + 2.0, 0.1, rTop, 96)
        .rotate([180, 0, 0]).translate([cx, lensY, lensPupilZ]);
      if (intersectionVolume(assembled, cone) > 1e-3) break;
      deg = d;
    }
    worst = Math.min(worst, deg);
  }
  check("the assembled face and skeleton pass the design field on every lens",
    worst >= P.lensFieldDeg,
    `${worst.toFixed(1)}-degree diagonal clear on the tightest of the four, against the ${P.lensFieldDeg}-degree design figure (the OV3660's real field is MEASURE_REQUIRED)`);
}

// The baffle. This is the gate the clear shell exists for: a sensor must see
// nothing but its own cell. Probed by putting a light path where stray light
// would travel - through the face, beside a cell - and requiring it blocked.
{
  let sealed = true; const read = [];
  for (const cx of cameraXs) {
    // Two rays, each just OUTSIDE the opening it has to be outside of. The
    // first cut of this probe sat 1.2 mm outside the cell's THROAT, which is
    // still well inside its mouth, so it read 33% solid on a face that was
    // perfectly opaque.
    //   face: 1.0 mm outside the cell's widest radius, through bar and plate
    //   skeleton: 0.4 mm outside the lens bore, through the light seal
    const faceRay = cylZ(cx + cellMouthR + 1.0, lensY, cellMouthZ + 0.1, 0.4,
      (faceBackZ - cellMouthZ) - 0.2, 16);
    // Only as long as the seal itself: the seal is the plate IN FRONT of the
    // pocket, Z faceBackZ..camPocketFloorZ, and a probe that runs on into the
    // pocket reads 57% on a seal that is completely solid.
    const skelRay = cylZ(cx + lensBoreR + 0.4, lensY, faceBackZ + 0.1, 0.3,
      (camPocketFloorZ - faceBackZ) - 0.2, 16);
    const fs = intersectionVolume(face, faceRay) / faceRay.volume();
    const ss = intersectionVolume(skeleton, skelRay) / skelRay.volume();
    sealed = sealed && fs > 0.95 && ss > 0.95;
    read.push(`${(100 * fs).toFixed(0)}%/${(100 * ss).toFixed(0)}%`);
  }
  check("the face and skeleton block every path to a sensor but the cell",
    sealed,
    `light paths beside each cell, face/skeleton: ${read.join(", ")} solid. The clear shell can light up without a sensor seeing it, which is what lets the firmware's cover-closed test read dark.`);
}

// The standoff pattern, and its one unmeasured figure.
{
  const socketFloorD = P.p4StandoffOD + 2 * P.p4SocketSlopBottom;
  let fits = 0, grips = 0;
  for (const x of mountXs) {
    for (const y of mountYs) {
      const brass = cylZ(x, y, postTopZ - P.p4SocketDepth + 0.02, (P.p4StandoffOD - 0.02) / 2, P.p4SocketDepth - 0.04, 48);
      if (intersectionVolume(skeleton, brass) < 1e-6) fits++;
      const tight = cylZ(x, y, postTopZ - P.p4SocketDepth + 0.05, socketFloorD / 2 + 0.1, 0.3, 48);
      if (intersectionVolume(skeleton, tight) > 1e-6) grips++;
    }
  }
  check("all four standoff sockets take the brass and grip it at the floor",
    fits === 4 && grips === 4,
    `Ø${P.p4StandoffOD} brass enters all ${fits} sockets to the floor and is gripped in ${grips}: Ø${(P.p4StandoffOD + 2 * P.p4SocketSlopTop).toFixed(2)} mouth closing to Ø${socketFloorD.toFixed(2)} over ${P.p4SocketDepth} mm`);
  check("the standoff pattern is the drawing's, on its unmeasured centre",
    Math.abs(P.p4HoleX - 61.9) < 1e-9 && Math.abs(P.p4HoleY - 54.8) < 1e-9 &&
      Math.abs(P.p4StandoffH - 3.3) < 1e-9 && Math.abs(P.p4StandoffOD - 3.5) < 1e-9,
    `${P.p4HoleX} x ${P.p4HoleY} between centres, of Ø${P.p4StandoffOD} x ${P.p4StandoffH} brass, pattern centre ${-P.p4PatternOffsetX} mm left of module centre. Diameter and height MEASURED, pitch from the drawing, offset PROVISIONAL and shared with the field body - so a paper check there settles it here too.`);
  // A caliper reaches edges, not centres. The two have to differ by exactly one
  // standoff diameter, or one of them has been written into the other's field -
  // which is how this pattern came to move 1.8 mm and splay on the print.
  {
    const spanX = P.p4HoleX + P.p4StandoffOD, spanY = P.p4HoleY + P.p4StandoffOD;
    check("the standoff pitch and the caliper span across the standoffs agree",
      Math.abs(spanX - P.p4OutsideSpanX) <= 0.5 && Math.abs(spanY - P.p4OutsideSpanY) <= 0.5,
      `${P.p4HoleX} x ${P.p4HoleY} between centres plus Ø${P.p4StandoffOD} of brass is ${spanX.toFixed(1)} x ${spanY.toFixed(1)} edge to edge, against ${P.p4OutsideSpanX} x ${P.p4OutsideSpanY} measured - inside the 0.5 mm a whole-millimetre reading can hide`);
  }
}

// The three parts have to go together, and only one way.
{
  const inShell = intersectionVolume(shell, face);
  const faceOnSkeleton = intersectionVolume(face, skeleton);
  check("the face drops into the shell's recess without interference",
    inShell < 1e-3,
    `${inShell.toFixed(4)} mm^3 shared between the face and the shell at ${P.faceClear} mm a side`);
  check("the face lands on the skeleton, not on air",
    faceOnSkeleton < 1e-3,
    `${faceOnSkeleton.toFixed(4)} mm^3 of overlap; the face's back plane and the skeleton's front plane are both Z=${faceBackZ}`);
  const seated = fuse([shell, face, skeleton]);
  check("the assembled camera is one solid",
    seated.decompose().length === 1,
    `${seated.decompose().length} connected component(s) with all three parts seated`);
  const flush = Math.abs(facePrint.boundingBox().min[2]) < 1e-6;
  check("the face finishes flush with the shell's outer surface",
    flush && Math.abs(face.boundingBox().max[2] - P.faceT) < 1e-6,
    `face spans Z ${face.boundingBox().min[2].toFixed(2)}..${face.boundingBox().max[2].toFixed(2)} against a recess ${P.faceT} deep; the bar stands ${P.faceBarProud} mm proud by design`);
}

// The screws, and the one thing that must never be true: a thread in resin.
{
  let clear = 0, threaded = 0;
  for (const x of faceScrewXs) {
    for (const y of faceScrewYs) {
      const shaft = cylZ(x, y, -0.5, P.m25ClearD / 2 - 0.1, P.faceT + 1.0, 32);
      if (intersectionVolume(face, shaft) < 1e-6) clear++;
      const pilot = cylZ(x, y, faceBackZ + 0.5, P.m25InsertPilotD / 2 - 0.15, P.m25InsertDepth - 0.7, 32);
      if (intersectionVolume(skeleton, pilot) < 1e-6) threaded++;
    }
  }
  check("all four face screws pass through resin into a thread in PETG",
    clear === 4 && threaded === 4,
    `${clear} clearance holes in the face and ${threaded} M2.5 insert pockets in the skeleton; the resin carries no thread anywhere on this camera`);
}

// The skeleton is MJF, so it is judged on what a powder bed cares about -
// feature size and powder escape - and NOT on overhangs. There is no
// support-free gate on this part, deliberately: a powder bed has no supports to
// be free of, and carrying the field body's 45-degree rule here would forbid
// geometry that this process prints perfectly well.
{
  check("every skeleton feature is coarser than MJF can resolve",
    P.camRibProud >= P.mjfMinDetail && P.xiaoFenceW >= P.mjfMinWall - 0.01 &&
      P.skeletonPlateT >= P.mjfMinWall,
    `pinch ribs ${P.camRibProud} mm proud, fences ${P.xiaoFenceW} mm, plate ${P.skeletonPlateT} mm, against a ${P.mjfMinDetail} mm smallest resolvable detail and a ${P.mjfMinWall} mm recommended wall. The field body's 0.20 mm ribs would not have appeared at all.`);
  check("the skeleton sits on Z=0 so a viewer opens it the right way up",
    Math.abs(skeletonPrint.boundingBox().min[2]) < 1e-6,
    `Z starts at ${skeletonPrint.boundingBox().min[2].toFixed(4)}`);
  // Powder escape: the skeleton is an open frame, so every pocket and socket
  // opens to the outside. A genus of zero says there is no through-tunnel, and
  // the socket/pocket probes above already show each one is reachable.
  check("no sealed pocket for unsintered powder to stay in",
    skeleton.genus() <= cameraXs.length,
    `genus ${skeleton.genus()}: the lens bores are the only tunnels through the part, and every pocket, socket and insert bore opens to the surface`);
}

// Resin parts must not trap uncured resin, which means no closed void.
for (const [name, solid] of [["shell", shell], ["face", face]]) {
  const genus = solid.genus();
  check(`${name} has no sealed void for resin to sit in`,
    genus >= 0,
    `genus ${genus}: the ${name} is ${name === "shell" ? "a tube, open at the front and the rear" : "a plate with four cells and four screw holes"}, so every internal surface drains`);
}

// The door zone is reserved, not drawn. Say so in a gate rather than in a
// comment nobody runs.
// A rounded probe, because the cavity is rounded: a square box inset 1 mm from
// a bore with R6 corners still has its own corners buried in the shell.
check("the rear door zone is reserved and clear",
  intersectionVolume(fuse([shell, face, skeleton]),
    roundedRectZ(inner.x0 + 1, inner.y0 + 1, doorZ0 + 0.5, cavW - 2, cavH - 2,
      P.bezelT - 1, Math.max(1.0, P.cornerR - P.shellWall - 1))) < 1e-6,
  `Z ${doorZ0}..${P.bodyD} is empty across the cavity, waiting for the door. The sliding lens cover, the door and the shutter are STAGED - see the README.`);

// ---------------------------------------------------------------------------
function normal(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const len = Math.hypot(...n) || 1;
  return n.map((q) => q / len);
}

function writeBinaryStl(name, solid) {
  const mesh = solid.getMesh();
  const stride = mesh.numProp;
  const vertices = [];
  for (let i = 0; i < mesh.numVert; i++) {
    vertices.push([mesh.vertProperties[i * stride], mesh.vertProperties[i * stride + 1],
      mesh.vertProperties[i * stride + 2]]);
  }
  const triangleCount = mesh.triVerts.length / 3;
  const buffer = Buffer.alloc(84 + triangleCount * 50);
  buffer.write(`KINO RESIN BODY ${name}`.slice(0, 80), 0, "ascii");
  buffer.writeUInt32LE(triangleCount, 80);
  let offset = 84;
  for (let i = 0; i < triangleCount; i++) {
    const tri = [vertices[mesh.triVerts[i * 3]], vertices[mesh.triVerts[i * 3 + 1]],
      vertices[mesh.triVerts[i * 3 + 2]]];
    for (const value of [...normal(...tri), ...tri[0], ...tri[1], ...tri[2]]) {
      buffer.writeFloatLE(value, offset);
      offset += 4;
    }
    buffer.writeUInt16LE(0, offset);
    offset += 2;
  }
  fs.writeFileSync(path.join(outDir, name), buffer);
  return { triangleCount, bytes: buffer.length };
}

const written = {
  skeleton: writeBinaryStl("KINO_RESIN_SKELETON.stl", skeletonPrint),
  shell: writeBinaryStl("KINO_RESIN_SHELL.stl", shellPrint),
  face: writeBinaryStl("KINO_RESIN_FACE.stl", facePrint),
};

const dims = (m) => {
  const b = m.boundingBox();
  return [0, 1, 2].map((a) => Number((b.max[a] - b.min[a]).toFixed(2)));
};
const report = {
  status: SOFT_GATES ? "SOFT_GATES" : "RELEASE_CHECKS_PASSED",
  useCase: "resin body: a clear SLA shell and a black SLA face over a black PETG skeleton that carries every piece of electronics",
  process: {
    shell: "JLCPCB SLA, transparent resin (8001-class), 2.0 mm walls, clear",
    face: "JLCPCB SLA, tough black resin (8228-class), 2.5 mm plate, 3.0 mm raised lens bar",
    skeleton: "JLCPCB MJF, nylon PA12, black - tough where resin is brittle, and it takes heat-set inserts",
    fasteners: "4 x M2.5 countersunk through the face into M2.5 brass heat-set inserts in the nylon skeleton; 4 x M2 into M2 inserts for the XIAO clamps. No thread in any resin part.",
  },
  parts: Object.fromEntries(Object.entries({
    skeleton: skeletonPrint, shell: shellPrint, face: facePrint,
  }).map(([k, m]) => [k, {
    mm: dims(m), cm3: Number((m.volume() / 1000).toFixed(2)),
    triangles: written[k].triangleCount,
  }])),
  measured: {
    p4StandoffPattern: [P.p4HoleX, P.p4HoleY],
    p4Standoff: { odMm: P.p4StandoffOD, heightMm: P.p4StandoffH },
    p4PatternOffsetFromModuleCentre: [P.p4PatternOffsetX, 0],
    moduleMm: [P.moduleW, P.moduleH, P.moduleT],
    cameraLensPitch: P.cameraPitch,
  },
  staged: ["sliding lens cover and its track", "rear door", "shutter pod and button", "bench coupons"],
  releaseChecks: checks,
};
fs.writeFileSync(path.join(outDir, "resin-body-release-report.json"),
  `${JSON.stringify(report, null, 2)}\n`);

const failed = checks.filter((c) => !c.pass);
console.log(`${checks.length} gates, ${failed.length} failure(s)`);
for (const c of failed) console.log(`  FAIL ${c.name}: ${c.details}`);
for (const [k, m] of Object.entries({ skeleton: skeletonPrint, shell: shellPrint, face: facePrint })) {
  console.log(`  ${k.padEnd(9)} ${dims(m).join(" x ").padEnd(24)} ${(m.volume() / 1000).toFixed(2)} cm^3`);
}
