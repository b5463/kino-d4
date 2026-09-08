from pathlib import Path
import math, struct, sys
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
STL = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else HERE / "PROVISIONAL_kino_skeleton_rig.stl"
OUT = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else HERE / "PROVISIONAL_kino_skeleton_rig_iso.png"

raw = STL.read_bytes()
count = struct.unpack_from("<I", raw, 80)[0]
triangles = []
offset = 84
for _ in range(count):
    values = struct.unpack_from("<12fH", raw, offset)
    triangles.append([values[3:6], values[6:9], values[9:12]])
    offset += 50

all_points = [p for triangle in triangles for p in triangle]
centre = [(min(p[i] for p in all_points) + max(p[i] for p in all_points))/2 for i in range(3)]
yaw_degrees = float(sys.argv[3]) if len(sys.argv) > 3 else -38
pitch_degrees = float(sys.argv[4]) if len(sys.argv) > 4 else 23
yaw, pitch = math.radians(yaw_degrees), math.radians(pitch_degrees)

def transform(p):
    x, y, z = (p[i]-centre[i] for i in range(3))
    x1 = x*math.cos(yaw) + z*math.sin(yaw)
    z1 = -x*math.sin(yaw) + z*math.cos(yaw)
    y2 = y*math.cos(pitch) - z1*math.sin(pitch)
    z2 = y*math.sin(pitch) + z1*math.cos(pitch)
    # World +X maps to screen RIGHT and the culling below draws the faces whose
    # normals point at a viewer on the +Z side. Those two choices together are
    # what make this a TRUE view - a slicer's top view of a print-frame STL. The
    # renderer used to draw the faces pointing AWAY from that viewer with the
    # same X mapping, which is a mirror image; lettering was judged against it
    # and flipped the wrong way once. Negating X as well was tried and is also a
    # mirror (of the other side). One flip, not two.
    return x1, -y2, z2

projected = [[transform(p) for p in triangle] for triangle in triangles]
xs=[p[0] for t in projected for p in t]; ys=[p[1] for t in projected for p in t]
canvas=(1600,1100); margin=80
scale=min((canvas[0]-2*margin)/(max(xs)-min(xs)),(canvas[1]-2*margin)/(max(ys)-min(ys)))
ox=(canvas[0]-(min(xs)+max(xs))*scale)/2
oy=(canvas[1]-(min(ys)+max(ys))*scale)/2

def screen(p): return (p[0]*scale+ox,p[1]*scale+oy)
# A raking key light with a wide value range. A near-axial light left every
# forward-facing surface at the same grey, so relief that is actually there -
# the grip drum's curve, the lens bar's steps - rendered as a flat slab and the
# renders were useless for judging outside shape.
# Outward faces of a closed mesh have a POSITIVE view-space normal Z here (see
# the culling note below - screen X is negated, which flipped the winding), so
# the key's Z must be positive to light the side facing the camera rather than
# the far side of the part.
KEY=(-.50,-.45,.74)
def shade(t):
    a,b,c=t
    u=[b[i]-a[i] for i in range(3)]; v=[c[i]-a[i] for i in range(3)]
    n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
    length=math.sqrt(sum(q*q for q in n)) or 1
    # Negated: transform() flips screen Y, which mirrors the frame and flips
    # every winding, so the raw cross product of an outward face points AWAY
    # from the viewer. After this, faces toward the viewer have unit[2] > 0.
    unit=[-q/length for q in n]
    key=max(0.0,sum(unit[i]*KEY[i] for i in range(3)))
    fill=max(0.0,unit[2])          # soft frontal fill so nothing goes solid black
    value=int(46+132*key+62*fill)
    value=max(0,min(255,value))
    return (value-12,value,value+8,255)

def view_normal_z(t):
    a,b,c=t
    u=[b[i]-a[i] for i in range(3)]; v=[c[i]-a[i] for i in range(3)]
    return u[0]*v[1]-u[1]*v[0]

# Backface culling. The viewer sits on +z2 and the projection negates screen Y
# only, which mirrors the frame: a triangle whose outward normal points at the
# viewer winds CLOCKWISE in screen coordinates, so its 2-D cross product is
# NEGATIVE. Keep those; drop the positive ones, which face away. The previous
# version kept the positive ones - the far side of every part - and the painter
# below then drew nearest-first so the far side won: a 2 mm cover rendered as
# its own back, serial engraving mirrored. Pass 0 as the 5th argument to
# disable culling.
cull = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0

image=Image.new("RGBA",canvas,(246,249,251,255)); draw=ImageDraw.Draw(image)
# Painter's algorithm: FAR faces first (smallest z2), near faces last.
for source, view in sorted(zip(triangles,projected),key=lambda item:sum(p[2] for p in item[1])/3):
    if cull and view_normal_z(view)*cull >= 0: continue
    pts=[screen(p) for p in view]
    draw.polygon(pts,fill=shade(view))

draw.rounded_rectangle((25,25,825,105),18,fill=(255,255,255,230),outline=(43,58,68,180),width=2)
# ASCII only: the default PIL bitmap font has no em dash or bullet and draws
# them as empty boxes, which looked like render corruption.
draw.text((50,42),"KINO - FIELD BODY / P4 + FOUR-CAMERA WIGGLE CAMERA",fill=(25,36,44,255),stroke_width=0)
draw.text((50,72),"support-free print | 22 mm lens centres | socketed P4 | 78-degree clear cells | 131 x 90 x 65",fill=(67,84,94,255))
image.convert("RGB").resize((1200,825),Image.Resampling.LANCZOS).save(OUT,quality=95)
print(OUT)
