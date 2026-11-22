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
// The track is the field body's, restated: dovetail lips on both X walls,
// 0.1 mm a side, drops to open; the detents are a leaf spring in each side
// wall with two bumps the cover's corners ride over (one holds it closed,
// one open, each touching exactly at the stop). The two lips are not the
// same: the left bevel is 1.0 and the right 1.5, so the cover goes in one
// way only (turned round, its 1.0 bevel meets the 1.5 lip and stops). The
// window's bottom rim is the stowed cover's stop and its top rim the
// closed cover's. The cover loads from the face's back before the face
// goes on; the face's own floor closes the track. The face is screwed to
// the shell from inside the cavity: six M2 inserts in its back.
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
  const openY0 = panelY0 + 0.5;
  const travel = closedY0 - openY0;
  const openY1 = openY0 + P.sliderH;
  const inset = P.bandChamfer + P.bandRim;
  const panel = [P.bandX[0] + inset, panelY0, P.bandX[1] - inset, closedY1 + 0.5];
  const horizon = [closedY0 - P.horizonPad, closedY1 + P.horizonPad];
  const tanF = Math.tan(((P.camFovDeg / 2 + P.fovMarginDeg) * Math.PI) / 180);
  const boreR = P.lensBoreD / 2;
  const coneR = (z) => Math.max(boreR, (z - Z.pupil) * tanF);
  const outerR = boreR;                               // plain bores through the floor, with a rim
  const bevel = P.sliderBevel, lipZ = bevel.map((b) => b + P.sliderLipOver);   // left, right
  const insertHoleDepth = P.insertLen + P.insertHoleExtra;
  // The detent leaves and their bumps. One V-notch in each of the cover's
  // flanks, sliderNotchH above its bottom edge. The upper bumps sit where
  // that notch is with the cover closed, the lower bumps where it is with
  // the cover open; so a stop is a bump seated in a notch, not a corner
  // arc. Each leaf's tip is its bump's far edge: the upper leaves root
  // toward the lens row (below their tips), the lower leaves root in the
  // face's bottom band (below their tips too).
  const rB = P.sliderBumpR, L = P.sliderLeafL, sl = P.sliderLeafSlit;
  const bumpClosedY = closedY0 + P.sliderNotchH;
  const bumpOpenY = openY0 + P.sliderNotchH;
  const leafTop = back + P.sliderLeafH;              // the leaf's top; the slit above it to leafTop + slit
  const leaves = [
    { name: "upper", bumpY: bumpClosedY, tipY: bumpClosedY + rB, rootY: bumpClosedY + rB - L, dir: 1 },
    { name: "lower", bumpY: bumpOpenY, tipY: bumpOpenY + rB, rootY: bumpOpenY + rB - L, dir: 1 },
  ].map((l) => Object.freeze({ ...l, y0: l.rootY, y1: l.tipY + sl }));   // y0..y1: the leaf and its tip slit
  return Object.freeze({ back, front, trackTop, floorZ, horizonD, panel, horizon, outline, outlineR, closedY0, closedY1, openY0, openY1, travel,
    tanF, boreR, coneR, outerR, bevel, lipZ, lensY, insertHoleDepth, bumpClosedY, bumpOpenY, leafTop, leaves });
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
  // The detent leaves: in each side wall, two beams sliderLeafT thick from
  // the window's wall outward, sliderLeafH tall from the back, each rooted
  // at its lower end and free to its tip, cut free by slits: its outer
  // side, its tip end, the slit above it (a bridge in print, under skin),
  // and its inner side where it runs past the window into the face's
  // bottom band. The lips skip the leaves' spans.
  const lipTop = F.trackTop + 0.02;
  const [b0, b1] = F.bevel, [l0, l1] = F.lipZ;
  const sl = P.sliderLeafSlit, lt = P.sliderLeafT;
  const leafX = [[p0x, p0x - lt, p0x - lt - sl], [p1x, p1x + lt, p1x + lt + sl]];   // inner face (the window's wall), outer face, the slit's far side; left and right
  for (const [xi, xo, xs] of leafX) {
    const [xa, xb] = xo < xs ? [xo, xs] : [xs, xo];
    const xlo = Math.min(xi, xs) - 0.5, xhi = Math.max(xi, xs) + 0.5;
    const s = xi < xo ? 1 : -1;   // +1: the window lies toward -X of this wall... the inner slit goes from the wall's face back toward the window
    for (const lf of F.leaves) {
      cuts.push(box(xa, lf.rootY, F.back - 1, xb, lf.y1, F.leafTop + sl));                 // the outer slit
      cuts.push(box(xlo, lf.tipY, F.back - 1, xhi, lf.y1, F.leafTop + sl));                 // the tip slit
      cuts.push(box(xlo, lf.rootY, F.leafTop, xhi, lf.y1, F.leafTop + sl));                 // the slit above
      // The inner slit, where the leaf runs below the window's bottom rim
      // (the lower leaves root in the bottom band): from the wall's face
      // toward the window, so the leaf is free there too.
      if (lf.rootY < p0y) cuts.push(box(Math.min(xi, xi - s * sl), lf.rootY, F.back - 1, Math.max(xi, xi - s * sl), p0y + 0.3, F.leafTop + sl));
    }
  }
  // Dovetail lips on both X walls (left 1.0, right 1.5: the key), in runs
  // between the leaves' spans, and one bump on each leaf's window face,
  // added AFTER the cuts.
  const adds = [];
  {
    const runs = [[p0y + 0.2, p1y - 0.2]];
    for (const lf of F.leaves) {
      const [a, b] = [lf.y0 - 0.01, lf.y1 + 0.01];
      for (let i = runs.length - 1; i >= 0; i--) {
        const [y0, y1] = runs[i];
        if (b <= y0 || a >= y1) continue;
        runs.splice(i, 1);
        if (a > y0) runs.push([y0, a]);
        if (b < y1) runs.push([b, y1]);
      }
    }
    for (const [y0, y1] of runs) {
      if (y1 - y0 < 1.0) continue;
      adds.push(prismY(y0, y1 - y0, [p0x - 0.01, lipTop], [p0x + b0, lipTop], [p0x - 0.01, lipTop - l0]));
      adds.push(prismY(y0, y1 - y0, [p1x + 0.01, lipTop], [p1x - b1, lipTop], [p1x + 0.01, lipTop - l1]));
    }
  }
  const bumpIn = P.sliderBumpR - (P.sliderClr + P.sliderBumpReach);   // the bump's centre this far outside the wall's face
  const bumpZ0 = F.floorZ + P.bedChamfer;                              // the cover's flank starts above its back chamfer
  for (const lf of F.leaves) {
    adds.push(cylZ(p0x - bumpIn, lf.bumpY, bumpZ0 - 0.01, P.sliderBumpR, P.sliderBumpH + 0.01, 32));
    adds.push(cylZ(p1x + bumpIn, lf.bumpY, bumpZ0 - 0.01, P.sliderBumpR, P.sliderBumpH + 0.01, 32));
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
  // One V-notch in each flank at sliderNotchH above the bottom edge, its
  // ramps sliderNotchDeg off the edge line, through the flank from the
  // back chamfer to just above the bumps' height: the detents seat here.
  const edgeCuts = [mark];
  // The groove for the rail, in the back (the bed face), open at both ends.
  {
    const gx = (sx0 + sx1) / 2 + P.sliderRailOffset, [gw, gd] = P.sliderGroove;
    edgeCuts.push(box(gx - gw / 2, sy0 - 1, sBack - 1, gx + gw / 2, sy1 + 1, sBack + gd));
  }
  {
    const zc0 = sBack - 0.01, zc1 = sBack + P.bedChamfer + P.sliderBumpH + 0.3;
    const yN = sy0 + P.sliderNotchH, d = P.sliderNotchD, t = Math.tan((P.sliderNotchDeg * Math.PI) / 180);
    for (const [edge, dir] of [[sx0, 1], [sx1, -1]]) {
      const out = edge - dir * 0.6, inn = edge + dir * d, hw = (d + 0.6) / t;   // the ramps continue 0.6 outside the edge line
      const pts = [[out, yN - hw], [out, yN + hw], [inn, yN]];
      const c2 = new CrossSection([pts], "Positive");
      edgeCuts.push((c2.area() > 0 ? c2 : new CrossSection([pts.slice().reverse()], "Positive")).extrude(zc1 - zc0).translate([0, 0, zc0]));
    }
  }
  const cover = status("cover", fuse([plateC, lip]).subtract(fuse(edgeCuts)).simplify(1e-3));
  // The cover turned round in its own plane: the orientation key's probe.
  const [cx, cy] = [(p0x + p1x) / 2, (sy0 + sy1) / 2];
  const coverTurned = cover.rotate([0, 0, 180]).translate([2 * cx, 2 * cy, 0]);
  return { face, cover, coverTurned, lipProud, markBox: { x: markX, y: markY, w: mw, h: mh } };
}
