// The face shell, the sliding lens cover and its keeper. Body frame; the face
// sits on the shell's front plate (Z.plateFront) inside the shell's rim, flush
// with it, and grows toward +Z. It prints back-face down, so every piece of
// relief points up in print and the lens cells open upward.
//
// ODD JOBS: the face is the cream (day) or cobalt (night) plate inside the
// charcoal shell. One thing stands proud of it, the lens band, whose recessed
// panel is the cover's track; the finger pad's ribs on the right, where the
// right hand's middle finger wraps the body; the maker's mark "odd jobs"
// raised on the upper deck; two rivet bosses over the upper pin holes.
//
// The track is the field body's, restated: dovetail lips on both walls, two
// detent pairs, the cover entering through a gap in the band's bottom rim that
// a keeper block closes. 0.1 mm a side, drops to open. The cover closed is one
// bar over the four cells; dropped, the four-mark.
import fs from "node:fs";
import { Manifold, CrossSection, cube, box, cylZ, coneZ, fuse, rbox, prismY, status } from "./lib.mjs";
import { P, Z, XY } from "./params.mjs";

const MARK = JSON.parse(fs.readFileSync(new URL("../KINO_FIELD_BODY/brand/kino-d4-mark.json", import.meta.url), "utf8"));
const MAKER = JSON.parse(fs.readFileSync(new URL("./brand/odd-jobs-wordmark.json", import.meta.url), "utf8"));

// ---- Derived figures, read by the builder and the gates ----------------------
export const FACE = (() => {
  const back = Z.plateFront, front = back + P.faceBase;
  const bandFront = front + P.bandProud;
  const floorZ = bandFront - P.panelDepth;
  const inset = P.bandChamfer + P.bandRim;
  const [cx0, cy0, cx1, cy1] = XY.cavity;
  const outline = [cx0 + P.faceClear, cy0 + P.faceClear, cx1 - P.faceClear, cy1 - P.faceClear];
  const outlineR = P.carrierR + P.carrierClear - P.faceClear;
  const lensY = XY.lensY;
  const closedY0 = lensY - P.sliderH / 2, closedY1 = closedY0 + P.sliderH;
  // The band's bottom rim is the face's bottom edge; the cover stows down to it.
  const panelY0 = outline[1] + P.bandBottomInset;
  const openY0 = panelY0 + 0.5;
  const travel = closedY0 - openY0;
  const panel = [P.bandX[0] + inset, panelY0, P.bandX[1] - inset, closedY1 + 0.5];
  const band = [P.bandX[0], outline[1] - 0.01, P.bandX[1], panel[3] + inset];
  const tanF = Math.tan(((P.camFovDeg / 2 + P.fovMarginDeg) * Math.PI) / 180);
  const boreR = P.lensBoreD / 2;
  const coneR = (z) => Math.max(boreR, (z - Z.pupil) * tanF);
  const zBore = Z.pupil + boreR / tanF;
  const zMid = (zBore + floorZ) / 2;
  const midR = coneR(zMid) + P.lensRingStep;
  const outerR = coneR(floorZ) + 2 * P.lensRingStep;
  const railXs = [(panel[0] + panel[2]) / 2 - P.coverRailOffset, (panel[0] + panel[2]) / 2 + P.coverRailOffset];
  return Object.freeze({ back, front, bandFront, floorZ, panel, band, outline, outlineR, closedY0, closedY1, openY0, openY1: openY0 + P.sliderH, travel,
    tanF, boreR, coneR, zBore, zMid, midR, outerR, railXs, lensY });
})();

const roundedRectZ = (x, y, z, w, d, h, r) => rbox(x, y, z, x + w, y + d, z + h, r);
const traced = (data, scale, x, y) => {
  const cs = new CrossSection(data.polygons, "EvenOdd").scale([scale, scale]).translate([x, y]);
  return cs.area() > 0 ? cs : new CrossSection(data.polygons.map((p) => p.slice().reverse()), "EvenOdd").scale([scale, scale]).translate([x, y]);
};

export function buildFace() {
  const F = FACE;
  const [fx0, fy0, fx1, fy1] = F.outline;
  const solids = [], cuts = [];
  // The plate, inside the rim, with a small chamfer on its front edge.
  solids.push(Manifold.hull([
    roundedRectZ(fx0, fy0, F.back, fx1 - fx0, fy1 - fy0, 0.01, F.outlineR),
    roundedRectZ(fx0, fy0, F.front - P.faceChamfer - 0.01, fx1 - fx0, fy1 - fy0, 0.01, F.outlineR),
    roundedRectZ(fx0 + P.faceChamfer, fy0 + P.faceChamfer, F.front - 0.01, fx1 - fx0 - 2 * P.faceChamfer, fy1 - fy0 - 2 * P.faceChamfer, 0.01, Math.max(0.5, F.outlineR - P.faceChamfer)),
  ]));
  // The lens band: proud of the plate, chamfered all round, its bottom at the
  // plate's bottom edge.
  {
    const [x0, y0, x1, y1] = F.band;
    // Rooted below the plate's edge chamfer, or its foot stands 0.3 mm proud
    // of the chamfered bottom edge as a lip facing the bed.
    solids.push(Manifold.hull([
      roundedRectZ(x0, y0, F.front - P.faceChamfer - 0.3, x1 - x0, y1 - y0, 0.01, P.bandR),
      roundedRectZ(x0 + P.bandChamfer, y0 + P.bandChamfer, F.bandFront - 0.01, x1 - x0 - 2 * P.bandChamfer, y1 - y0 - 2 * P.bandChamfer, 0.01, Math.max(0.8, P.bandR - P.bandChamfer)),
    ]));
  }
  // Pin holes in the back; bosses on the upper deck where the plate alone is
  // thinner than the hole is deep.
  for (const [hx, hy] of P.carrierHoles) {
    cuts.push(cylZ(hx, hy, F.back - 1, P.pinFaceD / 2, P.pinFaceL + 1, 32));
    if (hy > P.carrierH / 2) {
      solids.push(cylZ(hx, hy, F.front - 0.3, P.pinBossD / 2, P.pinBossH + 0.3 - P.pinBossChamfer, 48));
      solids.push(coneZ(hx, hy, F.front + P.pinBossH - P.pinBossChamfer - 0.01, P.pinBossD / 2, P.pinBossD / 2 - P.pinBossChamfer, P.pinBossChamfer + 0.01, 48));
    }
  }
  // Finger pad: horizontal ribs, raised, right of the band.
  for (let y = P.fingerPadY[0]; y + P.fingerRibW <= P.fingerPadY[1] + 1e-9; y += P.fingerRibPitch) {
    solids.push(box(P.fingerPadX[0], y, F.front - 0.3, P.fingerPadX[1], y + P.fingerRibW, F.front + P.fingerRibH));
  }
  // The maker's mark, raised on the upper deck.
  const makerScale = P.makerW / MAKER.widthMm;
  solids.push(traced(MAKER, makerScale, P.makerAt[0], P.makerAt[1]).extrude(P.makerProud + 0.3).translate([0, 0, F.front - 0.3]));

  // The recessed panel: the cover's track.
  const [p0x, p0y, p1x, p1y] = F.panel;
  cuts.push(roundedRectZ(p0x, p0y, F.floorZ, p1x - p0x, p1y - p0y, P.panelDepth + 0.01, P.sliderCornerR + P.sliderClr));
  // Rim gap through the band's bottom rim, and the keeper that refills it.
  const gapCut = cube(p0x, F.band[1] - 1.0, F.floorZ, p1x - p0x, p0y - (F.band[1] - 1.0), P.panelDepth + 0.01);
  const keeper = fuse(solids).subtract(fuse(cuts)).intersect(gapCut)
    .intersect(cube(p0x + P.keeperClr, F.band[1] - 2.0, F.floorZ - 2.0, p1x - p0x - 2 * P.keeperClr, (p0y - P.keeperClr) - (F.band[1] - 2.0), P.panelDepth + 3.0))
    .simplify(1e-3);
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
  for (const holdY of [F.closedY0 + P.sliderEdgeCrest / 2, F.openY1 - P.sliderEdgeCrest / 2]) {
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
  const [rw, rh] = P.coverRidge;
  const ridgeY = sy0 + P.coverRidgeGap;
  const ridge = cube((sx0 + sx1) / 2 - rw / 2, ridgeY, sFront - 0.4, rw, rh, P.coverRidgeProud + 0.4);
  const mw = MARK.widthMm * P.markScale, mh = MARK.heightMm * P.markScale;
  const bandY0 = ridgeY + rh + 0.8, bandY1 = sy1 - 1.0;
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
  const cover = status("cover", fuse([plate, ridge, mark]).subtract(fuse(edgeCuts)).simplify(1e-3));
  return { face, cover, keeper: status("keeper", keeper), markBox: { x: (sx0 + sx1) / 2 - mw / 2, y: markY, w: mw, h: mh },
    makerBox: { x: P.makerAt[0], y: P.makerAt[1], w: P.makerW, h: MAKER.heightMm * makerScale } };
}
