# Render several STLs in one picture, each in its own colour, so the two-tone
# body can be judged: charcoal shell, cream or cobalt face, pink shutter.
#
#   python render-parts.py out.png yaw pitch stage part.stl:rrggbb [part.stl:rrggbb ...]
#
# stage is "day" (light grey) or "night" (the brand's cobalt). Same true-view
# projection and painter's algorithm as render-stl.py; shading scales the
# part's colour by the key light.
from pathlib import Path
import math, struct, sys
from PIL import Image, ImageDraw

OUT = Path(sys.argv[1]).resolve()
yaw, pitch = math.radians(float(sys.argv[2])), math.radians(float(sys.argv[3]))
stage = sys.argv[4]
parts = []
for arg in sys.argv[5:]:
    path, colour = arg.rsplit(":", 1)
    rgb = tuple(int(colour[i:i + 2], 16) for i in (0, 2, 4))
    raw = Path(path).read_bytes()
    count = struct.unpack_from("<I", raw, 80)[0]
    tris = []
    o = 84
    for _ in range(count):
        v = struct.unpack_from("<12fH", raw, o)
        tris.append([v[3:6], v[6:9], v[9:12]])
        o += 50
    parts.append((tris, rgb))

all_points = [p for tris, _ in parts for t in tris for p in t]
centre = [(min(p[i] for p in all_points) + max(p[i] for p in all_points)) / 2 for i in range(3)]

def transform(p):
    x, y, z = (p[i] - centre[i] for i in range(3))
    x1 = x * math.cos(yaw) + z * math.sin(yaw)
    z1 = -x * math.sin(yaw) + z * math.cos(yaw)
    y2 = y * math.cos(pitch) - z1 * math.sin(pitch)
    z2 = y * math.sin(pitch) + z1 * math.cos(pitch)
    return x1, -y2, z2

# A painter's sort by centroid fails when one triangle spans the whole face
# plate and another is a 2 mm sliver of the cover lying on it: split every
# triangle until no edge is longer than MAX_EDGE, so depth order is local.
MAX_EDGE = 5.0
def split(t):
    a, b, c = t
    edges = [(a, b, c), (b, c, a), (c, a, b)]
    longest = max(edges, key=lambda e: sum((e[0][i] - e[1][i]) ** 2 for i in range(3)))
    p, q, r = longest
    if sum((p[i] - q[i]) ** 2 for i in range(3)) <= MAX_EDGE * MAX_EDGE:
        return [t]
    m = tuple((p[i] + q[i]) / 2 for i in range(3))
    return split((p, m, r)) + split((m, q, r))
faces = []
for tris, rgb in parts:
    for t in tris:
        for s in split(tuple(tuple(p) for p in t)):
            faces.append(([transform(p) for p in s], rgb))
xs = [p[0] for f, _ in faces for p in f]; ys = [p[1] for f, _ in faces for p in f]
canvas = (1600, 1100); margin = 90
scale = min((canvas[0] - 2 * margin) / (max(xs) - min(xs)), (canvas[1] - 2 * margin) / (max(ys) - min(ys)))
ox = (canvas[0] - (min(xs) + max(xs)) * scale) / 2
oy = (canvas[1] - (min(ys) + max(ys)) * scale) / 2
screen = lambda p: (p[0] * scale + ox, p[1] * scale + oy)

KEY = (-.50, -.45, .74)
def shade(t, rgb):
    a, b, c = t
    u = [b[i] - a[i] for i in range(3)]; v = [c[i] - a[i] for i in range(3)]
    n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    length = math.sqrt(sum(q * q for q in n)) or 1
    unit = [-q / length for q in n]
    key = max(0.0, sum(unit[i] * KEY[i] for i in range(3)))
    fill = max(0.0, unit[2])
    k = 0.42 + 0.46 * key + 0.22 * fill
    return tuple(max(0, min(255, int(ch * k))) for ch in rgb) + (255,)

def view_normal_z(t):
    a, b, c = t
    u = [b[i] - a[i] for i in range(3)]; v = [c[i] - a[i] for i in range(3)]
    return u[0] * v[1] - u[1] * v[0]

bg = (232, 234, 236, 255) if stage == "day" else (57, 103, 214, 255)
image = Image.new("RGBA", canvas, bg); draw = ImageDraw.Draw(image)
for view, rgb in sorted(faces, key=lambda item: sum(p[2] for p in item[0]) / 3):
    if view_normal_z(view) >= 0:
        continue
    draw.polygon([screen(p) for p in view], fill=shade(view, rgb))
image.convert("RGB").resize((1200, 825), Image.Resampling.LANCZOS).save(OUT, quality=95)
print(OUT)
