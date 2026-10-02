"""Close the three dangling items DRC reports on A0.2 that are not routing work (KiCad 10 python).

1. SYNC_MASTER: the In2 bus along y 19.4 stops at x 89.605 and the camera-4 branch stops at
   (89.905, 19.7); the 0.3 mm corner between them is missing. One 45-degree segment restores it.
2. P4_TX1: the via at (11.5, 23.6) sits in the middle of a front-only run and reaches nothing on
   the back. Removed.
3. P4_TX3: the via at (11.5, 21.2) and the 1.75 mm of front track west of the live branch at
   x 13.25 are a leftover of an earlier path. Both removed; the run now starts at (13.25, 21.2).

Re-running is harmless: each step checks what is there first.
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                      # SWIG order trap
mm = lambda v: pcb.ToMM(v) - 50
near = lambda a, c: abs(a[0] - c[0]) < 0.01 and abs(a[1] - c[1]) < 0.01
def ends(t): return (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))
done = []

# 1. SYNC_MASTER corner
A, C = (89.605, 19.4), (89.905, 19.7)
if not any(t.GetNetname() == 'SYNC_MASTER' and not isinstance(t, pcb.PCB_VIA) and t.GetLayer() == pcb.In2_Cu
           and (near(ends(t)[0], A) and near(ends(t)[1], C) or near(ends(t)[0], C) and near(ends(t)[1], A)) for t in tracks):
    t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + A[0], 50 + A[1])); t.SetEnd(pt(50 + C[0], 50 + C[1]))
    t.SetWidth(pcb.FromMM(.2)); t.SetLayer(pcb.In2_Cu); t.SetNet(b.FindNet('SYNC_MASTER')); b.Add(t); done.append('SYNC_MASTER corner')

# 2./3. unused vias and the P4_TX3 stub
for t in tracks:
    if isinstance(t, pcb.PCB_VIA):
        at = (mm(t.GetPosition().x), mm(t.GetPosition().y))
        if (t.GetNetname(), tuple(round(v, 2) for v in at)) in (('P4_TX1', (11.5, 23.6)), ('P4_TX3', (11.5, 21.2))):
            b.Remove(t); done.append(f'{t.GetNetname()} via {at}')
    elif t.GetNetname() == 'P4_TX3' and t.GetLayer() == pcb.F_Cu:
        s, e = ends(t)
        if near(s, (11.5, 21.2)) and near(e, (64.605, 21.2)): t.SetStart(pt(50 + 13.25, 50 + 21.2)); done.append('P4_TX3 run trimmed to x 13.25')
        elif near(e, (11.5, 21.2)) and near(s, (64.605, 21.2)): t.SetEnd(pt(50 + 13.25, 50 + 21.2)); done.append('P4_TX3 run trimmed to x 13.25')
pcb.SaveBoard(str(TARGET), b)
print('tidy:', '; '.join(done) or 'nothing to do', flush=True)
import os; os._exit(0)
