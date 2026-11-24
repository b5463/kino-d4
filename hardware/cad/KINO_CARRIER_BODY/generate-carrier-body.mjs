// KINO D4 carrier body: a shell around the dev carrier D1 stack, and the face
// that gives it its form.
//
// The carrier is the chassis. The P4 hangs on its own inserts through 8 mm
// spacers, the carrier sits on the spacers, the XIAOs stand in sockets on the
// carrier, and each camera module hangs off its XIAO on a short soft ribbon.
// The shell holds the stack by the carrier's edge on a ledge in front and by
// foam behind the glass, with the rear frame on six M2 screws into inserts; no screw
// anywhere, nothing at the carrier's holes. Each camera head sits in a
// pocket with pinch ribs so the picture does not shake on its ribbon. The
// face shell carries the form.
//
// ODD JOBS in two materials, one per part: black PETG for the shell, the
// frame and the cover; dark blue PLA for the face and the button. See
// shell.mjs, face.mjs, shutter.mjs.
//
// FDM, no support:
//   A01-KINO_CARRIER_SHELL.stl           black PETG; front plate, four walls, the ledge, shutter pod; front plate on the bed
//   A02-KINO_CARRIER_FACE.stl            dark blue PLA; the face with its own track floor; back down
//   A03-KINO_CARRIER_REAR_FRAME.stl      black PETG; the frame around the display; rear face up
//   B01-KINO_CARRIER_LENS_COVER.stl      black PETG; the sliding cover, keyed; back down
//   B02-KINO_CARRIER_SHUTTER_BUTTON.stl  dark blue PLA; the plunger, the one moving part of the shutter
// plus twelve M2 heat-set inserts (C01), four foam strips (C02), twelve M2 screws (C03),
// and KINO_CARRIER_STACK_DUMMY.stl, the electronics as blocks, for the
// previews and the interference gates.
//
//   node generate-carrier-body.mjs     writes .candidate/, gates throw on the first failure
//   KINO_SOFT_GATES=1 node ...         collects failures instead
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cube, box, cylZ, coneZ, cylY, fuse, vol, rbox, toBed, r2, overhangOutside, writeStl, textSolid, textWidth } from "./lib.mjs";
import { P, Z, XY, IDS } from "./params.mjs";
import { SHELL, buildShell, buildFrame, cameraPocket } from "./shell.mjs";
import { FACE, buildFace } from "./face.mjs";
import { SHUTTER, buildShutterButton, capPreview, plungerAtRest } from "./shutter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, ".candidate");
fs.mkdirSync(outDir, { recursive: true });

const [cx0, cy0, cx1, cy1] = XY.cavity;
const [ox0, oy0, ox1, oy1] = XY.outer;
const S = SHELL;

function buildDummy() {
  const [px0, py0, px1, py1] = XY.p4;
  const parts = [box(px0, py0, Z.glassFront, px1, py1, 0)];
  for (const [hx, hy] of P.carrierHoles) { parts.push(cylZ(hx, hy, 0, 1.75, Z.carrierBack, 24)); parts.push(cylZ(hx, hy, Z.carrierFront, P.carrierHead[0] / 2, P.carrierHead[1], 24)); }   // the standoffs, and the carrier's own screw heads on its front
  const [wx0, wy0, wx1, wy1] = P.usbWindow;
  parts.push(rbox(0, 0, Z.carrierBack, P.carrierW, P.carrierH, Z.carrierFront, P.carrierR)
    .subtract(box(wx0, wy0, Z.carrierBack - 1, wx1, wy1, Z.carrierFront + 1)));
  parts.push(box(P.usbCX - 4.47, P.carrierH - 7.88, Z.carrierBack - P.usbShellH, P.usbCX + 4.47, P.carrierH - 0.53, Z.carrierBack));
  for (const [x0, y0, x1, y1, h] of P.frontParts) parts.push(box(x0, y0, Z.carrierFront, x1, y1, Z.carrierFront + h));   // the front-face connectors and links
  const [bx0, by0, bx1, by1] = P.batteryBay;
  parts.push(box(bx0, by0, Z.bayFloor, bx1, by1, Z.bayCeiling));
  for (const x of P.cameraXs) {
    const cy = P.socketCentreY, ly = XY.lensY;
    for (const sx of [-7.62, 7.62]) parts.push(box(x + sx - 1.27, cy - 8.89, Z.carrierFront, x + sx + 1.27, cy + 8.89, Z.socketTop));
    parts.push(box(x - P.xiaoBoardW / 2, cy - P.xiaoBoardH / 2, Z.socketTop, x + P.xiaoBoardW / 2, cy + P.xiaoBoardH / 2, Z.senseTop));
    parts.push(box(x - P.camModulePcb[0] / 2, ly - P.camModulePcb[1] / 2, Z.plateInner - 1.0, x + P.camModulePcb[0] / 2, ly + P.camModulePcb[1] / 2, Z.plateInner));
    parts.push(box(x - P.camBody / 2, ly - P.camBody / 2, Z.plateInner, x + P.camBody / 2, ly + P.camBody / 2, Z.plateInner + 2.0));
    parts.push(cylZ(x, ly, Z.plateInner + 2.0, P.camBarrelD / 2, Z.lensFront - Z.plateInner - 2.0, 48));
  }
  return fuse(parts);
}

// ---- Build --------------------------------------------------------------------
const { bare, shell } = buildShell();
const frame = buildFrame();
const dummy = buildDummy();
const { face, cover, coverTurned, lipProud, markBox } = buildFace();
const button = buildShutterButton();
const coverOpen = cover.translate([0, -FACE.travel, 0]);
const coverMid = cover.translate([0, -FACE.travel / 2, 0]);

// ---- Gates --------------------------------------------------------------------
const checks = [];
const SOFT = process.env.KINO_SOFT_GATES === "1";
const check = (name, cond, details) => {
  checks.push({ name, pass: Boolean(cond), details });
  if (!cond && !SOFT) throw new Error(`Release-gate failure: ${name}: ${details}`);
};
const openProbe = (name, probe, details, solid = shell) => {
  const v = probe.volume();
  if (!Number.isFinite(v) || v < 1e-3) throw new Error(`Probe for "${name}" is degenerate (volume ${v})`);
  check(name, vol(solid, probe) < 1e-6, details);
};
const onePart = (name, m) => check(`${name} is one part`, m.decompose().length === 1, `${m.decompose().length} component(s)`);

{
  const terms = [
    ["rear frame", P.rearFrameT], ["glass clearance", P.glassClear], ["P4 module, glass to PCB back", P.p4T],
    ["P4 inserts", P.p4InsertH], ["spacers", P.spacer], ["carrier PCB", P.carrierT],
    ["XIAO socket", P.socketH], ["XIAO header insulator (PROVISIONAL)", P.xiaoHeaderInsulator],
    ["XIAO back face to lens front", P.camStackH], ["plate ahead of the lens", P.platePocketAhead],
    ["face, over the front", P.faceBase],
  ];
  const sum = terms.reduce((t, [, v]) => t + v, 0);
  const depth = FACE.front - Z.frameRear;
  check("the measured stack is the chain's rear", Math.abs(P.p4T + P.p4InsertH + P.spacer + P.carrierT - P.glassToCarrierFront) < 1e-9,
    `${P.p4T} module + ${P.p4InsertH} inserts + ${P.spacer} standoffs + ${P.carrierT} carrier = ${r2(P.p4T + P.p4InsertH + P.spacer + P.carrierT)}, the bench's ${P.glassToCarrierFront} glass front to carrier front`);
  check("depth chain adds up to the body depth", Math.abs(sum - depth) < 1e-9,
    terms.map(([n, v]) => `${n} ${v}`).join(" + ") + ` = ${r2(sum)} mm; body ${r2(depth)}; nothing stands proud of the face`);
  check("the horizon sits above the track's lips and the grip leaves plate", FACE.horizonD >= 0.8 && P.panelDepth >= P.sliderT + 0.2 && P.faceBase - P.gripD >= 1.0 && P.faceFloor >= 1.0,
    `groove ${r2(FACE.horizonD)} deep over lips ${P.panelDepth} above the face's own ${P.faceFloor} floor (the cover ${P.sliderT}, ${r2(P.panelDepth - P.sliderT)} of play); ${r2(P.faceBase - P.gripD)} mm of plate under the grip`);
  check("the lens front is the pocket floor", Math.abs((Z.plateInner + Z.camPocketDepth) - Z.lensFront) < 1e-9,
    `XIAO back at Z=${r2(Z.xiaoBack)} + ${P.camStackH} = lens front Z=${r2(Z.lensFront)}; pocket ${Z.camPocketDepth} deep from the plate's inner face at Z=${r2(Z.plateInner)}`);
  check("the module's PCB has the plate to land on", Z.plateInner - Z.senseTop >= P.camModulePcbT + 0.3,
    `${r2(Z.plateInner - Z.senseTop)} mm from the Sense board's top to the plate's inner face, for a ${P.camModulePcbT} mm module PCB and its fold`);
  check("the face covers the shell's front, inset from the outline", FACE.outline.every((v, i) => Math.abs(Math.abs(v - XY.outer[i]) - P.faceInset) < 1e-9) && FACE.back === Z.plateFront,
    `${r2(FACE.outline[2] - FACE.outline[0])} x ${r2(FACE.outline[3] - FACE.outline[1])} face on the plate, ${P.faceBase} mm thick with a ${P.faceEdgeR} mm chamfer`);
  check("plan corner leaves wall on the diagonal", P.cornerR <= (P.wall + P.carrierClear) * (1 + Math.SQRT2) - 1.0,
    `R${P.cornerR} outer corner against the cavity's near-square corner: ${r2(P.cornerR - (P.cornerR - P.wall - P.carrierClear) * Math.SQRT2)} mm of wall on the diagonal, ${r2(P.cornerR - (P.cornerR - P.wall - P.carrierClear) * Math.SQRT2 - P.grooveD)} under a groove`);
  check("the face steps in from the shell", P.faceInset >= 0.3 && P.faceInset <= 0.5,
    `${P.faceInset} mm of black wall end shows around the blue face`);
}
{
  const [bx0, by0, bx1, by1] = P.batteryBay;
  const h = Z.bayCeiling - Z.bayFloor;
  check("battery bay takes the cell with foam and its swell", h >= P.cellT + P.cellFoam + P.cellSwell,
    `${r2(h)} mm between the P4's module can (${P.p4CanH}, PROVISIONAL) and the carrier's back-face parts (${P.carrierBackPartsH}) for a ${P.cellT} mm cell, ${P.cellFoam} mm of foam and ${P.cellSwell} mm of swell (10 %), so a swelling pouch never lifts the P4 off its spacers`);
  const spacerGap = Math.min(...P.carrierHoles.map(([hx, hy]) => Math.hypot(Math.max(bx0 - hx, 0, hx - bx1), Math.max(by0 - hy, 0, hy - by1)) - 1.75));
  check("battery bay clears the four spacers", spacerGap >= 1.0, `${r2(bx1 - bx0)} x ${r2(by1 - by0)} mm in plan, ${r2(spacerGap)} mm from the nearest 3.5 mm spacer; a 55 x 73 pouch does not fit this plan`);
  check("battery bay is inside the carrier outline", bx0 >= 0 && by0 >= 0 && bx1 <= P.carrierW && by1 <= P.carrierH, "the cell never meets a wall");
}
for (const [n, m] of [["shell", shell], ["rear frame", frame], ["face", face], ["cover", cover]]) onePart(n, m);
check("shutter button file is one part", button.decompose().length === 1, `${button.decompose().length}: the plunger alone; the switch sits in the pod, nothing else is needed`);
check("shell and frame do not overlap", vol(shell, frame) < 1e-6, `${vol(shell, frame).toFixed(4)} mm^3 shared`);
check("face sits on the shell without overlap", vol(shell, face) < 1e-6, `${vol(shell, face).toFixed(4)} mm^3 shared`);
check("stack dummy clears the shell (ribs aside)", vol(bare, dummy) < 1e-3, `${vol(bare, dummy).toFixed(4)} mm^3 of electronics inside the shell's material`);
check("stack dummy clears the frame", vol(frame, dummy) < 1e-6, `${vol(frame, dummy).toFixed(4)} mm^3`);
{
  const crush = vol(shell, dummy);
  check("pinch ribs bite the heads and nothing else does", crush > 1.0 && crush < 40, `${crush.toFixed(2)} mm^3 of rib inside the nominal heads: 16 triangular ribs ${P.camRibBase} wide, ${P.camRibProud} proud`);
}
for (const [lx, ly] of S.lensXY) {
  const pocket = S.headPocket;
  const clear = pocket - P.camRibProud - 0.3;   // one ribbed wall per axis
  openProbe(`camera pocket at X ${lx} open`,
    cube(lx - pocket / 2 + P.camRibProud + 0.15, ly - pocket / 2 + P.camRibProud + 0.15, Z.plateInner + 0.1, clear, clear, Z.camPocketDepth - 0.2),
    `${pocket.toFixed(2)} mm pocket, ${clear.toFixed(2)} mm free between the rib tips and the datum walls for an ${P.camBody} head, ${Z.camPocketDepth} mm deep, ${P.camPocketCornerRelief} mm corner reliefs`);
  check(`camera pocket at X ${lx} has pinch ribs`,
    vol(shell, cube(lx - pocket / 2, ly - pocket / 2 + 1.0, Z.plateInner + 0.3, P.camRibProud * 0.8, pocket - 2.0, 0.5)) > 0.05, `${P.camRibSpan.length} ribs per axis, ${P.camRibProud} mm proud, ${P.camRibBase} at the wall`);
  openProbe(`lens bore at X ${lx} open through the plate`, cylZ(lx, ly, Z.plateInner + 0.1, P.lensBoreD / 2 - 0.1, P.plate - 0.2, 48), `${P.lensBoreD} mm bore to the plate's front face`);
  const zTop = FACE.floorZ + P.sliderT + 0.3;
  // The true view cone: a bore of boreR until the cone outgrows it, then the
  // cone itself (a straight line from the bore's edge at FACE.zBore would
  // overshoot the real cone where the bore is wider than the view).
  const zTrue = Z.pupil + (FACE.boreR - 0.05) / FACE.tanF;
  const cone = fuse([
    cylZ(lx, ly, Z.lensFront, FACE.boreR - 0.05, zTrue - Z.lensFront + 0.01, 64),
    coneZ(lx, ly, zTrue, FACE.boreR - 0.05, FACE.coneR(zTop) - 0.05, zTop - zTrue, 64),
  ]);
  openProbe(`field cone at X ${lx} clears the shell`, cone, `${P.camFovDeg + 2 * P.fovMarginDeg} degrees from a pupil ${P.camPupilBackFromLens} mm behind the lens face`);
  openProbe(`field cone at X ${lx} clears the face`, cone, `cell ${r2(2 * FACE.outerR)} mm: the shell's bore seen through the window`, face);
  openProbe(`field cone at X ${lx} clears the open cover`, cone, `cover stowed ${r2(FACE.travel)} mm down; its top edge at Y ${r2(FACE.openY1)} against the cone's bottom at Y ${r2(ly - FACE.coneR(zTop))}`, coverOpen);
  check(`closed cover blankets the cell at X ${lx}`, vol(cover, cylZ(lx, ly, FACE.floorZ + 0.1, FACE.outerR, 1.0, 48)) > 0.9 * Math.PI * FACE.outerR ** 2,
    `cover ${P.sliderH} tall over a ${r2(2 * FACE.outerR)} mm cell; the firmware's cover-closed test needs all four dark`);
}
// The ledge: the carrier's edge lands on a step all round the cavity at its
// front face; nothing of the body touches the carrier's holes or heads.
{
  const L = P.ledgeW, rc = P.carrierR + P.carrierClear;
  const ring = rbox(cx0 + 0.05, cy0 + 0.05, S.ledgeZ + 0.05, cx1 - 0.05, cy1 - 0.05, S.ledgeZ + 1.0, rc)
    .subtract(rbox(cx0 + L - 0.05, cy0 + L - 0.05, S.ledgeZ - 1, cx1 - L + 0.05, cy1 - L + 0.05, S.ledgeZ + 2, Math.max(0.5, rc - L)));
  check("the ledge stands round the whole cavity at the carrier's front face", vol(shell, ring) > ring.volume() * 0.97,
    `${L} mm wide at Z ${r2(S.ledgeZ)}, ${r2(100 * vol(shell, ring) / ring.volume())} % of the ring in material (the pod and the pockets are elsewhere)`);
  check("the ledge bears on bare carrier edge", L - P.carrierClear >= 1.0 && L + P.carrierClear <= P.carrierEdgeKeepOut,
    `${r2(L - P.carrierClear)} mm of bearing with the carrier pushed ${P.carrierClear} to one side; the ledge reaches ${r2(L + P.carrierClear)} in from the carrier's edge, the nearest front-face part (J1001) is ${P.carrierEdgeKeepOut}`);
  for (const [hx, hy] of P.carrierHoles) {
    const head = cylZ(hx, hy, Z.carrierFront - 0.1, P.carrierHead[0] / 2 + 1.0, P.carrierHead[1] + 1.0, 24);
    check(`nothing of the body within 1 mm of the carrier's head at (${hx}, ${hy})`, vol(bare, head) < 1e-6, `the ${P.carrierHead[0]} mm pan head, ${P.carrierHead[1]} tall, with 1 mm round it; no pillar, no pocket, no screw`);
  }
  // Turned round in its plane the stack does not go in: the heads meet the
  // plate instead of the pockets and the carrier's USB-C meets the top wall.
  const turned = dummy.rotate([0, 0, 180]).translate([P.carrierW, P.carrierH, 0]);
  check("the stack goes in one way", vol(bare, turned) > 50, `turned round, ${r2(vol(bare, turned))} mm^3 of electronics inside the shell's material; the right way, ${vol(bare, dummy).toFixed(4)}`);
}
// The frame's six screws: an insert hole in a boss at each wall's rear end
// and a counterbored hole through the frame; the screw's reach; the frame
// goes on one way; six inserts against the foam's push.
const hole = P.insertHoleD / 2, holeDeep = S.insertHoleDepth;
for (const [px, py, side] of S.frameScrewXY) {
  const at = `(${r2(px)}, ${r2(py)})`;
  openProbe(`frame insert hole in the ${side} wall's rear end at ${at} open`, cylZ(px, py, Z.glass + 0.1, hole - 0.1, holeDeep - 0.3, 24), `${P.insertHoleD} mm, ${r2(holeDeep)} deep for a ${P.insertLen} insert, countersunk ${P.insertMouthSink} at the mouth`);
  const ring = cylZ(px, py, Z.glass + 0.6, hole + 1.0, holeDeep - 0.8, 32).subtract(cylZ(px, py, Z.glass, hole + 0.1, holeDeep + 1, 32));
  check(`frame insert at ${at} has 1.0 mm of wall all round`, vol(shell, ring) > ring.volume() * 0.97,
    `${r2(100 * vol(shell, ring) / ring.volume())} % of a 1.0 mm ring round the hole in material over its depth: ${r2(P.frameScrewIn - hole)} outside (${r2(P.frameScrewIn - hole - P.grooveD)} under a groove), ${r2(P.wall - P.frameScrewIn - hole)} inside toward the cavity`);
  openProbe(`frame screw hole through the frame at ${at} open`, cylZ(px, py, Z.frameRear - 0.3, P.screwClearD / 2 - 0.1, P.rearFrameT + 0.6, 16), `${P.screwClearD} mm through the ${P.rearFrameT} frame`, frame);
  openProbe(`frame counterbore at ${at} open`, cylZ(px, py, Z.frameRear - 0.3, P.frameBoreD / 2 - 0.1, P.frameBoreDepth - 0.05 + 0.3, 24), `${P.frameBoreD} mm, ${P.frameBoreDepth} deep in the rear face; the ${P.screwHeadD} pan head stands ${r2(P.screwHeadH - P.frameBoreDepth)} proud`, frame);
}
check("the frame's counterbores sit inside its rear chamfer", P.frameScrewIn - P.frameBoreD / 2 >= P.frameEdgeR - 0.05 && P.frameScrewIn - P.screwClearD / 2 >= P.bedChamfer + 0.5,
  `the bore's edge ${r2(P.frameScrewIn - P.frameBoreD / 2)} mm from the outline, the chamfer starts at ${P.frameEdgeR}; the hole ${r2(P.frameScrewIn - P.screwClearD / 2)} from it at the inner face`);
check("the frame's screw reaches its insert and stops short of the floor", (() => { const reach = P.frameScrewLen - (P.rearFrameT - P.frameBoreDepth); return reach >= 0.8 * P.insertLen && reach <= holeDeep - 0.3; })(),
  `M2 x ${P.frameScrewLen}: ${r2(P.rearFrameT - P.frameBoreDepth)} of frame under the head, ${r2(P.frameScrewLen - (P.rearFrameT - P.frameBoreDepth))} into a ${P.insertLen} insert in a ${r2(holeDeep)} hole`);
check("the walls carry the insert holes without a boss", P.wall - P.frameScrewIn - hole >= 1.0 && P.frameScrewIn - hole - P.grooveD >= 1.0,
  `a ${P.wall} wall: ${r2(P.wall - P.frameScrewIn - hole)} mm between the hole and the cavity (nothing stands into the carrier's path from the rear, a gate above), ${r2(P.frameScrewIn - hole - P.grooveD)} outside under a groove`);
{
  const miss = Math.min(...S.frameScrewXY.map(([px, py]) => Math.min(...S.frameScrewXY.map(([qx, qy]) => Math.hypot(P.carrierW - px - qx, P.carrierH - py - qy)))));
  check("the frame goes on one way", miss >= 2.0, `turned round in its plane, the nearest hole misses an insert by ${r2(miss)} mm`);
}
// The face's six screws: a counterbored clearance hole through the plate at
// each station, an insert hole in the face's back behind it, blind with
// face ahead, in full plate, the head flush under the stack.
for (const [px, py] of S.faceScrewXY) {
  const at = `(${r2(px)}, ${r2(py)})`;
  openProbe(`face screw hole through the plate at ${at} open`, cylZ(px, py, Z.plateInner - 0.3, P.screwClearD / 2 - 0.1, P.plate + 0.6, 16), `${P.screwClearD} mm through the ${P.plate} plate`);
  openProbe(`face counterbore at ${at} open`, cylZ(px, py, Z.plateInner - 0.3, P.screwBoreD / 2 - 0.1, S.plateBoreDepth - 0.05 + 0.3, 24), `${P.screwBoreD} mm, ${r2(S.plateBoreDepth)} deep in the plate's inner face for the ${P.screwHeadD} x ${P.screwHeadH} pan head`);
  const seat = cylZ(px, py, Z.plateInner + S.plateBoreDepth + 0.05, P.screwBoreD / 2 + 0.8, 0.5, 24).subtract(cylZ(px, py, Z.plateInner, P.screwClearD / 2 + 0.1, P.plate, 24));
  check(`face screw at ${at} has plate to seat on`, vol(shell, seat) > seat.volume() * 0.95, `the head seats on a full ring of plate ${r2(P.plate - S.plateBoreDepth)} mm thick, clear of the pockets and the ledge`);
  const head = cylZ(px, py, Z.plateInner - 0.2, P.screwHeadD / 2 + 0.5, S.plateBoreDepth + 0.2, 24);
  check(`face screw head at ${at} is clear of the stack`, vol(dummy, head) < 1e-3 && P.screwHeadH <= S.plateBoreDepth, `the head ${P.screwHeadH} tall in a ${r2(S.plateBoreDepth)} counterbore, flush under the stack; ${vol(dummy, head).toFixed(4)} mm^3 of electronics in it`);
  openProbe(`face insert hole at ${at} open`, cylZ(px, py, FACE.back - 0.3, hole - 0.1, FACE.insertHoleDepth + 0.1, 24), `${P.insertHoleD} mm, ${r2(FACE.insertHoleDepth)} deep into the face's back for a ${P.insertLen} insert`, face);
  const inBand = py > FACE.horizon[0] && py < FACE.horizon[1];
  const faceThere = inBand ? FACE.trackTop - FACE.back : P.faceBase;   // in the horizon band the face is the groove's floor
  const ahead = cylZ(px, py, FACE.back + FACE.insertHoleDepth + 0.05, hole + 0.5, faceThere - FACE.insertHoleDepth - 0.1, 24);
  check(`face insert hole at ${at} is blind with face ahead`, vol(face, ahead) > ahead.volume() * 0.95 && faceThere - FACE.insertHoleDepth >= 0.7, `${r2(faceThere - FACE.insertHoleDepth)} mm of face ahead of the hole, full${inBand ? " (under the horizon's floor)" : ""}`);
  const ring = cylZ(px, py, FACE.back + 0.5, hole + 1.0, FACE.insertHoleDepth - 0.6, 32).subtract(cylZ(px, py, FACE.back, hole + 0.1, P.faceBase, 32));
  check(`face insert at ${at} has 1.0 mm of face all round`, vol(face, ring) > ring.volume() * 0.97, `${r2(100 * vol(face, ring) / ring.volume())} % of a 1.0 mm ring round the hole in material: clear of the window, the detent channels, the signature and the edge`);
}
check("the face's screw reaches its insert and stops short of the floor", (() => { const reach = P.faceScrewLen - (P.plate - S.plateBoreDepth); return Math.abs(reach - P.insertLen) < 1e-9 && reach <= FACE.insertHoleDepth - 0.3; })(),
  `M2 x ${P.faceScrewLen}: ${r2(P.plate - S.plateBoreDepth)} of plate under the head, the whole ${P.insertLen} insert, ${r2(FACE.insertHoleDepth - P.insertLen)} short of the hole's floor`);
check("the face's stations stay off the mouth and the pod", S.faceScrewXY.every(([px, py]) => py + P.screwBoreD / 2 + 1.0 <= SHUTTER.podInnerY || px + P.screwBoreD / 2 + 1.0 <= SHUTTER.podX0),
  `the pod's inner face at Y ${r2(SHUTTER.podInnerY)} from X ${r2(SHUTTER.podX0)}; the nearest station ${S.faceScrewXY.map(([x, y]) => `(${x}, ${y})`).join(" ")}`);
const MODEL_H = 10.745 * P.modelW / 79.993;   // the model mark's height at modelW
check("the signature inside sits on the plate, clear of the track and the stations", P.innerMarkAt[1] - MODEL_H - 2.5 > FACE.panel[3] + P.horizonPad + 2 && P.innerMarkAt[1] + 6 < FACE.outline[3] - P.faceEdgeR && P.innerMarkAt[0] - (P.modelW - P.innerMarkW) > 20 && P.innerMarkAt[0] + P.innerMarkW + 3 + P.innerSymbolH * 1.25 < 100
  && S.faceScrewXY.every(([px, py]) => px + hole + 1.0 <= P.innerMarkAt[0] - (P.modelW - P.innerMarkW) || px - hole - 1.0 >= P.innerMarkAt[0] + P.innerMarkW + 3 + P.innerSymbolH * 1.25 || py + hole + 1.0 <= P.innerMarkAt[1] - MODEL_H - 2.5 || py - hole - 1.0 >= P.innerMarkAt[1] + 7),
  `"odd jobs" ${P.innerMarkW} mm and the symbol ${P.innerSymbolH} mm, ${P.innerMarkD} deep in the face's back at (${P.innerMarkAt[0]}, ${P.innerMarkAt[1]}); the track ends at Y ${r2(FACE.panel[3])}; the stations 1.0 clear of its box`);
check("the side stations sit above the horizon channel", P.frameScrewsSideY - hole - 1.0 >= XY.lensY + P.sliderH / 2 + P.horizonPad, `inserts at Y ${P.frameScrewsSideY}; the channel runs to Y ${r2(XY.lensY + P.sliderH / 2 + P.horizonPad)}, ${P.horizonWallD} mm into a ${P.wall} mm wall`);
check("the horizon channel leaves wall", P.wall - P.horizonWallD - P.grooveD >= 2.0, `${r2(P.wall - P.horizonWallD - P.grooveD)} mm of wall under the channel where a layer groove crosses it`);
check("the horizon channel is the pry point for the face and the frame", P.horizonWallD - P.faceInset >= 1.0 && P.horizonWallD - P.bedChamfer >= 1.0,
  `${r2(P.horizonWallD - P.faceInset)} mm of the face's back edge exposed at the channel's front end, ${r2(P.horizonWallD - P.bedChamfer)} of the frame's inner face past its chamfer at the rear end; a nail lifts either part there`);
{
  const [hy0, hy1] = [XY.lensY - P.sliderH / 2 - P.horizonPad, XY.lensY + P.sliderH / 2 + P.horizonPad];
  openProbe("the horizon channel runs out under the frame", box(ox0 - 0.2, hy0 + 0.2, Z.glass - 0.3, ox0 + P.horizonWallD - 0.1, hy1 - 0.2, Z.glass + 2), `open to the joint; the frame's inner face shows in it`);
}
check("the lip stands proud of the face for the thumb", Math.abs(lipProud - ((FACE.front - (FACE.floorZ + P.sliderT)) + P.coverLipAboveFace)) < 1e-9 && P.coverLipAboveFace >= 0.4, `${r2(lipProud)} mm off the cover, ${P.coverLipAboveFace} above the face, closed and stowed; the thumb pushes it down and lifts it back`);
openProbe("the carrier slides in from the rear up to the ledge",
  rbox(-0.05, -0.05, Z.glass + 0.1, P.carrierW + 0.05, P.carrierH + 0.05, S.ledgeZ - 0.05, P.carrierR), `${P.carrierClear} mm a side; the ledge at Z=${r2(S.ledgeZ)} is the stop; the shutter pod ends at Z=${P.shutterPodBottomZ}`);
openProbe("USB-C plug passes the bottom wall",
  box(P.usbCX - P.usbPlug[0] / 2, oy0 - 0.5, S.usbOpenZ[0] + P.usbPlugClear, P.usbCX + P.usbPlug[0] / 2, cy0 + 0.5, S.usbOpenZ[1] - P.usbPlugClear), `${P.usbPlug[0]} x ${P.usbPlug[1]} overmold, ${P.usbPlugClear} mm a side`);
{
  const [pcx, pcy] = XY.p4Centre;
  openProbe("the frame shows the whole active area with margin",
    box(pcx - S.windowHalf[0] + 0.05, pcy - S.windowHalf[1] + 0.05, Z.frameRear - 0.5, pcx + S.windowHalf[0] - 0.05, pcy + S.windowHalf[1] - 0.05, Z.glass + 0.5),
    `${r2(2 * S.windowHalf[0])} x ${r2(2 * S.windowHalf[1])} window over ${P.activeArea[0]} x ${P.activeArea[1]} (active area centred: PROVISIONAL)`, frame);
  openProbe("the window's chamfer is cut",
    box(pcx - S.windowHalf[0] - P.frameWindowChamfer + 0.3, pcy - S.windowHalf[1] - P.frameWindowChamfer + 0.3, Z.frameRear - 0.5, pcx + S.windowHalf[0] + P.frameWindowChamfer - 0.3, pcy + S.windowHalf[1] + P.frameWindowChamfer - 0.3, Z.frameRear + 0.2),
    `${P.frameWindowChamfer} mm at 45 degrees, widening toward the rear, for the thumb`, frame);
  const lap = [(P.p4W - 2 * S.windowHalf[0]) / 2 - P.frameWindowChamfer, (P.p4H - 2 * S.windowHalf[1]) / 2 - P.frameWindowChamfer];
  check("the frame overlaps the module's border on every side past the chamfer", lap[0] >= 3 && lap[1] >= 2, `${r2(lap[0])} mm in X, ${r2(lap[1])} mm in Y`);
  check("thumb pad and symbol stay on the frame's borders", P.thumbPadX[0] >= pcx + S.windowHalf[0] + P.frameWindowChamfer + 1 && P.thumbPadX[1] <= ox1 - P.frameEdgeR - 0.5 && P.symbolRearAt[0] >= ox0 + P.frameEdgeR && P.symbolRearAt[0] + P.symbolRearH * 1.23 <= pcx - S.windowHalf[0] - P.frameWindowChamfer - 1,
    `window from X ${r2(pcx - S.windowHalf[0])} to ${r2(pcx + S.windowHalf[0])}; thumb pad X ${P.thumbPadX[0]} to ${P.thumbPadX[1]}; symbol from X ${P.symbolRearAt[0]}, ${P.symbolRearH} mm tall`);
}
check("layer grooves leave the wall", P.wall - P.grooveD >= 4.0, `${P.grooveD} mm V-grooves at ${P.grooveP} mm pitch in a ${P.wall} mm wall`);
check("the frame's insert holes keep wall under the first groove", P.frameScrewIn - hole - P.grooveD >= 1.0, `the axis ${P.frameScrewIn} from the outline, the hole ${P.insertHoleD}: ${r2(P.frameScrewIn - hole)} of wall outside it, ${r2(P.frameScrewIn - hole - P.grooveD)} where a groove crosses the hole's depth (the hole ends at Z ${r2(Z.glass + holeDeep)}, the first shell groove sits at ${r2(P.grooveZ[0] + P.grooveP)})`);
// The cover in its window: the stops, the teeth, the arms.
{
  const [p0x, p0y, p1x, p1y] = FACE.panel, sx0 = p0x + P.sliderClr, sx1 = p1x - P.sliderClr;
  // The rims are the stops: at each stop the cover lies on its rim, and
  // 0.05 past it the cover is in the rim.
  const rimTop = box(p0x + 4, p1y - 0.3, FACE.floorZ + 0.1, p1x - 4, p1y + 1.0, FACE.trackTop - 0.1);
  const rimBot = box(p0x + 4, p0y - 1.0, FACE.floorZ + 0.1, p1x - 4, p0y + 0.3, FACE.trackTop - 0.1);
  const inRim = (rim, c) => vol(face.intersect(rim), c);
  check("closed, the cover lies on the top rim", inRim(rimTop, cover) < 1e-3 && inRim(rimTop, cover.translate([0, 0.05, 0])) > 0.05,
    `its top edge at Y ${r2(FACE.closedY1)}, the window's top rim at ${r2(p1y)}: ${inRim(rimTop, cover.translate([0, 0.05, 0])).toFixed(3)} mm^3 of rim in it 0.05 higher (the rims stood 0.5 off, and the cover hung anywhere in that)`);
  check("stowed, the cover lies on the bottom rim", inRim(rimBot, coverOpen) < 1e-3 && inRim(rimBot, coverOpen.translate([0, -0.05, 0])) > 0.05,
    `its bottom edge at Y ${r2(FACE.openY0)}, the window's bottom rim at ${r2(p0y)}`);
  // At each stop each bump rests on its tooth's far ramp, pressed, so the
  // ramp pushes the cover into the rim; the contact is on the ramp, not on
  // the land and not past the ramp's foot.
  const th = (P.sliderToothDeg * Math.PI) / 180, R = P.sliderBumpR;
  const contactAlong = FACE.restOff - R * Math.sin(th);
  const closed = vol(face, cover), open = vol(face, coverOpen), mid = vol(face, coverMid);
  check("at each stop the bumps rest pressed on the teeth's far ramps", closed > 0.02 && open > 0.02 && contactAlong > 0.05 && contactAlong < FACE.ramp - 0.05,
    `${closed.toFixed(3)} mm^3 closed and ${open.toFixed(3)} stowed shared with the teeth (the arms' ${P.sliderRestPress} of press, drawn unsprung); the bump's centre ${r2(FACE.restOff)} past the land, touching the ${P.sliderToothDeg} degree ramp ${r2(contactAlong)} along its ${r2(FACE.ramp)}`);
  // Between the stops: free, but for one tooth near each end.
  const sweep = [];
  for (let d = 0.25; d < FACE.travel - 0.1; d += 0.25) sweep.push([d, vol(face, cover.translate([0, -d, 0]))]);
  const free = sweep.filter(([, v]) => v < 1e-3);
  const firstFree = free.length ? free[0][0] : NaN, lastFree = free.length ? free[free.length - 1][0] : NaN;
  const freeRun = sweep.filter(([d]) => d >= firstFree && d <= lastFree).every(([, v]) => v < 1e-3);
  check("between the clicks the cover touches nothing", mid < 1e-4 && freeRun && firstFree <= 4.0 && FACE.travel - lastFree <= 4.0 && sweep.some(([d, v]) => d < firstFree && v > 0.05) && sweep.some(([d, v]) => d > lastFree && v > 0.05),
    `${sweep.length} positions 0.25 apart: a tooth under each bump for the first ${r2(firstFree)} mm and the last ${r2(FACE.travel - lastFree)} mm of the ${r2(FACE.travel)}, nothing between (the leaves pressed the flanks over 16 of 19 mm)`);
  const sideways = [-0.09, 0.09].map((dx) => vol(face, coverMid.translate([dx, 0, 0])));
  check("mid-travel, the cover's play on the rail touches nothing", Math.max(...sideways) < 1e-3, `0.09 either way in X: ${sideways.map((v) => v.toFixed(4)).join(" and ")} mm^3; the bumps ${r2(P.sliderClr + P.sliderChannelD - P.sliderBumpOut)} off the channels' backs`);
  // The rail and its groove: the rail in material the window's full
  // height, the groove open through the cover's back, the rail inside the
  // groove at both stops and between, between cells 2 and 3.
  {
    const railX = (FACE.panel[0] + FACE.panel[2]) / 2 + P.sliderRailOffset, [rw, rh] = P.sliderRail, [gw, gd] = P.sliderGroove;
    const rail = box(railX - rw / 2 + 0.1, FACE.panel[1] + 0.5, FACE.floorZ + 0.05, railX + rw / 2 - 0.1, FACE.panel[3] - 0.5, FACE.floorZ + rh - 0.05);
    check("the rail stands on the floor the window's full height", vol(face, rail) > rail.volume() * 0.98, `${rw} x ${rh} at X ${r2(railX)}, from Y ${r2(FACE.panel[1])} to ${r2(FACE.panel[3])}, joined to both rims`);
    const cb = cover.boundingBox();
    const gx = (cb.min[0] + cb.max[0]) / 2 + P.sliderRailOffset;
    openProbe("the groove is open through the cover's back, end to end", box(gx - gw / 2 + 0.1, cb.min[1] - 0.2, cb.min[2] - 0.2, gx + gw / 2 - 0.1, cb.max[1] + 0.2, cb.min[2] + gd - 0.1), `${gw} x ${gd} in the back, ${P.sliderRailOffset} right of the cover's centre`, cover);
    const railFull = box(railX - rw / 2, FACE.panel[1], FACE.floorZ, railX + rw / 2, FACE.panel[3], FACE.floorZ + rh);
    check("the rail runs in the groove at both stops and between", vol(railFull, cover) < 1e-3 && vol(railFull, coverOpen) < 1e-3 && vol(railFull, coverMid) < 1e-3 && Math.abs(gx - railX) < 1e-3 && (gw - rw) / 2 >= 0.1 - 1e-9 && gd - rh >= 0.2 - 1e-9,
      `${r2((gw - rw) / 2)} a side, ${r2(gd - rh)} over the rail; the groove on the rail; guided over its whole ${P.sliderH} under the thumb, so the push cannot yaw it`);
    check("the rail is the orientation key", vol(railFull, coverTurned) > 1.0 && 2 * P.sliderRailOffset - gw / 2 - rw / 2 >= 1.0,
      `turned round in its plane the cover's groove misses the rail by ${r2(2 * P.sliderRailOffset - gw / 2 - rw / 2)} and ${r2(vol(railFull, coverTurned))} mm^3 of rail stands in the cover: it sits ${rh} proud of the floor, above the lips`);
    const nearest = Math.min(...P.cameraXs.map((x) => Math.abs(x - railX) - FACE.boreR - P.cellSink));
    check("the rail sits between cells 2 and 3", nearest >= 1.0 && P.sliderClr >= (gw - rw) / 2 + 0.1, `${r2(nearest)} mm from the nearest cell's rim; the walls stand ${P.sliderClr} off the cover, more than the rail's ${r2((gw - rw) / 2)}, so the rail is the guide`);
  }
  // The bumps sit under the cover's bevels, and under the channels'
  // ceilings with the cover's play.
  const flankTop = P.sliderT - Math.max(...P.sliderBevel);
  const ceilAtTip = P.sliderChannelTop - (P.sliderBumpOut + 0.1 - P.sliderClr);
  check("the bumps run under the bevels and the channels' ceilings", P.sliderBumpTop <= flankTop - 0.3 + 1e-9 && P.sliderBumpTop - 0.5 <= ceilAtTip - 0.3 + 1e-9 && P.sliderChannelTop <= P.panelDepth - FACE.lipZ[0] + 0.03,
    `the bump ${P.sliderBumpTop} tall, full out to ${r2(P.sliderBumpTop - 0.5)}; the flank to ${r2(flankTop)}; the ceiling ${r2(ceilAtTip)} over the bump's tip with 0.1 of play; the channel's mouth ends at the lip's underside`);
  // The walls: two teeth each, the channel open between them.
  for (const [name, wx, s] of [["left", p0x, -1], ["right", p1x, 1]]) {
    const X = (u) => wx + s * u, xs = (a, b) => [Math.min(X(a), X(b)), Math.max(X(a), X(b))];
    const zLo = FACE.floorZ + P.sliderChannelFloor + 0.05, zHi = FACE.floorZ + P.sliderChannelTop - P.sliderChannelD - 0.1;
    for (const t of FACE.teeth) {
      const [xa, xb] = xs(0.05, P.sliderChannelD - 0.05);
      const tooth = box(xa, t.land[0] + 0.05, zLo, xb, t.land[1] - 0.05, zHi);
      check(`the ${name} wall's ${t.name} tooth stands`, vol(face, tooth) > tooth.volume() * 0.97, `its land from Y ${r2(t.land[0])} to ${r2(t.land[1])} at the wall's face, its ramps ${r2(FACE.ramp)} long`);
    }
    const [xa, xb] = xs(0.1, P.sliderChannelD - 0.1);
    openProbe(`the ${name} wall's channel is open between the teeth`, box(xa, FACE.teeth[1].base[1] + 0.1, zLo, xb, FACE.teeth[0].base[0] - 0.1, zHi), `${P.sliderChannelD} deep from Y ${r2(FACE.teeth[1].base[1])} to ${r2(FACE.teeth[0].base[0])}`, face);
  }
  // The arms: in PETG, in the print plane. Stiffness at the bump, the
  // strain at the crest and when the cover is pressed in under a lip, the
  // click under the thumb and the hold into the rim against the cover's
  // weight.
  const at = P.sliderArmT, sw = P.sliderArmSlit, L = P.sliderArmRoot - sw / 2 - P.sliderBumpY;
  const b = P.sliderT - P.bedChamfer - P.sliderBevel[0] / 2;
  const k = 3 * 2000 * (b * at ** 3 / 12) / L ** 3;
  const peak = P.sliderBumpOut - P.sliderClr, fold = P.sliderBevel[0] - P.sliderClr;
  const strain = (d) => 3 * at * d / (2 * L ** 2);
  const click = k * peak * Math.tan(th + (17 * Math.PI) / 180), hold = k * P.sliderRestPress * Math.tan(th);
  const grams = cover.volume() * 1.27e-3;
  const holdG = (2 * hold) / (grams * 9.81e-3);
  check("the arms click and hold inside PETG's limit", strain(fold) <= 0.025 && 2 * click >= 3 && 2 * click <= 7 && holdG >= 5,
    `${at} wide, ${r2(L)} from the slit's end to the bump: about ${r2(k)} N/mm (E 2.0 GPa); ${(100 * strain(peak)).toFixed(2)} % strain over a crest (${peak}), ${(100 * strain(fold)).toFixed(2)} % pressed in under a lip (${r2(fold)}); about ${r2(2 * click)} N under the thumb to click, ${r2(2 * hold)} N into the rim at rest: ${r2(holdG)} g on a ${r2(grams)} g cover`);
  for (const [name, edge, dir] of [["left", sx0, 1], ["right", sx1, -1]]) {
    const [xa, xb] = [edge + dir * at, edge + dir * (at + sw)].sort((p, q) => p - q);
    openProbe(`the ${name} arm's slit is open`, box(xa + 0.1, FACE.closedY0 - 0.5, FACE.floorZ - 0.5, xb - 0.1, FACE.closedY0 + P.sliderArmRoot - sw / 2 - 0.1, FACE.floorZ + P.sliderT + 1), `${sw} wide from the bottom edge to ${P.sliderArmRoot}, room for the ${r2(fold)} fold`, cover);
    const [ya, yb] = [edge + dir * 0.1, edge + dir * (at - 0.1)].sort((p, q) => p - q);
    const arm = box(ya, FACE.closedY0 + 3.2, FACE.floorZ + P.bedChamfer + 0.05, yb, FACE.closedY0 + P.sliderArmRoot - 0.5, FACE.floorZ + 1.9);
    check(`the ${name} arm stands`, vol(cover, arm) > arm.volume() * 0.97, `${at} x ${P.sliderArmRoot} along the flank`);
  }
  check("the slits clear the wordmark and the bumps stay on their arms", markBox.x >= sx0 + at + sw + 0.3 && P.sliderBumpR * 2 - P.sliderBumpOut <= at - 0.2,
    `the wordmark starts ${r2(markBox.x - sx0 - at - sw)} past the left slit; each bump reaches ${r2(2 * P.sliderBumpR - P.sliderBumpOut)} into its ${at} arm`);
  // The lips: the window's whole height but for one gap a side, so the
  // cover is held along its height at both stops, and the stowed bump has
  // its way in from the front.
  const lipCover = (y0, y1) => {
    let n = 0, hit = 0;
    for (let y = y0 + 0.25; y < y1; y += 0.5, n++) {
      const pr = [box(p0x + 0.3, y - 0.05, FACE.trackTop - 0.4, p0x + 0.5, y + 0.05, FACE.trackTop - 0.1), box(p1x - 0.5, y - 0.05, FACE.trackTop - 0.4, p1x - 0.3, y + 0.05, FACE.trackTop - 0.1)];
      if (pr.every((p) => vol(face, p) > p.volume() * 0.9)) hit++;
    }
    return hit / n;
  };
  const lipClosed = lipCover(FACE.closedY0 + P.sliderCornerR, FACE.closedY1 - P.sliderCornerR), lipOpen = lipCover(FACE.openY0 + P.sliderCornerR, FACE.openY1 - P.sliderCornerR);
  check("the lips hold the cover along its height at both stops", lipClosed >= 0.99 && lipOpen >= 0.75 && FACE.lipGap[0] <= FACE.bumpOpenY - P.sliderBumpR - 0.2 && FACE.lipGap[1] >= FACE.bumpOpenY + P.sliderBumpR + 0.2 && FACE.lipGap[1] < FACE.closedY0,
    `${Math.round(100 * lipClosed)} % of the cover's straight flank under a lip closed, ${Math.round(100 * lipOpen)} % stowed (it was 3.9 of 10.5 mm a side stowed, and shaken the cover flew off); the gap Y ${r2(FACE.lipGap[0])} to ${r2(FACE.lipGap[1])}, round the stowed bump and below the closed cover`);
  check("the cover presses in from the front, stowed", fold <= sw - 0.2 && peak <= fold && strain(fold) <= 0.025,
    `stowed, each bump stands over its lip gap and goes in folding its arm ${r2(peak)}; the bevels fold the arms ${r2(fold)} under the lips (the slit ${sw}); the rigid top 2.5 snaps under the lips as the whole bar did before`);
  check("the thumb lip is on the cover's axis", Math.abs(P.coverLipLeft + P.coverLip[0] / 2 - (FACE.panel[2] - FACE.panel[0] - 2 * P.sliderClr) / 2) < 0.5 && markBox.x + markBox.w <= FACE.panel[0] + P.sliderClr + P.coverLipLeft - 0.2,
    `the lip's centre ${r2(P.coverLipLeft + P.coverLip[0] / 2)} from the bar's left end, the bar ${r2(FACE.panel[2] - FACE.panel[0] - 2 * P.sliderClr)} wide: the push cannot yaw it; the wordmark ends ${r2(FACE.panel[0] + P.sliderClr + P.coverLipLeft - markBox.x - markBox.w)} before the lip`);
  check("cover travel is positive and the cover stows on the rim", FACE.travel > 10 && Math.abs(FACE.openY0 - FACE.panel[1]) < 1e-9 && Math.abs(FACE.closedY1 - FACE.panel[3]) < 1e-9, `${r2(FACE.travel)} mm down from Y ${r2(FACE.closedY0)}; stowed bottom edge at Y ${r2(FACE.openY0)}, panel from Y ${r2(FACE.panel[1])}`);
  check("wordmark fits under the lip", markBox.y > FACE.closedY0 + 0.8 && markBox.y + markBox.h < FACE.closedY1 - P.coverLip[1] - 0.6 && markBox.w < (FACE.panel[2] - FACE.panel[0]) - 10,
    `${r2(markBox.w)} x ${r2(markBox.h)} mm engraved ${P.markDepth}; "odd jobs" at ${P.markW} mm has strokes about ${r2(1.3 * P.markW / 30)} mm, floor ${P.markMinStroke}`);
  check("the cover goes in one way only", vol(face, coverTurned) > vol(face, cover) + 1.0,
    `turned round in its plane the cover sits on the rail: ${r2(vol(face, coverTurned))} mm^3 of face inside it; the right way, ${vol(face, cover).toFixed(3)}`);
  check("wordmark strokes clear one nozzle line with margin", 1.3 * P.markW / 30 >= P.markMinStroke, `about ${r2(1.3 * P.markW / 30)} mm, engraved ${P.markDepth}`);
  check("the grip is the horizon's right end, past the track", P.gripX0 > FACE.panel[2] + 3 && P.gripX0 < FACE.outline[2] - 12,
    `grip from X ${P.gripX0} to the face's edge, ${P.gripD} mm deep in a ${r2(FACE.horizonD)} mm groove; the track ends at X ${r2(FACE.panel[2])}`);
}
// The shutter: the slot open to the front, the step, the chamber open
// through the plate, the floor with the switch's pocket and the leg
// channels; the arithmetic that puts the actuator under the flange; the
// order of operations swept; the face as the door.
{
  const X = P.shutterX, Zc = SHUTTER.Zc, T = SHUTTER, rF = T.rF, rG = T.rG;
  const hS = P.shutterSwitchBody[2], wS = P.shutterSwitchBody[0], dS = P.shutterSwitchBody[1];
  openProbe("shutter slot open through the deck from its round end to the front", fuse([cylY(X, T.guideBottom + 0.1, Zc, rG - 0.3, P.shutterGuideLen + 0.5, 32), box(X - rG + 0.3, T.guideBottom + 0.1, Zc, X + rG - 0.3, T.guideTop + 0.6, Z.plateFront + 0.3)]),
    `${P.shutterActuatorGuideD} wide, ${P.shutterGuideLen} deep, round at the rear with a flat ceiling ${P.shutterGuideCeil} above it (round for its last ${P.shutterGuideRound}), straight out to the plate's front at Z ${r2(Z.plateFront)}; the ${P.shutterPressCapD} cap slides in from the front`);
  openProbe("shutter chamber open from its rear end out through the plate", box(X - rF + 0.1, T.floorTop + 0.1, T.chamberZ0 + 0.1, X + rF - 0.1, T.guideBottom - 0.1, Z.plateFront + 0.3),
    `${r2(2 * rF)} wide, ${r2(T.chamberH)} tall from the floor at Y ${r2(T.floorTop)} to the step at ${r2(T.guideBottom)}, from Z ${r2(T.chamberZ0)} to the front`);
  openProbe("the switch's pocket is open in the floor", box(T.pocket[0] + 0.1, T.seatTop + 0.05, T.pocket[1] + 0.1, T.pocket[2] - 0.1, T.floorTop + 0.2, T.pocket[3] - 0.1),
    `${r2(T.pocket[2] - T.pocket[0])} x ${r2(T.pocket[3] - T.pocket[1])}, ${P.shutterSwitchPocket} deep, ${P.shutterSwitchPocketClr} a side round the ${wS} x ${dS} body, under the cap`);
  {
    const lips = [-1, 1].map((s) => cube(X + (s < 0 ? -(rF - 0.1) : rG + 0.1), T.guideBottom + 0.1, Zc, rF - rG - 0.2, 0.9, Z.plateFront - 0.6 - Zc));
    const rearLip = box(X - 3, T.guideBottom + 0.1, Zc - rF + 0.1, X + 3, T.guideBottom + 1.0, Zc - rG - P.shutterGuideCeil - 0.1);
    check("the step holds the flange under the slot", lips.every((l) => vol(shell, l) > l.volume() * 0.95) && vol(shell, rearLip) > rearLip.volume() * 0.95 && T.lip >= 1.2,
      `${r2(rF - rG)} mm of step each side of the slot and behind its round end, the flange ${r2(T.lip)} over it; the plunger cannot leave through the deck`);
    const floor = box(X - 2.0, T.podInnerY + 0.05, Zc - 2.0, X + 2.0, T.seatTop - 0.05, Zc + 2.0);
    check("the floor carries the press", vol(shell, floor) > floor.volume() * 0.98 && P.shutterFloor >= 1.5, `${P.shutterFloor} mm of pod under the switch's base between the leg channels`);
    const walls = [box(X - 2.0, T.seatTop + 0.1, T.pocket[3] + 0.05, X + 2.0, T.floorTop - 0.05, T.pocket[3] + 0.4), box(X - 2.0, T.seatTop + 0.1, T.pocket[1] - 0.4, X + 2.0, T.floorTop - 0.05, T.pocket[1] - 0.05)];
    check("the pocket's walls hold the switch fore and aft", walls.every((w) => vol(shell, w) > w.volume() * 0.95) && P.shutterSwitchPocket >= 0.4,
      `${P.shutterSwitchPocket} mm of wall ahead of and behind the body between the leg channels; to leave, the switch must rise ${P.shutterSwitchPocket} against the flange ${P.shutterSwitchFree} above its actuator`);
    const rear = box(X - rF + 0.5, T.floorTop + 0.5, T.chamberZ0 - 1.0, X + rF - 0.5, T.guideBottom - 0.5, T.chamberZ0 - 0.1);
    check("the chamber is closed at the rear", vol(shell, rear) > rear.volume() * 0.98 && T.chamberZ0 >= P.shutterPodBottomZ + 2.0, `${r2(T.chamberZ0 - P.shutterPodBottomZ)} mm of pod behind the flange's rear edge`);
    const door = fuse([box(X - rF + 0.2, T.floorTop + 0.2, Z.plateFront + 0.05, X + rF - 0.2, T.guideBottom - 0.2, Z.plateFront + 0.8),
      box(X - rG + 0.2, T.guideBottom + 0.2, Z.plateFront + 0.05, X + rG - 0.2, oy1 - P.faceInset - P.bedChamfer - 0.2, Z.plateFront + 0.8)]);
    check("the face closes the slot and the mouth", vol(face, door) > door.volume() * 0.98 && P.shutterCapToFace >= 0.3,
      `the face's back covers the ${r2(2 * rF)} x ${r2(T.chamberH)} mouth and the slot's front up to ${r2(P.faceInset + P.bedChamfer)} under the deck (the reveal); the cap's front ${P.shutterCapToFace} off it; face off, the button comes out the front`);
  }
  for (const s of [-1, 1]) {
    openProbe(`leg channel ${s < 0 ? "-X" : "+X"} open through the floor from its stop to the front`,
      box(X + s * P.shutterLegX - P.shutterLegSlot[0] / 2 + 0.1, T.podInnerY - 0.2, T.legStopZ - 2 * P.shutterLegZ - 0.3, X + s * P.shutterLegX + P.shutterLegSlot[0] / 2 - 0.1, T.floorTop + 0.3, Z.plateFront + 0.2),
      `${P.shutterLegSlot[0]} wide, from Z ${r2(T.legStopZ - 2 * P.shutterLegZ - 2 * P.shutterLegClr)} to the front: the legs ride in it, the leads hang through it; the rear legs stop at its end with the switch over its pocket`);
  }
  check("the leg channels' ends sit inside the pocket", T.legStopZ - 2 * P.shutterLegZ - 2 * P.shutterLegClr >= T.pocket[1] && T.legStopZ - 2 * P.shutterLegZ - 2 * P.shutterLegClr <= Zc,
    `channels end at Z ${r2(T.legStopZ - 2 * P.shutterLegZ - 2 * P.shutterLegClr)}, the pocket from ${r2(T.pocket[1])} to ${r2(T.pocket[3])}, the body from ${r2(Zc - dS / 2)}: the legs stop it with the body over the pocket, then it drops in`);
  {
    const [rh] = P.shutterGuideRib;
    const ribs = [
      ...[-1, 1].map((s) => cube(X + (s < 0 ? -(rG - 0.05) : rG - rh + 0.05), T.guideBottom + 0.3, Zc - 0.3, rh - 0.1, 0.7, 0.6)),
      ...[-120, 120].map((phi) => cube(-0.3, T.guideBottom + 0.3, rG - rh + 0.05, 0.6, 0.7, rh - 0.1).rotate([0, phi, 0]).translate([X, 0, Zc])),
    ];
    check("the cap runs on four ribs in the slot", ribs.every((r) => vol(shell, r) > r.volume() * 0.9) && (P.shutterActuatorGuideD - P.shutterPressCapD) / 2 - rh > 0 && (P.shutterActuatorGuideD - P.shutterPressCapD) / 2 - rh <= 0.15,
      `four ${P.shutterGuideRib[0]} x ${P.shutterGuideRib[1]} ribs, one each straight side and two 60 degrees off the round end's apex; the ${P.shutterPressCapD} cap ${r2((P.shutterActuatorGuideD - P.shutterPressCapD) / 2 - rh)} off each`);
  }
  // The order of operations, swept: 1. the switch rides in on the floor
  // from the mouth and drops into its pocket; 2. the plunger, deck down,
  // hangs on the step and slides in over the seated switch, cap in the
  // slot, to the round end; 3. the face. Each sweep must be clear of the
  // shell and of what is already in; and a plunger already at rest must
  // block a switch on the floor, which is why the order is the order.
  {
    const rest = plungerAtRest();
    const rFl = P.shutterActuatorFlangeD / 2;
    const switchSweep = box(X - wS / 2, T.floorTop + 0.05, Zc - dS / 2, X + wS / 2, T.floorTop + hS, Z.plateFront + 0.2);
    check("1. the switch rides in on the floor to its pocket", vol(shell, switchSweep) < 1e-3 && T.chamberH - hS >= 1.0,
      `a ${wS} x ${r2(hS)} sweep from the mouth to Z ${r2(Zc - dS / 2)}: ${vol(shell, switchSweep).toFixed(4)} mm^3 of shell in it, ${r2(T.chamberH - hS)} of headroom under the step`);
    const seated = box(X - wS / 2, T.seatTop + 0.05, Zc - dS / 2, X + wS / 2, T.seatTop + hS, Zc + dS / 2);
    check("1. the switch drops into its pocket", vol(shell, seated) < 1e-3, `${vol(shell, seated).toFixed(4)} mm^3 of shell in the seated switch; its actuator top at Y ${r2(T.seatTop + hS)}`);
    const bodySeated = box(X - wS / 2, T.seatTop, Zc - dS / 2, X + wS / 2, T.seatTop + hS - 0.8, Zc + dS / 2);   // the 6 x 6 body under the actuator
    const stadium = (r, y0, y1) => fuse([cylY(X, y0, Zc, r, y1 - y0, 48), box(X - r, y0, Zc, X + r, y1, Z.plateFront + 0.2)]);   // a round part swept from the axis out through the mouth
    const plungerSweep = fuse([
      stadium(rFl, T.flangeBottomRest + 0.05, T.flangeBottomRest + P.shutterFlangeH - 0.05),   // the flange, hanging on the step
      stadium(P.shutterPressCapD / 2, T.guideBottom + 0.05, T.oy1 + P.shutterProud),          // the cap in the slot
    ]);
    check("2. the plunger slides in over the seated switch, hanging on the step, cap in the slot", vol(shell, plungerSweep) < 1e-3 && vol(seated, plungerSweep) < 1e-3 && T.flangeBottomRest - (T.seatTop + hS - 0.8) >= 0.6,
      `a ${r2(2 * rFl)} flange and a ${P.shutterPressCapD} cap swept from the mouth to the axis: ${vol(shell, plungerSweep).toFixed(4)} mm^3 of shell and ${vol(seated, plungerSweep).toFixed(4)} of switch in it; the flange ${r2(T.flangeBottomRest - (T.seatTop + hS - 0.8))} over the switch's body, ${P.shutterSwitchFree} over its actuator`);
    const rimR = P.shutterPressCapD / 2 - P.shutterCapEdge, dishR = P.shutterCapDish[0] / 2;
    const rim = box(X + dishR + 0.1, T.oy1 + P.shutterProud - 0.3, Zc - 1, X + rimR - 0.1, T.oy1 + P.shutterProud - 0.1, Zc + 1);   // the flat rim between the dish and the chamfer
    const dishProbe = box(X - 1, T.oy1 + P.shutterProud - P.shutterCapDish[1] + 0.05, Zc - 1, X + 1, T.oy1 + P.shutterProud + 1, Zc + 1);   // the dish's centre, empty
    check("2. the plunger rests on the step, cap proud, dished", vol(shell, rest) < 1e-3 && vol(rest, box(X - 7, T.oy1 + P.shutterProud + 0.05, Zc - 7, X + 7, T.oy1 + P.shutterProud + 1, Zc + 7)) < 1e-3 && vol(rest, rim) > rim.volume() * 0.95 && vol(rest, dishProbe) < 0.05 && rimR - dishR >= 0.8,   // the sphere's facets leave a few thousandths in the probe
      `at rest ${vol(shell, rest).toFixed(4)} mm^3 of shell inside it; its rim at Y ${r2(T.oy1 + P.shutterProud)}, ${P.shutterProud} proud of the deck; the ${P.shutterCapDish[0]} dish ${P.shutterCapDish[1]} deep inside a ${r2(rimR - dishR)} flat rim`);
    check("the plunger must go in second: at rest it blocks a switch on the floor", vol(rest, switchSweep) > 1.0 && vol(bodySeated, plungerSweep) < 1e-3,
      `${r2(vol(rest, switchSweep))} mm^3 of plunger in the sweep of a switch riding on the floor (${P.shutterSwitchPocket} higher than seated); switch first, plunger second, face third`);
  }
  check("the actuator sits under the flange at rest", Math.abs(T.seatTop + hS + P.shutterSwitchFree - T.flangeBottomRest) < 1e-9 && P.shutterSwitchFree >= 0.2 && P.shutterSwitchFree <= 0.4,
    `seat at Y ${r2(T.seatTop)} + switch ${hS} + ${P.shutterSwitchFree} free = flange bottom ${r2(T.flangeBottomRest)}; the first ${P.shutterSwitchFree} of press is free, the next ${P.shutterSwitchTravel} is the click`);
  check("the cap sits against the face's back with its clearance", Math.abs(Zc + P.shutterPressCapD / 2 + P.shutterCapToFace - Z.plateFront) < 1e-9 && Zc + rG <= Z.plateFront,
    `axis at Z ${r2(Zc)}; the cap's front edge ${P.shutterCapToFace} behind the face's back at ${r2(Z.plateFront)}, its rear ${r2(rG - P.shutterPressCapD / 2 - P.shutterGuideRib[0])} off the ribs on the round end`);
  check("the pod joins the right wall and clears CAM 4", T.podX1 > cx1 && T.podX0 >= P.cameraXs[3] + P.xiaoBoardW / 2 + 1.5, `pod from X ${r2(T.podX0)} into the wall at ${r2(cx1)}; CAM 4's XIAO ends at ${r2(P.cameraXs[3] + P.xiaoBoardW / 2)}`);
  check("shutter pod stays above the carrier and its connectors", P.shutterPodBottomZ >= Z.carrierFront + 1.0 && Math.min(...P.frontParts.map(([, , , y1]) => T.podInnerY - y1)) >= 4.0, `pod bottom Z=${P.shutterPodBottomZ}, carrier front Z=${r2(Z.carrierFront)}; the pod's inner face at Y ${r2(T.podInnerY)}, J1001's top at ${P.frontParts[0][3]}`);
  check("the chamber stays inside the pod's width", X - rF >= T.podX0 + 1.5 && X + rF <= cx1 - 1.5, `chamber from X ${r2(X - rF)} to ${r2(X + rF)}; the pod's face at ${r2(T.podX0)}, the wall at ${r2(cx1)}`);
  check("the mouth in the plate clears CAM 4's pocket and the face's stations", X - rF >= P.cameraXs[3] + S.headPocket / 2 + 3.0 && S.faceScrewXY.every(([px, py]) => px + P.screwBoreD / 2 + 1.5 <= X - rF || px - P.screwBoreD / 2 - 1.5 >= X + rF || py + P.screwBoreD / 2 + 1.0 <= T.floorTop),
    `mouth from X ${r2(X - rF)}, CAM 4's pocket ends at ${r2(P.cameraXs[3] + S.headPocket / 2)}; the stations near it at ${S.faceScrewXY.filter(([px]) => px > 90).map(([x, y]) => `(${x}, ${y})`).join(" ")}`);
  check("shutter plunger stem is positive", T.stem > 2.0, `${r2(T.stem)} mm nose above the flange; cap ${P.shutterProud} mm proud of the deck at rest`);
  check("the deck carries the button and nothing else, grooved whole", P.deckRing >= 1.0 && P.deckRing <= 3.0, `grooves over the whole deck; a ${P.deckRing} mm ring round the ${P.shutterCollarD} collar; the name is inside, on the face`);
}
for (const [i, [x0, y0, x1, y1]] of S.strapSlots.entries()) {
  openProbe(`strap slot ${i} open through the frame`, box(x0 + 0.1, y0 + 0.1, Z.frameRear - 0.3, x1 - 0.1, y1 - 0.1, Z.glass + 0.3), `${P.strapSlot[0]} x ${P.strapSlot[1]} mm through the frame's border`, frame);
}
for (const [i, [x0, y0, x1, y1]] of S.strapChannels.entries()) {
  openProbe(`strap tunnel ${i} open inside the wall end`, box(x0 + 0.1, y0 + 0.1, Z.glass + P.strapTunnelSkin + 0.1, x1 - 0.1, y1 - 0.1, Z.glass + P.strapTunnelSkin + P.strapChannelD - 0.1), `${P.strapChannelD} mm square under ${P.strapTunnelSkin} of wall end: the cord loops the shell, the frame's slots are pass-throughs`);
  const skin = box(x0 + P.strapSlot[0] + 0.3, y0 + 0.1, Z.glass + 0.05, x1 - P.strapSlot[0] - 0.3, y1 - 0.1, Z.glass + P.strapTunnelSkin - 0.05);
  check(`strap tunnel ${i} has its skin`, vol(shell, skin) > skin.volume() * 0.9, `the bar the cord pulls on is ${P.strapTunnelSkin} mm of shell between the slots`);
}
{
  const toRect = ([px, py], [x0, y0, x1, y1]) => Math.hypot(Math.max(x0 - px, 0, px - x1), Math.max(y0 - py, 0, py - y1));
  const nearest = Math.min(...S.strapSlots.map((s) => Math.min(...S.frameScrewXY.map((p) => toRect(p, s)))));
  const tunnelNearest = Math.min(...S.strapChannels.map((s) => Math.min(...S.frameScrewXY.map((p) => toRect(p, s)))));
  check("strap slots and tunnels clear the frame's stations and the frame's edge", nearest >= P.frameBoreD / 2 + 1.5 && tunnelNearest >= hole + 1.5 && S.strapSlots[0][1] >= oy0 + P.frameEdgeR,
    `nearest station ${r2(nearest)} mm from a slot, ${r2(tunnelNearest)} from a tunnel; slots from Y ${r2(S.strapSlots[0][1])}, the round to ${r2(oy0 + P.frameEdgeR)}`);
}
check("the shell's bar between the slots carries a cord", P.strapSlotXs[1] - P.strapSlotXs[0] - P.strapSlot[0] >= 3.0 && P.strapTunnelSkin >= 0.6 && P.wall - P.strapChannelD - 0.5 >= 1.0, `${r2(P.strapSlotXs[1] - P.strapSlotXs[0] - P.strapSlot[0])} mm of wall end between the slots; ${r2(P.wall - P.strapSlot[1] - 0.5)} mm beside the tunnel`);

// The P4 held at the rear: the frame stands off the glass and clamps the
// module's glass margin through a foam gasket in a groove round the window.
const GASK = (() => {
  const [pcx, pcy] = XY.p4Centre, [gIn, gW, gT, gD] = P.gasket;
  return { x0: pcx - S.windowHalf[0] - gIn, y0: pcy - S.windowHalf[1] - gIn, x1: pcx + S.windowHalf[0] + gIn, y1: pcy + S.windowHalf[1] + gIn, gIn, gW, gT, gD };
})();
{
  const [px0, py0, px1, py1] = XY.p4, { x0: gx0, y0: gy0, x1: gx1, y1: gy1, gIn, gW, gT, gD } = GASK;
  check("the frame's inner face stands off the glass", P.glassClear >= 0.3 && vol(frame, box(px0, py0, Z.glassFront - P.glassClear + 0.01, px1, py1, Z.glassFront + 1)) < 1e-3,
    `${P.glassClear} mm from the glass front at Z ${r2(Z.glassFront)} to the frame's inner face at Z ${r2(Z.glass)}; nothing of the frame inside the module's outline past that`);
  check("the gasket groove sits on the glass margin past the window's chamfer", gIn > P.frameWindowChamfer + 0.25 && gx0 - gW >= px0 + 0.5 && gy0 - gW >= py0 + 0.5 && gx1 + gW <= px1 - 0.5 && gy1 + gW <= py1 - 0.5,
    `a ${gW} mm strip from ${gIn} to ${r2(gIn + gW)} mm outside the window; ${r2(gy0 - gW - py0)} mm inside the module's long edge, ${r2(gx0 - gW - px0)} inside its short edge; the chamfer reaches ${P.frameWindowChamfer}`);
  openProbe("the gasket groove is open in the frame's inner face", box(gx0 - gW + 0.1, gy0 + 0.1, Z.glass - gD + 0.05, gx0 - 0.1, gy1 - 0.1, Z.glass - 0.05), `${gD} mm deep, ${gW} wide, ${r2(P.rearFrameT - gD)} of frame under it`, frame);
  const space = P.glassClear + gD, squeeze = (t) => 1 - (space + t) / gT;
  check("the gasket's squeeze covers the stack's tolerance", P.rearFrameT - gD >= 1.2 && squeeze(0) >= 0.3 && squeeze(0.3) >= 0.15 && squeeze(-0.3) <= 0.55,
    `${gT} mm foam in ${r2(space)} mm: ${Math.round(squeeze(0) * 100)} % squeezed; ${Math.round(squeeze(0.3) * 100)} to ${Math.round(squeeze(-0.3) * 100)} % over +-0.3 mm of stack`);
  const ringArea = 2 * (gx1 - gx0 + gW) * gW + 2 * (gy1 - gy0 - gW) * gW;
  const clampN = P.gasketKPa * ringArea / 1000, weightN = P.stackMassG * 9.81 / 1000;
  check("the foam clamps the stack onto the ledge", clampN >= 5 * weightN,
    `${r2(ringArea)} mm^2 of foam at ${P.gasketKPa} kPa (PROVISIONAL) is ${r2(clampN)} N on the glass, ${r2(clampN / weightN)} times the ${P.stackMassG} g stack; no screw anywhere in the body`);
  check("six inserts hold the frame against the foam", S.frameScrewXY.length * P.insertPullN >= 3 * clampN,
    `${S.frameScrewXY.length} M2 inserts at ${P.insertPullN} N pull-out each (PROVISIONAL, T04's pull) against ${r2(clampN)} N of foam; the frame seats on the wall ends, so the screws see the foam's push and nothing else`);
}

// Print orientations: the shell face down; the frame rear face up; the
// rest as drawn, bearing face on the bed.
// Each print names the places where a face may point down past 45 degrees:
// a bridge, a hole or a pocket, where a support could not stand or its scar
// would never show. Everything else must be clean, so the slicer's supports
// stay off and nothing it would grow could mark a visible surface.
const shellZones = [
  [cx0, cy0, Z.glass - 1, cx1, cy1, Z.plateInner + 0.5],
  [P.usbCX - S.usbOpenW / 2 - 1, oy0 - 1, S.usbOpenZ[0] - 1, P.usbCX + S.usbOpenW / 2 + 1, cy0 + 1, S.usbOpenZ[1] + 1],
  ...S.strapChannels.map(([x0, y0, x1, y1]) => [x0 - 0.5, y0 - 0.5, Z.glass - 1, x1 + 0.5, y1 + 0.5, Z.glass + P.strapTunnelSkin + P.strapChannelD + 1]),
  [SHUTTER.podX0 - 1, SHUTTER.podInnerY - 1, SHUTTER.chamberZ0 - 1, SHUTTER.podX1, oy1 + 1, Z.plateFront + 1],   // the slot's flat ceiling, the pocket's rear wall and the chamber's closed rear end (an 18.6 mm bridge inside the pod)
];
const idEdgeW = textWidth(IDS.face, P.idCapEdge);
const faceZones = [
  ...S.faceScrewXY.map(([px, py]) => [px - 2.5, py - 2.5, FACE.back - 0.5, px + 2.5, py + 2.5, FACE.back + FACE.insertHoleDepth + 0.3]),   // the insert holes: the mouth countersinks at the bed, the 3 mm floors as small bridges
  // the detent channels' ceilings fall at 45 degrees into the walls: no zone
  [P.innerMarkAt[0] - (P.modelW - P.innerMarkW) - 3, P.innerMarkAt[1] - MODEL_H - 5, FACE.back - 0.5, P.innerMarkAt[0] + P.innerMarkW + 3 + P.innerSymbolH * 1.25 + 3, P.innerMarkAt[1] + 10, FACE.back + P.innerMarkD + 0.5],
  [P.idFaceX - idEdgeW / 2 - 1, FACE.outline[1] - 1, FACE.back, P.idFaceX + idEdgeW / 2 + 1, FACE.outline[1] + P.idDepthWall + 0.2, FACE.back + P.idCapEdge + 1],   // the letters' 0.3 mm top edges in the edge wall
];
const printSpec = {
  "A01-KINO_CARRIER_SHELL.stl": [shell, [180, 0, 0], shellZones, 5, "the cavity, the USB opening (a 13.4 mm bridge inside the wall), the strap tunnels, the slot's flat ceiling, the switch pocket's rear wall and the chamber's closed rear end (an 18.6 mm bridge inside the pod, under the face); the ledge, the counterbores and the rear insert holes face up"],
  "A03-KINO_CARRIER_REAR_FRAME.stl": [frame, [180, 0, 0], [[GASK.x0 - GASK.gW - 1, GASK.y0 - GASK.gW - 1, Z.glass - GASK.gD - 0.5, GASK.x1 + GASK.gW + 1, GASK.y1 + GASK.gW + 1, Z.glass + 0.5]], 2, "the gasket groove's ceiling (a 2 mm bridge at the bed); the chamfer, the counterbores, the pad and the A03 engraving face up"],
  "A02-KINO_CARRIER_FACE.stl": [face, [0, 0, 0], faceZones, 5, "the six insert holes' countersinks and the signature's 0.4 mm ceilings at the bed, the A02 letters' top edges in the bottom edge wall (0.3 mm bridges); the lips' undersides are steeper than 45"],
  "B01-KINO_CARRIER_LENS_COVER.stl": [cover, [0, 0, 0], [[(FACE.panel[0] + FACE.panel[2]) / 2 + P.sliderRailOffset - P.sliderGroove[0] / 2 - 0.5, -1e3, FACE.floorZ - 1, (FACE.panel[0] + FACE.panel[2]) / 2 + P.sliderRailOffset + P.sliderGroove[0] / 2 + 0.5, 1e3, FACE.floorZ + P.sliderGroove[1] + 0.3]], 2, "the groove's ceiling in the back (a 1.8 mm bridge at the bed)"],
  "B02-KINO_CARRIER_SHUTTER_BUTTON.stl": [button, [0, 0, 0], [], 1, "nothing: the flange lies on the bed"],
};
const placed = (part, rot, zones) => {
  const b = part.rotate(rot).boundingBox(), t = [-b.min[0], -b.min[1], -b.min[2]];
  return zones.map(([x0, y0, z0, x1, y1, z1]) => rot[0] === 180
    ? [x0 + t[0], -y1 + t[1], -z1 + t[2], x1 + t[0], -y0 + t[1], -z0 + t[2]]
    : [x0 + t[0], y0 + t[1], z0 + t[2], x1 + t[0], y1 + t[1], z1 + t[2]]);
};
const prints = Object.fromEntries(Object.entries(printSpec).map(([name, [part, rot]]) => [name, toBed(part.rotate(rot))]));
for (const [name, [part, rot, zones, slack, what]] of Object.entries(printSpec)) {
  const m = prints[name];
  const { outside, inside, worst } = overhangOutside(m, placed(part, rot, zones));
  check(`${name} overhangs only where a support's scar would hide`, outside <= slack,
    `${r2(outside)} mm^2 facing down past 45 degrees outside the named places (allowed ${slack}), ${r2(inside)} inside them: ${what}${worst ? `; the largest stray at (${worst.map(r2).join(", ")})` : ""}`);
  const b = m.boundingBox();
  check(`${name} fits the bed`, b.max[0] <= 250 && b.max[1] <= 210, `${r2(b.max[0])} x ${r2(b.max[1])} x ${r2(b.max[2])}`);
}

// ---- Coupons: pieces of the real parts, cut out with boxes, to print before
// the whole. Each is the parent's geometry, so a fit proved here is the fit
// in the part. Same print orientation as the parent. Each carries its ID
// in a face that is up in print, engraved in the font: a gate proves the
// engraving sits in material. `engrave` cuts text into a face at zFace
// whose material lies toward +Z (dir -1: the face is read from -Z, up in a
// face-down print) or toward -Z (dir +1: read from +Z).
const couponText = [];
const engrave = (name, m, text, x, y, zFace, dir, cap = P.idCap) => {
  const probe = dir < 0 ? textSolid(text, x, y, zFace + 0.02, cap, P.idDepth - 0.02, true) : textSolid(text, x, y, zFace - P.idDepth, cap, P.idDepth - 0.02, false);
  const share = vol(m, probe) / probe.volume();
  check(`${name} carries "${text}" in material`, share > 0.98, `${cap} mm letters at (${x}, ${y}) in the face at Z ${r2(zFace)}, ${P.idDepth} deep; ${r2(100 * share)} % of the engraving in material`);
  couponText.push([name, text]);
  return m.subtract(dir < 0 ? textSolid(text, x, y, zFace - 1, cap, P.idDepth + 1, true) : textSolid(text, x, y, zFace - P.idDepth, cap, P.idDepth + 1, false));
};
const gauge = (() => {
  // T02, the pocket gauge: three real pockets of different widths in one
  // 4.4 mm plate, each labelled with its width in the pocket face (up in
  // print); the one that holds the head sets camBody + camBodySlack.
  const pitch = 17, y = 10, plate = box(0, 0, Z.plateInner, 60, 20, Z.plateFront);
  const cuts = [], ribs = [];
  P.camGaugePockets.forEach((w, i) => {
    const pk = cameraPocket(9 + i * pitch, y, w);
    cuts.push(...pk.cuts); ribs.push(...pk.ribs);
  });
  let m = plate.subtract(fuse(cuts)).add(fuse(ribs));
  P.camGaugePockets.forEach((w, i) => { m = engrave("T02-KINO_COUPON_POCKET_GAUGE.stl", m, w.toFixed(1), 9 + i * pitch - textWidth(w.toFixed(1), 2.5) / 2, y + w / 2 + 1.5, Z.plateInner, -1, 2.5); });
  return engrave("T02-KINO_COUPON_POCKET_GAUGE.stl", m, "T02", 51.0, 8.5, Z.plateInner, -1, 3.0);
})();
const coupons = (() => {
  const cut = (m, b) => m.intersect(b);
  const t03Box = box(ox0 - 1, oy0 - 1, Z.carrierBack - 2, ox0 + 26, P.faceScrewXY[0][1] + 5, Z.plateFront + 1);   // the lower-left corner: two walls, the ledge, the plate up past the face's screw station at (4, 36)
  const t04Box = box(ox0 - 1, oy0 - 1, Z.glass - 1, P.frameScrewsBottom[0] + 5, oy0 + 14, Z.glass + 14);  // the bottom wall's rear end: two strap slots over their tunnel, the frame's insert station at X 40 with its boss
  const t06Box = box(ox0 - 1, oy0 - 1, FACE.back - 1, ox0 + 21, P.faceScrewXY[0][1] + 5, FACE.front + 1);   // the face's lower-left corner: the insert station at (4, 13), the window's corner with its chamfers, the left wall's channel and lower tooth
  const t05Z0 = P.shutterPodBottomZ - 6;
  const t05Box = box(SHUTTER.podX0 - 1, SHUTTER.podInnerY - 2, t05Z0, ox1 + 1, oy1 + 1, Z.plateFront + 1);   // the whole pod with the deck over it, the wall corner it joins and the plate with the mouth
  const t07Box = box(FACE.panel[0] - 8, oy0 - 1, FACE.back - 1, FACE.panel[2] + 8, FACE.panel[3] + 3, FACE.front + 1);   // the slide: the face's whole window band, both walls with their lips, channels and four teeth, both rims; the real B01 runs in it
  let t03 = cut(shell, t03Box), t04 = cut(shell, t04Box), t05 = cut(shell, t05Box), t06 = cut(face, t06Box), t07 = cut(face, t07Box);
  t07 = engrave("T07-KINO_COUPON_TRACK.stl", t07, "T07", FACE.panel[0] + 14, FACE.outline[1] + P.faceEdgeR + 0.6, FACE.front, 1, 3.0);
  t03 = engrave("T03-KINO_COUPON_LEDGE_CORNER.stl", t03, "T03", 8.0, oy0 + 0.75, Z.carrierBack - 2, -1, 3.0);
  t04 = engrave("T04-KINO_COUPON_STRAP_SHELL.stl", t04, "T04", 14.0, oy0 + 0.75, Z.glass, -1, 3.0);
  t05 = engrave("T05-KINO_COUPON_DECK.stl", t05, "T05", SHUTTER.podX0 + 1.0, cy1 + 0.75, t05Z0, -1, 3.0);
  t06 = engrave("T06-KINO_COUPON_FACE_CORNER.stl", t06, "T06", 5.0, FACE.outline[1] + P.faceEdgeR + 0.6, FACE.front, 1, 3.0);   // in the front, below the window's rim (the face prints back down: the front is up)
  const bar = engrave("T01-KINO_COUPON_SHRINK_BAR.stl", box(0, 0, 0, 100, 10, 3), "T01", 3.0, 3.5, 3, 1, 3.0);
  return {
    "T03-KINO_COUPON_LEDGE_CORNER.stl": toBed(t03.rotate([180, 0, 0])),
    "T02-KINO_COUPON_POCKET_GAUGE.stl": toBed(gauge.rotate([180, 0, 0])),
    "T05-KINO_COUPON_DECK.stl": toBed(t05.rotate([180, 0, 0])),
    "T04-KINO_COUPON_STRAP_SHELL.stl": toBed(t04.rotate([180, 0, 0])),
    "T06-KINO_COUPON_FACE_CORNER.stl": toBed(t06),
    "T07-KINO_COUPON_TRACK.stl": toBed(t07),
    "T01-KINO_COUPON_SHRINK_BAR.stl": bar,
  };
})();
check("every coupon is labelled", ["T01", "T02", "T03", "T04", "T05", "T06", "T07"].every((id) => couponText.some(([, t]) => t === id)), couponText.map(([n, t]) => `${t} in ${n}`).join("; "));
{
  // T07 is the whole track: all four teeth, both lips, the window's two
  // rims, so the real cover runs in it as it runs in the face.
  const t07 = coupons["T07-KINO_COUPON_TRACK.stl"].translate([FACE.panel[0] - 8, FACE.outline[1], FACE.back]);
  const [p0x, , p1x] = FACE.panel, cd = P.sliderChannelD, zT = FACE.floorZ + P.sliderChannelTop - cd - 0.1;
  const teeth = FACE.teeth.flatMap((t) => [box(p0x - cd + 0.05, t.land[0] + 0.05, FACE.floorZ + 0.1, p0x - 0.05, t.land[1] - 0.05, zT), box(p1x + 0.05, t.land[0] + 0.05, FACE.floorZ + 0.1, p1x + cd - 0.05, t.land[1] - 0.05, zT)]);
  const rims = [box(p0x + 10, FACE.panel[1] - 2.0, FACE.back + 0.2, p1x - 10, FACE.panel[1] - 0.2, FACE.front - 1.5), box(p0x + 10, FACE.panel[3] + 0.2, FACE.back + 0.2, p1x - 10, FACE.panel[3] + 1.5, FACE.trackTop - 0.2)];
  check("the track coupon carries all four teeth, both rims and the cover's whole run", teeth.every((l) => vol(t07, l) > l.volume() * 0.97) && rims.every((r) => vol(t07, r) > r.volume() * 0.9) && [cover, coverOpen, coverMid].every((c) => Math.abs(vol(t07, c) - vol(face, c)) < 1e-3) && vol(t07, box((p0x + p1x) / 2 + P.sliderRailOffset - 0.5, FACE.panel[1] + 2, FACE.floorZ + 0.1, (p0x + p1x) / 2 + P.sliderRailOffset + 0.5, FACE.panel[3] - 2, FACE.floorZ + P.sliderRail[1] - 0.1)) > 0.5,
    `the window band from X ${r2(p0x - 8)} to ${r2(p1x + 8)}, Y ${r2(FACE.outline[1])} to ${r2(FACE.panel[3] + 3)}, the rail down it, the teeth in both walls; the real B01 runs and clicks in it as in the face`);
}
{
  // T03 holds the face's station at (4, 4) and a piece of ledge; T04 holds
  // the frame's station at X 40 with its boss and the first two strap
  // slots over their tunnel; T06 is the face's corner over T03.
  const [sx, sy] = S.faceScrewXY[0];
  const st03 = cylZ(sx, sy, Z.plateInner - 0.3, P.screwClearD / 2 - 0.1, P.plate + 0.6, 16);
  check("the ledge coupon carries a face screw station and the ledge", sx + P.screwBoreD / 2 + 1 <= ox0 + 26 && sy + P.screwBoreD / 2 + 1 <= sy + 5 && vol(shell, st03) < 1e-3
    && vol(shell, box(cx0 + 0.1, cy0 + 2, S.ledgeZ + 0.1, cx0 + P.ledgeW - 0.1, cy0 + 20, S.ledgeZ + 1)) > 17 * (P.ledgeW - 0.2) * 0.9 * 0.9,
    `station (${sx}, ${sy}) inside the coupon (${r2(26 + 1)} wide, ${r2(sy + 5 - oy0 + 1)} tall); ${P.ledgeW} mm of ledge along 24 mm of the bottom wall and ${r2(sy + 5 - cy0)} of the left`);
  const [fx, fy] = S.frameScrewXY.find(([, , side]) => side === "bottom");
  const st04 = cylZ(fx, fy, Z.glass + 0.1, hole - 0.1, holeDeep - 0.3, 16);
  check("the strap coupon carries a frame insert station", vol(shell, st04) < 1e-3 && fx + hole + 1.5 <= P.frameScrewsBottom[0] + 5 && S.strapSlots.filter(([x0]) => x0 < fx).length >= 2,
    `insert hole at X ${fx}, ${r2(holeDeep)} deep in the wall end; the insert set with the iron and pulled is the hold (insertPullN ${P.insertPullN} N, PROVISIONAL)`);
  const t06 = coupons["T06-KINO_COUPON_FACE_CORNER.stl"].translate([FACE.outline[0], FACE.outline[1], FACE.back]);   // back to the body frame: toBed put its corner at the origin
  const st06 = cylZ(sx, sy, FACE.back - 0.3, hole - 0.1, FACE.insertHoleDepth + 0.1, 16);
  const lower = FACE.teeth.find((t) => t.name === "lower");
  const lowerTooth = box(FACE.panel[0] - P.sliderChannelD + 0.05, lower.land[0] + 0.05, FACE.floorZ + 0.1, FACE.panel[0] - 0.05, lower.land[1] - 0.05, FACE.floorZ + P.sliderChannelTop - P.sliderChannelD - 0.1);
  check("the face coupon carries the insert station and the left lower tooth", vol(t06, st06) < 1e-3 && vol(t06, lowerTooth) > lowerTooth.volume() * 0.97,
    `station (${sx}, ${sy}) and the tooth's land from Y ${r2(lower.land[0])} to ${r2(lower.land[1])} inside the coupon; it screws onto T03 with an M2 x ${P.faceScrewLen}`);
}
// Bed plates: the coupons that print together, 10 mm apart, as one file each.
const plates = (() => {
  const beside = (a, b, gap = 10) => fuse([a, b.translate([a.boundingBox().max[0] + gap, 0, 0])]);
  return {
    "P1-COUPON_PLATE_T01_T02.stl": beside(coupons["T01-KINO_COUPON_SHRINK_BAR.stl"], coupons["T02-KINO_COUPON_POCKET_GAUGE.stl"]),
    "P2-COUPON_PLATE_T03_T04.stl": beside(coupons["T03-KINO_COUPON_LEDGE_CORNER.stl"], coupons["T04-KINO_COUPON_STRAP_SHELL.stl"]),
  };
})();
for (const [name, m] of Object.entries(plates)) {
  check(`${name} is two pieces on the bed`, m.decompose().length === 2 && m.boundingBox().max[0] <= 250, `${r2(m.boundingBox().max[0])} x ${r2(m.boundingBox().max[1])} mm, ${m.decompose().length} pieces`);
}
for (const [name, m] of Object.entries(coupons)) {
  check(`${name} is one piece on the bed`, m.decompose().length === 1 && m.boundingBox().max[0] <= 250, `${r2(m.boundingBox().max[0])} x ${r2(m.boundingBox().max[1])} x ${r2(m.boundingBox().max[2])} mm, ${m.decompose().length} piece(s)`);
}

// ---- Write --------------------------------------------------------------------
const files = {};
for (const [name, m] of Object.entries(prints)) files[name] = writeStl(outDir, name, m);
for (const [name, m] of Object.entries(coupons)) files[name] = writeStl(outDir, name, m);
for (const [name, m] of Object.entries(plates)) files[name] = writeStl(outDir, name, m);
files["KINO_CARRIER_STACK_DUMMY.stl"] = writeStl(outDir, "KINO_CARRIER_STACK_DUMMY.stl", dummy);
for (const [name, m] of [["shell", shell], ["frame", frame], ["face", face], ["cover", cover], ["cover-open", coverOpen]]) {
  writeStl(outDir, `preview-${name}.stl`, m);
}
writeStl(outDir, "preview-shutter.stl", capPreview());
{
  const [px0, py0, px1, py1] = XY.p4;
  writeStl(outDir, "preview-glass.stl", box(px0 + 0.5, py0 + 0.5, Z.glassFront - 0.2, px1 - 0.5, py1 - 0.5, Z.glassFront + 2));
}
files["KINO_CARRIER_ASSEMBLED_PREVIEW.stl"] = writeStl(outDir, "KINO_CARRIER_ASSEMBLED_PREVIEW.stl", fuse([shell, frame, dummy, face, cover]));
files["KINO_CARRIER_OPEN_PREVIEW.stl"] = writeStl(outDir, "KINO_CARRIER_OPEN_PREVIEW.stl", fuse([shell, frame, dummy, face, coverOpen]));
const report = {
  package: "KINO_CARRIER_BODY", generated: new Date().toISOString(),
  body: { width: r2(XY.bodyW), height: r2(XY.bodyH), depth: r2(FACE.front - Z.frameRear), lensRowY: r2(XY.lensY), cameraXs: P.cameraXs },
  stack: Object.fromEntries(Object.entries(Z).map(([k, v]) => [k, r2(v)])),
  face: { back: r2(FACE.back), front: r2(FACE.front), trackTop: r2(FACE.trackTop), outline: FACE.outline.map(r2), panel: FACE.panel.map(r2), horizon: FACE.horizon.map(r2), coverClosed: [r2(FACE.closedY0), r2(FACE.closedY1)], coverOpen: [r2(FACE.openY0), r2(FACE.openY1)], travel: r2(FACE.travel), horizonD: r2(FACE.horizonD), cellOuterD: r2(2 * FACE.outerR) },
  shutter: { x: P.shutterX, zc: r2(SHUTTER.Zc), stem: r2(SHUTTER.stem), podInnerY: r2(SHUTTER.podInnerY), capD: P.shutterPressCapD, flangeD: P.shutterActuatorFlangeD, chamberW: r2(2 * SHUTTER.rF), chamberH: r2(SHUTTER.chamberH), pocket: P.shutterSwitchPocket, free: P.shutterSwitchFree },
  print: { shrinkPct: P.shrinkPct, ledgeW: P.ledgeW, inserts: S.faceScrewXY.length + S.frameScrewXY.length, screws: { face: `M2 x ${P.faceScrewLen} x ${S.faceScrewXY.length}`, frame: `M2 x ${P.frameScrewLen} x ${S.frameScrewXY.length}` }, gaugePockets: P.camGaugePockets },
  slide: { bumpClosedY: r2(FACE.bumpClosedY), bumpOpenY: r2(FACE.bumpOpenY), teeth: FACE.teeth.map((t) => ({ name: t.name, land: t.land.map(r2) })), arm: [P.sliderArmT, P.sliderArmSlit, P.sliderArmRoot], bumpOut: P.sliderBumpOut, restPress: P.sliderRestPress, lipGap: FACE.lipGap.map(r2) },
  files, gates: { total: checks.length, failed: checks.filter((c) => !c.pass).length }, checks,
};
fs.writeFileSync(path.join(outDir, "carrier-body-release-report.json"), JSON.stringify(report, null, 2));
console.log(`${checks.length} gates, ${report.gates.failed} failed. Body ${report.body.width} x ${report.body.height} x ${report.body.depth} mm.`);
for (const [k, f] of Object.entries(files)) console.log(`  ${k}: ${f.size.join(" x ")} mm, ${f.volumeCm3} cm^3, ${f.triangles} triangles`);
if (report.gates.failed) { for (const c of checks.filter((c) => !c.pass)) console.log(`  FAIL ${c.name}: ${c.details}`); process.exit(1); }
