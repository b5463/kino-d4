"""Move one footprint to the nearest spot clear of courtyards, copper and holes.

Usage: python free_spot.py REF X Y [RADIUS_MM] [ANGLE_DEG]   (X, Y in carrier coordinates, mm)
Only the named footprint moves. Copper on its own nets is ignored because it is rerouted.
Through-hole parts are also checked against the far side and inner-layer copper.
"""
import sys, math
import pcbnew as pcb
from rework import TARGET
from routing import pt

ref, tx, ty = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
radius = float(sys.argv[4]) if len(sys.argv) > 4 else 8.0
angle = float(sys.argv[5]) if len(sys.argv) > 5 else None

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())          # read first: this SWIG build fails if read after pad lists
fs = {f.GetReference(): f for f in b.GetFootprints()}
me = fs[ref]; back = me.IsFlipped()
if angle is not None: me.SetOrientationDegrees(angle)
cu = pcb.B_Cu if back else pcb.F_Cu
own = {p.GetNetname() for p in me.Pads()}
my_tht = any(p.GetAttribute() == pcb.PAD_ATTRIB_PTH for p in me.Pads())
MARGIN = pcb.FromMM(0.25)

def box(item):
    bb = item.GetBoundingBox(); bb.Inflate(MARGIN); return bb

def courtyard(f, layer):
    cy = f.GetCourtyard(layer)
    return cy.BBox() if cy.OutlineCount() else f.GetBoundingBox(False)

near, far = [], []          # obstacles on my side / for my through pins only
for f in b.GetFootprints():
    if f.GetReference() == ref: continue   # SWIG returns a new proxy per lookup; compare by name
    holes = [p for p in f.Pads() if p.GetAttribute() in (pcb.PAD_ATTRIB_PTH, pcb.PAD_ATTRIB_NPTH)]
    if f.IsFlipped() == back:
        near.append(courtyard(f, pcb.B_CrtYd if back else pcb.F_CrtYd))
    else:
        near += [box(p) for p in holes]
        far.append(courtyard(f, pcb.F_CrtYd if back else pcb.B_CrtYd))
for t in tracks:
    if t.GetNetname() in own: continue
    if isinstance(t, pcb.PCB_VIA) or t.GetLayer() == cu: near.append(box(t))
    else: far.append(box(t))
outline = b.GetBoardEdgesBoundingBox(); outline.Inflate(-pcb.FromMM(0.8))

def fits(x, y):
    me.SetPosition(pt(50 + x, 50 + y))
    mb = courtyard(me, pcb.B_CrtYd if back else pcb.F_CrtYd)
    if not outline.Contains(mb): return False
    if any(mb.Intersects(o) for o in near): return False
    if my_tht:
        for p in me.Pads():
            if p.GetAttribute() == pcb.PAD_ATTRIB_PTH and any(box(p).Intersects(o) for o in far): return False
    return True

best = None
steps = int(radius / 0.25)
for i in range(-steps, steps + 1):
    for j in range(-steps, steps + 1):
        x, y = tx + i * 0.25, ty + j * 0.25
        d = math.hypot(x - tx, y - ty)
        if d > radius or (best and d >= best[0]): continue
        if fits(x, y): best = (d, x, y)
if not best: sys.exit(f'{ref}: no clear spot within {radius} mm')
me.SetPosition(pt(50 + best[1], 50 + best[2]))
pcb.SaveBoard(str(TARGET), b)
print(f'{ref} -> ({best[1]:.2f}, {best[2]:.2f}) at {me.GetOrientationDegrees():.0f} deg, {best[0]:.2f} mm from target')
