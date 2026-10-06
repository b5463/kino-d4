"""Tidy copper without changing connectivity (ODD JOBS 87/88: coherent, readable routing).

1. Drop zero-length segments.
2. Drop a segment whose whole area (centreline and both edges, 0.05 mm steps) lies inside other
   same-net copper on the same layer: pads, other tracks or vias. Electrically nothing changes.
3. Merge two same-net, same-layer, same-width segments that meet end to end, run collinear, and
   share that point with nothing else (no pad, via or third track there).
Run with KiCad 10 python; then refill, DRC and inspect.
"""
import math
import pcbnew as pcb
from rework import TARGET

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())            # read first: this SWIG build fails if read after pad lists
pads = [p for f in b.GetFootprints() for p in f.Pads()]
segs = [t for t in tracks if not isinstance(t, pcb.PCB_VIA)]
vias = [t for t in tracks if isinstance(t, pcb.PCB_VIA)]
gone = set()
key = lambda t: id(t)

def covered(t):
    layer, net = t.GetLayer(), t.GetNetCode()
    s, e = t.GetStart(), t.GetEnd(); w = t.GetWidth()
    L = math.hypot(e.x - s.x, e.y - s.y)
    if L == 0: return True
    ux, uy = (e.x - s.x) / L, (e.y - s.y) / L
    step = pcb.FromMM(0.05); n = max(2, int(L / step) + 1)
    bb = t.GetBoundingBox()
    near = [o for o in segs if o is not t and key(o) not in gone and o.GetNetCode() == net and o.GetLayer() == layer
            and o.GetBoundingBox().Intersects(bb)]
    near += [v for v in vias if key(v) not in gone and v.GetNetCode() == net and v.GetBoundingBox().Intersects(bb)]
    near += [p for p in pads if p.GetNetCode() == net and p.IsOnLayer(layer) and p.GetBoundingBox().Intersects(bb)]
    if not near: return False
    for i in range(n + 1):
        cxp, cyp = s.x + ux * L * i / n, s.y + uy * L * i / n
        for off in (-w / 2 + 1000, 0, w / 2 - 1000):          # 1 um inside the edge
            q = pcb.VECTOR2I(int(cxp - uy * off), int(cyp + ux * off))
            if not any(o.HitTest(q, 0) for o in near): return False
    return True

removed = 0
for t in segs:
    if t.GetLength() == 0 or covered(t):
        gone.add(key(t)); b.Remove(t); removed += 1

def pt_key(v): return (v.x, v.y)
merged = 0
changed = True
while changed:
    changed = False
    live = [t for t in segs if key(t) not in gone]
    ends = {}
    for t in live:
        for v in (t.GetStart(), t.GetEnd()):
            ends.setdefault((t.GetNetCode(), t.GetLayer(), pt_key(v)), []).append(t)
    for (net, layer, p), ts in ends.items():
        if len(ts) != 2: continue
        a, c = ts
        if a.GetWidth() != c.GetWidth(): continue
        pos = pcb.VECTOR2I(*p)
        if any(v.GetNetCode() == net and v.HitTest(pos, 0) for v in vias if key(v) not in gone): continue
        if any(pd.GetNetCode() == net and pd.IsOnLayer(layer) and pd.HitTest(pos, 0) for pd in pads): continue
        fa = a.GetEnd() if pt_key(a.GetStart()) == p else a.GetStart()
        fc = c.GetEnd() if pt_key(c.GetStart()) == p else c.GetStart()
        v1 = (p[0] - fa.x, p[1] - fa.y); v2 = (fc.x - p[0], fc.y - p[1])
        cross = v1[0] * v2[1] - v1[1] * v2[0]
        n1, n2 = math.hypot(*v1), math.hypot(*v2)
        if n1 == 0 or n2 == 0 or abs(cross) > 1e-6 * n1 * n2 or v1[0] * v2[0] + v1[1] * v2[1] <= 0: continue
        a.SetStart(fa); a.SetEnd(fc)
        gone.add(key(c)); b.Remove(c); merged += 1; changed = True
        break
pcb.SaveBoard(str(TARGET), b)
print('removed', removed, 'covered or empty segments; merged', merged, 'collinear pairs', flush=True)
import os; os._exit(0)
