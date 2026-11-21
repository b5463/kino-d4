// The face shell and the sliding lens cover. Body frame; the face sits on
// the shell's front plate (Z.plateFront), covers the walls' ends to faceInset
// of their outer edge, and grows toward +Z. It prints back-face down, so
// every piece of relief points up in print.
//
// ODD JOBS, after the jury: the face is the cream (day) or cobalt (night)
// plate with a chamfered edge, framed by a line of charcoal wall end. One
// line is cut across it, the horizon, at the bar's height, edge to edge; the
// bar (the cover) sits in it; its right end is cut deeper and is the grip.
//
// The twelfth cut opened the stow zone: the cover's panel is a window
// through the whole plate, the shell's own plate is the track floor, and
// the cover is loaded from the face's back before the face goes on. No
// roof, no lip slot, no entry gap, no keeper, no blades. The track is the
// field body's, restated: dovetail lips on both X walls, two detent pairs,
// 0.1 mm a side, drops to open; the window's bottom rim is the stowed
// cover's stop and its top rim the closed cover's.
import fs from "node:fs";
import { Manifold, CrossSection, cube, box, cylZ, coneZ, fuse, rbox, prismY, status } from "./lib.mjs";
import { P, Z, XY } from "./params.mjs";

const MAKER = JSON.parse(fs.readFileSync(new URL("./brand/odd-jobs-wordmark.json", import.meta.url), "utf8"));
const SYMBOL = JSON.parse(fs.readFileSync(new URL("../../pcb/kino-d4-carrier-a0/brand/odd-jobs-symbol.json", import.meta.url), "utf8"));
const MODEL = JSON.parse(fs.readFileSync(new URL("../KINO_FIELD_BODY/brand/kino-d4-mark.json", import.meta.url), "utf8"));

// ---- Derived figures, read by the builder and the gates ----------------------
export const FACE = (() => {
  const back = Z.plateFront, front = back + P.faceBase;
  const floorZ = back;                                // the shell's plate is the track floor
  const trackTop = back + P.panelDepth;               // the lips' top, and the groove's floor
  const horizonD = front - trackTop;                  // the groove's depth, derived
  const [ox0, oy0, ox1, oy1] = XY.outer;
  const outline = [ox0 + P.faceInset, oy0 + P.faceInset, ox1 - P.faceInset, oy1 - P.faceInset];
  const outlineR = Math.max(0.5, P.cornerR - P.faceInset);
  const lensY = XY.lensY;
  const closedY0 = lensY - P.sliderH / 2, closedY1 = closedY0 + P.sliderH;
  const panelY0 = outline[1] + P.faceEdgeR + P.bandBottomInset;
  const openY0 = panelY0 + 0.5;
  const travel = closedY0 - openY0;
  const openY1 = openY0 + P.sliderH;
  const inset = P.bandChamfer + P.bandRim;
  const panel = [P.bandX[0] + inset, panelY0, P.bandX[1] - inset, closedY1 + 0.5];
  const horizon = [closedY0 - P.horizonPad, closedY1 + P.horizonPad];
  const tanF = Math.tan(((P.camFovDeg / 2 + P.fovMarginDeg) * Math.PI) / 180);
  const boreR = P.lensBoreD / 2;
  const coneR = (z) => Math.max(boreR, (z - Z.pupil) * tanF);
  const outerR = boreR;                               // the cells are the shell's bores, seen through the window
  const pinXY = [
    ...P.facePinsTop.map((x) => [x, XY.wallMidY[1]]), ...P.facePinsBottom.map((x) => [x, XY.wallMidY[0]]),
    [ox0 + P.wall / 2, P.facePinsSideY], [ox1 - P.wall / 2, P.facePinsSideY],
  ];
  return Object.freeze({ back, front, trackTop, floorZ, horizonD, panel, horizon, outline, outlineR, closedY0, closedY1, openY0, openY1, travel,
    tanF, boreR, coneR, outerR, lensY, pinXY });
})();

const roundedRectZ = (x, y, z, w, d, h, r) => rbox(x, y, z, x + w, y + d, z + h, r);

export function buildFace() {
  const F = FACE;
  const [fx0, fy0, fx1, fy1] = F.outline;
  const solids = [], cuts = [];
  // The plate, its front edge a 45 degree chamfer of faceEdgeR: one hull.
  // Rounds in plan, chamfers in Z: a quarter round here terraced at 0.2 mm
  // layers; the chamfer steps one layer each and reads as the grooves do.
  {
    const R = P.faceEdgeR, slices = [];
    slices.push(roundedRectZ(fx0 + R, fy0 + R, F.front - 0.01, fx1 - fx0 - 2 * R, fy1 - fy0 - 2 * R, 0.01, Math.max(0.5, F.outlineR - R)));
    slices.push(roundedRectZ(fx0, fy0, F.front - R - 0.01, fx1 - fx0, fy1 - fy0, 0.01, F.outlineR));
    // The back outer edge chamfered bedChamfer in the same hull: the elephant
    // foot would otherwise show as a bright lip under the chamfer and eat
    // the charcoal reveal. Exactly 45 degrees (the gate counts 44 as overhang).
    slices.push(roundedRectZ(fx0, fy0, F.back + P.bedChamfer + 0.01, fx1 - fx0, fy1 - fy0, 0.01, F.outlineR));
    slices.push(roundedRectZ(fx0 + P.bedChamfer, fy0 + P.bedChamfer, F.back, fx1 - fx0 - 2 * P.bedChamfer, fy1 - fy0 - 2 * P.bedChamfer, 0.01, Math.max(0.5, F.outlineR - P.bedChamfer)));
    solids.push(Manifold.hull(slices));
  }
  // Blind holes in the back for the six filament pins in the walls' ends,
  // countersunk at the mouth against the elephant foot. Exactly 45 degrees:
  // the extra 0.01 goes into the radius, not the height.
  for (const [px, py] of F.pinXY) {
    cuts.push(cylZ(px, py, F.back - 1, P.facePinD / 2, P.facePinFace + 1, 24));
    cuts.push(coneZ(px, py, F.back - 0.01, P.facePinD / 2 + P.facePinSink + 0.01, P.facePinD / 2, P.facePinSink + 0.01, 24));
  }
  // The signature inside, engraved on the back (the bed face in print, so a
  // recess), mirrored so it reads right when the face is turned over: the
  // symbol, "odd jobs", and under them "kino D4".
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
  // The horizon: edge to edge, open at both ends through the chamfer, its
  // two lips chamfered (upper 0.8, lower 0.4) so the line catches light from
  // every angle. Cut from the top of a back-down print, so no overhang.
  cuts.push(box(fx0 - 2, F.horizon[0], F.trackTop, fx1 + 2, F.horizon[1], F.front + 2));
  {
    const prismX = (x, len, ...ptsYZ) => Manifold.hull(ptsYZ.map(([y, z]) => cube(x, y - 0.01, z - 0.01, len, 0.02, 0.02)));
    const [ct, cb] = P.horizonChamfer, [h0, h1] = F.horizon;
    cuts.push(prismX(fx0 - 2, fx1 - fx0 + 4, [h1 - 0.01, F.front + 0.01], [h1 + ct, F.front + 0.01], [h1 - 0.01, F.front - ct]));
    cuts.push(prismX(fx0 - 2, fx1 - fx0 + 4, [h0 + 0.01, F.front + 0.01], [h0 - cb, F.front + 0.01], [h0 + 0.01, F.front - cb]));
  }
  // The grip: the horizon's right end, deeper, its floor ramping down from
  // the groove floor at 45 degrees (a chamfer in Z: steps one layer each;
  // a vertical step rendered as a chipped notch beside the window).
  {
    const ramp = P.gripD - F.horizonD;
    cuts.push(Manifold.hull([
      box(P.gripX0, F.horizon[0], F.trackTop - 0.01, P.gripX0 + 0.01, F.horizon[1], F.front + 2),
      box(P.gripX0 + ramp, F.horizon[0], F.front - P.gripD, fx1 + 2, F.horizon[1], F.front + 2),
    ]));
  }
  // The panel: the cover's window through the whole plate. The shell's plate
  // is the floor; the window's rims are the stops.
  const [p0x, p0y, p1x, p1y] = F.panel;
  cuts.push(roundedRectZ(p0x, p0y, F.back - 1, p1x - p0x, p1y - p0y, F.front - F.back + 3, P.sliderCornerR + P.sliderClr));
  // The window's front edges chamfered as the horizon's lips are: the bottom
  // rim 0.8, the side rims 0.4 up to the groove. The open stow zone is then
  // the second line of a cut tray, and the bar sits between two lit edges.
  {
    const [wb, ws] = P.windowChamfer, cr0 = P.sliderCornerR + P.sliderClr;
    const prismX = (x, len, ...ptsYZ) => Manifold.hull(ptsYZ.map(([y, z]) => cube(x, y - 0.01, z - 0.01, len, 0.02, 0.02)));
    cuts.push(prismX(p0x + cr0, p1x - p0x - 2 * cr0, [p0y + 0.01, F.front + 0.01], [p0y - wb, F.front + 0.01], [p0y + 0.01, F.front - wb]));
    const sy = p0y + cr0, sl = F.horizon[0] - sy + 0.5;
    cuts.push(prismY(sy, sl, [p0x + 0.01, F.front + 0.01], [p0x - ws, F.front + 0.01], [p0x + 0.01, F.front - ws]));
    cuts.push(prismY(sy, sl, [p1x - 0.01, F.front + 0.01], [p1x + ws, F.front + 0.01], [p1x - 0.01, F.front - ws]));
  }
  // Dovetail lips on both X walls and two detent pairs, added AFTER the cuts.
  const lipTop = F.trackTop + 0.02, lipLen = p1y - p0y - 0.4;
  const adds = [
    prismY(p0y + 0.2, lipLen, [p0x - 0.01, lipTop], [p0x + P.sliderBevel, lipTop], [p0x - 0.01, lipTop - P.sliderLipZ]),
    prismY(p0y + 0.2, lipLen, [p1x + 0.01, lipTop], [p1x - P.sliderBevel, lipTop], [p1x + 0.01, lipTop - P.sliderLipZ]),
  ];
  const bumpSink = P.sliderBumpR - (P.sliderClr + P.sliderBumpBite);
  for (const holdY of [F.closedY0 + P.sliderCornerR + 0.5, F.openY1 - P.sliderCornerR - 0.5]) {
    adds.push(cylZ(p0x - bumpSink, holdY, F.floorZ, P.sliderBumpR, P.sliderBumpH, 32));
    adds.push(cylZ(p1x + bumpSink, holdY, F.floorZ, P.sliderBumpR, P.sliderBumpH, 32));
  }
  const faceCut = status("face: plate less cuts", status("face: plate", fuse(solids)).subtract(status("face: cuts", fuse(cuts))));
  const face = status("face", status("face: with lips", faceCut.add(status("face: lips and bumps", fuse(adds)))).simplify(1e-3));

  // ---- The cover, built closed ------------------------------------------------
  const sx0 = p0x + P.sliderClr, sx1 = p1x - P.sliderClr;
  const sy0 = F.closedY0, sy1 = F.closedY1;
  const sBack = F.floorZ, sFront = sBack + P.sliderT;
  const cr = P.sliderCornerR;
  // The back edge chamfered bedChamfer against the elephant foot: the back
  // is the cover's first layer, and it would flare into the track's walls.
  const bc = P.bedChamfer;
  const plateC = Manifold.hull([
    roundedRectZ(sx0 + bc, sy0 + bc, sBack, sx1 - sx0 - 2 * bc, sy1 - sy0 - 2 * bc, 0.01, Math.max(0.3, cr - bc)),
    roundedRectZ(sx0, sy0, sBack + bc + 0.01, sx1 - sx0, sy1 - sy0, 0.01, cr),
    roundedRectZ(sx0, sy0, sFront - P.sliderBevel - 0.01, sx1 - sx0, sy1 - sy0, 0.01, cr),
    roundedRectZ(sx0 + P.sliderBevel, sy0, sFront - 0.01, sx1 - sx0 - 2 * P.sliderBevel, sy1 - sy0, 0.01, Math.max(0.3, cr - P.sliderBevel / 2)),
  ]);
  // The lip stands coverLipAboveFace proud of the face, closed and stowed.
  const [lw, lh] = P.coverLip;
  const lipProud = (F.front - sFront) + P.coverLipAboveFace;
  // A 45 degree root on the lip's three free sides (the fourth is the
  // cover's own top edge): the lip takes the face-down drop.
  const lr = P.coverLipRoot, lipX = sx0 + P.coverLipLeft, lipY = sy1 - lh;
  const lip = Manifold.hull([
    roundedRectZ(lipX - lr, lipY - lr, sFront - 0.4, lw + 2 * lr, lh + lr, 0.41, 0.6 + lr),
    roundedRectZ(lipX, lipY, sFront + lr, lw, lh, lipProud - lr, 0.6),
  ]);
  // The brand's wordmark, raised off the bar, left-aligned as the brand sets its plate.
  const ms = P.markW / MAKER.widthMm, mw = P.markW, mh = MAKER.heightMm * ms;
  const bandY0 = sy0 + 1.0, bandY1 = sy1 - lh - 0.8;
  const markY = bandY0 + (bandY1 - bandY0 - mh) / 2, markX = sx0 + P.markLeft;
  const cs = new CrossSection(MAKER.polygons, "EvenOdd").scale([ms, ms]).translate([markX, markY]);
  const mark = (cs.area() > 0 ? cs : new CrossSection(MAKER.polygons.map((p) => p.slice().reverse()), "EvenOdd").scale([ms, ms]).translate([markX, markY]))
    .extrude(P.markProud + 0.4).translate([0, 0, sFront - 0.4]);
  const edgeCuts = [];
  {
    const zc0 = sBack - 0.01, zc1 = sFront - P.sliderBevel + 0.01;
    const y0 = sy0 + P.sliderEdgeCrest, y1 = sy1 - P.sliderEdgeCrest, r = P.sliderEdgeRamp;
    for (const [edge, dir] of [[sx0, 1], [sx1, -1]]) {
      const out = edge - dir * 1.0, inn = edge + dir * P.sliderEdgeRelief;
      const pts = [[out, y0 - r], [edge, y0 - r], [inn, y0], [inn, y1], [edge, y1 + r], [out, y1 + r]];
      const c2 = new CrossSection([pts], "Positive");
      edgeCuts.push((c2.area() > 0 ? c2 : new CrossSection([pts.slice().reverse()], "Positive")).extrude(zc1 - zc0).translate([0, 0, zc0]));
    }
  }
  const cover = status("cover", fuse([plateC, lip, mark]).subtract(fuse(edgeCuts)).simplify(1e-3));
  // The mark's cream layers, for the previews: the top markProud of the raised mark.
  const markTop = mark.intersect(box(sx0, sy0, sFront, sx1, sy1, sFront + P.markProud + 1));
  return { face, cover, markTop, lipProud, markBox: { x: markX, y: markY, w: mw, h: mh } };
}
