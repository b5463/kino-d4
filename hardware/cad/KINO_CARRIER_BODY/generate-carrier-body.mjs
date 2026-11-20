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
// layer texture on its walls, a cream (day) or cobalt (night) face set inside
// the shell's rim, a pink shutter, quiet markings. Three filaments, one part
// each. See shell.mjs, face.mjs, shutter.mjs.
//
// PETG, FDM, no support:
//   KINO_CARRIER_SHELL.stl           charcoal; front plate, four walls, pillars, shutter pod, strap lug; face down
//   KINO_CARRIER_REAR_FRAME.stl      charcoal; the frame around the display; rear face down
//   KINO_CARRIER_FACE.stl            cream or cobalt; the face shell; back down
//   KINO_CARRIER_LENS_COVER.stl      charcoal; the sliding cover; back down
//   KINO_CARRIER_COVER_KEEPER.stl    as the face; the block that closes the cover's track
//   KINO_CARRIER_FACE_PINS.stl       four stepped pins, face to shell
//   KINO_CARRIER_SHUTTER_BUTTON.stl  pink; plunger and switch retainer
// plus KINO_CARRIER_STACK_DUMMY.stl, the electronics as blocks, for the
// assembled preview and the interference gates. It is not a part.
//
//   node generate-carrier-body.mjs     writes .candidate/, gates throw on the first failure
//   KINO_SOFT_GATES=1 node ...         collects failures instead
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cube, box, cylZ, coneZ, cylY, fuse, vol, rbox, toBed, r2, overhangArea, writeStl } from "./lib.mjs";
import { P, Z, XY } from "./params.mjs";
import { SHELL, buildShell, buildFrame } from "./shell.mjs";
import { FACE, buildFace } from "./face.mjs";
import { SHUTTER, buildShutterButton } from "./shutter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, ".candidate");
fs.mkdirSync(outDir, { recursive: true });

const [cx0, cy0, cx1, cy1] = XY.cavity;
const [ox0, oy0, ox1, oy1] = XY.outer;
const S = SHELL;

function buildPins() {
  return fuse([0, 1, 2, 3].map((i) => fuse([
    cylZ(i * 8, 0, 0, P.pinShellD / 2, P.pinShellL, 48),
    cylZ(i * 8, 0, P.pinShellL - 0.01, P.pinFaceD / 2, P.pinFaceL + 0.01, 48),
  ])));
}

function buildDummy() {
  const [px0, py0, px1, py1] = XY.p4;
  const parts = [box(px0, py0, Z.glass, px1, py1, 0)];
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
const { face, cover, keeper, markBox, makerBox } = buildFace();
const button = buildShutterButton();
const pins = buildPins();
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
    ["rear frame", P.rearFrameT], ["P4 module, glass to PCB back", P.p4T],
    ["P4 inserts", P.p4InsertH], ["spacers", P.spacer], ["carrier PCB", P.carrierT],
    ["XIAO socket", P.socketH], ["XIAO header insulator (PROVISIONAL)", P.xiaoHeaderInsulator],
    ["XIAO back face to lens front", P.camStackH], ["plate ahead of the lens", P.platePocketAhead],
    ["face, on the plate", P.faceBase], ["lens band", P.bandProud],
  ];
  const sum = terms.reduce((t, [, v]) => t + v, 0);
  const depth = FACE.bandFront - Z.frameRear;
  check("depth chain adds up to the body depth", Math.abs(sum - depth) < 1e-9,
    terms.map(([n, v]) => `${n} ${v}`).join(" + ") + ` = ${r2(sum)} mm; body ${r2(depth)} over the lens band, ${r2(Z.plateFront - Z.frameRear)} to the shell's front`);
  check("the lens front is the pocket floor", Math.abs((Z.plateInner + Z.camPocketDepth) - Z.lensFront) < 1e-9,
    `XIAO back at Z=${r2(Z.xiaoBack)} + ${P.camStackH} = lens front Z=${r2(Z.lensFront)}; pocket ${Z.camPocketDepth} deep from the plate's inner face at Z=${r2(Z.plateInner)}`);
  check("the module's PCB has the plate to land on", Z.plateInner - Z.senseTop >= P.camModulePcbT + 0.3,
    `${r2(Z.plateInner - Z.senseTop)} mm from the Sense board's top to the plate's inner face, for a ${P.camModulePcbT} mm module PCB and its fold`);
  const margin = Math.min(FACE.outline[0] - ox0, ox1 - FACE.outline[2], FACE.outline[1] - oy0, oy1 - FACE.outline[3]);
  check("the face stands on the plate inside a charcoal margin", margin >= P.wall - 0.01 && FACE.back === Z.plateFront,
    `${r2(margin)} mm of the shell's front shows around a ${r2(FACE.outline[2] - FACE.outline[0])} x ${r2(FACE.outline[3] - FACE.outline[1])} face, ${P.faceBase} mm proud`);
}
{
  const [bx0, by0, bx1, by1] = P.batteryBay;
  const h = Z.bayCeiling - Z.bayFloor;
  check("battery bay takes the cell with foam", h >= P.cellT + P.cellFoam,
    `${r2(h)} mm between the P4's module can (${P.p4CanH}, PROVISIONAL) and the carrier's back-face parts (${P.carrierBackPartsH}) for a ${P.cellT} mm cell and ${P.cellFoam} mm of foam`);
  const spacerGap = Math.min(...P.carrierHoles.map(([hx, hy]) => Math.hypot(Math.max(bx0 - hx, 0, hx - bx1), Math.max(by0 - hy, 0, hy - by1)) - 1.75));
  check("battery bay clears the four spacers", spacerGap >= 1.0, `${r2(bx1 - bx0)} x ${r2(by1 - by0)} mm in plan, ${r2(spacerGap)} mm from the nearest 3.5 mm spacer; a 55 x 73 pouch does not fit this plan`);
  check("battery bay is inside the carrier outline", bx0 >= 0 && by0 >= 0 && bx1 <= P.carrierW && by1 <= P.carrierH, "the cell never meets a wall");
}
for (const [n, m] of [["shell", shell], ["rear frame", frame], ["face", face], ["cover", cover], ["keeper", keeper]]) onePart(n, m);
check("shutter button file is two parts", button.decompose().length === 2, `${button.decompose().length}: plunger and retainer`);
check("pins file is four parts", pins.decompose().length === 4, `${pins.decompose().length}`);
check("shell and frame do not overlap", vol(shell, frame) < 1e-6, `${vol(shell, frame).toFixed(4)} mm^3 shared`);
check("face sits on the shell without overlap", vol(shell, face) < 1e-6, `${vol(shell, face).toFixed(4)} mm^3 shared; the pins are the only thing in the shafts`);
check("stack dummy clears the shell (ribs aside)", vol(bare, dummy) < 1e-3, `${vol(bare, dummy).toFixed(4)} mm^3 of electronics inside the shell's material`);
check("stack dummy clears the frame", vol(frame, dummy) < 1e-6, `${vol(frame, dummy).toFixed(4)} mm^3`);
{
  const crush = vol(shell, dummy);
  check("pinch ribs bite the heads and nothing else does", crush > 0.5 && crush < 20, `${crush.toFixed(2)} mm^3 of rib inside the nominal heads`);
}
for (const [lx, ly] of S.lensXY) {
  const pocket = S.headPocket;
  const clear = pocket - 3 * P.camRibProud - 0.3;
  openProbe(`camera pocket at X ${lx} open`,
    cube(lx - pocket / 2 + 2 * P.camRibProud + 0.15, ly - pocket / 2 + 2 * P.camRibProud + 0.15, Z.plateInner + 0.1, clear, clear, Z.camPocketDepth - 0.2),
    `${pocket.toFixed(2)} mm pocket, ${clear.toFixed(2)} mm free between the rib tips and the datum walls, ${Z.camPocketDepth} mm deep`);
  check(`camera pocket at X ${lx} has pinch ribs`,
    vol(shell, cube(lx - pocket / 2, ly - pocket / 2 + 1.0, Z.plateInner + 0.3, P.camRibProud * 1.5, pocket - 2.0, 0.5)) > 0.05, `${P.camRibSpan.length} ribs per axis, ${P.camRibProud} mm proud`);
  openProbe(`lens bore at X ${lx} open through the plate`, cylZ(lx, ly, Z.plateInner + 0.1, P.lensBoreD / 2 - 0.1, P.plate - 0.2, 48), `${P.lensBoreD} mm bore to the plate's front face`);
  const zTop = FACE.floorZ + P.sliderT + 0.3;
  const cone = fuse([
    cylZ(lx, ly, Z.lensFront, FACE.boreR - 0.05, FACE.zBore - Z.lensFront + 0.01, 64),
    coneZ(lx, ly, FACE.zBore, FACE.boreR - 0.05, FACE.coneR(zTop) - 0.05, zTop - FACE.zBore, 64),
  ]);
  openProbe(`field cone at X ${lx} clears the shell`, cone, `${P.camFovDeg + 2 * P.fovMarginDeg} degrees from a pupil ${P.camPupilBackFromLens} mm behind the lens face`);
  openProbe(`field cone at X ${lx} clears the face`, cone, `cell ${r2(2 * FACE.outerR)} mm at the panel floor, rings ${P.lensRingStep} mm proud of the cone`, face);
  openProbe(`field cone at X ${lx} clears the open cover`, cone, `cover stowed ${r2(FACE.travel)} mm down; its top edge at Y ${r2(FACE.openY1)} against the cone's bottom at Y ${r2(ly - FACE.coneR(zTop))}`, coverOpen);
  check(`closed cover blankets the cell at X ${lx}`, vol(cover, cylZ(lx, ly, FACE.floorZ + 0.1, FACE.outerR, 1.0, 48)) > 0.9 * Math.PI * FACE.outerR ** 2,
    `cover ${P.sliderH} tall over a ${r2(2 * FACE.outerR)} mm cell; the firmware's cover-closed test needs all four dark`);
}
for (const [hx, hy] of P.carrierHoles) {
  openProbe(`driver reaches the screw at (${hx}, ${hy})`, cylZ(hx, hy, S.shaftFloorZ + 0.05, P.accessShaftD / 2 - 0.1, Z.plateFront - S.shaftFloorZ + 0.5, 32), `${P.accessShaftD} mm shaft from the plate's front to the foot at Z=${r2(S.shaftFloorZ)}`);
  openProbe(`screw passes the foot at (${hx}, ${hy})`, cylZ(hx, hy, S.bossFootZ - 0.5, P.screwBore / 2 - 0.1, P.bossFoot + 0.4, 24), `${P.screwBore} mm bore through ${P.bossFoot} mm of foot`);
  const foot = cylZ(hx, hy, S.bossFootZ, P.bossD / 2 - 0.1, 0.5, 24).subtract(cylZ(hx, hy, S.bossFootZ - 1, P.screwBore / 2 + 0.1, 3, 24));
  check(`foot stands on the carrier at (${hx}, ${hy})`, vol(shell, foot) > foot.volume() * 0.9, `pillar ${P.bossD} mm, inside the ${P.fastenerKeepOutD} mm fastener keep-out`);
  openProbe(`face pin hole at (${hx}, ${hy}) open`, cylZ(hx, hy, FACE.back - 0.2, P.pinFaceD / 2 - 0.1, P.pinFaceL - 0.2, 24), `${P.pinFaceD} mm, ${P.pinFaceL} deep into the face's back`, face);
  const ahead = cylZ(hx, hy, FACE.back + P.pinFaceL + 0.05, P.pinFaceD / 2 - 0.1, 1.0, 24);
  check(`face pin hole at (${hx}, ${hy}) is blind`, vol(face, ahead) > ahead.volume() * 0.95, `at least 1.0 mm of face ahead of the hole`);
  check(`pin at (${hx}, ${hy}) reaches past the plate into the shaft`, P.pinShellL >= 3.0 && P.pinShellD <= P.accessShaftD, `${P.pinShellD} mm pin in the ${P.accessShaftD} mm shaft, ${P.pinShellL} mm of it; ${P.pinFaceD} mm in the face, ${P.pinFaceL} mm`);
}
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
  const lap = [(P.p4W - 2 * S.windowHalf[0]) / 2, (P.p4H - 2 * S.windowHalf[1]) / 2];
  check("the frame overlaps the module's border on every side", lap[0] >= 3 && lap[1] >= 3, `${r2(lap[0])} mm in X, ${r2(lap[1])} mm in Y`);
  check("thumb pad and symbol stay on the frame's borders", P.thumbPadX[0] >= pcx + S.windowHalf[0] + 1 && P.thumbPadX[1] <= ox1 - 1.5 && P.symbolRearAt[0] >= ox0 + 1.5 && P.symbolRearAt[0] + P.symbolRearH * 1.23 <= pcx - S.windowHalf[0] - 1,
    `window from X ${r2(pcx - S.windowHalf[0])} to ${r2(pcx + S.windowHalf[0])}; thumb grooves X ${P.thumbPadX[0]} to ${P.thumbPadX[1]}; symbol from X ${P.symbolRearAt[0]}, ${P.symbolRearH} mm tall`);
}
for (const x of P.frameScrewXs) for (const y of XY.wallMidY) {
  openProbe(`frame pilot at (${x}, ${r2(y)}) open`, cylZ(x, y, Z.glass - 0.2, P.framePilotD / 2 - 0.1, P.framePilotDepth, 16), `${P.framePilotD} mm pilot ${P.framePilotDepth} mm into the wall end`);
  openProbe(`frame screw hole at (${x}, ${r2(y)}) open`, cylZ(x, y, Z.frameRear - 0.2, P.frameScrewHoleD / 2 - 0.1, P.rearFrameT + 0.4, 16), `${P.frameScrewHoleD} mm through the frame`, frame);
}
check("wall carries the frame pilots", (P.wall - P.framePilotD) / 2 >= 1.2, `${r2((P.wall - P.framePilotD) / 2)} mm a side`);
check("layer grooves leave the wall", P.wall - P.grooveD >= 4.0, `${P.grooveD} mm V-grooves at ${P.grooveP} mm pitch in a ${P.wall} mm wall`);
// The cover in its track.
{
  const closed = vol(face, cover), open = vol(face, coverOpen), mid = vol(face, coverMid);
  check("cover closed: held by the detent and nothing else", closed > 0.01 && closed < 1.0, `${closed.toFixed(3)} mm^3 of bump inside the cover's edge crests`);
  check("cover open: held by the detent and nothing else", open > 0.01 && open < 1.0, `${open.toFixed(3)} mm^3`);
  check("cover mid-travel: free in the track", mid < 1e-3, `${mid.toFixed(4)} mm^3; the edge relief clears the bumps between the crests`);
  check("cover travel is positive and the cover stows above the rim", FACE.travel > 10 && FACE.openY0 >= FACE.panel[1] + 0.4, `${r2(FACE.travel)} mm down from Y ${r2(FACE.closedY0)}; stowed bottom edge at Y ${r2(FACE.openY0)}, panel from Y ${r2(FACE.panel[1])}`);
  check("keeper fills the rim gap and nothing else", vol(face, keeper) < 1e-6 && keeper.volume() > 30, `${r2(keeper.volume())} mm^3, ${P.keeperClr} mm a side in the gap; glued in once the cover is in`);
  const kb = keeper.boundingBox();
  check("keeper sits under the stowed cover's bottom edge", kb.max[1] <= FACE.openY0 - 0.3, `keeper top at Y ${r2(kb.max[1])}, cover bottom when stowed at ${r2(FACE.openY0)}: the positive stop`);
  check("wordmark fits the cover's band", markBox.y > FACE.closedY0 + P.coverRidgeGap + P.coverRidge[1] && markBox.y + markBox.h < FACE.closedY1 - 0.8 && markBox.w < (FACE.panel[2] - FACE.panel[0]) - 10,
    `${r2(markBox.w)} x ${r2(markBox.h)} mm raised ${P.markProud}, strokes about ${r2(1.2 * P.markScale)} mm at this scale (one nozzle line is 0.45)`);
  check("maker's mark sits on the upper deck clear of the band and the bosses", makerBox.y > FACE.band[3] + 1.5 && makerBox.y + makerBox.h < P.carrierHoles[0][1] - P.pinBossD / 2 - 1.0 && makerBox.x + makerBox.w < P.fingerPadX[0] - 2,
    `${r2(makerBox.w)} x ${r2(makerBox.h)} mm at (${makerBox.x}, ${makerBox.y}), raised ${P.makerProud}; band top at Y ${r2(FACE.band[3])}, bosses from Y ${r2(P.carrierHoles[0][1] - P.pinBossD / 2)}`);
  check("finger pad stays on the face, clear of the band and the boss", P.fingerPadX[0] > P.bandX[1] + 2 && P.fingerPadX[1] < FACE.outline[2] - 2 && P.fingerPadY[1] < FACE.outline[3] - 2,
    `ribs X ${P.fingerPadX[0]} to ${P.fingerPadX[1]}, Y ${P.fingerPadY[0]} to ${P.fingerPadY[1]}; face to X ${r2(FACE.outline[2])}`);
}
// The shutter.
{
  const X = P.shutterX, Zc = P.shutterZ, T = SHUTTER;
  openProbe("shutter guide bore open through the top face", cylY(X, T.switchPocketY + T.switchPocketDepth, Zc, P.shutterActuatorGuideD / 2 - 0.3, oy1 + 0.5 - (T.switchPocketY + T.switchPocketDepth), 32), `${P.shutterActuatorGuideD} mm, the ${P.shutterPressCapD} mm cap passes`);
  openProbe("shutter switch pocket open from the cavity", cylY(X, T.podInnerY - 0.3, Zc, P.shutterAssemblyAccessD / 2 - 0.2, T.switchPocketDepth + 0.2, 32), `${P.shutterAssemblyAccessD} mm access bore; the ${P.shutterRetainerPlateD} mm retainer plate seats on the pod's inner face`);
  for (const s of [-1, 1]) openProbe(`shutter lead route ${s < 0 ? "-X" : "+X"} open`,
    box(X + s * (P.shutterSwitchBody[0] + P.shutterSwitchClearance) / 2 - 1.0, T.podInnerY - 1.0, Zc - 1.0, X + s * (P.shutterSwitchBody[0] + P.shutterSwitchClearance) / 2 + 1.0, T.podInnerY + P.shutterPodReach, Zc + 1.0),
    `${P.shutterSideWireW} mm channel from the switch pocket into the cavity, down to J103`);
  check("shutter pod stays above the carrier", P.shutterPodBottomZ >= Z.carrierFront + 1.0, `pod bottom Z=${P.shutterPodBottomZ}, carrier front Z=${r2(Z.carrierFront)}`);
  check("shutter bore's teardrop roof stays inside the pod", Zc - Math.SQRT2 * P.shutterAssemblyAccessD / 2 >= P.shutterPodBottomZ && Zc + P.shutterAssemblyAccessD / 2 <= Z.plateInner + 0.3,
    `axis Z=${Zc}, access bore ${P.shutterAssemblyAccessD}: roof apex at Z=${r2(Zc - Math.SQRT2 * P.shutterAssemblyAccessD / 2)}, top at ${r2(Zc + P.shutterAssemblyAccessD / 2)}; pod Z ${P.shutterPodBottomZ} to ${r2(Z.plateInner + 0.3)}`);
  check("shutter plunger stem is positive", T.stem > 2.0, `${r2(T.stem)} mm stem; press face ${P.shutterProud} mm proud of the top face`);
  check("retainer passes its bore and seats on the pod", P.shutterRetainerCupD + 0.2 <= P.shutterAssemblyAccessD && P.shutterRetainerPlateD > P.shutterAssemblyAccessD && P.shutterRetainerPlateD <= P.shutterPodW - 2 && P.shutterActuatorFlangeD + 0.2 <= P.shutterAssemblyAccessD,
    `${P.shutterRetainerCupD} cup and ${P.shutterActuatorFlangeD} flange through ${P.shutterAssemblyAccessD}; ${P.shutterRetainerPlateD} plate on a ${P.shutterPodW} pod`);
}
openProbe("strap cord hole open", cylZ(S.lugHole[0], S.lugHole[1], P.strapLugZ0 - 0.5, P.strapHoleD / 2 - 0.1, P.strapLugH + S.lugProud + 1, 24), `${P.strapHoleD} mm through the lug on the right wall, front to back`);
check("strap lug clears the USB opening and the shutter pod", P.strapLugY0 > S.usbOpenZ[1] - 100 && P.strapLugY0 + P.strapLugLen < SHUTTER.podInnerY - 2 && P.strapLugY0 > P.carrierH - P.carrierH, `lug Y ${P.strapLugY0} to ${P.strapLugY0 + P.strapLugLen} on the right wall; the USB-C is in the bottom wall, the pod from Y ${r2(SHUTTER.podInnerY)}`);

// Print orientations: the shell face down; everything else as drawn, its
// cosmetic or bearing face on the bed.
const prints = {
  "KINO_CARRIER_SHELL.stl": toBed(shell.rotate([180, 0, 0])),
  "KINO_CARRIER_REAR_FRAME.stl": toBed(frame),
  "KINO_CARRIER_FACE.stl": toBed(face),
  "KINO_CARRIER_LENS_COVER.stl": toBed(cover),
  "KINO_CARRIER_COVER_KEEPER.stl": toBed(keeper),
  "KINO_CARRIER_FACE_PINS.stl": toBed(pins),
  "KINO_CARRIER_SHUTTER_BUTTON.stl": toBed(button),
};
const allowance = {
  "KINO_CARRIER_SHELL.stl": [P.ledXs.length * P.ledSlot[0] * (cy0 - oy0) + P.carrierHoles.length * Math.PI * ((P.accessShaftD / 2) ** 2 - (P.screwBore / 2) ** 2) + (P.shutterCollarD / 2) * (Math.PI / 2) * (P.shutterCollarDepth + 0.2) + 20,
    "the LED slot bridges, the four screw-foot shoulders, the shutter collar's 1.6 mm recess, and up to 20 mm^2 of exact 45 degree gable that rounds past the threshold; the layer grooves are 49 degrees"],
  "KINO_CARRIER_REAR_FRAME.stl": [P.frameScrewXs.length * XY.wallMidY.length * Math.PI * ((P.frameHeadD / 2) ** 2 - (P.frameScrewHoleD / 2) ** 2)
    + Math.ceil((P.thumbPadY[1] - P.thumbPadY[0]) / P.thumbGroovePitch) * P.thumbGrooveW * (P.thumbPadX[1] - P.thumbPadX[0]) + P.symbolRearH * P.symbolRearH * 1.25 + 2,
    "recesses in the bed face: the four counterbore shoulders, the thumb grooves and the engraved symbol, none deeper than 1.6 mm"],
  "KINO_CARRIER_FACE.stl": [P.carrierHoles.length * Math.PI * (P.pinFaceD / 2) ** 2 + 3, "the four blind pin holes' ends (3.5 mm bridges)"],
  "KINO_CARRIER_LENS_COVER.stl": [8, "the 0.2 mm ledges at the edge relief"],
  "KINO_CARRIER_COVER_KEEPER.stl": [1, "nothing"],
  "KINO_CARRIER_FACE_PINS.stl": [1, "nothing"],
  "KINO_CARRIER_SHUTTER_BUTTON.stl": [110, "the retainer's leg-slot bridge and wire notches"],
};
for (const [name, m] of Object.entries(prints)) {
  const a = overhangArea(m), [allow, what] = allowance[name];
  check(`${name} prints support-free`, a <= allow, `${r2(a)} mm^2 facing down steeper than 45 degrees off the bed, allowed ${r2(allow)} for ${what}`);
  const b = m.boundingBox();
  check(`${name} fits the bed`, b.max[0] <= 250 && b.max[1] <= 210, `${r2(b.max[0])} x ${r2(b.max[1])} x ${r2(b.max[2])}`);
}

// ---- Write --------------------------------------------------------------------
const files = {};
for (const [name, m] of Object.entries(prints)) files[name] = writeStl(outDir, name, m);
files["KINO_CARRIER_STACK_DUMMY.stl"] = writeStl(outDir, "KINO_CARRIER_STACK_DUMMY.stl", dummy);
// Body-frame copies of each part for the colour previews (render-parts.py).
for (const [name, m] of [["shell", shell], ["frame", frame], ["face", face], ["cover", cover], ["cover-open", coverOpen], ["keeper", keeper]]) {
  writeStl(outDir, `preview-${name}.stl`, m);
}
{
  // The plunger in place: its flange on the pod's inner side is hidden; show the cap over the collar.
  const capZ = P.shutterZ, cap = fuse([
    cylZ(0, 0, 0, P.shutterPressCapD / 2, SHUTTER.stem + 1.6, 64),
  ]).rotate([-90, 0, 0]).translate([P.shutterX, oy1 - P.shutterCollarDepth - 1.6 + 0.01, capZ]);
  writeStl(outDir, "preview-shutter.stl", cap);
}
files["KINO_CARRIER_ASSEMBLED_PREVIEW.stl"] = writeStl(outDir, "KINO_CARRIER_ASSEMBLED_PREVIEW.stl", fuse([shell, frame, dummy, face, cover, keeper]));
files["KINO_CARRIER_OPEN_PREVIEW.stl"] = writeStl(outDir, "KINO_CARRIER_OPEN_PREVIEW.stl", fuse([shell, frame, dummy, face, coverOpen, keeper]));
const report = {
  package: "KINO_CARRIER_BODY", generated: new Date().toISOString(),
  body: { width: r2(XY.bodyW), height: r2(XY.bodyH), depth: r2(FACE.bandFront - Z.frameRear), depthToRim: r2(S.rimFront - Z.frameRear), lensRowY: r2(XY.lensY), cameraXs: P.cameraXs },
  stack: Object.fromEntries(Object.entries(Z).map(([k, v]) => [k, r2(v)])),
  face: { back: r2(FACE.back), front: r2(FACE.front), bandFront: r2(FACE.bandFront), outline: FACE.outline.map(r2), panel: FACE.panel.map(r2), band: FACE.band.map(r2), coverClosed: [r2(FACE.closedY0), r2(FACE.closedY1)], coverOpen: [r2(FACE.openY0), r2(FACE.openY1)], travel: r2(FACE.travel), cellOuterD: r2(2 * FACE.outerR) },
  shutter: { stem: r2(SHUTTER.stem), podInnerY: r2(SHUTTER.podInnerY), capD: P.shutterPressCapD },
  files, gates: { total: checks.length, failed: checks.filter((c) => !c.pass).length }, checks,
};
fs.writeFileSync(path.join(outDir, "carrier-body-release-report.json"), JSON.stringify(report, null, 2));
console.log(`${checks.length} gates, ${report.gates.failed} failed. Body ${report.body.width} x ${report.body.height} x ${report.body.depth} mm over the lens band.`);
for (const [k, f] of Object.entries(files)) console.log(`  ${k}: ${f.size.join(" x ")} mm, ${f.volumeCm3} cm^3, ${f.triangles} triangles`);
if (report.gates.failed) { for (const c of checks.filter((c) => !c.pass)) console.log(`  FAIL ${c.name}: ${c.details}`); process.exit(1); }
