// The face shell, the sliding lens cover and the apron. Body frame; the face
// sits on the shell's front plate (Z.plateFront), covers the walls' ends to
// faceInset of their outer edge, and grows toward +Z. It prints back-face
// down, so every piece of relief points up in print and the lens cells open
// upward.
//
// ODD JOBS, after the jury: the face is the cream (day) or cobalt (night)
// plate with a pillow edge, framed by a line of charcoal wall end. One line
// is cut across it, the horizon, at the bar's height, edge to edge; the bar
// (the cover) sits in it; its right end is cut deeper and is the grip. Below
// the bar, in the stow zone, the apron sits flush in its own recess. Nothing
// stands proud of the face.
//
// The track is the field body's, restated: dovetail lips on both walls, two
// detent pairs, 0.1 mm a side, drops to open. The cover enters through a gap
// below the track; the apron's block refills it and is the stop. The cover's
// lip, on its top edge, is what the thumb pushes down; it stops above the
// apron, and the brand's wordmark rides on the bar.
import fs from "node:fs";
import { Manifold, CrossSection, cube, box, cylZ, coneZ, fuse, rbox, prismY, status } from "./lib.mjs";
import { P, Z, XY } from "./params.mjs";

const MAKER = JSON.parse(fs.readFileSync(new URL("./brand/odd-jobs-wordmark.json", import.meta.url), "utf8"));

// ---- Derived figures, read by the builder and the gates ----------------------
export const FACE = (() => {
  const back = Z.plateFront, front = back + P.faceBase;
  const trackTop = front - P.horizonD;               // the groove's floor; the track is cut below it
  const floorZ = trackTop - P.panelDepth;
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
  const lipSlotY0 = openY1 - P.coverLip[1] - P.lipSlotClear;   // the slot through the roof, from here up to the horizon
  const tanF = Math.tan(((P.camFovDeg / 2 + P.fovMarginDeg) * Math.PI) / 180);
  const boreR = P.lensBoreD / 2;
  const coneR = (z) => Math.max(boreR, (z - Z.pupil) * tanF);
  const zBore = Z.pupil + boreR / tanF;
  const zMid = (zBore + floorZ) / 2;
  const midR = coneR(zMid) + P.lensRingStep;
  const outerR = coneR(floorZ) + 2 * P.lensRingStep;
  const railXs = [(panel[0] + panel[2]) / 2 - P.coverRailOffset, (panel[0] + panel[2]) / 2 + P.coverRailOffset];
  const pinXY = [
    ...P.facePinsTop.map((x) => [x, XY.wallMidY[1]]), ...P.facePinsBottom.map((x) => [x, XY.wallMidY[0]]),
    [ox0 + P.wall / 2, P.facePinsSideY], [ox1 - P.wall / 2, P.facePinsSideY],
  ];
  return Object.freeze({ back, front, trackTop, floorZ, panel, horizon, outline, outlineR, closedY0, closedY1, openY0, openY1, travel, lipSlotY0,
    tanF, boreR, coneR, zBore, zMid, midR, outerR, railXs, lensY, pinXY });
})();

const roundedRectZ = (x, y, z, w, d, h, r) => rbox(x, y, z, x + w, y + d, z + h, r);

export function buildFace() {
  const F = FACE;
  const [fx0, fy0, fx1, fy1] = F.outline;
  const solids = [], cuts = [];
  // The plate, its edge a quarter round: a hull of insetting slices on a
  // quarter circle, every slice face up-and-out in print. Nothing below F.back.
  {
    const R = P.faceEdgeR, n = 8, slices = [];
    for (let k = 0; k <= n; k++) {
      const th = (Math.PI / 2) * (k / n);
      const ins = R * (1 - Math.cos(th));
      const z = Math.min(F.front - 0.01, F.front - R * (1 - Math.sin(th)));
      slices.push(roundedRectZ(fx0 + ins, fy0 + ins, z, fx1 - fx0 - 2 * ins, fy1 - fy0 - 2 * ins, 0.01, Math.max(0.5, F.outlineR - ins)));
    }
    slices.push(roundedRectZ(fx0, fy0, F.back, fx1 - fx0, fy1 - fy0, 0.01, F.outlineR));
    solids.push(Manifold.hull(slices));
  }
  // Blind holes in the back for the six filament pins in the walls' ends.
  for (const [px, py] of F.pinXY) cuts.push(cylZ(px, py, F.back - 1, P.facePinD / 2, P.facePinFace + 1, 24));
  // The horizon: edge to edge, open at both ends through the round.
  cuts.push(box(fx0 - 2, F.horizon[0], F.trackTop, fx1 + 2, F.horizon[1], F.front + 2));
  // The grip: the horizon's right end, deeper.
  cuts.push(box(P.gripX0, F.horizon[0], F.front - P.gripD, fx1 + 2, F.horizon[1], F.front + 2));
  // The recessed panel: the cover's track, cut below the groove's floor.
  const [p0x, p0y, p1x, p1y] = F.panel;
  cuts.push(roundedRectZ(p0x, p0y, F.floorZ, p1x - p0x, p1y - p0y, F.trackTop - F.floorZ + 0.01, P.sliderCornerR + P.sliderClr));
  // The cover's entry gap, through the plate below the track.
  const gapY0 = fy0 + P.faceEdgeR - 0.6;
  const gapCut = cube(p0x, gapY0 - 1.0, F.floorZ, p1x - p0x, p0y - (gapY0 - 1.0), F.front - F.floorZ + 2);
  // The lip's slot through the roof: from the stowed lip's foot up into the horizon.
  const lw0 = P.coverLip[0] + 2 * P.lipSlotClear;
  cuts.push(box((p0x + p1x) / 2 - lw0 / 2, F.lipSlotY0, F.trackTop - 0.01, (p0x + p1x) / 2 + lw0 / 2, F.horizon[0] + 0.5, F.front + 2));
  // The keeper: the block in the gap, less keeperClr on its fitted sides, the
  // track's stop, flush with the face's front; glued in once the cover is in.
  const keeper = status("keeper", cube(p0x + P.keeperClr, gapY0 + 0.3, F.floorZ, p1x - p0x - 2 * P.keeperClr, (p0y - P.keeperClr) - (gapY0 + 0.3), F.front - F.floorZ));
  cuts.push(gapCut);
  // Lens cells: bore, then two stepped cones opening forward.
  for (const lx of P.cameraXs) {
    cuts.push(cylZ(lx, F.lensY, F.back - 1, F.boreR, F.zBore - F.back + 1));
    cuts.push(coneZ(lx, F.lensY, F.zBore - 0.01, F.boreR, F.midR, F.zMid - F.zBore + 0.01));
    cuts.push(coneZ(lx, F.lensY, F.zMid - 0.01, F.midR, F.outerR, F.floorZ - F.zMid + 0.02));
  }
  // Track floor relief: the cover rides on two lands.
  {
    const band = cube(p0x + P.sliderBevel + 0.5, p0y + 1.0, F.floorZ - 0.01, (p1x - p0x) - 2 * (P.sliderBevel + 0.5), (p1y - p0y) - 2.0, P.coverRailProud + 0.01);
    const lands = fuse(F.railXs.map((rx) => cube(rx - P.coverRailW / 2, p0y - 2, F.floorZ - 0.02, P.coverRailW, (p1y - p0y) + 4, P.coverRailProud + 0.04)));
    cuts.push(band.subtract(lands));
  }
  // Dovetail lips on both X walls and two detent pairs, added AFTER the cuts.
  const lipTop = F.trackTop + 0.02, lipLen = p1y - p0y - 0.4;
  const adds = [
    prismY(p0y + 0.2, lipLen, [p0x - 0.01, lipTop], [p0x + P.sliderBevel, lipTop], [p0x - 0.01, lipTop - P.sliderLipZ]),
    prismY(p0y + 0.2, lipLen, [p1x + 0.01, lipTop], [p1x - P.sliderBevel, lipTop], [p1x + 0.01, lipTop - P.sliderLipZ]),
  ];
  const bumpSink = P.sliderBumpR - (P.sliderClr + P.sliderBumpBite);
  for (const holdY of [F.closedY0 + P.sliderCornerR + 0.5, F.openY1 - P.sliderCornerR - 0.5]) {
    adds.push(cylZ(p0x - bumpSink, holdY, F.floorZ - 0.01, P.sliderBumpR, P.sliderBumpH + 0.01, 32));
    adds.push(cylZ(p1x + bumpSink, holdY, F.floorZ - 0.01, P.sliderBumpR, P.sliderBumpH + 0.01, 32));
  }
  const faceCut = status("face: plate less cuts", status("face: plate", fuse(solids)).subtract(status("face: cuts", fuse(cuts))));
  const face = status("face", status("face: with lips", faceCut.add(status("face: lips and bumps", fuse(adds)))).simplify(1e-3));

  // ---- The cover, built closed ------------------------------------------------
  const sx0 = p0x + P.sliderClr, sx1 = p1x - P.sliderClr;
  const sy0 = F.closedY0, sy1 = F.closedY1;
  const sBack = F.floorZ, sFront = sBack + P.sliderT;
  const cr = P.sliderCornerR;
  const plateC = Manifold.hull([
    roundedRectZ(sx0, sy0, sBack, sx1 - sx0, sy1 - sy0, 0.01, cr),
    roundedRectZ(sx0, sy0, sFront - P.sliderBevel - 0.01, sx1 - sx0, sy1 - sy0, 0.01, cr),
    roundedRectZ(sx0 + P.sliderBevel, sy0, sFront - 0.01, sx1 - sx0 - 2 * P.sliderBevel, sy1 - sy0, 0.01, Math.max(0.3, cr - P.sliderBevel / 2)),
  ]);
  const [lw, lh] = P.coverLip;
  const lip = roundedRectZ((sx0 + sx1) / 2 - lw / 2, sy1 - lh, sFront - 0.4, lw, lh, P.coverLipProud + 0.4, 0.6);
  // The brand's wordmark, raised off the bar, under the lip.
  const ms = P.markW / MAKER.widthMm, mw = P.markW, mh = MAKER.heightMm * ms;
  const bandY0 = sy0 + 1.0, bandY1 = sy1 - lh - 0.8;
  const markY = bandY0 + (bandY1 - bandY0 - mh) / 2;
  const cs = new CrossSection(MAKER.polygons, "EvenOdd").scale([ms, ms]).translate([(sx0 + sx1) / 2 - mw / 2, markY]);
  const mark = (cs.area() > 0 ? cs : new CrossSection(MAKER.polygons.map((p) => p.slice().reverse()), "EvenOdd").scale([ms, ms]).translate([(sx0 + sx1) / 2 - mw / 2, markY]))
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
  return { face, cover, keeper, markBox: { x: (sx0 + sx1) / 2 - mw / 2, y: markY, w: mw, h: mh }, roofBridge: (p1x - p0x) * (F.lipSlotY0 - p0y) + ((p1x - p0x) - lw0) * (F.horizon[0] - F.lipSlotY0) };
}
