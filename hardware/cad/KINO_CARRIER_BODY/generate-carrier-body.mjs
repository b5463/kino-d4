// KINO D4 carrier body: a shell around the dev carrier D1 stack.
//
// The carrier is the chassis. The P4 hangs on its own inserts through 8 mm
// spacers, the carrier sits on the spacers, the XIAOs stand in sockets on the
// carrier, and each camera module hangs off its XIAO on a short soft ribbon.
// The body's two jobs are to hold the carrier by the same four M2 screws that
// already hold the stack, and to capture each camera head in a pocket with
// pinch ribs so the picture does not shake on its ribbon. Everything else is
// a wall.
//
// Two prints, PETG, FDM, no support:
//   KINO_CARRIER_SHELL.stl       front plate and all four walls, printed face down
//   KINO_CARRIER_REAR_FRAME.stl  the frame around the display, printed rear face down
// plus KINO_CARRIER_STACK_DUMMY.stl, the electronics as blocks, for the
// assembled preview and the interference gate. It is not a part.
//
//   node generate-carrier-body.mjs     writes .candidate/, gates throw on the first failure
//   KINO_SOFT_GATES=1 node ...         collects failures instead
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module from "manifold-3d";
import { P, Z, XY } from "./params.mjs";

const wasm = await Module();
wasm.setup();
const { Manifold } = wasm;
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, ".candidate");
fs.mkdirSync(outDir, { recursive: true });

// ---- Primitives --------------------------------------------------------------
const cube = (x, y, z, w, d, h) => {
  if (![x, y, z, w, d, h].every(Number.isFinite) || w <= 0 || d <= 0 || h <= 0) {
    throw new Error(`cube(${[x, y, z, w, d, h].join(", ")}) is not a real box`);
  }
  return Manifold.cube([w, d, h]).translate([x, y, z]);
};
const box = (x0, y0, z0, x1, y1, z1) => cube(x0, y0, z0, x1 - x0, y1 - y0, z1 - z0);
const cylZ = (cx, cy, z, r, h, seg = 64) => Manifold.cylinder(h, r, r, seg).translate([cx, cy, z]);
// A box with rounded vertical edges: the hull of four cylinders.
const rbox = (x0, y0, z0, x1, y1, z1, r, seg = 48) => Manifold.hull([
  cylZ(x0 + r, y0 + r, z0, r, z1 - z0, seg), cylZ(x1 - r, y0 + r, z0, r, z1 - z0, seg),
  cylZ(x0 + r, y1 - r, z0, r, z1 - z0, seg), cylZ(x1 - r, y1 - r, z0, r, z1 - z0, seg)]);
const fuse = (list) => Manifold.union(list);
const vol = (a, b) => a.intersect(b).volume();

// ---- Derived positions -------------------------------------------------------
const lensXY = P.cameraXs.map((x) => [x, XY.lensY]);
const pocket = P.camBody + P.camBodySlack;
const [cx0, cy0, cx1, cy1] = XY.cavity;
const [ox0, oy0, ox1, oy1] = XY.outer;
const bottomWallY = [oy0, cy0];     // the bottom wall spans these Y
const bossTopZ = Z.plateInner + 0.3;  // embedded into the plate
const bossFootZ = Z.carrierFront;
const shaftFloorZ = bossFootZ + P.bossFoot;
const usbTop = Z.carrierBack;                       // the receptacle hangs below the carrier's back face
const usbOpenH = P.usbPlug[1] + 2 * P.usbPlugClear;
const usbOpenW = P.usbPlug[0] + 2 * P.usbPlugClear;
const usbOpenZ = [usbTop - P.usbShellH / 2 - usbOpenH / 2, usbTop - P.usbShellH / 2 + usbOpenH / 2];
const windowHalf = [P.activeArea[0] / 2 + P.windowMargin, P.activeArea[1] / 2 + P.windowMargin];

// ---- The shell ---------------------------------------------------------------
function buildShell() {
  const outer = rbox(ox0, oy0, Z.glass, ox1, oy1, Z.plateFront, P.cornerR);
  const cavity = rbox(cx0, cy0, Z.glass - 1, cx1, cy1, Z.plateInner, P.carrierR + P.carrierClear);
  let shell = outer.subtract(cavity);

  // The four stack-screw pillars: from the plate down to the carrier's front
  // face, each tied to its wall by a rib. The screw head bears on the foot;
  // the driver comes in through a shaft from the front.
  const pillars = [];
  for (const [hx, hy] of P.carrierHoles) {
    pillars.push(cylZ(hx, hy, bossFootZ, P.bossD / 2, bossTopZ - bossFootZ));
    const toTop = hy > P.carrierH / 2;
    const ry0 = toTop ? hy : cy0 - 0.5, ry1 = toTop ? cy1 + 0.5 : hy;
    pillars.push(box(hx - P.bossRib / 2, ry0, bossFootZ, hx + P.bossRib / 2, ry1, bossTopZ));
  }
  shell = shell.add(fuse(pillars));

  const cuts = [];
  for (const [hx, hy] of P.carrierHoles) {
    cuts.push(cylZ(hx, hy, shaftFloorZ, P.accessShaftD / 2, Z.plateFront + 1 - shaftFloorZ, 48));
    cuts.push(cylZ(hx, hy, bossFootZ - 0.5, P.screwBore / 2, P.bossFoot + 1, 32));
  }
  // Camera capture: the head's pocket in the plate's inner face, the bore
  // ahead of it. The pinch ribs are added AFTER the cut.
  for (const [lx, ly] of lensXY) {
    cuts.push(cube(lx - pocket / 2, ly - pocket / 2, Z.plateInner - 0.01, pocket, pocket, Z.camPocketDepth + 0.01));
    cuts.push(cylZ(lx, ly, Z.lensFront - 0.01, P.lensBoreD / 2, P.platePocketAhead + 1, 64));
  }
  // LED slots through the bottom wall, one per LED, 2 mm bridges in print.
  for (const lx of P.ledXs) {
    cuts.push(box(lx - P.ledSlot[0] / 2, oy0 - 1, Z.carrierBack - P.ledSlot[1], lx + P.ledSlot[0] / 2, cy0 + 1, Z.carrierBack));
  }
  // The carrier's USB-C opening in the bottom wall, with a gabled roof toward
  // the rear so it prints without support (the plate is the bed).
  {
    const [x0, x1] = [P.usbCX - usbOpenW / 2, P.usbCX + usbOpenW / 2];
    const gable = (usbOpenW / 2) * Math.tan((P.usbGable * Math.PI) / 180);
    // Counter-clockwise, or manifold reports InvalidConstruction and every
    // Boolean after it silently returns nothing.
    const prism = Manifold.extrude(
      [[x0, usbOpenZ[0]], [(x0 + x1) / 2, usbOpenZ[0] - gable], [x1, usbOpenZ[0]], [x1, usbOpenZ[1]], [x0, usbOpenZ[1]]],
      bottomWallY[1] - bottomWallY[0] + 2)
      .rotate([90, 0, 0]).translate([0, cy0 + 1, 0]);
    if (prism.status() !== "NoError") throw new Error(`USB opening prism: ${prism.status()}`);
    cuts.push(prism);
  }
  // Pilots for the rear frame's screws, in the top and bottom wall ends.
  for (const x of P.frameScrewXs) for (const y of XY.wallMidY) {
    cuts.push(cylZ(x, y, Z.glass - 0.5, P.framePilotD / 2, P.framePilotDepth + 0.5, 24));
  }
  const bare = shell.subtract(fuse(cuts));

  // Pinch ribs: one wall in X, one in Y, so two ribbed faces push the head
  // onto two datum faces.
  const ribs = [];
  for (const [lx, ly] of lensXY) {
    for (const t of P.camRibSpan) {
      ribs.push(cylZ(lx - pocket / 2 + P.camRibProud / 2, ly - pocket / 2 + pocket * t, Z.plateInner, P.camRibProud, Z.camPocketDepth, 12));
      ribs.push(cylZ(lx - pocket / 2 + pocket * t, ly - pocket / 2 + P.camRibProud / 2, Z.plateInner, P.camRibProud, Z.camPocketDepth, 12));
    }
  }
  const result = bare.add(fuse(ribs));
  if (result.status() !== "NoError") throw new Error(`shell: ${result.status()}`);
  return { bare, shell: result };
}

// ---- The rear frame ----------------------------------------------------------
function buildFrame() {
  const [pcx, pcy] = XY.p4Centre;
  let frame = rbox(ox0, oy0, Z.frameRear, ox1, oy1, Z.glass, P.cornerR);
  const cuts = [box(pcx - windowHalf[0], pcy - windowHalf[1], Z.frameRear - 1, pcx + windowHalf[0], pcy + windowHalf[1], Z.glass + 1)];
  for (const x of P.frameScrewXs) for (const y of XY.wallMidY) {
    cuts.push(cylZ(x, y, Z.frameRear - 1, P.frameScrewHoleD / 2, P.rearFrameT + 2, 24));
    cuts.push(cylZ(x, y, Z.frameRear - 1, P.frameHeadD / 2, P.frameHeadDepth + 1, 32));
  }
  return frame.subtract(fuse(cuts));
}

// ---- The electronics as blocks ----------------------------------------------
function buildDummy() {
  const [px0, py0, px1, py1] = XY.p4;
  const parts = [box(px0, py0, Z.glass, px1, py1, 0)];                                  // the P4 with its display
  for (const [hx, hy] of P.carrierHoles) parts.push(cylZ(hx, hy, 0, 1.75, Z.carrierBack, 24));   // inserts and spacers
  const [wx0, wy0, wx1, wy1] = P.usbWindow;
  parts.push(rbox(0, 0, Z.carrierBack, P.carrierW, P.carrierH, Z.carrierFront, P.carrierR)
    .subtract(box(wx0, wy0, Z.carrierBack - 1, wx1, wy1, Z.carrierFront + 1)));            // the carrier
  parts.push(box(P.usbCX - 4.47, P.carrierH - 7.88, Z.carrierBack - P.usbShellH, P.usbCX + 4.47, P.carrierH - 0.53, Z.carrierBack)); // J1000, shell 0.53 inside the edge
  const [bx0, by0, bx1, by1] = P.batteryBay;
  parts.push(box(bx0, by0, Z.bayFloor, bx1, by1, Z.bayCeiling));                             // the battery bay, as the cell it is gated for
  for (const x of P.cameraXs) {
    const cy = P.socketCentreY, ly = XY.lensY;
    for (const sx of [-7.62, 7.62]) parts.push(box(x + sx - 1.27, cy - 8.89, Z.carrierFront, x + sx + 1.27, cy + 8.89, Z.socketTop));
    parts.push(box(x - P.xiaoBoardW / 2, cy - P.xiaoBoardH / 2, Z.socketTop, x + P.xiaoBoardW / 2, cy + P.xiaoBoardH / 2, Z.senseTop)); // header insulator + XIAO + Sense
    parts.push(box(x - P.camModulePcb[0] / 2, ly - P.camModulePcb[1] / 2, Z.plateInner - 1.0, x + P.camModulePcb[0] / 2, ly + P.camModulePcb[1] / 2, Z.plateInner)); // module PCB on the plate
    parts.push(box(x - P.camBody / 2, ly - P.camBody / 2, Z.plateInner, x + P.camBody / 2, ly + P.camBody / 2, Z.plateInner + 2.0)); // the head
    parts.push(cylZ(x, ly, Z.plateInner + 2.0, P.camBarrelD / 2, Z.lensFront - Z.plateInner - 2.0, 48));   // the barrel to the lens front
  }
  return fuse(parts);
}

// ---- Build --------------------------------------------------------------------
const { bare, shell } = buildShell();
const frame = buildFrame();
const dummy = buildDummy();

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
const r2 = (v) => Math.round(v * 100) / 100;

// The stack chain, re-added term by term. Bulk in the hand is depth.
{
  const terms = [
    ["rear frame", P.rearFrameT], ["P4 module, glass to PCB back", P.p4T],
    ["P4 inserts", P.p4InsertH], ["spacers", P.spacer], ["carrier PCB", P.carrierT],
    ["XIAO socket", P.socketH], ["XIAO header insulator (PROVISIONAL)", P.xiaoHeaderInsulator],
    ["XIAO back face to lens front", P.camStackH], ["plate ahead of the lens", P.platePocketAhead],
  ];
  const sum = terms.reduce((t, [, v]) => t + v, 0);
  check("depth chain adds up to the body depth", Math.abs(sum - Z.depth) < 1e-9,
    terms.map(([n, v]) => `${n} ${v}`).join(" + ") + ` = ${r2(sum)} mm; body ${r2(Z.depth)}`);
  check("the lens front is the pocket floor", Math.abs((Z.plateInner + Z.camPocketDepth) - Z.lensFront) < 1e-9,
    `XIAO back at Z=${r2(Z.xiaoBack)} + ${P.camStackH} = lens front Z=${r2(Z.lensFront)}; pocket ${Z.camPocketDepth} deep from the plate's inner face at Z=${r2(Z.plateInner)}`);
  check("the module's PCB has the plate to land on", Z.plateInner - Z.senseTop >= P.camModulePcbT + 0.3,
    `${r2(Z.plateInner - Z.senseTop)} mm from the Sense board's top to the plate's inner face, for a ${P.camModulePcbT} mm module PCB and its fold`);
}
// The battery bay: the layer between the P4 and the carrier, between the spacers.
{
  const [bx0, by0, bx1, by1] = P.batteryBay;
  const h = Z.bayCeiling - Z.bayFloor;
  check("battery bay takes the cell with foam", h >= P.cellT + P.cellFoam,
    `${r2(h)} mm between the P4's module can (${P.p4CanH}, PROVISIONAL) and the carrier's back-face parts (${P.carrierBackPartsH}) for a ${P.cellT} mm cell and ${P.cellFoam} mm of foam`);
  const spacerGap = Math.min(...P.carrierHoles.map(([hx, hy]) => {
    const dx = Math.max(bx0 - hx, 0, hx - bx1), dy = Math.max(by0 - hy, 0, hy - by1);
    return Math.hypot(dx, dy) - 1.75;
  }));
  check("battery bay clears the four spacers", spacerGap >= 1.0,
    `${r2(bx1 - bx0)} x ${r2(by1 - by0)} mm in plan, ${r2(spacerGap)} mm from the nearest 3.5 mm spacer; a 55 x 73 pouch does not fit this plan`);
  check("battery bay is inside the carrier outline", bx0 >= 0 && by0 >= 0 && bx1 <= P.carrierW && by1 <= P.carrierH, "the cell never meets a wall");
}
check("shell is one part", shell.decompose().length === 1, `${shell.decompose().length} component(s)`);
check("rear frame is one part", frame.decompose().length === 1, `${frame.decompose().length} component(s)`);
check("shell and frame do not overlap", vol(shell, frame) < 1e-6, `${vol(shell, frame).toFixed(4)} mm^3 shared`);
check("stack dummy clears the shell (ribs aside)", vol(bare, dummy) < 1e-3,
  `${vol(bare, dummy).toFixed(4)} mm^3 of electronics inside the shell's material`);
check("stack dummy clears the frame", vol(frame, dummy) < 1e-6, `${vol(frame, dummy).toFixed(4)} mm^3`);
{
  const crush = vol(shell, dummy);
  check("pinch ribs bite the heads and nothing else does", crush > 0.5 && crush < 20,
    `${crush.toFixed(2)} mm^3 of rib inside the nominal heads: ${lensXY.length} pockets x 4 ribs x ${P.camRibProud} mm`);
}
// Camera capture, per station.
for (const [lx, ly] of lensXY) {
  const clear = pocket - 3 * P.camRibProud - 0.3;
  openProbe(`camera pocket at X ${lx} open`,
    cube(lx - pocket / 2 + 2 * P.camRibProud + 0.15, ly - pocket / 2 + 2 * P.camRibProud + 0.15, Z.plateInner + 0.1, clear, clear, Z.camPocketDepth - 0.2),
    `${pocket.toFixed(2)} mm pocket, ${clear.toFixed(2)} mm free between the rib tips and the datum walls, ${Z.camPocketDepth} mm deep`);
  check(`camera pocket at X ${lx} has pinch ribs`,
    vol(shell, cube(lx - pocket / 2, ly - pocket / 2 + 1.0, Z.plateInner + 0.3, P.camRibProud * 1.5, pocket - 2.0, 0.5)) > 0.05,
    `${P.camRibSpan.length} ribs per axis, ${P.camRibProud} mm proud`);
  openProbe(`lens bore at X ${lx} open through the plate`,
    cylZ(lx, ly, Z.plateInner + 0.1, P.lensBoreD / 2 - 0.1, P.plate - 0.2, 48),
    `${P.lensBoreD} mm bore from the pocket floor to the plate's front face`);
  // The field cone from the pupil must clear the bore at the plate's front.
  const tanF = Math.tan(((P.camFovDeg / 2 + P.fovMarginDeg) * Math.PI) / 180);
  const need = (Z.plateFront - Z.pupil) * tanF;
  check(`lens bore at X ${lx} passes the field`, P.lensBoreD / 2 >= need,
    `${r2(need)} mm radius needed at the plate's front for ${P.camFovDeg + 2 * P.fovMarginDeg} degrees from a pupil ${r2(Z.plateFront - Z.pupil)} mm behind it; bore ${P.lensBoreD / 2}`);
}
// The stack screws: driver in from the front, screw through the foot into the spacer.
for (const [hx, hy] of P.carrierHoles) {
  openProbe(`driver reaches the screw at (${hx}, ${hy})`,
    cylZ(hx, hy, shaftFloorZ + 0.05, P.accessShaftD / 2 - 0.1, Z.plateFront - shaftFloorZ + 0.5, 32),
    `${P.accessShaftD} mm shaft from the front face to the foot at Z=${r2(shaftFloorZ)}`);
  openProbe(`screw passes the foot at (${hx}, ${hy})`,
    cylZ(hx, hy, bossFootZ - 0.5, P.screwBore / 2 - 0.1, P.bossFoot + 0.4, 24),
    `${P.screwBore} mm bore through ${P.bossFoot} mm of foot onto the carrier at Z=${r2(bossFootZ)}`);
  const foot = cylZ(hx, hy, bossFootZ, P.bossD / 2 - 0.1, 0.5, 24).subtract(cylZ(hx, hy, bossFootZ - 1, P.screwBore / 2 + 0.1, 3, 24));
  check(`foot stands on the carrier at (${hx}, ${hy})`, vol(shell, foot) > foot.volume() * 0.9,
    `pillar ${P.bossD} mm, inside the carrier's ${P.fastenerKeepOutD} mm fastener keep-out`);
  check(`pillar at (${hx}, ${hy}) stays inside the keep-out`, P.bossD + 2 * P.bossRib <= P.fastenerKeepOutD + 2 * P.bossRib && P.bossD <= P.fastenerKeepOutD, "nothing but silk under it");
}
// The stack has to get in: a carrier-sized sweep from the rear to the pillar
// feet meets no shell material.
openProbe("the carrier slides in from the rear up to the pillar feet",
  rbox(-0.05, -0.05, Z.glass + 0.1, P.carrierW + 0.05, P.carrierH + 0.05, bossFootZ - 0.05, P.carrierR),
  `${P.carrierClear} mm a side; the feet at Z=${r2(bossFootZ)} are the stop`);
// Openings.
openProbe("USB-C plug passes the bottom wall",
  box(P.usbCX - P.usbPlug[0] / 2, oy0 - 0.5, usbOpenZ[0] + P.usbPlugClear, P.usbCX + P.usbPlug[0] / 2, cy0 + 0.5, usbOpenZ[1] - P.usbPlugClear),
  `${P.usbPlug[0]} x ${P.usbPlug[1]} overmold, ${P.usbPlugClear} mm a side, centred Z=${r2((usbOpenZ[0] + usbOpenZ[1]) / 2)}`);
for (const lx of P.ledXs) openProbe(`LED slot at X ${lx} open`,
  box(lx - P.ledSlot[0] / 2 + 0.1, oy0 - 0.5, Z.carrierBack - P.ledSlot[1] + 0.1, lx + P.ledSlot[0] / 2 - 0.1, cy0 + 0.5, Z.carrierBack - 0.1),
  `${P.ledSlot[0]} x ${P.ledSlot[1]} mm through the bottom wall under the carrier's back face`);
// The display.
{
  const [pcx, pcy] = XY.p4Centre;
  openProbe("the frame shows the whole active area with margin",
    box(pcx - windowHalf[0] + 0.05, pcy - windowHalf[1] + 0.05, Z.frameRear - 0.5, pcx + windowHalf[0] - 0.05, pcy + windowHalf[1] - 0.05, Z.glass + 0.5),
    `${r2(2 * windowHalf[0])} x ${r2(2 * windowHalf[1])} window over a ${P.activeArea[0]} x ${P.activeArea[1]} active area, ${P.windowMargin} mm a side (active area centred: PROVISIONAL)`, frame);
  const lap = [(P.p4W - 2 * windowHalf[0]) / 2, (P.p4H - 2 * windowHalf[1]) / 2];
  check("the frame overlaps the module's border on every side", lap[0] >= 3 && lap[1] >= 3, `${r2(lap[0])} mm in X, ${r2(lap[1])} mm in Y`);
}
for (const x of P.frameScrewXs) for (const y of XY.wallMidY) {
  openProbe(`frame pilot at (${x}, ${r2(y)}) open`, cylZ(x, y, Z.glass - 0.2, P.framePilotD / 2 - 0.1, P.framePilotDepth, 16),
    `${P.framePilotD} mm pilot ${P.framePilotDepth} mm into the wall end`);
  openProbe(`frame screw hole at (${x}, ${r2(y)}) open`, cylZ(x, y, Z.frameRear - 0.2, P.frameScrewHoleD / 2 - 0.1, P.rearFrameT + 0.4, 16),
    `${P.frameScrewHoleD} mm through the frame`, frame);
  check(`wall carries the pilot at (${x}, ${r2(y)})`, (P.wall - P.framePilotD) / 2 >= 1.2, `${r2((P.wall - P.framePilotD) / 2)} mm a side`);
}

// Print orientation: the shell face down (rotate 180 about X), the frame rear
// face down. Each lands on Z=0 with its bounding box at the origin.
const toBed = (m) => { const b = m.boundingBox(); return m.translate([-b.min[0], -b.min[1], -b.min[2]]); };
const shellPrint = toBed(shell.rotate([180, 0, 0]));
const framePrint = toBed(frame.rotate([180, 0, 0]));
// Support-free: no face on either print points down more than 45 degrees off
// vertical, except the bed plane itself and the LED slots' 2 mm bridges.
function overhangArea(m, allow) {
  const mesh = m.getMesh(); const s = mesh.numProp; let area = 0;
  const v = (i) => [mesh.vertProperties[i * s], mesh.vertProperties[i * s + 1], mesh.vertProperties[i * s + 2]];
  for (let t = 0; t < mesh.triVerts.length; t += 3) {
    const [a, b, c] = [v(mesh.triVerts[t]), v(mesh.triVerts[t + 1]), v(mesh.triVerts[t + 2])];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n); if (len < 1e-9) continue;
    const nz = n[2] / len, zMax = Math.max(a[2], b[2], c[2]);
    if (nz < -Math.cos(Math.PI / 4) - 1e-6 && zMax > 0.01) area += len / 2;
  }
  return area;
}
{
  const bridges = P.ledXs.length * P.ledSlot[0] * (cy0 - oy0);
  const shoulders = P.carrierHoles.length * Math.PI * ((P.accessShaftD / 2) ** 2 - (P.screwBore / 2) ** 2);
  const a = overhangArea(shellPrint);
  check("shell prints support-free", a <= bridges + shoulders + 3.0,
    `${r2(a)} mm^2 facing down steeper than 45 degrees off the bed: ${r2(bridges)} mm^2 the three LED slots' 2 mm bridges, ${r2(shoulders)} mm^2 the four screw-foot shoulders (0.8 mm rings over the bore), nothing else`);
  const f = overhangArea(framePrint);
  const heads = P.frameScrewXs.length * XY.wallMidY.length * Math.PI * ((P.frameHeadD / 2) ** 2 - (P.frameScrewHoleD / 2) ** 2);
  check("frame prints support-free", f <= heads + 1.0, `${r2(f)} mm^2 off the bed, ${r2(heads)} mm^2 of it the four counterbore shoulders (0.9 mm bridges)`);
}
check("prints fit a 250 x 210 bed", [shellPrint, framePrint].every((m) => { const b = m.boundingBox(); return b.max[0] <= 250 && b.max[1] <= 210; }),
  [shellPrint, framePrint].map((m) => { const b = m.boundingBox(); return `${r2(b.max[0])} x ${r2(b.max[1])} x ${r2(b.max[2])}`; }).join("; "));

// ---- Write --------------------------------------------------------------------
function writeStl(name, solid) {
  const mesh = solid.getMesh(); const s = mesh.numProp;
  const v = (i) => [mesh.vertProperties[i * s], mesh.vertProperties[i * s + 1], mesh.vertProperties[i * s + 2]];
  const n = mesh.triVerts.length / 3;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write(`KINO CARRIER BODY ${name}`.slice(0, 80), 0, "ascii");
  buf.writeUInt32LE(n, 80);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const [a, b, c] = [v(mesh.triVerts[t * 3]), v(mesh.triVerts[t * 3 + 1]), v(mesh.triVerts[t * 3 + 2])];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...nn) || 1;
    for (const x of [nn[0] / l, nn[1] / l, nn[2] / l, ...a, ...b, ...c]) { buf.writeFloatLE(x, o); o += 4; }
    buf.writeUInt16LE(0, o); o += 2;
  }
  fs.writeFileSync(path.join(outDir, name), buf);
  const bb = solid.boundingBox();
  return { triangles: n, volumeCm3: r2(solid.volume() / 1000), size: bb.max.map((hi, i) => r2(hi - bb.min[i])) };
}
const files = {
  "KINO_CARRIER_SHELL.stl": writeStl("KINO_CARRIER_SHELL.stl", shellPrint),
  "KINO_CARRIER_REAR_FRAME.stl": writeStl("KINO_CARRIER_REAR_FRAME.stl", framePrint),
  "KINO_CARRIER_STACK_DUMMY.stl": writeStl("KINO_CARRIER_STACK_DUMMY.stl", dummy),
  "KINO_CARRIER_ASSEMBLED_PREVIEW.stl": writeStl("KINO_CARRIER_ASSEMBLED_PREVIEW.stl", fuse([shell, frame, dummy])),
};
const report = {
  package: "KINO_CARRIER_BODY", generated: new Date().toISOString(),
  body: { width: r2(XY.bodyW), height: r2(XY.bodyH), depth: r2(Z.depth), lensRowY: r2(XY.lensY), cameraXs: P.cameraXs },
  stack: Object.fromEntries(Object.entries(Z).map(([k, v]) => [k, r2(v)])),
  files, gates: { total: checks.length, failed: checks.filter((c) => !c.pass).length }, checks,
};
fs.writeFileSync(path.join(outDir, "carrier-body-release-report.json"), JSON.stringify(report, null, 2));
console.log(`${checks.length} gates, ${report.gates.failed} failed. Body ${report.body.width} x ${report.body.height} x ${report.body.depth} mm.`);
for (const [k, f] of Object.entries(files)) console.log(`  ${k}: ${f.size.join(" x ")} mm, ${f.volumeCm3} cm^3, ${f.triangles} triangles`);
if (report.gates.failed) { for (const c of checks.filter((c) => !c.pass)) console.log(`  FAIL ${c.name}: ${c.details}`); process.exit(1); }
