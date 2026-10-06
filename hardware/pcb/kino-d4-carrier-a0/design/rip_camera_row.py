"""Clear the camera row for a deliberate re-route (KiCad 10 python). Locked copper is never touched.

The first grid-router pass routed the SYS_5V camera trunk before the camera control lines. Its B
trunk took the corridor between each power switch and its FAULT pull-up, and two of its vias sat in
the only escape pocket of the camera 1 and camera 2 FAULT_N pins. This script removes, unlocked
items only:

  * all copper of CAMk_EN, CAMk_FAULT_N and CAMk_REQ (k = 1..4);
  * CAM1_SHUNT_OUT and CAM2_SHUNT_OUT (the camera 2 one put a via in the FAULT_N pocket);
  * SYS_5V copper lying entirely inside the camera row, x 22-100 mm, y 18-26 mm;
  * the SYS_5V feed via at (28.05, 23.7) and its B stub; the F feed from the boost is shortened to
    end at y 26.5, south of camera 1's switch, so a new via cannot land in the same pocket.

Then route, in this order: FAULT_N, EN, REQ, SHUNT_OUT, SYS_5V (grid_router.py with GR_ORDER=argv).
"""
import re
import pcbnew as pcb
from rework import TARGET
from routing import pt

NETS = re.compile(r'(CAM\d_(EN|FAULT_N|REQ)|CAM[12]_SHUNT_OUT)$')
ROW = (22.0, 18.0, 100.0, 26.0)
FEED_VIA, FEED_TOP = (28.05, 23.7), 26.5

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                      # SWIG order trap: read before pad lists
mm = lambda v: pcb.ToMM(v) - 50
near = lambda a, c: abs(a[0] - c[0]) < 0.01 and abs(a[1] - c[1]) < 0.01
inrow = lambda p: ROW[0] <= p[0] <= ROW[2] and ROW[1] <= p[1] <= ROW[3]
doomed, counts, shortened = [], {}, 0
for t in tracks:
    if t.IsLocked(): continue
    n = t.GetNetname()
    if isinstance(t, pcb.PCB_VIA):
        p = (mm(t.GetPosition().x), mm(t.GetPosition().y))
        if NETS.match(n) or (n == 'SYS_5V' and inrow(p)): doomed.append(t); counts[n] = counts.get(n, 0) + 1
        continue
    s, e = (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))
    if NETS.match(n) or (n == 'SYS_5V' and inrow(s) and inrow(e)):
        doomed.append(t); counts[n] = counts.get(n, 0) + 1
    elif n == 'SYS_5V' and t.GetLayer() == pcb.F_Cu and abs(s[0] - FEED_VIA[0]) < 0.01 and abs(e[0] - FEED_VIA[0]) < 0.01:
        for p, set_ in ((s, t.SetStart), (e, t.SetEnd)):
            if near(p, FEED_VIA): set_(pt(50 + FEED_VIA[0], 50 + FEED_TOP)); shortened += 1
for t in doomed: b.Remove(t)                      # last: Remove() invalidates the other proxies
pcb.SaveBoard(str(TARGET), b)
print('rip camera row:', len(doomed), 'items;', ', '.join(f'{k} {v}' for k, v in sorted(counts.items())), '; F feed shortened' if shortened else '; F feed not found', flush=True)
import os; os._exit(0)
