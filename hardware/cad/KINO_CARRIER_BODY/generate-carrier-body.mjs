// KINO D4 carrier body: a shell around the dev carrier D1 stack, and the face
// that gives it its form.
//
// The carrier is the chassis. The P4 hangs on its own inserts through 8 mm
// spacers, the carrier sits on the spacers, the XIAOs stand in sockets on the
// carrier, and each camera module hangs off its XIAO on a short soft ribbon.
// The shell holds the stack by the carrier's edge on a ledge in front and by
// foam behind the glass, with the rear frame on six filament pins; no screw
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
//   B02-KINO_CARRIER_SHUTTER_BUTTON.stl  dark blue PLA; plunger (B02) and switch retainer (B03)
// plus twelve pins cut from 1.75 mm filament (C01), four foam strips (C02),
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
import { SHUTTER, buildShutterButton, capPreview } from "./shutter.mjs";

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
  check("the face steps in from the shell and still covers the pins", P.faceInset >= 0.3 && P.faceInset + P.facePinD / 2 + 0.4 <= P.wall / 2,
    `${P.faceInset} mm of black wall end shows around the blue face; the pins at the wall's middle sit ${r2(P.wall / 2 - P.faceInset - P.facePinD / 2)} mm inside the face's edge`);
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
check("shutter button file is two parts", button.decompose().length === 2, `${button.decompose().length}: plunger and retainer`);
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
// The frame's six pins: a blind hole in each wall's rear end and a hole
// through the frame, countersunk at its inner face; the frame goes on one
// way; six holds against the foam's push.
for (const [px, py] of S.pinRearXY) {
  openProbe(`frame pin hole in the wall end at (${r2(px)}, ${r2(py)}) open`, cylZ(px, py, Z.glass - P.facePinWall + 0.1, P.facePinD / 2 - 0.1, P.facePinWall - 0.1 + 0.3, 16), `${P.facePinD} mm, ${P.facePinWall} deep in a ${P.wall} mm wall`);
  openProbe(`frame pin hole through the frame at (${r2(px)}, ${r2(py)}) open`, cylZ(px, py, Z.frameRear - 0.3, P.framePinHoleD / 2 - 0.1, P.rearFrameT + 0.6, 16), `${P.framePinHoleD} mm through the ${P.rearFrameT} frame, countersunk ${P.facePinSink} at the inner face`, frame);
}
check("the frame's pin holes sit inside its rear chamfer", P.wall / 2 - P.framePinHoleD / 2 >= P.frameEdgeR + 0.1 && P.wall / 2 - P.framePinHoleD / 2 - P.facePinSink >= P.bedChamfer + 0.1,
  `${r2(P.wall / 2 - P.framePinHoleD / 2)} mm from the outline to the hole, the rear chamfer ${P.frameEdgeR}; the countersink ${r2(P.wall / 2 - P.framePinHoleD / 2 - P.facePinSink)} from it at the inner face, the bed chamfer ${P.bedChamfer}`);
{
  const miss = Math.min(...S.pinRearXY.map(([px, py]) => Math.min(...S.pinRearXY.map(([qx, qy]) => Math.hypot(P.carrierW - px - qx, P.carrierH - py - qy)))));
  check("the frame goes on one way", miss >= 2.0, `turned round in its plane, the nearest hole misses a pin by ${r2(miss)} mm; the face's pattern is another, so neither part fits the other's end`);
  const cross = Math.max(...S.pinRearXY.map(([px, py]) => Math.min(...S.pinXY.map(([qx, qy]) => Math.hypot(px - qx, py - qy)))));
  check("the frame's pattern is not the face's", cross >= 2.0, `one frame hole is ${r2(cross)} mm from every face pin, so neither part fits the other's end (the top and side pairs coincide in plan, the bottom pairs do not)`);
}
// The six face pins: a hole in the wall end and a hole in the face's back at each station.
for (const [px, py] of S.pinXY) {
  openProbe(`face pin hole in the wall end at (${r2(px)}, ${r2(py)}) open`, cylZ(px, py, Z.plateFront - P.facePinWall + 0.1, P.facePinD / 2 - 0.1, P.facePinWall - 0.1 + 0.3, 16), `${P.facePinD} mm, ${P.facePinWall} deep in a ${P.wall} mm wall`);
  openProbe(`face pin hole in the face at (${r2(px)}, ${r2(py)}) open`, cylZ(px, py, FACE.back - 0.3, P.facePinD / 2 - 0.1, P.facePinFace - 0.1 + 0.3, 16), `${P.facePinFace} deep into the face's back`, face);
  const ahead = cylZ(px, py, FACE.back + P.facePinFace + 0.05, P.facePinD / 2 - 0.1, 1.0, 16);
  check(`face pin hole at (${r2(px)}, ${r2(py)}) is blind`, vol(face, ahead) > ahead.volume() * 0.95, `at least 1.0 mm of face ahead of it; the plate is ${P.faceBase}`);
}
check("the walls carry the pin holes", (P.wall - P.facePinD) / 2 >= 1.2, `${r2((P.wall - P.facePinD) / 2)} mm a side`);
const MODEL_H = 10.745 * P.modelW / 79.993;   // the model mark's height at modelW
check("the signature inside sits on the plate, clear of the track and the pins", P.innerMarkAt[1] - MODEL_H - 2.5 > FACE.panel[3] + P.horizonPad + 2 && P.innerMarkAt[1] + 6 < FACE.outline[3] - P.faceEdgeR && P.innerMarkAt[0] - (P.modelW - P.innerMarkW) > 20 && P.innerMarkAt[0] + P.innerMarkW + 3 + P.innerSymbolH * 1.25 < 100, `"odd jobs" ${P.innerMarkW} mm and the symbol ${P.innerSymbolH} mm, ${P.innerMarkD} deep in the face's back at (${P.innerMarkAt[0]}, ${P.innerMarkAt[1]}); the track ends at Y ${r2(FACE.panel[3])}`);
check("the side pins sit above the horizon channel", P.facePinsSideY - P.facePinD / 2 - 1.0 >= XY.lensY + P.sliderH / 2 + P.horizonPad, `pins at Y ${P.facePinsSideY}; the channel runs to Y ${r2(XY.lensY + P.sliderH / 2 + P.horizonPad)}, ${P.horizonWallD} mm into a ${P.wall} mm wall`);
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
check("the first groove clears the frame pins' floors", P.grooveZ[0] - P.grooveD * 1.25 >= Z.glass - P.facePinWall + 0.6, `groove bottom at Z ${r2(P.grooveZ[0] - P.grooveD * 1.25)}, the pins' floors at ${r2(Z.glass - P.facePinWall)}`);
// The cover in its window.
{
  const closed = vol(face, cover), open = vol(face, coverOpen), mid = vol(face, coverMid);
  check("cover closed: held by the detent and nothing else", closed > 0.01 && closed < 1.0, `${closed.toFixed(3)} mm^3 of bump inside the cover's edge crests`);
  check("cover open: held by the detent and nothing else", open > 0.01 && open < 1.0, `${open.toFixed(3)} mm^3`);
  check("cover mid-travel: free in the track", mid < 1e-3, `${mid.toFixed(4)} mm^3; the edge relief clears the bumps between the crests`);
  check("cover travel is positive and the cover stows above the rim", FACE.travel > 10 && FACE.openY0 >= FACE.panel[1] + 0.4, `${r2(FACE.travel)} mm down from Y ${r2(FACE.closedY0)}; stowed bottom edge at Y ${r2(FACE.openY0)}, panel from Y ${r2(FACE.panel[1])}`);
  check("wordmark fits under the lip", markBox.y > FACE.closedY0 + 0.8 && markBox.y + markBox.h < FACE.closedY1 - P.coverLip[1] - 0.6 && markBox.w < (FACE.panel[2] - FACE.panel[0]) - 10,
    `${r2(markBox.w)} x ${r2(markBox.h)} mm engraved ${P.markDepth}; "odd jobs" at ${P.markW} mm has strokes about ${r2(1.3 * P.markW / 30)} mm, floor ${P.markMinStroke}`);
  check("the cover goes in one way only", vol(face, coverTurned) > 0.5 && vol(face, cover) < 1.0,
    `turned round in its plane the cover's 1.0 bevel meets the 1.5 lip: ${r2(vol(face, coverTurned))} mm^3 of lip inside it; the right way, ${r2(vol(face, cover))} (the detent's bite)`);
  check("wordmark strokes clear one nozzle line with margin", 1.3 * P.markW / 30 >= P.markMinStroke, `about ${r2(1.3 * P.markW / 30)} mm, engraved ${P.markDepth}`);
  check("the grip is the horizon's right end, past the track", P.gripX0 > FACE.panel[2] + 3 && P.gripX0 < FACE.outline[2] - 12,
    `grip from X ${P.gripX0} to the face's edge, ${P.gripD} mm deep in a ${r2(FACE.horizonD)} mm groove; the track ends at X ${r2(FACE.panel[2])}`);
}
// The shutter: guide, step, flange bore, pocket, slit, lips, pin; the
// plate; the arithmetic that puts the actuator against the flange.
{
  const X = P.shutterX, Zc = P.shutterZ, T = SHUTTER;
  const rG = P.shutterActuatorGuideD / 2, rF = P.shutterActuatorFlangeD / 2 + P.shutterFlangeBoreClear;
  const pw = P.shutterPocketX, pz = P.shutterSwitchBody[1] + P.shutterSwitchClearance, W = P.shutterFloorW;
  openProbe("shutter guide bore open through the deck", cylY(X, T.guideBottom + 0.1, Zc, rG - 0.3, P.shutterGuideLen + 0.5, 32), `${P.shutterActuatorGuideD} mm, ${P.shutterGuideLen} long, flat ceiling ${P.shutterGuideCeil} above the circle, round for its last ${P.shutterGuideRound}; the ${P.shutterPressCapD} cap passes`);
  openProbe("shutter flange bore open under the step", cylY(X, T.flangeBoreBottom + 0.1, Zc, rF - 0.3, T.guideBottom - T.flangeBoreBottom - 0.2, 32), `${r2(2 * rF)} mm from Y ${r2(T.flangeBoreBottom)} to the step at ${r2(T.guideBottom)}; the ${P.shutterActuatorFlangeD} flange rides in it`);
  {
    const step = box(X - 3, T.guideBottom + 0.1, Zc + rG + 0.1, X + 3, T.guideBottom + 1.0, Zc + rF - 0.1);
    check("the step holds the flange under the guide", vol(shell, step) > step.volume() * 0.95 && P.shutterActuatorFlangeD >= P.shutterActuatorGuideD + 1.0 && P.shutterActuatorFlangeD + 2 * P.shutterFlangeBoreClear <= 2 * rF + 1e-9,
      `${r2(rF - rG)} mm of step all round; the plunger goes in from the cavity and cannot leave through the deck`);
  }
  openProbe("shutter switch pocket open from the flange bore to the floor", box(X - pw / 2 + 0.1, T.floorTop + 0.1, Zc - pz / 2 + 0.1, X + pw / 2 - 0.1, T.flangeBoreBottom, Zc + pz / 2 - 0.1),
    `${pw} x ${r2(pz)} mm, ${r2(T.flangeBoreBottom - T.floorTop)} deep under the flange bore; the ${P.shutterSwitchBody[0]} x ${P.shutterSwitchBody[1]} switch with its legs`);
  openProbe("shutter floor slit open from the pod's left face", box(T.podX0 - 0.2, T.slitBottom + 0.05, Zc - W / 2 - 0.1, T.slitX1 - 0.1, T.slitTop - 0.05, Zc + W / 2 + 0.1),
    `${r2(T.plateLen)} x ${r2(W + 2 * P.shutterFloorClr)} x ${r2(T.slitTop - T.slitBottom)} mm from X ${r2(T.podX0)}; the plate slides in to its stop`);
  {
    const lip = box(X - 4, T.podInnerY + 0.05, Zc - 5, X + 4, T.slitBottom - 0.05, Zc + 5);
    check("the lower lip carries the press", vol(shell, lip) > lip.volume() * 0.98 && P.shutterFloorLip >= 1.2, `${P.shutterFloorLip} mm of pod under the slit: the press lands on it, not on the pin`);
    const above = cylY(T.pinX, T.podInnerY + P.pinLen + P.shutterFloorClr + 0.1, Zc, 0.8, 1.0, 16);
    check("the pin's hole ends in the upper lip", vol(shell, above) > above.volume() * 0.98 && T.pinX + P.facePinD / 2 + 1.2 <= X - pw / 2 && T.pinX - P.facePinD / 2 - 1.2 >= T.podX0,
      `pin at X ${r2(T.pinX)}, ${r2(P.pinLen - P.shutterFloorLip - P.shutterFloorT - P.shutterFloorClr)} mm into the pod above the plate; ${r2(X - pw / 2 - T.pinX - P.facePinD / 2)} of pod to the pocket, ${r2(T.pinX - P.facePinD / 2 - T.podX0)} to the face`);
  }
  openProbe("shutter floor pin hole open from the pod's inner face", cylY(T.pinX, T.podInnerY - 0.2, Zc, P.facePinD / 2 - 0.1, P.pinLen + P.shutterFloorClr + 0.1, 16), `${P.facePinD} mm up through the lower lip, the slit and into the upper lip`);
  check("the actuator meets the flange at rest and the press stops on the switch", Math.abs(T.floorTop + P.shutterSwitchBody[2] - T.flangeBottomRest) < 1e-9 && P.shutterTravelClr >= P.shutterSwitchTravel + 0.5,
    `floor at Y ${r2(T.floorTop)} + switch ${P.shutterSwitchBody[2]} = flange bottom ${r2(T.flangeBottomRest)}; the flange bore runs ${P.shutterTravelClr} below for a ${P.shutterSwitchTravel} stroke`);
  check("the plate's slots sit under the pocket and pass the legs", P.shutterLegX + P.shutterLegSlot[0] / 2 <= pw / 2 && P.shutterLegSlot[1] <= pz && P.shutterLegSlot[0] >= 1.5,
    `slots ${P.shutterLegSlot[0]} x ${P.shutterLegSlot[1]} at X +-${P.shutterLegX} in a ${pw} x ${r2(pz)} pocket; the legs and both leads go down through them`);
  check("the pod joins the right wall and clears CAM 4", T.podX1 > cx1 && T.podX0 >= P.cameraXs[3] + P.xiaoBoardW / 2 + 2.5, `pod from X ${r2(T.podX0)} into the wall at ${r2(cx1)}; CAM 4's XIAO ends at ${r2(P.cameraXs[3] + P.xiaoBoardW / 2)}`);
  check("shutter pod stays above the carrier and its connectors", P.shutterPodBottomZ >= Z.carrierFront + 1.0 && Math.min(...P.frontParts.map(([, , , y1]) => T.podInnerY - y1)) >= 5.0, `pod bottom Z=${P.shutterPodBottomZ}, carrier front Z=${r2(Z.carrierFront)}; the pod's inner face at Y ${r2(T.podInnerY)}, J1001's top at ${P.frontParts[0][3]}`);
  check("shutter bores stay inside the pod", Zc - rF - P.shutterGuideCeil >= P.shutterPodBottomZ + 1.0 && Zc + rF <= Z.plateInner + 0.3 - 1.0, `flange bore from Z ${r2(Zc - rF - P.shutterGuideCeil)} to ${r2(Zc + rF)}; pod Z ${P.shutterPodBottomZ} to ${r2(Z.plateInner + 0.3)}`);
  check("shutter plunger stem is positive", T.stem > 2.0, `${r2(T.stem)} mm nose above the flange; cap ${P.shutterProud} mm proud of the deck at rest`);
  {
    // The plate in the button file: its slots open, in the print frame.
    const px0 = 24, py0 = 2, cxP = px0 + (X - T.podX0), cyP = py0 + W / 2, [sw, sl] = P.shutterLegSlot;
    for (const s of [-1, 1]) openProbe(`floor plate leg slot ${s < 0 ? "-X" : "+X"} open`, box(cxP + s * P.shutterLegX - sw / 2 + 0.1, cyP - sl / 2 + 0.1, 0.1, cxP + s * P.shutterLegX + sw / 2 - 0.1, cyP + sl / 2 - 0.1, P.shutterFloorT - 0.1), `${sw} x ${sl} through the ${P.shutterFloorT} plate`, button);
    openProbe("floor plate pin hole open", cylZ(px0 + P.shutterFloorPinX, cyP, 0.1, P.facePinD / 2 - 0.1, P.shutterFloorT - 0.2, 16), `${P.facePinD} mm, ${P.shutterFloorPinX} from the mouth end`, button);
  }
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
  const nearest = Math.min(...S.strapSlots.map((s) => Math.min(...S.pinRearXY.map((p) => toRect(p, s)))));
  const tunnelNearest = Math.min(...S.strapChannels.map((s) => Math.min(...S.pinRearXY.map((p) => toRect(p, s)))));
  check("strap slots and tunnels clear the frame pins and the frame's edge", nearest >= P.framePinHoleD / 2 + 1.5 && tunnelNearest >= P.facePinD / 2 + 1.5 && S.strapSlots[0][1] >= oy0 + P.frameEdgeR,
    `nearest pin ${r2(nearest)} mm from a slot, ${r2(tunnelNearest)} from a tunnel; slots from Y ${r2(S.strapSlots[0][1])}, the round to ${r2(oy0 + P.frameEdgeR)}`);
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
  check("six pins hold the frame against the foam", S.pinRearXY.length * P.pinHoldN >= 1.5 * clampN,
    `${S.pinRearXY.length} pins at ${P.pinHoldN} N each (PROVISIONAL, T04's hang test) against ${r2(clampN)} N of foam; the frame seats on the wall ends, so the pins see the foam's push and nothing else`);
}

// Print orientations: the shell face down; the frame rear face up; the
// rest as drawn, bearing face on the bed.
// Each print names the places where a face may point down past 45 degrees:
// a bridge, a hole or a pocket, where a support could not stand or its scar
// would never show. Everything else must be clean, so the slicer's supports
// stay off and nothing it would grow could mark a visible surface.
const pinZone = (z0, z1) => S.pinXY.map(([px, py]) => [px - 2, py - 2, z0, px + 2, py + 2, z1]);
const shellZones = [
  [cx0, cy0, Z.glass - 1, cx1, cy1, Z.plateInner + 0.5],
  [P.usbCX - S.usbOpenW / 2 - 1, oy0 - 1, S.usbOpenZ[0] - 1, P.usbCX + S.usbOpenW / 2 + 1, cy0 + 1, S.usbOpenZ[1] + 1],
  ...S.strapChannels.map(([x0, y0, x1, y1]) => [x0 - 0.5, y0 - 0.5, Z.glass - 1, x1 + 0.5, y1 + 0.5, Z.glass + P.strapTunnelSkin + P.strapChannelD + 1]),
  ...pinZone(Z.plateFront - P.facePinWall - 1, Z.plateFront + 0.5),
  [SHUTTER.podX0 - 1, SHUTTER.podInnerY - 1, P.shutterZ - P.shutterCollarD / 2 - 1, SHUTTER.podX1, oy1 + 1, P.shutterZ + P.shutterCollarD / 2 + 1],   // the pod's bores, pocket, slit and pin hole
];
const idEdgeW = textWidth(IDS.face, P.idCapEdge);
const faceZones = [
  ...pinZone(FACE.back - 0.5, FACE.back + P.facePinFace + 1),
  [P.innerMarkAt[0] - (P.modelW - P.innerMarkW) - 3, P.innerMarkAt[1] - MODEL_H - 5, FACE.back - 0.5, P.innerMarkAt[0] + P.innerMarkW + 3 + P.innerSymbolH * 1.25 + 3, P.innerMarkAt[1] + 10, FACE.back + P.innerMarkD + 0.5],
  [P.idFaceX - idEdgeW / 2 - 1, FACE.outline[1] - 1, FACE.back, P.idFaceX + idEdgeW / 2 + 1, FACE.outline[1] + P.idDepthWall + 0.2, FACE.back + P.idCapEdge + 1],   // the letters' 0.3 mm top edges in the edge wall
];
const printSpec = {
  "A01-KINO_CARRIER_SHELL.stl": [shell, [180, 0, 0], shellZones, 5, "the cavity, the USB opening (a 13.4 mm bridge inside the wall), the strap tunnels, the six front pin holes, the pod's bores, pocket, slit and pin hole (flat ceilings, bridges of 16 mm and less, hidden); the ledge and the rear pin holes face up"],
  "A03-KINO_CARRIER_REAR_FRAME.stl": [frame, [180, 0, 0], [[GASK.x0 - GASK.gW - 1, GASK.y0 - GASK.gW - 1, Z.glass - GASK.gD - 0.5, GASK.x1 + GASK.gW + 1, GASK.y1 + GASK.gW + 1, Z.glass + 0.5], ...S.pinRearXY.map(([px, py]) => [px - 2, py - 2, Z.glass - P.facePinSink - 0.5, px + 2, py + 2, Z.glass + 0.5])], 2, "the gasket groove's ceiling (a 2 mm bridge at the bed) and the pin holes' countersinks at the bed; the chamfer, the pad and the A03 engraving face up"],
  "A02-KINO_CARRIER_FACE.stl": [face, [0, 0, 0], faceZones, 5, "the six pin holes and the signature's 0.4 mm ceilings at the bed, the A02 letters' top edges in the bottom edge wall (0.3 mm bridges); the lips' undersides are steeper than 45"],
  "B01-KINO_CARRIER_LENS_COVER.stl": [cover, [0, 0, 0], [[FACE.panel[0] + P.sliderClr - 1.5, -1e3, FACE.floorZ - 1, FACE.panel[0] + P.sliderClr + 1.5, 1e3, FACE.floorZ + P.sliderT - P.sliderBevel[0] + 0.05], [FACE.panel[2] - P.sliderClr - 1.5, -1e3, FACE.floorZ - 1, FACE.panel[2] - P.sliderClr + 1.5, 1e3, FACE.floorZ + P.sliderT - P.sliderBevel[1] + 0.05]], 2, "the 0.2 mm ledges over the edge reliefs"],
  "B02-KINO_CARRIER_SHUTTER_BUTTON.stl": [button, [0, 0, 0], [], 1, "nothing: the plunger's flange and the plate lie on the bed, their holes go through"],
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
  const t03Box = box(ox0 - 1, oy0 - 1, Z.carrierBack - 2, ox0 + 26, oy0 + 26, Z.plateFront + 1);        // the lower-left corner: two walls, the ledge, the plate, the face pin at X 5
  const t04Box = box(ox0 - 1, oy0 - 1, Z.glass - 1, P.framePinsBottom[0] + 4, oy0 + 14, Z.glass + 14);  // the bottom wall's rear end: two strap slots over their tunnel, the frame pin at X 40
  const t05Box = box(SHUTTER.podX0 - 1, SHUTTER.podInnerY - 2, 8, ox1 + 1, oy1 + 1, Z.plateInner + 1);   // the whole pod with the deck over it and the wall corner it joins
  let t03 = cut(shell, t03Box), t04 = cut(shell, t04Box), t05 = cut(shell, t05Box);
  t03 = engrave("T03-KINO_COUPON_LEDGE_CORNER.stl", t03, "T03", 8.0, oy0 + 0.75, Z.carrierBack - 2, -1, 3.0);
  t04 = engrave("T04-KINO_COUPON_STRAP_SHELL.stl", t04, "T04", 14.0, oy0 + 0.75, Z.glass, -1, 3.0);
  t05 = engrave("T05-KINO_COUPON_DECK.stl", t05, "T05", SHUTTER.podX0 + 1.0, cy1 + 0.75, 8, -1, 3.0);
  const bar = engrave("T01-KINO_COUPON_SHRINK_BAR.stl", box(0, 0, 0, 100, 10, 3), "T01", 3.0, 3.5, 3, 1, 3.0);
  return {
    "T03-KINO_COUPON_LEDGE_CORNER.stl": toBed(t03.rotate([180, 0, 0])),
    "T02-KINO_COUPON_POCKET_GAUGE.stl": toBed(gauge.rotate([180, 0, 0])),
    "T05-KINO_COUPON_DECK.stl": toBed(t05.rotate([180, 0, 0])),
    "T04-KINO_COUPON_STRAP_SHELL.stl": toBed(t04.rotate([180, 0, 0])),
    "T01-KINO_COUPON_SHRINK_BAR.stl": bar,
  };
})();
check("every coupon is labelled", ["T01", "T02", "T03", "T04", "T05"].every((id) => couponText.some(([, t]) => t === id)), couponText.map(([n, t]) => `${t} in ${n}`).join("; "));
{
  // T03 holds the face pin at X 5 and a piece of ledge; T04 holds the
  // frame pin at X 40 and the first two strap slots over their tunnel.
  const pin03 = cylZ(P.facePinsBottom[0], XY.wallMidY[0], Z.plateFront - P.facePinWall + 0.1, P.facePinD / 2 - 0.1, P.facePinWall - 0.1 + 0.3, 16);
  check("the ledge coupon carries a face pin hole and the ledge", P.facePinsBottom[0] + 2 <= ox0 + 26 && vol(shell, pin03) < 1e-3
    && vol(shell, box(cx0 + 0.1, cy0 + 2, S.ledgeZ + 0.1, cx0 + P.ledgeW - 0.1, cy0 + 20, S.ledgeZ + 1)) > 17 * (P.ledgeW - 0.2) * 0.9 * 0.9,
    `pin hole at X ${P.facePinsBottom[0]} inside the coupon's ${r2(26 + 1)} mm; ${P.ledgeW} mm of ledge along 24 mm of two walls`);
  const pin04 = cylZ(P.framePinsBottom[0], XY.wallMidY[0], Z.glass - P.facePinWall + 0.1, P.facePinD / 2 - 0.1, P.facePinWall - 0.1 + 0.3, 16);
  check("the strap coupon carries a frame pin hole", vol(shell, pin04) < 1e-3 && P.framePinsBottom[0] + 4 <= ox0 + 60 && S.strapSlots.filter(([x0]) => x0 < P.framePinsBottom[0]).length >= 2,
    `pin hole at X ${P.framePinsBottom[0]}, ${P.facePinWall} deep; 500 g hung on the pin is the hold (pinHoldN ${P.pinHoldN} N, PROVISIONAL)`);
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
  shutter: { stem: r2(SHUTTER.stem), podInnerY: r2(SHUTTER.podInnerY), capD: P.shutterPressCapD },
  print: { shrinkPct: P.shrinkPct, ledgeW: P.ledgeW, pins: 2 * S.pinXY.length, gaugePockets: P.camGaugePockets },
  files, gates: { total: checks.length, failed: checks.filter((c) => !c.pass).length }, checks,
};
fs.writeFileSync(path.join(outDir, "carrier-body-release-report.json"), JSON.stringify(report, null, 2));
console.log(`${checks.length} gates, ${report.gates.failed} failed. Body ${report.body.width} x ${report.body.height} x ${report.body.depth} mm.`);
for (const [k, f] of Object.entries(files)) console.log(`  ${k}: ${f.size.join(" x ")} mm, ${f.volumeCm3} cm^3, ${f.triangles} triangles`);
if (report.gates.failed) { for (const c of checks.filter((c) => !c.pass)) console.log(`  FAIL ${c.name}: ${c.details}`); process.exit(1); }
