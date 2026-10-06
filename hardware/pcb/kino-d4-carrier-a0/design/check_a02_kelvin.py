"""Check that every Kelvin sense line of route_a02_kelvin.py touches only its own shunt pad and U700 pin (KiCad 10 python).

DRC cannot see this: SENSE+ is SYS_5V, so a sense line merging into the supply copper is no violation,
but camera current would then flow in it. Lists, for each planned sense item, every same-net pad it
touches and any same-net track or via that is not part of the plan. A clean board prints one pad per
line end (RS(k)00 pad 1 or 2, a U700 pin) and nothing else.
"""
import pcbnew as pcb
from rework import TARGET
src = open('route_a02_kelvin.py').read()
ns = {}; exec(src[src.index("W = 0.15"):src.index("\nb = pcb.LoadBoard")], ns)
b = pcb.LoadBoard(str(TARGET)); mm = lambda v: pcb.ToMM(v) - 50
P = lambda x, y: pcb.VECTOR2I(pcb.FromMM(50 + x), pcb.FromMM(50 + y))
LAY = {'F': pcb.F_Cu, 'B': pcb.B_Cu, 'I2': pcb.In2_Cu}
plan = []
for tag, net, layer, pts in ns['items']:
    if not tag.startswith('c'): continue
    if layer == 'V': plan.append((tag, net, (pcb.F_Cu, pcb.In2_Cu, pcb.B_Cu), pcb.SHAPE_CIRCLE(P(*pts[0]), pcb.FromMM(0.3)), pts))
    else:
        for a, c in zip(pts, pts[1:]): plan.append((tag, net, (LAY[layer],), pcb.SHAPE_SEGMENT(P(*a), P(*c), pcb.FromMM(0.15)), [a, c]))
def is_plan(t):
    if isinstance(t, pcb.PCB_VIA):
        q = (round(mm(t.GetPosition().x), 2), round(mm(t.GetPosition().y), 2))
        return any(len(p) == 1 and abs(p[0][0] - q[0]) < .02 and abs(p[0][1] - q[1]) < .02 for _, _, _, _, p in plan)
    s = (mm(t.GetStart().x), mm(t.GetStart().y)); e = (mm(t.GetEnd().x), mm(t.GetEnd().y))
    return any(len(p) == 2 and ((abs(p[0][0]-s[0]) < .02 and abs(p[0][1]-s[1]) < .02 and abs(p[1][0]-e[0]) < .02 and abs(p[1][1]-e[1]) < .02)) for _, _, _, _, p in plan)
bad = []
for t in b.GetTracks():
    if t.GetNetname() != 'SYS_5V' and 'SHUNT_OUT' not in t.GetNetname(): continue
    if is_plan(t): continue
    for tag, net, layers, s, _ in plan:
        if net != t.GetNetname(): continue
        if any(t.IsOnLayer(l) and t.GetEffectiveShape(l).Collide(s, 0) for l in layers):
            bad.append(f'{tag} touches {t.GetNetname()} {"via" if isinstance(t, pcb.PCB_VIA) else "track"} at ({mm(t.GetStart().x):.2f},{mm(t.GetStart().y):.2f})-({mm(t.GetEnd().x):.2f},{mm(t.GetEnd().y):.2f})'); break
for f in b.GetFootprints():
    for p in f.Pads():
        if p.GetNetname() != 'SYS_5V' and 'SHUNT_OUT' not in p.GetNetname(): continue
        for tag, net, layers, s, _ in plan:
            if net == p.GetNetname() and any(p.IsOnLayer(l) and p.GetEffectiveShape(l).Collide(s, 0) for l in layers):
                bad.append(f'{tag} touches pad {f.GetReference()}.{p.GetNumber()}')
for x in sorted(set(bad)): print(x)
print('checked', len(plan), 'plan shapes', flush=True)
import os; os._exit(0)
