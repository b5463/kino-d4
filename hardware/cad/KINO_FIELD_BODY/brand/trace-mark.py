# Trace the KINO D4 wordmark into VECTOR outlines for the raised mark on the
# lens cover, from the reserved brand raster. Output is a JSON the generator
# reads at build time: closed polygons in millimetres (outer boundaries and
# holes, even-odd fill), plus a coarse pixel grid whose left/right ink balance
# the direction gates compare against.
#
#   python trace-mark.py [width_mm] [px_mm] [threshold] [preview.png]
#
# Defaults: 80 mm wide, traced at 0.0175 mm per pixel - the raster upsampled
# four times with bicubic filtering, so its anti-aliased edges land between the
# source pixels instead of on them - then each contour is smoothed with a
# 9-point moving average (0.16 mm window: it flattens the 0.0175 mm staircase
# and rounds a sharp corner by about 0.05 mm, under the nozzle's resolution)
# and simplified to 0.01 mm. The first pass traced the raster's own pixel edges
# at 0.07 mm and simplified to 0.05: that put 0.9 mm straight chords on the
# round letters and the mark still looked faceted in the slicer.
# Coordinates: x to the reader's RIGHT, y UP, origin at the mark's bottom-left.
# The generator mirrors x into body coordinates.
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
SRC = HERE.parents[3] / "docs" / "assets" / "brand" / "kino-d4-black-on-light.png"
OUT = HERE / "kino-d4-mark.json"

width_mm = float(sys.argv[1]) if len(sys.argv) > 1 else 80.0
px_mm = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0175
threshold = int(sys.argv[3]) if len(sys.argv) > 3 else 128
preview = Path(sys.argv[4]) if len(sys.argv) > 4 else HERE / "kino-d4-mark-preview.png"
SIMPLIFY_MM = 0.01
SMOOTH_PX = 4          # moving-average half-window, in trace pixels

im = Image.open(SRC).convert("L")
ink0 = im.point(lambda v: 255 if v < threshold else 0)
im = im.crop(ink0.getbbox())
W = int(round(width_mm / px_mm))
H = max(1, int(round(im.size[1] * W / im.size[0])))
small = im.resize((W, H), Image.Resampling.BICUBIC if W > im.size[0] else Image.Resampling.BOX)
px = small.load()
ink = [[1 if px[x, y] < threshold else 0 for x in range(W)] for y in range(H)]

# ---- Boundary edges of ink pixels, oriented with ink on the LEFT ------------
# Pixel (x, y) occupies [x, x+1] x [y, y+1] in image space (y down). Each side
# facing a non-ink pixel (or the border) becomes a directed edge; walking the
# edges by their endpoints yields closed loops. Orientation is consistent, so
# outer loops and holes wind opposite ways; even-odd fill makes that moot.
def get(x, y):
    return ink[y][x] if 0 <= x < W and 0 <= y < H else 0

edges = {}  # start point -> end point
for y in range(H):
    for x in range(W):
        if not ink[y][x]:
            continue
        if not get(x, y - 1): edges[(x, y)] = (x + 1, y)          # top: left->right
        if not get(x + 1, y): edges[(x + 1, y)] = (x + 1, y + 1)  # right: down
        if not get(x, y + 1): edges[(x + 1, y + 1)] = (x, y + 1)  # bottom: right->left
        if not get(x - 1, y): edges[(x, y + 1)] = (x, y)          # left: up

loops = []
while edges:
    start, cur = next(iter(edges.items()))
    del edges[start]
    loop = [start]
    while cur != start:
        loop.append(cur)
        nxt = edges.pop(cur)
        cur = nxt
    loops.append(loop)

# ---- Douglas-Peucker on closed loops, tolerance in pixels ------------------
def dp(points, eps):
    if len(points) < 3:
        return points
    (x0, y0), (x1, y1) = points[0], points[-1]
    dx, dy = x1 - x0, y1 - y0
    norm = (dx * dx + dy * dy) ** 0.5 or 1.0
    imax, dmax = 0, -1.0
    for i in range(1, len(points) - 1):
        px_, py_ = points[i]
        d = abs(dy * (px_ - x0) - dx * (py_ - y0)) / norm
        if d > dmax:
            imax, dmax = i, d
    if dmax > eps:
        return dp(points[: imax + 1], eps)[:-1] + dp(points[imax:], eps)
    return [points[0], points[-1]]

def simplify_closed(loop, eps):
    # Split at the two points farthest apart so DP sees two open runs.
    a = 0
    b = max(range(len(loop)), key=lambda i: (loop[i][0] - loop[a][0]) ** 2 + (loop[i][1] - loop[a][1]) ** 2)
    run1 = dp(loop[a: b + 1], eps)
    run2 = dp(loop[b:] + loop[: a + 1], eps)
    pts = run1[:-1] + run2[:-1]
    return pts if len(pts) >= 3 else None

def smooth_closed(loop, k):
    # Circular moving average over 2k+1 points. Loops shorter than the window
    # (specks) are dropped.
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

eps_px = SIMPLIFY_MM / px_mm
smoothed = [s for s in (smooth_closed(l, SMOOTH_PX) for l in loops) if s]
polys = [p for p in (simplify_closed(l, eps_px) for l in smoothed) if p]
# To millimetres, y up, origin bottom-left.
polygons = [[[round(x * px_mm, 4), round((H - y) * px_mm, 4)] for (x, y) in p] for p in polys]

# ---- Coarse grid for the direction gates ------------------------------------
coarse_cell = 0.45
cw = int(round(width_mm / coarse_cell)); ch = max(1, int(round(H * px_mm / coarse_cell)))
cs = im.resize((cw, ch), Image.Resampling.BOX); cp = cs.load()
rows = ["".join("1" if cp[x, y] < threshold else "0" for x in range(cw)) for y in range(ch)]
third = cw // 3
left = sum(r[:third].count("1") for r in rows)
right = sum(r[-third:].count("1") for r in rows)

data = {
    "source": "docs/assets/brand/kino-d4-black-on-light.png",
    "license": "LicenseRef-KINO-Reserved",
    "widthMm": round(W * px_mm, 3),
    "heightMm": round(H * px_mm, 3),
    "tracePxMm": px_mm,
    "simplifyMm": SIMPLIFY_MM,
    "smoothMm": round((2 * SMOOTH_PX + 1) * px_mm, 4),
    "polygons": polygons,
    "polygonCount": len(polygons),
    "vertexCount": sum(len(p) for p in polygons),
    "cellMm": coarse_cell,
    "widthPx": cw,
    "heightPx": ch,
    "inkLeftThird": left,
    "inkRightThird": right,
}
OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")

scale = 12  # px per mm in the preview
pv = Image.new("L", (int(data["widthMm"] * scale) + 8, int(data["heightMm"] * scale) + 8), 235)
d = ImageDraw.Draw(pv)
for p in polygons:
    pts = [(4 + x * scale, 4 + (data["heightMm"] - y) * scale) for x, y in p]
    d.polygon(pts, outline=30)
pv.save(preview)
print(f"{data['widthMm']} x {data['heightMm']} mm, traced at {px_mm} mm/px ({W} x {H}), "
      f"{len(polygons)} polygons, {data['vertexCount']} vertices after {SIMPLIFY_MM} mm simplification; "
      f"coarse ink left/right thirds {left}/{right}")
print(OUT); print(preview)
