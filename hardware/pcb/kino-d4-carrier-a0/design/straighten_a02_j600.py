"""Straighten the J600 SYS_5V branch on B (KiCad 10 python). ODD JOBS 87/88: no jogs.

The grid router's J600 branch (0.4 mm) stepped up and down over J102's back mounting pad because
GND stitching via (34.20, 58.49) sat on the straight line. The via moves 1.1 mm south to
(34.20, 59.60), 0.35 mm clear of the new run, and the unlocked SYS_5V B chain between the J600 via
at (28.20, 57.70) and the U1201 branch at (39.90, 57.55) becomes one straight run at y 58.75 with
a 45-degree end at each side. Run after grid_router.py / apply_routes.py and tidy_routes.py.
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())
mm = lambda v: pcb.ToMM(v) - 50
near = lambda a, c: abs(a[0] - c[0]) < 0.02 and abs(a[1] - c[1]) < 0.02
A, Z = (28.2, 57.7), (39.9, 57.55)
box = (28.1, 57.4, 40.0, 59.45)
inside = lambda p: box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3]
code = b.FindNet('SYS_5V').GetNetCode()

chain, ends = [], set()
for t in tracks:
    if isinstance(t, pcb.PCB_VIA) or t.GetNetname() != 'SYS_5V' or t.GetLayer() != pcb.B_Cu or t.IsLocked(): continue
    s, e = (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))
    if inside(s) and inside(e): chain.append(t); ends |= {s, e}
assert any(near(p, A) for p in ends) and any(near(p, Z) for p in ends), ('chain ends not found', sorted(ends))
gnd = [t for t in tracks if isinstance(t, pcb.PCB_VIA) and t.GetNetname() == 'GND' and near((mm(t.GetPosition().x), mm(t.GetPosition().y)), (34.202, 58.49))]
assert len(gnd) == 1, len(gnd)
gnd[0].SetPosition(pt(50 + 34.202, 50 + 59.6))
pts = [A, (29.25, 58.75), (38.7, 58.75), Z]
for a, c in zip(pts, pts[1:]):
    t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + a[0], 50 + a[1])); t.SetEnd(pt(50 + c[0], 50 + c[1]))
    t.SetWidth(pcb.FromMM(0.4)); t.SetLayer(pcb.B_Cu); t.SetNetCode(code); b.Add(t)
n = len(chain)
for t in chain: b.Remove(t)                    # last: Remove() invalidates the other proxies
pcb.SaveBoard(str(TARGET), b)
print(f'j600 branch: {n} segments -> 3; GND stitching via to (34.20, 59.60)', flush=True)
import os; os._exit(0)
