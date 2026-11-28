# Trace the ODD JOBS wordmark ("odd jobs", the text under the symbol in the
# brand's logo raster) into vector outlines for the raised maker's mark on the
# face. Same method as KINO_FIELD_BODY/brand/trace-mark.py: the raster
# upsampled with bicubic filtering, boundary edges walked into loops, a moving
# average over the staircase, Douglas-Peucker to 0.01 mm. Output is reserved
# brand material, read by face.mjs at build time and never embedded in source.
#
#   python trace-wordmark.py <logo.png> [width_mm] [px_mm] [threshold]
#
# The logo raster carries the symbol above the text. The text is everything
# below the widest row gap with no ink.
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
SRC = Path(sys.argv[1])
OUT = HERE / "odd-jobs-wordmark.json"
PREVIEW = HERE / "odd-jobs-wordmark-preview.png"
width_mm = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0
px_mm = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0175
threshold = int(sys.argv[4]) if len(sys.argv) > 4 else 128
SIMPLIFY_MM = 0.01
SMOOTH_PX = 4

# The logo raster is black on transparent: flatten onto white before reading
# ink, or the alpha is dropped and every pixel is black.
src = Image.open(SRC).convert("RGBA")
flat = Image.new("RGBA", src.size, (255, 255, 255, 255))
flat.alpha_composite(src)
im = flat.convert("L")
ink0 = im.point(lambda v: 255 if v < threshold else 0)
im = im.crop(ink0.getbbox())
# Rows with ink; the longest empty run splits the symbol from the text.
p0 = im.load()
rows = [any(p0[x, y] < threshold for x in range(im.size[0])) for y in range(im.size[1])]
best, run, start = (0, 0, 0), 0, 0
for y, has in enumerate(rows + [True]):
    if not has:
        if run == 0: start = y
        run += 1
    else:
        if run > best[0]: best = (run, start, y)
        run = 0
gap_end = best[2]
im = im.crop((0, gap_end, im.size[0], im.size[1]))
im = im.crop(im.point(lambda v: 255 if v < threshold else 0).getbbox())

W = int(round(width_mm / px_mm))
H = max(1, int(round(im.size[1] * W / im.size[0])))
small = im.resize((W, H), Image.Resampling.BICUBIC if W > im.size[0] else Image.Resampling.BOX)
px = small.load()
ink = [[1 if px[x, y] < threshold else 0 for x in range(W)] for y in range(H)]

def get(x, y):
    return ink[y][x] if 0 <= x < W and 0 <= y < H else 0

edges = {}
for y in range(H):
    for x in range(W):
        if not ink[y][x]:
            continue
        if not get(x, y - 1): edges[(x, y)] = (x + 1, y)
        if not get(x + 1, y): edges[(x + 1, y)] = (x + 1, y + 1)
        if not get(x, y + 1): edges[(x + 1, y + 1)] = (x, y + 1)
        if not get(x - 1, y): edges[(x, y + 1)] = (x, y)
loops = []
while edges:
    start, cur = next(iter(edges.items()))
    del edges[start]
    loop = [start]
    while cur != start:
        loop.append(cur)
        cur = edges.pop(cur)
    loops.append(loop)

def dp(points, eps):
    if len(points) < 3:
        return points
    (x0, y0), (x1, y1) = points[0], points[-1]
    dx, dy = x1 - x0, y1 - y0
    norm = (dx * dx + dy * dy) ** 0.5 or 1.0
    imax, dmax = 0, -1.0
    for i in range(1, len(points) - 1):
        d = abs(dy * (points[i][0] - x0) - dx * (points[i][1] - y0)) / norm
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

eps_px = SIMPLIFY_MM / px_mm
smoothed = [s for s in (smooth_closed(l, SMOOTH_PX) for l in loops) if s]
polys = [p for p in (simplify_closed(l, eps_px) for l in smoothed) if p]
polygons = [[[round(x * px_mm, 4), round((H - y) * px_mm, 4)] for (x, y) in p] for p in polys]
# The thinnest stroke, by the narrowest ink run across any row: the gate
# against one nozzle line reads this.
thin = min((sum(1 for _ in g) for row in ink for k, g in __import__("itertools").groupby(row) if k), default=0) * px_mm
data = {
    "source": SRC.name,
    "license": "LicenseRef-KINO-Reserved",
    "widthMm": round(W * px_mm, 3),
    "heightMm": round(H * px_mm, 3),
    "tracePxMm": px_mm,
    "simplifyMm": SIMPLIFY_MM,
    "thinnestRunMm": round(thin, 3),
    "polygons": polygons,
    "polygonCount": len(polygons),
    "vertexCount": sum(len(p) for p in polygons),
}
OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
scale = 12
pv = Image.new("L", (int(data["widthMm"] * scale) + 8, int(data["heightMm"] * scale) + 8), 235)
d = ImageDraw.Draw(pv)
for p in polygons:
    d.polygon([(4 + x * scale, 4 + (data["heightMm"] - y) * scale) for x, y in p], outline=30)
pv.save(PREVIEW)
print(f"{data['widthMm']} x {data['heightMm']} mm, {len(polygons)} polygons, {data['vertexCount']} vertices, thinnest run {thin:.2f} mm")
