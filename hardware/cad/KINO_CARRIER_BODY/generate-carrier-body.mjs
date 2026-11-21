// KINO D4 carrier body: a shell around the dev carrier D1 stack, and the face
// that gives it its form.
//
// The carrier is the chassis. The P4 hangs on its own inserts through 8 mm
// spacers, the carrier sits on the spacers, the XIAOs stand in sockets on the
// carrier, and each camera module hangs off its XIAO on a short soft ribbon.
// The shell holds the carrier by the same four M2 screws that already hold
// the stack, and captures each camera head in a pocket with pinch ribs so the
// picture does not shake on its ribbon. The face shell carries the form.
//
// ODD JOBS, as the brand's camera concept draws it: a charcoal shell with the
// layer texture on its walls, a cream (day) or cobalt (night) face with a
// pillow edge, a pink shutter, quiet markings. Three filaments, one part
// each. See shell.mjs, face.mjs, shutter.mjs.
//
// PETG, FDM, no support:
//   KINO_CARRIER_SHELL.stl           charcoal; front plate, four walls, pillars, shutter pod, strap tabs; face down
//   KINO_CARRIER_REAR_FRAME.stl      charcoal; the frame around the display; rear face up
//   KINO_CARRIER_FACE.stl            cream or cobalt; the face shell; back down
//   KINO_CARRIER_LENS_COVER.stl      charcoal; the sliding cover, its wordmark in the face's filament; back down
//   KINO_CARRIER_SHUTTER_BUTTON.stl  pink; plunger and switch retainer
// plus six pins cut from 1.75 mm filament, and KINO_CARRIER_STACK_DUMMY.stl,
// the electronics as blocks, for the previews and the interference gates.
//
//   node generate-carrier-body.mjs     writes .candidate/, gates throw on the first failure
//   KINO_SOFT_GATES=1 node ...         collects failures instead
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cube, box, cylZ, coneZ, cylY, fuse, vol, rbox, toBed, r2, overhangOutside, writeStl } from "./lib.mjs";
import { P, Z, XY } from "./params.mjs";
import { SHELL, buildShell, buildFrame } from "./shell.mjs";
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
  for (const [hx, hy] of P.carrierHoles) parts.push(cylZ(hx, hy, 0, 1.75, Z.carrierBack, 24));
  const [wx0, wy0, wx1, wy1] = P.usbWindow;
  parts.push(rbox(0, 0, Z.carrierBack, P.carrierW, P.carrierH, Z.carrierFront, P.carrierR)
    .subtract(box(wx0, wy0, Z.carrierBack - 1, wx1, wy1, Z.carrierFront + 1)));
  parts.push(box(P.usbCX - 4.47, P.carrierH - 7.88, Z.carrierBack - P.usbShellH, P.usbCX + 4.47, P.carrierH - 0.53, Z.carrierBack));
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
const { face, cover, markTop, lipProud, markBox } = buildFace();
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
  check("depth chain adds up to the body depth", Math.abs(sum - depth) < 1e-9,
    terms.map(([n, v]) => `${n} ${v}`).join(" + ") + ` = ${r2(sum)} mm; body ${r2(depth)}; nothing stands proud of the face`);
  check("the horizon sits above the track's lips and the grip leaves plate", FACE.horizonD >= 1.5 && P.panelDepth >= P.sliderT + 0.2 && P.faceBase - P.gripD >= 1.0,
    `groove ${r2(FACE.horizonD)} deep over lips ${P.panelDepth} above the shell's plate (the cover ${P.sliderT}, ${r2(P.panelDepth - P.sliderT)} of play); ${r2(P.faceBase - P.gripD)} mm of plate under the grip`);
  check("the lens front is the pocket floor", Math.abs((Z.plateInner + Z.camPocketDepth) - Z.lensFront) < 1e-9,
    `XIAO back at Z=${r2(Z.xiaoBack)} + ${P.camStackH} = lens front Z=${r2(Z.lensFront)}; pocket ${Z.camPocketDepth} deep from the plate's inner face at Z=${r2(Z.plateInner)}`);
  check("the module's PCB has the plate to land on", Z.plateInner - Z.senseTop >= P.camModulePcbT + 0.3,
    `${r2(Z.plateInner - Z.senseTop)} mm from the Sense board's top to the plate's inner face, for a ${P.camModulePcbT} mm module PCB and its fold`);
  check("the face covers the shell's front, inset from the outline", FACE.outline.every((v, i) => Math.abs(Math.abs(v - XY.outer[i]) - P.faceInset) < 1e-9) && FACE.back === Z.plateFront,
    `${r2(FACE.outline[2] - FACE.outline[0])} x ${r2(FACE.outline[3] - FACE.outline[1])} face on the plate, ${P.faceBase} mm thick with a ${P.faceEdgeR} mm chamfer`);
  check("plan corner leaves wall on the diagonal", P.cornerR <= (P.wall + P.carrierClear) * (1 + Math.SQRT2) - 1.0,
    `R${P.cornerR} outer corner against the cavity's near-square corner: ${r2(P.cornerR - (P.cornerR - P.wall - P.carrierClear) * Math.SQRT2)} mm of wall on the diagonal, ${r2(P.cornerR - (P.cornerR - P.wall - P.carrierClear) * Math.SQRT2 - P.grooveD)} under a groove`);
  check("the face steps in from the shell and still covers the pins", P.faceInset >= 0.5 && P.faceInset + P.facePinD / 2 + 0.4 <= P.wall / 2,
    `${P.faceInset} mm of charcoal wall end shows around the face; the pins at the wall's middle sit ${r2(P.wall / 2 - P.faceInset - P.facePinD / 2)} mm inside the face's edge`);
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
  openProbe(`field cone at X ${lx} clears the face`, cone, `cell ${r2(2 * FACE.outerR)} mm at the panel floor, rings ${P.lensRingStep} mm proud of the cone`, face);
  openProbe(`field cone at X ${lx} clears the open cover`, cone, `cover stowed ${r2(FACE.travel)} mm down; its top edge at Y ${r2(FACE.openY1)} against the cone's bottom at Y ${r2(ly - FACE.coneR(zTop))}`, coverOpen);
  check(`closed cover blankets the cell at X ${lx}`, vol(cover, cylZ(lx, ly, FACE.floorZ + 0.1, FACE.outerR, 1.0, 48)) > 0.9 * Math.PI * FACE.outerR ** 2,
    `cover ${P.sliderH} tall over a ${r2(2 * FACE.outerR)} mm cell; the firmware's cover-closed test needs all four dark`);
}
for (const [hx, hy] of P.carrierHoles) {
  openProbe(`driver reaches the screw at (${hx}, ${hy})`, cylZ(hx, hy, S.shaftFloorZ + 0.05, P.accessShaftD / 2 - 0.1, Z.plateFront - S.shaftFloorZ + 0.5, 32), `${P.accessShaftD} mm shaft from the plate's front to the foot at Z=${r2(S.shaftFloorZ)}; the face comes off first`);
  openProbe(`screw passes the foot at (${hx}, ${hy})`, cylZ(hx, hy, S.bossFootZ - 0.5, P.screwBore / 2 - 0.1, P.bossFoot + 0.4, 24), `${P.screwBore} mm bore through ${P.bossFoot} mm of foot`);
  const foot = cylZ(hx, hy, S.bossFootZ, P.bossD / 2 - 0.1, 0.5, 24).subtract(cylZ(hx, hy, S.bossFootZ - 1, P.screwBore / 2 + 0.1, 3, 24));
  check(`foot stands on the carrier at (${hx}, ${hy})`, vol(shell, foot) > foot.volume() * 0.9, `pillar ${P.bossD} mm, inside the ${P.fastenerKeepOutD} mm fastener keep-out`);
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
check("the lip stands proud of the face for the thumb", Math.abs(lipProud - ((FACE.front - (FACE.floorZ + P.sliderT)) + P.coverLipAboveFace)) < 1e-9 && P.coverLipAboveFace >= 0.4, `${r2(lipProud)} mm off the cover, ${P.coverLipAboveFace} above the face, closed and stowed; the thumb pushes it down and lifts it back`);
openProbe("the carrier slides in from the rear up to the pillar feet",
  rbox(-0.05, -0.05, Z.glass + 0.1, P.carrierW + 0.05, P.carrierH + 0.05, S.bossFootZ - 0.05, P.carrierR), `${P.carrierClear} mm a side; the feet at Z=${r2(S.bossFootZ)} are the stop; the shutter pod ends at Z=${P.shutterPodBottomZ}`);
openProbe("USB-C plug passes the bottom wall",
  box(P.usbCX - P.usbPlug[0] / 2, oy0 - 0.5, S.usbOpenZ[0] + P.usbPlugClear, P.usbCX + P.usbPlug[0] / 2, cy0 + 0.5, S.usbOpenZ[1] - P.usbPlugClear), `${P.usbPlug[0]} x ${P.usbPlug[1]} overmold, ${P.usbPlugClear} mm a side`);
for (const lx of P.ledXs) openProbe(`LED slot at X ${lx} open`, box(lx - P.ledSlot[0] / 2 + 0.1, oy0 - 0.5, Z.carrierBack - P.ledSlot[1] + 0.1, lx + P.ledSlot[0] / 2 - 0.1, cy0 + 0.5, Z.carrierBack - 0.1), `${P.ledSlot[0]} x ${P.ledSlot[1]} mm through the bottom wall`);
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
for (const x of P.frameScrewXs) for (const y of XY.wallMidY) {
  openProbe(`frame pilot at (${x}, ${r2(y)}) open`, cylZ(x, y, Z.glass - 0.2, P.framePilotD / 2 - 0.1, P.framePilotDepth, 16), `${P.framePilotD} mm pilot ${P.framePilotDepth} mm into the wall end`);
  openProbe(`frame screw hole at (${x}, ${r2(y)}) open`, cylZ(x, y, Z.frameRear - 0.2, P.frameScrewHoleD / 2 - 0.1, P.rearFrameT + 0.4, 16), `${P.frameScrewHoleD} mm through the frame; the M2 pan head sits proud on the back`, frame);
}
check("wall carries the frame pilots", (P.wall - P.framePilotD) / 2 >= 1.2, `${r2((P.wall - P.framePilotD) / 2)} mm a side`);
check("layer grooves leave the wall", P.wall - P.grooveD >= 4.0, `${P.grooveD} mm V-grooves at ${P.grooveP} mm pitch in a ${P.wall} mm wall`);
// The cover in its window.
{
  const closed = vol(face, cover), open = vol(face, coverOpen), mid = vol(face, coverMid);
  check("cover closed: held by the detent and nothing else", closed > 0.01 && closed < 1.0, `${closed.toFixed(3)} mm^3 of bump inside the cover's edge crests`);
  check("cover open: held by the detent and nothing else", open > 0.01 && open < 1.0, `${open.toFixed(3)} mm^3`);
  check("cover mid-travel: free in the track", mid < 1e-3, `${mid.toFixed(4)} mm^3; the edge relief clears the bumps between the crests`);
  check("cover travel is positive and the cover stows above the rim", FACE.travel > 10 && FACE.openY0 >= FACE.panel[1] + 0.4, `${r2(FACE.travel)} mm down from Y ${r2(FACE.closedY0)}; stowed bottom edge at Y ${r2(FACE.openY0)}, panel from Y ${r2(FACE.panel[1])}`);
  check("wordmark fits under the lip", markBox.y > FACE.closedY0 + 0.8 && markBox.y + markBox.h < FACE.closedY1 - P.coverLip[1] - 0.6 && markBox.w < (FACE.panel[2] - FACE.panel[0]) - 10,
    `${r2(markBox.w)} x ${r2(markBox.h)} mm raised ${P.markProud}; "odd jobs" at ${P.markW} mm has strokes about ${r2(1.3 * P.markW / 30)} mm, floor ${P.markMinStroke}`);
  check("wordmark strokes clear one nozzle line with margin", 1.3 * P.markW / 30 >= P.markMinStroke, `about ${r2(1.3 * P.markW / 30)} mm; print its last ${P.markProud} mm in cream on both colourways`);
  check("the grip is the horizon's right end, past the track", P.gripX0 > FACE.panel[2] + 3 && P.gripX0 < FACE.outline[2] - 12,
    `grip from X ${P.gripX0} to the face's edge, ${P.gripD} mm deep in a ${r2(FACE.horizonD)} mm groove; the track ends at X ${r2(FACE.panel[2])}`);
}
// The shutter.
{
  const X = P.shutterX, Zc = P.shutterZ, T = SHUTTER;
  openProbe("shutter guide bore open through the top face", cylY(X, T.switchPocketY + T.switchPocketDepth, Zc, P.shutterActuatorGuideD / 2 - 0.3, oy1 + 0.5 - (T.switchPocketY + T.switchPocketDepth), 32), `${P.shutterActuatorGuideD} mm, the ${P.shutterPressCapD} mm cap passes; the plunger goes in from the cavity, its ${P.shutterActuatorFlangeD} flange cannot pass the guide`);
  openProbe("shutter switch pocket open from the cavity", cylY(X, T.podInnerY - 0.3, Zc, P.shutterAssemblyAccessD / 2 - 0.2, T.switchPocketDepth + 0.2, 32), `${P.shutterAssemblyAccessD} mm access bore; the ${P.shutterRetainerPlateD} mm retainer plate seats on the pod's inner face`);
  for (const s of [-1, 1]) openProbe(`shutter lead route ${s < 0 ? "-X" : "+X"} open`,
    box(X + s * (P.shutterSwitchBody[0] + P.shutterSwitchClearance) / 2 - 1.0, T.podInnerY - 1.0, Zc - 1.0, X + s * (P.shutterSwitchBody[0] + P.shutterSwitchClearance) / 2 + 1.0, T.podInnerY + P.shutterPodReach, Zc + 1.0),
    `${P.shutterSideWireW} mm channel from the switch pocket into the cavity, down to J103`);
  check("shutter pod stays above the carrier", P.shutterPodBottomZ >= Z.carrierFront + 1.0, `pod bottom Z=${P.shutterPodBottomZ}, carrier front Z=${r2(Z.carrierFront)}`);
  check("shutter bore's teardrop roof stays inside the pod", Zc - Math.SQRT2 * P.shutterAssemblyAccessD / 2 >= P.shutterPodBottomZ && Zc + P.shutterAssemblyAccessD / 2 <= Z.plateInner + 0.3,
    `axis Z=${Zc}, access bore ${P.shutterAssemblyAccessD}: roof apex at Z=${r2(Zc - Math.SQRT2 * P.shutterAssemblyAccessD / 2)}, top at ${r2(Zc + P.shutterAssemblyAccessD / 2)}; pod Z ${P.shutterPodBottomZ} to ${r2(Z.plateInner + 0.3)}`);
  check("shutter plunger stem is positive", T.stem > 2.0, `${r2(T.stem)} mm stem; press face ${P.shutterProud} mm proud of the top face plus the dome`);
  check("retainer passes its bore and seats on the pod", P.shutterRetainerCupD + 0.2 <= P.shutterAssemblyAccessD && P.shutterRetainerPlateD > P.shutterAssemblyAccessD && P.shutterRetainerPlateD <= P.shutterPodW - 2 && P.shutterActuatorFlangeD + 0.2 <= P.shutterAssemblyAccessD,
    `${P.shutterRetainerCupD} cup and ${P.shutterActuatorFlangeD} flange through ${P.shutterAssemblyAccessD}; ${P.shutterRetainerPlateD} plate on a ${P.shutterPodW} pod`);
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
check("strap slots clear the frame screws and the frame's edge", Math.min(...S.strapSlots.map(([x0, , x1]) => Math.min(...P.frameScrewXs.map((sx) => Math.min(Math.abs(sx - x0), Math.abs(sx - x1)))))) >= P.frameScrewHoleD / 2 + 1.5
  && S.strapSlots[0][1] >= oy0 + P.frameEdgeR, `nearest screw ${r2(Math.min(...S.strapSlots.map(([x0, , x1]) => Math.min(...P.frameScrewXs.map((sx) => Math.min(Math.abs(sx - x0), Math.abs(sx - x1)))))))} mm from a slot; slots from Y ${r2(S.strapSlots[0][1])}, the round to ${r2(oy0 + P.frameEdgeR)}`);
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
  check("the gasket groove sits on the glass margin past the window's chamfer", gIn > P.frameWindowChamfer + 0.3 && gx0 - gW >= px0 + 0.8 && gy0 - gW >= py0 + 0.8 && gx1 + gW <= px1 - 0.8 && gy1 + gW <= py1 - 0.8,
    `a ${gW} mm strip from ${gIn} to ${r2(gIn + gW)} mm outside the window; ${r2(gy0 - gW - py0)} mm inside the module's long edge, ${r2(gx0 - gW - px0)} inside its short edge; the chamfer reaches ${P.frameWindowChamfer}`);
  openProbe("the gasket groove is open in the frame's inner face", box(gx0 - gW + 0.1, gy0 + 0.1, Z.glass - gD + 0.05, gx0 - 0.1, gy1 - 0.1, Z.glass - 0.05), `${gD} mm deep, ${gW} wide, ${r2(P.rearFrameT - gD)} of frame under it`, frame);
  const space = P.glassClear + gD, squeeze = (t) => 1 - (space + t) / gT;
  check("the gasket's squeeze covers the stack's tolerance", P.rearFrameT - gD >= 1.2 && squeeze(0) >= 0.3 && squeeze(0.3) >= 0.15 && squeeze(-0.3) <= 0.55,
    `${gT} mm foam in ${r2(space)} mm: ${Math.round(squeeze(0) * 100)} % squeezed; ${Math.round(squeeze(0.3) * 100)} to ${Math.round(squeeze(-0.3) * 100)} % over +-0.3 mm of stack`);
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
  ...P.ledXs.map((lx) => [lx - P.ledSlot[0] / 2 - 0.5, oy0 - 1, Z.carrierBack - P.ledSlot[1] - 0.5, lx + P.ledSlot[0] / 2 + 0.5, cy0 + 1, Z.carrierBack + 0.5]),
  [P.usbCX - S.usbOpenW / 2 - 1, oy0 - 1, S.usbOpenZ[0] - S.usbOpenW / 2 - 1, P.usbCX + S.usbOpenW / 2 + 1, cy0 + 1, S.usbOpenZ[1] + 1],
  ...S.strapChannels.map(([x0, y0, x1, y1]) => [x0 - 0.5, y0 - 0.5, Z.glass - 1, x1 + 0.5, y1 + 0.5, Z.glass + P.strapTunnelSkin + P.strapChannelD + 1]),
  ...pinZone(Z.plateFront - P.facePinWall - 1, Z.plateFront + 0.5),
  [P.shutterX - P.shutterCollarD / 2 - 1, oy1 - P.wall - 3, P.shutterZ - P.shutterCollarD / 2 - 1, P.shutterX + P.shutterCollarD / 2 + 1, oy1 + 1, P.shutterZ + P.shutterCollarD / 2 + 1],
];
const faceZones = [
  ...pinZone(FACE.back - 0.5, FACE.back + P.facePinFace + 1),
  [P.innerMarkAt[0] - (P.modelW - P.innerMarkW) - 3, P.innerMarkAt[1] - MODEL_H - 5, FACE.back - 0.5, P.innerMarkAt[0] + P.innerMarkW + 3 + P.innerSymbolH * 1.25 + 3, P.innerMarkAt[1] + 10, FACE.back + P.innerMarkD + 0.5],
];
const retD = P.shutterRetainerPlateD;
const printSpec = {
  "KINO_CARRIER_SHELL.stl": [shell, [180, 0, 0], shellZones, 5, "the cavity (the four screw-foot shoulders), the LED slots (4.5 mm bridges), the USB opening's 45 degree gable, the strap tunnels, the six pin holes, the collar's 0.4 recess"],
  "KINO_CARRIER_REAR_FRAME.stl": [frame, [180, 0, 0], [[GASK.x0 - GASK.gW - 1, GASK.y0 - GASK.gW - 1, Z.glass - GASK.gD - 0.5, GASK.x1 + GASK.gW + 1, GASK.y1 + GASK.gW + 1, Z.glass + 0.5]], 2, "the gasket groove's ceiling (a 1.5 mm bridge at the bed); holes through, the chamfer and the pad face up"],
  "KINO_CARRIER_FACE.stl": [face, [0, 0, 0], faceZones, 5, "the six pin holes and the signature's 0.4 mm ceilings at the bed; the lips' undersides are steeper than 45"],
  "KINO_CARRIER_LENS_COVER.stl": [cover, [0, 0, 0], [FACE.panel[0] + P.sliderClr, FACE.panel[2] - P.sliderClr].map((ex) => [ex - 1.5, -1e3, FACE.floorZ - 1, ex + 1.5, 1e3, FACE.floorZ + P.sliderT - P.sliderBevel + 0.05]), 2, "the 0.2 mm ledges over the edge reliefs"],
  "KINO_CARRIER_SHUTTER_BUTTON.stl": [button, [0, 0, 0], [[32 - retD / 2 - 1, -1, 0.3, 32 + retD / 2 + 1, retD + 1, 10]], 1, "the retainer's leg-slot bridge and wire notches, inside the pod"],
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
// in the part. Same print orientation as the parent.
const coupons = (() => {
  const [hx, hy] = [P.carrierHoles[2][0] + 0.695, 70.105 - P.carrierHoles[2][1]];   // the lower-left pillar
  const [lx, ly] = S.lensXY[0];
  const [p0x, p0y, , ] = FACE.panel;
  const cut = (m, b) => m.intersect(b);
  return {
    "KINO_COUPON_PILLAR.stl": toBed(cut(shell, box(2, oy0 - 1, S.bossFootZ - 1, hx + 12, hy + 8, Z.plateFront + 1)).rotate([180, 0, 0])),
    "KINO_COUPON_POCKET.stl": toBed(cut(shell, box(lx - 8, ly - 8, Z.plateInner - 1.5, lx + 8, ly + 8, Z.plateFront + 1)).rotate([180, 0, 0])),
    "KINO_COUPON_DECK.stl": toBed(cut(shell, box(P.shutterX - 18, cy1 - 3, 8, P.shutterX + 18, oy1 + 1, Z.plateInner + 1)).rotate([180, 0, 0])),
    "KINO_COUPON_STRAP_SHELL.stl": toBed(cut(shell, box(ox0 - 1, oy0 - 1, Z.glass - 1, ox0 + 22, oy0 + 14, Z.glass + 14)).rotate([180, 0, 0])),
    "KINO_COUPON_STRAP_FRAME.stl": toBed(cut(frame, box(ox0 - 1, oy0 - 1, Z.frameRear - 1, ox0 + 22, oy0 + 14, Z.glass + 1)).rotate([180, 0, 0])),
    "KINO_COUPON_TRACK_FACE.stl": toBed(cut(face, box(p0x - 4, FACE.outline[1] - 1, FACE.back - 1, p0x + 70, FACE.horizon[1] + 4, FACE.front + 1))),
    "KINO_COUPON_TRACK_COVER.stl": toBed(cut(cover, box(p0x - 4, FACE.outline[1] - 1, FACE.back - 1, p0x + 70, FACE.horizon[1] + 4, FACE.front + 3))),
    "KINO_COUPON_SHRINK_BAR.stl": box(0, 0, 0, 100, 10, 3),
  };
})();
for (const [name, m] of Object.entries(coupons)) {
  check(`${name} is one piece on the bed`, m.decompose().length === 1 && m.boundingBox().max[0] <= 250, `${r2(m.boundingBox().max[0])} x ${r2(m.boundingBox().max[1])} x ${r2(m.boundingBox().max[2])} mm, ${m.decompose().length} piece(s)`);
}

// ---- Write --------------------------------------------------------------------
const files = {};
for (const [name, m] of Object.entries(prints)) files[name] = writeStl(outDir, name, m);
for (const [name, m] of Object.entries(coupons)) files[name] = writeStl(outDir, name, m);
files["KINO_CARRIER_STACK_DUMMY.stl"] = writeStl(outDir, "KINO_CARRIER_STACK_DUMMY.stl", dummy);
for (const [name, m] of [["shell", shell], ["frame", frame], ["face", face], ["cover", cover], ["cover-open", coverOpen]]) {
  writeStl(outDir, `preview-${name}.stl`, m);
}
writeStl(outDir, "preview-shutter.stl", capPreview());
writeStl(outDir, "preview-mark.stl", markTop);
writeStl(outDir, "preview-mark-open.stl", markTop.translate([0, -FACE.travel, 0]));
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
  files, gates: { total: checks.length, failed: checks.filter((c) => !c.pass).length }, checks,
};
fs.writeFileSync(path.join(outDir, "carrier-body-release-report.json"), JSON.stringify(report, null, 2));
console.log(`${checks.length} gates, ${report.gates.failed} failed. Body ${report.body.width} x ${report.body.height} x ${report.body.depth} mm.`);
for (const [k, f] of Object.entries(files)) console.log(`  ${k}: ${f.size.join(" x ")} mm, ${f.volumeCm3} cm^3, ${f.triangles} triangles`);
if (report.gates.failed) { for (const c of checks.filter((c) => !c.pass)) console.log(`  FAIL ${c.name}: ${c.details}`); process.exit(1); }
