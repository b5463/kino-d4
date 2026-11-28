# Glyph outlines for the part IDs: DejaVu Sans Bold, the font matplotlib
# ships, so every machine draws the same letters. The generator calls this
# per string and extrudes the polygons; nothing is cached in the repository.
#
#   python -I text-outline.py "A01" 5.0      (text, cap height in mm)
#
# Prints JSON: polygons (outer rings and holes, even-odd), the glyph box's
# lower-left (x0, y0) and its width and height, all in mm at that cap height.
import json, sys
from matplotlib.font_manager import FontProperties
from matplotlib.textpath import TextPath

text, cap = sys.argv[1], float(sys.argv[2])
font = FontProperties(family="DejaVu Sans", weight="bold")
ref = TextPath((0, 0), "H", size=100, prop=font).get_extents()
s = cap / ref.height
path = TextPath((0, 0), text, size=100, prop=font)
polygons = []
for poly in path.to_polygons():
    pts = [[round(x * s, 4), round(y * s, 4)] for x, y in poly]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) >= 3:
        polygons.append(pts)
box = path.get_extents()
print(json.dumps({
    "polygons": polygons,
    "x0": round(box.x0 * s, 4), "y0": round(box.y0 * s, 4),
    "widthMm": round(box.width * s, 4), "heightMm": round(box.height * s, 4),
}))
