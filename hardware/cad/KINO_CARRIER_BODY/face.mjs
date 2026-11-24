// A02, the face, and B01, the sliding lens cover. Body frame; the face sits
// on the shell's front plate (Z.plateFront), covers the walls' ends to
// faceInset of their outer edge, and grows toward +Z. It prints back-face
// down, so every piece of relief points up in print.
//
// Two materials, one colour each, one material per part (PLA on PETG does
// not bond; they are the classic breakaway pair): the face is dark blue PLA,
// the cover black PETG. Closed, the cover is a black bar in a blue field at
// the horizon; dropped, it sits in the open stow zone, a cut tray in the
// face's own floor, and the four cells show in the line.
//
// The track: dovetail lips on both X walls the window's whole height (but
// for a loading gap a side), 0.3 off the cover, which runs on a rail in a
// groove in its back. The window's rims are the stops. The detents are
// PETG spring arms at the cover's ends whose bumps click over fixed teeth
// in a channel in each side wall and rest pressed on the far ramp, so the
// ramp holds the cover into its rim. The face's own floor closes the
// track; the cover presses in from the front, stowed. The face is screwed
// to the shell from inside the cavity: six M2 inserts in its back.
import fs from "node:fs";
import { Manifold, CrossSection, cube, box, cylZ, coneZ, fuse, rbox, prismY, status, textSolid, textWidth } from "./lib.mjs";
import { P, Z, XY, IDS } from "./params.mjs";

const MAKER = JSON.parse(fs.readFileSync(new URL("./brand/odd-jobs-wordmark.json", import.meta.url), "utf8"));
const SYMBOL = JSON.parse(fs.readFileSync(new URL("../../pcb/kino-d4-carrier-a0/brand/odd-jobs-symbol.json", import.meta.url), "utf8"));
const MODEL = JSON.parse(fs.readFileSync(new URL("../KINO_FIELD_BODY/brand/kino-d4-mark.json", import.meta.url), "utf8"));

// ---- Derived figures, read by the builder and the gates ----------------------
export const FACE = (() => {
  const back = Z.plateFront, front = back + P.faceBase;
  const floorZ = back + P.faceFloor;                  // the track floor: the face's own
  const trackTop = floorZ + P.panelDepth;             // the lips' top, and the groove's floor
  const horizonD = front - trackTop;                  // the groove's depth, derived
  const [ox0, oy0, ox1, oy1] = XY.outer;
  const outline = [ox0 + P.faceInset, oy0 + P.faceInset, ox1 - P.faceInset, oy1 - P.faceInset];
  const outlineR = Math.max(0.5, P.cornerR - P.faceInset);
  const lensY = XY.lensY;
  const closedY0 = lensY - P.sliderH / 2, closedY1 = closedY0 + P.sliderH;
  const panelY0 = outline[1] + P.faceEdgeR + P.bandBottomInset;
  // The rims are the stops: stowed, the cover's bottom edge lies on the
  // bottom rim; closed, its top edge lies on the top rim.
  const openY0 = panelY0;
  const travel = closedY0 - openY0;
  const openY1 = openY0 + P.sliderH;
  const inset = P.bandChamfer + P.bandRim;
  const panel = [P.bandX[0] + inset, panelY0, P.bandX[1] - inset, closedY1];
  const horizon = [closedY0 - P.horizonPad, closedY1 + P.horizonPad];
  const tanF = Math.tan(((P.camFovDeg / 2 + P.fovMarginDeg) * Math.PI) / 180);
  const boreR = P.lensBoreD / 2;
  const coneR = (z) => Math.max(boreR, (z - Z.pupil) * tanF);
  const outerR = boreR;                               // plain bores through the floor, with a rim
  const bevel = P.sliderBevel, lipZ = bevel.map((b) => b + P.sliderLipOver);   // left, right
  const insertHoleDepth = P.insertLen + P.insertHoleExtra;
  // The detents. A bump on each of the cover's two spring arms, sliderBumpY
  // above its bottom edge, runs in a channel in the side wall. Two teeth
  // per wall interrupt the channel; a tooth's crest is the wall's own face.
  // u is measured outward from the cover's edge line: the wall's face at
  // u = sliderClr, the bump's tip at u = sliderBumpOut, its centre at
  // u = sliderBumpOut - R. At each stop the bump rests on the tooth's far
  // ramp, pressed sliderRestPress, so the ramp pushes the cover into the
  // rim: closed, the bump sits above the upper tooth; stowed, below the
  // lower one. restOff is the bump centre's distance past the tooth's land
  // there (the circle tangent to the ramp, the arm deflected restPress).
  const rB = P.sliderBumpR, th = (P.sliderToothDeg * Math.PI) / 180;
  const uc = P.sliderClr, ub = P.sliderBumpOut - rB;
  const restOff = (rB + (ub - uc - P.sliderRestPress) * Math.cos(th)) / Math.sin(th);   // the centre's distance from the ramp's line is R - press x cos
  const ramp = P.sliderChannelD / Math.tan(th);       // a ramp's length along the travel, the channel's depth deep
  const bumpClosedY = closedY0 + P.sliderBumpY;
  const bumpOpenY = openY0 + P.sliderBumpY;
  const upperTop = bumpClosedY - restOff, lowerBot = bumpOpenY + restOff;
  const teeth = [
    { name: "upper", land: [upperTop - P.sliderToothLand, upperTop] },
    { name: "lower", land: [lowerBot, lowerBot + P.sliderToothLand] },
  ].map((t) => Object.freeze({ ...t, base: [t.land[0] - ramp, t.land[1] + ramp] }));
  const channel = [bumpOpenY - rB - 0.4, bumpClosedY + rB + 0.4];
  const lipGap = [bumpOpenY - rB - 0.3, bumpOpenY + rB + 0.3];   // the stowed bump's way in from the front
  return Object.freeze({ back, front, trackTop, floorZ, horizonD, panel, horizon, outline, outlineR, closedY0, closedY1, openY0, openY1, travel,
    tanF, boreR, coneR, outerR, bevel, lipZ, lensY, insertHoleDepth, bumpClosedY, bumpOpenY, restOff, ramp, teeth, channel, lipGap });
})();

const roundedRectZ = (x, y, z, w, d, h, r) => rbox(x, y, z, x + w, y + d, z + h, r);

export function buildFace() {
  const F = FACE;
  const [fx0, fy0, fx1, fy1] = F.outline;
  const solids = [], cuts = [];
  // The plate, its front edge a 45 degree chamfer of faceEdgeR: one hull.
  {
    const R = P.faceEdgeR, slices = [];
    slices.push(roundedRectZ(fx0 + R, fy0 + R, F.front - 0.01, fx1 - fx0 - 2 * R, fy1 - fy0 - 2 * R, 0.01, Math.max(0.5, F.outlineR - R)));
    slices.push(roundedRectZ(fx0, fy0, F.front - R - 0.01, fx1 - fx0, fy1 - fy0, 0.01, F.outlineR));
    slices.push(roundedRectZ(fx0, fy0, F.back + P.bedChamfer + 0.01, fx1 - fx0, fy1 - fy0, 0.01, F.outlineR));
    slices.push(roundedRectZ(fx0 + P.bedChamfer, fy0 + P.bedChamfer, F.back, fx1 - fx0 - 2 * P.bedChamfer, fy1 - fy0 - 2 * P.bedChamfer, 0.01, Math.max(0.5, F.outlineR - P.bedChamfer)));
    solids.push(Manifold.hull(slices));
  }
  // Blind insert holes in the back (the bed face) at the six screw
  // stations, countersunk at the mouth for the melt; the screws come from
  // inside the cavity through the shell's plate.
  for (const [px, py] of P.faceScrewXY) {
    cuts.push(cylZ(px, py, F.back - 1, P.insertHoleD / 2, F.insertHoleDepth + 1, 32));
    cuts.push(coneZ(px, py, F.back - 0.01, P.insertHoleD / 2 + P.insertMouthSink + 0.01, P.insertHoleD / 2, P.insertMouthSink + 0.01, 32));
  }
  // The signature inside, engraved on the back (the bed face), mirrored so
  // it reads right when the face is turned over, and the part ID beside it.
  {
    const [mx, my] = P.innerMarkAt;
    const mirrored = (data, w, x, y) => {
      const s = w / data.widthMm;
      const c0 = new CrossSection(data.polygons, "EvenOdd").scale([-s, s]).translate([x + w, y]);
      return c0.area() > 0 ? c0 : new CrossSection(data.polygons.map((p) => p.slice().reverse()), "EvenOdd").scale([-s, s]).translate([x + w, y]);
    };
    const wm = mirrored(MAKER, P.innerMarkW, mx, my);
    const model = mirrored(MODEL, P.modelW, mx - (P.modelW - P.innerMarkW), my - MODEL.heightMm * P.modelW / MODEL.widthMm - 2.5);
    const [bx0, by0, bx1, by1] = SYMBOL.pixel_bounds, ss = P.innerSymbolH / (by1 - by0);
    const sw = (bx1 - bx0) * ss;
    const pts = SYMBOL.points.map(([px, py]) => [mx + P.innerMarkW + 3 + sw - (px - bx0) * ss, my - 1 + (by1 - py) * ss]);
    const sy0 = new CrossSection([pts], "Positive");
    const sym = sy0.area() > 0 ? sy0 : new CrossSection([pts.slice().reverse()], "Positive");
    cuts.push(fuse([wm.extrude(P.innerMarkD + 1), model.extrude(P.innerMarkD + 1), sym.extrude(P.innerMarkD + 1)]).translate([0, 0, F.back - 1]));
  }
  // A02, engraved in the face's bottom edge wall (vertical in print, hidden
  // in the reveal), between the back's 0.4 chamfer and the front's 1.2,
  // read from below with X to the right. The text is drawn flat, stood up
  // about X (its height becomes Z, its depth runs toward -Y) and set 0.3
  // into the edge.
  {
    const w = textWidth(IDS.face, P.idCapEdge);
    cuts.push(textSolid(IDS.face, P.idFaceX - w / 2, F.back + P.bedChamfer + 0.2, 0, P.idCapEdge, P.idDepthWall + 1, false)
      .rotate([90, 0, 0]).translate([0, fy0 + P.idDepthWall, 0]));
  }
  // The horizon: edge to edge, its two lips chamfered (upper 0.8, lower
  // 0.4) so the line catches light from every angle.
  cuts.push(box(fx0 - 2, F.horizon[0], F.trackTop, fx1 + 2, F.horizon[1], F.front + 2));
  const prismX = (x, len, ...ptsYZ) => Manifold.hull(ptsYZ.map(([y, z]) => cube(x, y - 0.01, z - 0.01, len, 0.02, 0.02)));
  {
    const [ct, cb] = P.horizonChamfer, [h0, h1] = F.horizon;
    cuts.push(prismX(fx0 - 2, fx1 - fx0 + 4, [h1 - 0.01, F.front + 0.01], [h1 + ct, F.front + 0.01], [h1 - 0.01, F.front - ct]));
    cuts.push(prismX(fx0 - 2, fx1 - fx0 + 4, [h0 + 0.01, F.front + 0.01], [h0 - cb, F.front + 0.01], [h0 + 0.01, F.front - cb]));
  }
  // The grip: the horizon's right end, deeper, its floor ramping down from
  // the groove floor at 45 degrees.
  {
    const ramp = P.gripD - F.horizonD;
    cuts.push(Manifold.hull([
      box(P.gripX0, F.horizon[0], F.trackTop - 0.01, P.gripX0 + 0.01, F.horizon[1], F.front + 2),
      box(P.gripX0 + ramp, F.horizon[0], F.front - P.gripD, fx1 + 2, F.horizon[1], F.front + 2),
    ]));
  }
  // The panel: the cover's track, cut down to the face's own floor. The
  // window's rims are the stops.
  const [p0x, p0y, p1x, p1y] = F.panel;
  cuts.push(roundedRectZ(p0x, p0y, F.floorZ, p1x - p0x, p1y - p0y, F.front - F.floorZ + 3, P.sliderCornerR + P.sliderClr));
  // The window's front edges chamfered as the horizon's lips are: the bottom
  // rim 0.8, the side rims 0.4 up to the groove.
  {
    const [wb, ws] = P.windowChamfer, cr0 = P.sliderCornerR + P.sliderClr;
    cuts.push(prismX(p0x + cr0, p1x - p0x - 2 * cr0, [p0y + 0.01, F.front + 0.01], [p0y - wb, F.front + 0.01], [p0y + 0.01, F.front - wb]));
    const sy = p0y + cr0, sl = F.horizon[0] - sy + 0.5;
    cuts.push(prismY(sy, sl, [p0x + 0.01, F.front + 0.01], [p0x - ws, F.front + 0.01], [p0x + 0.01, F.front - ws]));
    cuts.push(prismY(sy, sl, [p1x - 0.01, F.front + 0.01], [p1x + ws, F.front + 0.01], [p1x - 0.01, F.front - ws]));
  }
  // The four cells: plain bores through the floor with a 45 degree rim at
  // the mouth, so they read as eyes and not as holes.
  for (const lx of P.cameraXs) {
    cuts.push(cylZ(lx, F.lensY, F.back - 1, F.boreR, F.floorZ - F.back + 1.02));
    cuts.push(coneZ(lx, F.lensY, F.floorZ - P.cellSink, F.boreR, F.boreR + P.cellSink + 0.01, P.cellSink + 0.01, 64));
  }
  // The detent channels: in each side wall, from the floor to the lip's
  // underside, sliderChannelD deep past the wall's face, its ceiling falling
  // 45 degrees into the wall so it prints without support. The two teeth
  // are where the channel is not cut: a land at the wall's face and a ramp
  // at sliderToothDeg off the travel at each end, down to past the
  // channel's back. The face is rigid now; nothing in it is a spring.
  const lipTop = F.trackTop + 0.02;
  const [b0, b1] = F.bevel, [l0, l1] = F.lipZ;
  const cd = P.sliderChannelD, ct = P.sliderChannelTop;
  const plan = (pts) => { const c = new CrossSection([pts], "Positive"); return c.area() > 0 ? c : new CrossSection([pts.slice().reverse()], "Positive"); };
  for (const [wx, s] of [[p0x, -1], [p1x, 1]]) {                       // the wall's face; s points into the wall
    const X = (u) => wx + s * u;                                        // u: depth past the wall's face
    const [c0, c1] = F.channel;
    const cz = F.floorZ + P.sliderChannelFloor;
    // No vertex on the wall's own plane: the window's cut owns it, and two
    // near-equal copies of it left slivers. The ceiling's line runs on 0.1
    // into the window instead.
    let channel = prismY(c0, c1 - c0, [X(-0.1), cz], [X(cd), cz], [X(cd), F.floorZ + ct - cd], [X(-0.1), F.floorZ + ct + 0.1]);
    const g = F.ramp / cd;                                              // the ramp's run along Y per unit of depth
    const teeth = F.teeth.map(({ land: [y0, y1] }) => plan([[X(-0.2), y0 + 0.2 * g], [X(-0.2), y1 - 0.2 * g], [X(cd + 0.2), y1 + (cd + 0.2) * g], [X(cd + 0.2), y0 - (cd + 0.2) * g]])
      .extrude(ct + 2).translate([0, 0, F.floorZ - 1]));
    channel = channel.subtract(fuse(teeth));
    cuts.push(channel);
  }
  // Dovetail lips on both X walls, the window's whole height but for one
  // gap a side where the stowed cover's bump comes in from the front,
  // added AFTER the cuts.
  const adds = [];
  for (const [y0, y1] of [[p0y + 0.2, F.lipGap[0]], [F.lipGap[1], p1y - 0.2]]) {
    adds.push(prismY(y0, y1 - y0, [p0x - 0.01, lipTop], [p0x + b0, lipTop], [p0x - 0.01, lipTop - l0]));
    adds.push(prismY(y0, y1 - y0, [p1x + 0.01, lipTop], [p1x - b1, lipTop], [p1x + 0.01, lipTop - l1]));
  }
  // The rail: on the floor at the window's centre, the window's full
  // height, joined to both rims. Up in print.
  const railX = (p0x + p1x) / 2 + P.sliderRailOffset;
  adds.push(box(railX - P.sliderRail[0] / 2, p0y - 0.5, F.floorZ - 0.01, railX + P.sliderRail[0] / 2, p1y + 0.5, F.floorZ + P.sliderRail[1]));
  const faceCut = status("face: plate less cuts", status("face: plate", fuse(solids)).subtract(status("face: cuts", fuse(cuts))));
  const face = status("face", status("face: with lips", faceCut.add(status("face: lips and bumps", fuse(adds)))).simplify(1e-3));

  // ---- The cover, built closed ------------------------------------------------
  const sx0 = p0x + P.sliderClr, sx1 = p1x - P.sliderClr;
  const sy0 = F.closedY0, sy1 = F.closedY1;
  const sBack = F.floorZ, sFront = sBack + P.sliderT;
  const cr = P.sliderCornerR;
  // The plate, its back edge chamfered bedChamfer against the elephant foot
  // (the back is the first layer), then the two X edges bevelled 45 degrees,
  // 1.0 on the left and 1.5 on the right, by two prisms: the key.
  const bc = P.bedChamfer;
  let plateC = Manifold.hull([
    roundedRectZ(sx0 + bc, sy0 + bc, sBack, sx1 - sx0 - 2 * bc, sy1 - sy0 - 2 * bc, 0.01, Math.max(0.3, cr - bc)),
    roundedRectZ(sx0, sy0, sBack + bc + 0.01, sx1 - sx0, sy1 - sy0, sFront - sBack - bc - 0.01, cr),
  ]);
  plateC = plateC.subtract(fuse([
    prismY(sy0 - 1, sy1 - sy0 + 2, [sx0 - 0.5, sFront - b0 - 0.5], [sx0 + b0 + 0.5, sFront + 0.5], [sx0 - 0.5, sFront + 0.5]),
    prismY(sy0 - 1, sy1 - sy0 + 2, [sx1 + 0.5, sFront - b1 - 0.5], [sx1 - b1 - 0.5, sFront + 0.5], [sx1 + 0.5, sFront + 0.5]),
  ]));
  // The lip stands coverLipAboveFace proud of the face, closed and stowed,
  // with a 45 degree root on its three free sides.
  const [lw, lh] = P.coverLip;
  const lipProud = (F.front - sFront) + P.coverLipAboveFace;
  const lr = P.coverLipRoot, lipX = sx0 + P.coverLipLeft, lipY = sy1 - lh;
  const lip = Manifold.hull([
    roundedRectZ(lipX - lr, lipY - lr, sFront - 0.4, lw + 2 * lr, lh + lr, 0.41, 0.6 + lr),
    roundedRectZ(lipX, lipY, sFront + lr, lw, lh, lipProud - lr, 0.6),
  ]);
  // The brand's wordmark, engraved in the bar's top (one material per part:
  // a raised mark in a second colour would be PLA on PETG, which does not
  // bond), left-aligned as the brand sets its plate.
  const ms = P.markW / MAKER.widthMm, mw = P.markW, mh = MAKER.heightMm * ms;
  const bandY0 = sy0 + 1.0, bandY1 = sy1 - lh - 0.8;
  const markY = bandY0 + (bandY1 - bandY0 - mh) / 2, markX = sx0 + P.markLeft;
  const cs = new CrossSection(MAKER.polygons, "EvenOdd").scale([ms, ms]).translate([markX, markY]);
  const mark = (cs.area() > 0 ? cs : new CrossSection(MAKER.polygons.map((p) => p.slice().reverse()), "EvenOdd").scale([ms, ms]).translate([markX, markY]))
    .extrude(P.markDepth + 1).translate([0, 0, sFront - P.markDepth]);
  // No ID on the cover: its back is the bed, its top carries the brand, and
  // it is the only black bar in the kit.
  const edgeCuts = [mark];
  // The groove for the rail, in the back (the bed face), open at both ends,
  // its two edges at the bed chamfered so an elephant foot cannot close it.
  {
    const gx = (sx0 + sx1) / 2 + P.sliderRailOffset, [gw, gd] = P.sliderGroove, m = P.sliderGrooveMouth;
    edgeCuts.push(box(gx - gw / 2, sy0 - 1, sBack - 1, gx + gw / 2, sy1 + 1, sBack + gd));
    edgeCuts.push(prismY(sy0 - 1, sy1 - sy0 + 2, [gx - gw / 2 - m - 0.01, sBack - 0.01], [gx + gw / 2 + m + 0.01, sBack - 0.01], [gx + gw / 2, sBack + m], [gx - gw / 2, sBack + m]));
  }
  // The spring arms: at each end of the bar, sliderArmT wide, cut free by a
  // slit from the bottom edge up to sliderArmRoot, its top end round. They
  // flex in X, in the print plane: PETG along its layers.
  const at = P.sliderArmT, sw = P.sliderArmSlit, ar = P.sliderArmRoot;
  for (const [edge, dir] of [[sx0, 1], [sx1, -1]]) {
    const xa = edge + dir * at, xb = edge + dir * (at + sw), xm = (xa + xb) / 2;
    edgeCuts.push(box(Math.min(xa, xb), sy0 - 1, sBack - 1, Math.max(xa, xb), sy0 + ar - sw / 2, sFront + 1));
    edgeCuts.push(cylZ(xm, sy0 + ar - sw / 2, sBack - 1, sw / 2, sFront - sBack + 2, 32));
  }
  // One bump on each arm's flank, sliderBumpOut past the edge line: a round
  // in plan, its bed edge chamfered 45 degrees, its top 0.5
  // chamfered 45 degrees in under the channel's ceiling.
  const rB = P.sliderBumpR, bt = P.sliderBumpTop, bc0 = P.sliderBumpOut - P.sliderClr + 0.05 + P.sliderChannelFloor;   // the foot: inside the wall's face up to the channel's floor
  const bumps = [[sx0, 1], [sx1, -1]].map(([edge, dir]) => {
    const bx = edge + dir * (rB - P.sliderBumpOut), by = sy0 + P.sliderBumpY;
    return Manifold.hull([
      cylZ(bx, by, sBack, rB - bc0, 0.01, 48),
      cylZ(bx, by, sBack + bc0, rB, bt - 0.5 - bc0, 48),
      cylZ(bx, by, sBack + bt - 0.01, rB - 0.5, 0.01, 48),
    ]);
  });
  const cover = status("cover", fuse([plateC, lip, ...bumps]).subtract(fuse(edgeCuts)).simplify(1e-3));
  // The cover turned round in its own plane: the orientation key's probe.
  const [cx, cy] = [(p0x + p1x) / 2, (sy0 + sy1) / 2];
  const coverTurned = cover.rotate([0, 0, 180]).translate([2 * cx, 2 * cy, 0]);
  return { face, cover, coverTurned, lipProud, markBox: { x: markX, y: markY, w: mw, h: mh } };
}
