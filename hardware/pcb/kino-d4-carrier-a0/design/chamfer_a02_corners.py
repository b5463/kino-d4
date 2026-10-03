"""Chamfer the right-angle bends routing_audit.py reports on A0.2, locked copper included (KiCad 10 python). ODD JOBS 87/88.

tidy_routes.py leaves locked copper (the hand-route and power scripts) alone, so their 90-degree
corners survive it. A bend here is what the audit counts: exactly two track ends meeting square,
not inside a same-net pad and not on a via. Each gets a 45-degree chamfer, the largest of 0.4, 0.3,
0.2 and 0.15 mm (per leg) that keeps 0.15 mm from foreign copper and out of rule areas that forbid
tracks, and leaves each original leg at least 0.1 mm long. The two legs are shortened in place and
the diagonal inherits the net, layer, width (the wider of the two, else the narrower if only that
clears) and lock. Nothing is removed, so connectivity is unchanged. Run after tidy_routes.py, then DRC.

    python chamfer_a02_corners.py          # rewrite the board
    python chamfer_a02_corners.py --dry    # report only
"""
import math, sys
from collections import defaultdict
import pcbnew as pcb
from rework import TARGET

DRY = '--dry' in sys.argv
CLR = pcb.FromMM(0.15)
LEGS = [pcb.FromMM(v) for v in (0.4, 0.3, 0.2, 0.15)]
MIN_LEFT = pcb.FromMM(0.1)
COPPER = (pcb.F_Cu, pcb.In2_Cu, pcb.B_Cu)

b = pcb.LoadBoard(str(TARGET))
tracks = [t for t in b.GetTracks() if not isinstance(t, pcb.PCB_VIA)]
vias = [t for t in b.GetTracks() if isinstance(t, pcb.PCB_VIA)]
pads = [p for f in b.GetFootprints() for p in f.Pads()]
areas = [z for z in b.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowTracks()]
mm = lambda v: round(pcb.ToMM(v) - 50, 3)

obstacles = defaultdict(list)          # layer -> (netcode, shape)
for t in tracks:
    if t.GetLayer() in COPPER: obstacles[t.GetLayer()].append((t.GetNetCode(), t.GetEffectiveShape(), t))
for v in vias:
    for l in COPPER:
        if v.IsOnLayer(l): obstacles[l].append((v.GetNetCode(), v.GetEffectiveShape(l), v))
for p in pads:
    for l in COPPER:
        if p.IsOnLayer(l): obstacles[l].append((p.GetNetCode(), p.GetEffectiveShape(l), p))

def clear(layer, net, a, c, width):
    seg = pcb.SHAPE_SEGMENT(a, c, width)
    for n, shape, _ in obstacles[layer]:
        if n != net and seg.Collide(shape, CLR): return False
    return not any(z.IsOnLayer(layer) and z.Outline().Collide(seg, 0) for z in areas)

def keeps_joins(layer, net, corner, p1, p2, w1, w2, w, legs):
    """False if a same-net item touches the copper the chamfer cuts away but not the new copper."""
    old = [pcb.SHAPE_SEGMENT(corner, p1, w1), pcb.SHAPE_SEGMENT(corner, p2, w2)]
    new = [pcb.SHAPE_SEGMENT(p1, p2, w), pcb.SHAPE_SEGMENT(p1, p1, w1), pcb.SHAPE_SEGMENT(p2, p2, w2)]
    for n, shape, item in obstacles[layer]:
        if n != net or item in legs: continue
        if any(s.Collide(shape, 0) for s in old) and not any(s.Collide(shape, 0) for s in new): return False
    return True

ends = defaultdict(list)
for t in tracks:
    if t.GetLayer() not in COPPER or t.GetLength() == 0: continue
    for v, o in ((t.GetStart(), t.GetEnd()), (t.GetEnd(), t.GetStart())):
        ends[(t.GetNetCode(), t.GetLayer(), v.x, v.y)].append((t, v, o))

def unit(v, o):
    dx, dy = o.x - v.x, o.y - v.y
    return ((dx > 0) - (dx < 0), (dy > 0) - (dy < 0))

done = skipped = 0
for (net, layer, x, y), legs in ends.items():
    if len(legs) != 2: continue
    (t1, v1, o1), (t2, v2, o2) = legs
    d1, d2 = (o1.x - x, o1.y - y), (o2.x - x, o2.y - y)
    if d1[0] * d2[0] + d1[1] * d2[1] != 0: continue
    pos = pcb.VECTOR2I(x, y)
    if any(p.GetNetCode() == net and p.IsOnLayer(layer) and p.HitTest(pos) for p in pads): continue
    if any(v.GetNetCode() == net and v.GetPosition() == pos for v in vias): continue
    u1, u2 = unit(pos, o1), unit(pos, o2)
    widths = sorted({t1.GetWidth(), t2.GetWidth()}, reverse=True)
    hit = None
    for leg in LEGS:
        step1 = leg if 0 in u1 else round(leg / math.sqrt(2))
        step2 = leg if 0 in u2 else round(leg / math.sqrt(2))
        if t1.GetLength() - leg < MIN_LEFT or t2.GetLength() - leg < MIN_LEFT: continue
        p1 = pcb.VECTOR2I(x + u1[0] * step1, y + u1[1] * step1)
        p2 = pcb.VECTOR2I(x + u2[0] * step2, y + u2[1] * step2)
        for w in widths:
            if clear(layer, net, p1, p2, w) and \
               keeps_joins(layer, net, pos, p1, p2, t1.GetWidth(), t2.GetWidth(), w, (t1, t2)): hit = (p1, p2, w); break
        if hit: break
    name = t1.GetNetname()
    if not hit:
        skipped += 1; print(f'  no clear chamfer: {name} {pcb.LayerName(layer)} ({mm(x)}, {mm(y)})', flush=True); continue
    p1, p2, w = hit; done += 1
    print(f'  chamfer {name} {pcb.LayerName(layer)} ({mm(x)}, {mm(y)}) leg {pcb.ToMM(abs(p1.x - x) or abs(p1.y - y)):.2f} w {pcb.ToMM(w)}', flush=True)
    if DRY: continue
    for t, v in ((t1, v1), (t2, v2)):
        p = p1 if t is t1 else p2
        if t.GetStart() == v: t.SetStart(p)
        else: t.SetEnd(p)
    n = pcb.PCB_TRACK(b); n.SetLayer(layer); n.SetWidth(w); n.SetNetCode(net)
    n.SetStart(p1); n.SetEnd(p2); n.SetLocked(t1.IsLocked() or t2.IsLocked()); b.Add(n)
    obstacles[layer].append((net, n.GetEffectiveShape(), n))

if not DRY: pcb.SaveBoard(str(TARGET), b)
print(f'chamfer: {done} corners chamfered, {skipped} left' + (' (dry)' if DRY else ''), flush=True)
import os; os._exit(0)
