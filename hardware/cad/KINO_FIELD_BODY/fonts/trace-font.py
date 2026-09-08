# Trace a TrueType typeface into vector glyph outlines for the engraved
# identity marks (revision and serial), the same way brand/trace-mark.py traces
# the wordmark: render each glyph large, take the ink's boundary edges, smooth
# them, simplify, and write closed polygons. The generator lays text out from
# this file at build time; no font software ships in the repository, only the
# traced outlines, under the font's own licence.
#
#   python trace-font.py [font.ttf] [out.json]
#
# Default: Roboto Regular (Apache-2.0, Christian Robertson / Google) from the
# Windows font folder. Units: cap height = 1.0 (measured on "H"), x to the
# reader's right, y up, glyph origin at the pen position on the baseline;
# advance is the font's own, in the same units.
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FONT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("C:/Windows/Fonts/Roboto-Regular.ttf")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "roboto-regular.json"
CHARS = " 0123456789.#·-/:ABCDEFGHIJKLMNOPQRSTUVWXYZ"   # the space carries only its advance
SIZE = 400                 # px per em when rendering
SMOOTH_PX = 3              # moving-average half-window; ~0.005 mm at a 3.8 mm cap
SIMPLIFY_CAP = 0.0025      # Douglas-Peucker tolerance in cap-height units (0.01 mm at 3.8)

font = ImageFont.truetype(str(FONT), SIZE)
# Cap height from "H": PIL's bbox is (left, top, right, bottom) with y down
# from the ascender line, so cap = bottom - top.
hb = font.getbbox("H")
cap_px = hb[3] - hb[1]
baseline_px = hb[3]        # y (down) of the baseline in the rendered image frame

def get(ink, W, H, x, y):
    return ink[y][x] if 0 <= x < W and 0 <= y < H else 0

def trace(ink, W, H):
    edges = {}
    for y in range(H):
        for x in range(W):
            if not ink[y][x]:
                continue
            if not get(ink, W, H, x, y - 1): edges[(x, y)] = (x + 1, y)
            if not get(ink, W, H, x + 1, y): edges[(x + 1, y)] = (x + 1, y + 1)
            if not get(ink, W, H, x, y + 1): edges[(x + 1, y + 1)] = (x, y + 1)
            if not get(ink, W, H, x - 1, y): edges[(x, y + 1)] = (x, y)
    loops = []
    while edges:
        start, cur = next(iter(edges.items()))
        del edges[start]
        loop = [start]
        while cur != start:
            loop.append(cur)
            cur = edges.pop(cur)
        loops.append(loop)
    return loops

def dp(points, eps):
    if len(points) < 3:
        return points
    (x0, y0), (x1, y1) = points[0], points[-1]
    dx, dy = x1 - x0, y1 - y0
    norm = (dx * dx + dy * dy) ** 0.5 or 1.0
    imax, dmax = 0, -1.0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        d = abs(dy * (px - x0) - dx * (py - y0)) / norm
        if d > dmax:
            imax, dmax = i, d
    if dmax > eps:
        return dp(points[: imax + 1], eps)[:-1] + dp(points[imax:], eps)
    return [points[0], points[-1]]

def simplify_closed(loop, eps):
    a = 0
    b = max(range(len(loop)), key=lambda i: (loop[i][0] - loop[a][0]) ** 2 + (loop[i][1] - loop[a][1]) ** 2)
    pts = dp(loop[a: b + 1], eps)[:-1] + dp(loop[b:] + loop[: a + 1], eps)[:-1]
    return pts if len(pts) >= 3 else None

def smooth_closed(loop, k):
    n = len(loop)
    if n < 4 * k + 4:
        return None
    out = []
    for i in range(n):
        sx = sy = 0.0
        for j in range(-k, k + 1):
            x, y = loop[(i + j) % n]
            sx += x; sy += y
        out.append((sx / (2 * k + 1), sy / (2 * k + 1)))
    return out

glyphs = {}
for ch in CHARS:
    adv = font.getlength(ch)
    bb = font.getbbox(ch)
    if bb is None or bb[2] <= bb[0]:
        glyphs[ch] = {"adv": round(adv / cap_px, 5), "polygons": []}
        continue
    pad = 4
    W = bb[2] - bb[0] + 2 * pad
    H = bb[3] - bb[1] + 2 * pad
    im = Image.new("L", (W, H), 0)
    ImageDraw.Draw(im).text((pad - bb[0], pad - bb[1]), ch, font=font, fill=255)
    px = im.load()
    ink = [[1 if px[x, y] >= 128 else 0 for x in range(W)] for y in range(H)]
    loops = trace(ink, W, H)
    eps_px = SIMPLIFY_CAP * cap_px
    polys = []
    for loop in loops:
        s = smooth_closed(loop, SMOOTH_PX)
        if not s:
            continue
        p = simplify_closed(s, eps_px)
        if p:
            # Back to glyph space: x from the pen position, y up from the baseline.
            polys.append([[round((x - pad + bb[0]) / cap_px, 5), round((baseline_px - (y - pad + bb[1])) / cap_px, 5)] for x, y in p])
    glyphs[ch] = {"adv": round(adv / cap_px, 5), "polygons": polys}

data = {
    "font": FONT.name,
    "family": "Roboto Regular",
    "license": "Apache-2.0",
    "copyright": "Copyright 2011 Google Inc. All Rights Reserved. (Roboto, by Christian Robertson)",
    "units": "cap height = 1.0; x right, y up from the baseline; advance in the same units",
    "renderPxPerEm": SIZE,
    "capPx": cap_px,
    "smoothPx": SMOOTH_PX,
    "simplifyCap": SIMPLIFY_CAP,
    "glyphs": glyphs,
}
OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
n_poly = sum(len(g["polygons"]) for g in glyphs.values())
n_vert = sum(len(p) for g in glyphs.values() for p in g["polygons"])
print(f"{FONT.name}: {len(glyphs)} glyphs, {n_poly} polygons, {n_vert} vertices; cap {cap_px} px at {SIZE} px/em")
print(OUT)
