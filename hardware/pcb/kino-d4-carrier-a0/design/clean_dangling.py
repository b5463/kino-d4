"""Remove dangling track ends and unconnected vias left by partial routing. Repeats until stable.

Geometric test: a track end is live if it lies on a same-net pad, via, zone or another track
on the same layer; a via is live if at least two same-net items touch it (layers counted apart).
Pads are tested on their real copper shape: PAD.HitTest only sees the anchor of a custom pad, and
trusting it once deleted 297 good items ending on L-shaped QFN lands. --dry lists without removing.
"""
import sys
DRY = '--dry' in sys.argv
import pcbnew as pcb
from rework import TARGET

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())   # read before pad/zone lists: this SWIG build fails otherwise
pads = [p for f in b.GetFootprints() for p in f.Pads()]
zones = list(b.Zones())
removed = 0
while True:
    def touches(pos, layer, net, skip):
        for p in pads:
            if p.GetNetCode() == net and p.IsOnLayer(layer) and p.GetEffectiveShape(layer).Collide(pos, 0): return True
        for z in zones:
            if z.GetNetCode() == net and z.IsOnLayer(layer) and z.HitTestFilledArea(layer, pos, 0): return True
        for t in tracks:
            if t is skip or t.GetNetCode() != net: continue
            if isinstance(t, pcb.PCB_VIA):
                if t.IsOnLayer(layer) and t.HitTest(pos, 0): return True
            elif t.GetLayer() == layer and t.HitTest(pos, 0): return True
        return False
    dead = []
    for t in tracks:
        n = t.GetNetCode()
        if isinstance(t, pcb.PCB_VIA):
            hits = sum(touches(t.GetPosition(), l, n, t) for l in (pcb.F_Cu, pcb.In1_Cu, pcb.In2_Cu, pcb.B_Cu))
            if hits < 2: dead.append(t)
        elif not (touches(t.GetStart(), t.GetLayer(), n, t) and touches(t.GetEnd(), t.GetLayer(), n, t)):
            dead.append(t)
    if not dead or DRY:
        for t in dead:
            q = t.GetPosition() if isinstance(t, pcb.PCB_VIA) else t.GetStart()
            print('  would remove', t.GetNetname(), 'via' if isinstance(t, pcb.PCB_VIA) else b.GetLayerName(t.GetLayer()), round(pcb.ToMM(q.x) - 50, 2), round(pcb.ToMM(q.y) - 50, 2))
        removed = len(dead) if DRY else removed
        break
    for t in dead: b.Remove(t)
    tracks = [t for t in tracks if not any(t is d for d in dead)]
    removed += len(dead)
if not DRY: pcb.SaveBoard(str(TARGET), b)
print('would remove' if DRY else 'removed', removed, 'dangling items', flush=True)
import os; os._exit(0)
