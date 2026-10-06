"""Remove the unlocked copper of one net inside a box, for re-routing (KiCad 10 python).

    python rip_box.py NET x0 y0 x1 y1 [--dry]

Tracks with both ends inside the box and vias inside it go; locked copper (designed routes) stays.
Board mm. Run DRC afterwards; drop_dangling.py takes any stub left at the box edge.
"""
import sys
import pcbnew as pcb
from rework import TARGET

net = sys.argv[1]; x0, y0, x1, y1 = map(float, sys.argv[2:6]); DRY = '--dry' in sys.argv
b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())
mm = lambda v: pcb.ToMM(v) - 50
inside = lambda p: x0 <= mm(p.x) <= x1 and y0 <= mm(p.y) <= y1
doomed = [t for t in tracks if t.GetNetname() == net and not t.IsLocked() and
          (inside(t.GetPosition()) if isinstance(t, pcb.PCB_VIA) else inside(t.GetStart()) and inside(t.GetEnd()))]
n = len(doomed)
if not DRY:
    for t in doomed: b.Remove(t)
    pcb.SaveBoard(str(TARGET), b)
print(f'rip_box {net}: {n} items' + (' (dry)' if DRY else ''), flush=True)
import os; os._exit(0)
