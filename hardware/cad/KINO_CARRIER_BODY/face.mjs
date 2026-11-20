// The face shell, the sliding lens cover and the apron. Body frame; the face
// sits on the shell's front plate (Z.plateFront), covers the walls' ends, and
// grows toward +Z. It prints back-face down, so every piece of relief points
// up in print and the lens cells open upward.
//
// ODD JOBS: the face is the cream (day) or cobalt (night) plate over the
// front with a pillow edge. On it: the lens band, a 1 mm rim around the
// cover's track; the grip, a raised pad on the right where the right hand
// lands, with the finger ribs on it. Nothing else.
//
// The track is the field body's, restated: dovetail lips on both walls, two
// detent pairs, 0.1 mm a side, drops to open. The cover enters through a gap
// in the band's bottom rim; the APRON, a fixed plate in the face's colour,
// closes that gap and roofs the stow zone, so closed the front is a bar over
// a door and dropped the cover slides under the door. The cover's lip, on
// its top edge, is what the thumb pushes down; it stops above the apron.
import fs from "node:fs";
import { Manifold, CrossSection, cube, box, cylZ, coneZ, fuse, rbox, prismY, status } from "./lib.mjs";
import { P, Z, XY } from "./params.mjs";

const MARK = JSON.parse(fs.readFileSync(new URL("../KINO_FIELD_BODY/brand/kino-d4-mark.json", import.meta.url), "utf8"));

// ---- Derived figures, read by the builder and the gates ----------------------
export const FACE = (() => {
  const back = Z.plateFront, front = back + P.faceBase;
  const bandFront = front + P.bandProud;
  const floorZ = bandFront - P.panelDepth;
  const inset = P.bandChamfer + P.bandRim;
  const outline = XY.outer;
  const outlineR = P.cornerR;
  const lensY = XY.lensY;
  const closedY0 = lensY - P.sliderH / 2, closedY1 = closedY0 + P.sliderH;
  const panelY0 = outline[1] + P.faceEdgeR + P.bandBottomInset;
  const openY0 = panelY0 + 0.5;
  const travel = closedY0 - openY0;
  const openY1 = openY0 + P.sliderH;
  const panel = [P.bandX[0] + inset, panelY0, P.bandX[1] - inset, closedY1 + 0.5];
  const band = [P.bandX[0], outline[1] + P.faceEdgeR, P.bandX[1], panel[3] + inset];
  const apronTop = openY1 - P.coverLip[1] - P.apronGapBelowBar;   // the stowed lip clears it
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
    [outline[0] + P.wall / 2, P.facePinsSideY], [outline[2] - P.wall / 2, P.facePinsSideY],
  ];
  return Object.freeze({ back, front, bandFront, floorZ, panel, band, outline, outlineR, closedY0, closedY1, openY0, openY1, travel, apronTop,
    tanF, boreR, coneR, zBore, zMid, midR, outerR, railXs, lensY, pinXY });
})();

const roundedRectZ = (x, y, z, w, d, h, r) => rbox(x, y, z, x + w, y + d, z + h, r);

export function buildFace() {
  const F = FACE;
  const [fx0, fy0, fx1, fy1] = F.outline;
  const solids = [], cuts = [];
  // The plate, its edge a quarter round over the full thickness: a hull of
  // insetting slices on a quarter circle, every slice face up-and-out in
  // print. Nothing below F.back.
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
  // The lens band: a rim, chamfered, pill-ended, its bottom at the inner edge
  // of the plate's round.
  {
    const [x0, y0, x1, y1] = F.band;
    solids.push(Manifold.hull([
      roundedRectZ(x0, y0, F.front - 0.3, x1 - x0, y1 - y0, 0.01, P.bandR),
      roundedRectZ(x0 + P.bandChamfer, y0 + P.bandChamfer, F.bandFront - 0.01, x1 - x0 - 2 * P.bandChamfer, y1 - y0 - 2 * P.bandChamfer, 0.01, Math.max(0.8, P.bandR - P.bandChamfer)),
    ]));
  }
  // The grip pad, chamfered, with the finger ribs on it in a pill field.
  {
    const [gx0, gx1] = P.gripX, [gy0, gy1] = P.gripY, c = P.gripChamfer;
    solids.push(Manifold.hull([
      roundedRectZ(gx0, gy0, F.front - 0.3, gx1 - gx0, gy1 - gy0, 0.01, P.gripR),
      roundedRectZ(gx0 + c, gy0 + c, F.front + P.gripProud - 0.01, gx1 - gx0 - 2 * c, gy1 - gy0 - 2 * c, 0.01, Math.max(0.8, P.gripR - c)),
    ]));
    const ribs = [], top = F.front + P.gripProud;
    for (let y = P.fingerPadY[0]; y + P.fingerRibW <= P.fingerPadY[1] + 1e-9; y += P.fingerRibPitch) {
      ribs.push(box(P.fingerPadX[0], y, top - 0.3, P.fingerPadX[1], y + P.fingerRibW, top + P.fingerRibH));
    }
    solids.push(fuse(ribs).intersect(rbox(P.fingerPadX[0], P.fingerPadY[0], top - 1, P.fingerPadX[1], P.fingerPadY[1], top + 2, P.fingerPadR)));
  }
  // Blind holes in the back for the six filament pins in the walls' ends.
  for (const [px, py] of F.pinXY) cuts.push(cylZ(px, py, F.back - 1, P.facePinD / 2, P.facePinFace + 1, 24));

  // The recessed panel: the cover's track, cut into the plate.
  const [p0x, p0y, p1x, p1y] = F.panel;
  cuts.push(roundedRectZ(p0x, p0y, F.floorZ, p1x - p0x, p1y - p0y, P.panelDepth + 0.01, P.sliderCornerR + P.sliderClr));
  // Rim gap through the band's bottom rim: the cover goes in from below.
  const gapCut = cube(p0x, F.band[1] - 1.0, F.floorZ, p1x - p0x, p0y - (F.band[1] - 1.0), P.panelDepth + 0.01);
  // The apron: a block that refills the rim gap (less keeperClr on its fitted
  // sides, the track's stop), a riser, and a plate over the stow zone
  // apronClear in front of the cover, across the band to its chamfer. One
  // part, glued in once the cover is in; printed plate-face down.
  const apronZ0 = F.floorZ + P.sliderT + P.apronClear;
  const keeperY0 = F.band[1] + 0.6, keeperY1 = p0y - P.keeperClr;
  // One footprint for both: the band's flat, inset 1.8 from its outline with
  // the matching corner radius. The keeper block is clipped to it, so printed
  // plate-down nothing of the block hangs past the plate; the slivers of gap
  // it leaves at the band's two bottom corners are inside the entry seam.
  const fi = P.bandChamfer + 0.3;
  const footprint = rbox(F.band[0] + fi, F.band[1] + fi, F.floorZ - 1, F.band[2] - fi, F.band[3] - fi, apronZ0 + P.apronT + 1, Math.max(0.8, P.bandR - fi));
  // The block is clipped 0.05 inside the plate's footprint and runs 0.5 into
  // the plate: coincident curved faces over a 0.01 mm overlap left a
  // zero-area triangle the validator refused.
  const footprintIn = rbox(F.band[0] + fi + 0.05, F.band[1] + fi + 0.05, F.floorZ - 1, F.band[2] - fi - 0.05, F.band[3] - fi - 0.05, apronZ0 + P.apronT + 1, Math.max(0.8, P.bandR - fi - 0.05));
  const keeper = cube(p0x + P.keeperClr, keeperY0, F.floorZ, p1x - p0x - 2 * P.keeperClr, keeperY1 - keeperY0, apronZ0 + 0.5 - F.floorZ).intersect(footprintIn);
  const apronPlate = footprint.intersect(box(F.band[0] - 1, keeperY0, apronZ0, F.band[2] + 1, F.apronTop, apronZ0 + P.apronT));
  const apron = status("apron", fuse([keeper, apronPlate]).simplify(1e-5));
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
  const lipTop = F.bandFront + 0.02, lipLen = p1y - p0y - 0.4;
  const adds = [
    prismY(p0y + 0.2, lipLen, [p0x - 0.01, lipTop], [p0x + P.sliderBevel, lipTop], [p0x - 0.01, lipTop - P.sliderLipZ]),
    prismY(p0y + 0.2, lipLen, [p1x + 0.01, lipTop], [p1x - P.sliderBevel, lipTop], [p1x + 0.01, lipTop - P.sliderLipZ]),
  ];
  const bumpSink = P.sliderBumpR - (P.sliderClr + P.sliderBumpBite);
  // Each pair sits past the cover's corner round, on the straight part of a crest.
  for (const holdY of [F.closedY0 + P.sliderCornerR + 0.5, F.openY1 - P.sliderCornerR - 0.5]) {
    adds.push(cylZ(p0x - bumpSink, holdY, F.floorZ - 0.01, P.sliderBumpR, P.sliderBumpH + 0.01, 32));
    adds.push(cylZ(p1x + bumpSink, holdY, F.floorZ - 0.01, P.sliderBumpR, P.sliderBumpH + 0.01, 32));
  }
  const face = status("face", fuse(solids).subtract(fuse(cuts)).add(fuse(adds)).simplify(1e-3));

  // ---- The cover, built closed ------------------------------------------------
  const sx0 = p0x + P.sliderClr, sx1 = p1x - P.sliderClr;
  const sy0 = F.closedY0, sy1 = F.closedY1;
  const sBack = F.floorZ, sFront = sBack + P.sliderT;
  const cr = P.sliderCornerR;
  const plate = Manifold.hull([
    roundedRectZ(sx0, sy0, sBack, sx1 - sx0, sy1 - sy0, 0.01, cr),
    roundedRectZ(sx0, sy0, sFront - P.sliderBevel - 0.01, sx1 - sx0, sy1 - sy0, 0.01, cr),
    roundedRectZ(sx0 + P.sliderBevel, sy0, sFront - 0.01, sx1 - sx0 - 2 * P.sliderBevel, sy1 - sy0, 0.01, Math.max(0.3, cr - P.sliderBevel / 2)),
  ]);
  // The lip on the cover's top edge; the thumb pushes down on its top face.
  const [lw, lh] = P.coverLip;
  const lip = roundedRectZ((sx0 + sx1) / 2 - lw / 2, sy1 - lh, sFront - 0.4, lw, lh, P.coverLipProud + 0.4, 1.0);
  // The wordmark, raised off the cover's front, under the lip.
  const mw = MARK.widthMm * P.markScale, mh = MARK.heightMm * P.markScale;
  const bandY0 = sy0 + 1.0, bandY1 = sy1 - lh - 0.8;
  const markY = bandY0 + (bandY1 - bandY0 - mh) / 2;
  const mark = new CrossSection(MARK.polygons, "EvenOdd").scale([P.markScale, P.markScale])
    .translate([(sx0 + sx1) / 2 - mw / 2, markY]).extrude(P.markProud + 0.4).translate([0, 0, sFront - 0.4]);
  // Side-edge relief between crests at each end, one hexagon per edge.
  const edgeCuts = [];
  {
    const zc0 = sBack - 0.01, zc1 = sFront - P.sliderBevel + 0.01;
    const y0 = sy0 + P.sliderEdgeCrest, y1 = sy1 - P.sliderEdgeCrest, r = P.sliderEdgeRamp;
    for (const [edge, dir] of [[sx0, 1], [sx1, -1]]) {
      const out = edge - dir * 1.0, inn = edge + dir * P.sliderEdgeRelief;
      const pts = [[out, y0 - r], [edge, y0 - r], [inn, y0], [inn, y1], [edge, y1 + r], [out, y1 + r]];
      const cs = new CrossSection([pts], "Positive");
      edgeCuts.push((cs.area() > 0 ? cs : new CrossSection([pts.slice().reverse()], "Positive")).extrude(zc1 - zc0).translate([0, 0, zc0]));
    }
  }
  const cover = status("cover", fuse([plate, lip, mark]).subtract(fuse(edgeCuts)).simplify(1e-3));
  return { face, cover, apron, markBox: { x: (sx0 + sx1) / 2 - mw / 2, y: markY, w: mw, h: mh }, apronZ: [apronZ0, apronZ0 + P.apronT] };
}
