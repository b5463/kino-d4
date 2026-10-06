"""Move the SYNC_MASTER distribution bus from the top of the camera row to the buffers (KiCad 10 python).

Before: SYNC reached camera 1's buffer via at (23.905, 38.65) from the P4 header, then climbed a
19.25 mm In2 drop to a bus at y 19.4 and came back down an identical drop at each other camera.
The bus and the four drops cut In2 into sealed cells across the whole camera row. With the UART
lanes on F and the camera supply on B, no signal could cross the row on any layer: camera 1 and 2
EN / FAULT_N could not reach the expander.

After: one In2 bus at y 41.05 joins the four buffer vias at (x, 38.65), x = 23.905 + 22 k, through
2.4 mm drops. y 41.05 is the centre line between the socket pin rows at 39.78 and 42.33 (0.27 mm
clear of every pin). The bus runs over the In1 ground plane its whole length (ODD JOBS 18/21), is
straight between the end chamfers (87/88), and is 66 mm long instead of 66 + 4 x 19.25 mm of drops.
The B stubs into U200-U500 pin 3 and the F feed from J100 pin 19 are unchanged.

Moved to clear the bus by 0.2 mm or more (no net or connection changes):
  GND stitching vias (43.41, 40.7) and (87.41, 41.1)  -> y 41.7 (they carry no tracks)
  MB_3V3 hop vias (73.85, 41.05) and (82.65, 41.05)   -> y 41.65 and 40.45, with a 45-degree kink each side
  MB_3V3 via (45.0, 40.65)                            -> (45.0, 40.4)

outputs/A02-FIXED-ROUTES.json is updated so rip_signals.py protects the new bus, not the old one.
Re-running is harmless: it checks what is there first.
"""
import json
import pcbnew as pcb
from rework import ROOT, TARGET
from routing import pt

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                      # SWIG order trap: read before pad lists
mm = lambda v: pcb.ToMM(v) - 50
near = lambda a, c, tol=0.01: abs(a[0] - c[0]) < tol and abs(a[1] - c[1]) < tol
def ends(t): return (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))
F, I2, B = pcb.F_Cu, pcb.In2_Cu, pcb.B_Cu
XS = [23.905 + 22 * k for k in range(4)]
Y_BUS, Y_VIA = 41.05, 38.65
net_sync = b.FindNet('SYNC_MASTER')

# ---- 1. remove the old In2 bus and drops ---------------------------------------------------------
# Remove() invalidates every other SWIG proxy in this build, so all removals are collected here and
# carried out last, after every move and addition.
doomed = []
for t in tracks:
    if isinstance(t, pcb.PCB_VIA) or t.GetNetname() != 'SYNC_MASTER' or t.GetLayer() != I2: continue
    (x1, y1), (x2, y2) = ends(t)
    if min(y1, y2) < 38.0:                        # every old In2 SYNC item lies north of the buffer vias
        doomed.append(t)
removed = len(doomed)
tracks = [t for t in tracks if not any(t is d for d in doomed)]

# ---- 2. the new bus ------------------------------------------------------------------------------
def add(net, layer, w, pts, lock=True):
    for a, c in zip(pts, pts[1:]):
        dx, dy = abs(c[0] - a[0]), abs(c[1] - a[1])
        assert min(dx, dy) < 1e-6 or abs(dx - dy) < 1e-6, (net, 'non-45 segment', a, c)
        t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + a[0], 50 + a[1])); t.SetEnd(pt(50 + c[0], 50 + c[1]))
        t.SetWidth(pcb.FromMM(w)); t.SetLayer(layer); t.SetNet(b.FindNet(net)); t.SetLocked(lock); b.Add(t)
have_bus = any(not isinstance(t, pcb.PCB_VIA) and t.GetNetname() == 'SYNC_MASTER' and t.GetLayer() == I2
               and abs(ends(t)[0][1] - Y_BUS) < 0.01 and abs(ends(t)[1][1] - Y_BUS) < 0.01 for t in tracks)
BUS = [(XS[0], Y_VIA), (XS[0], Y_BUS - 0.4), (XS[0] + 0.4, Y_BUS), (XS[3] - 0.4, Y_BUS), (XS[3], Y_BUS - 0.4), (XS[3], Y_VIA)]
DROPS = [[(x, Y_BUS), (x, Y_VIA)] for x in XS[1:3]]
if not have_bus:
    add('SYNC_MASTER', I2, 0.2, BUS)
    for d in DROPS: add('SYNC_MASTER', I2, 0.2, d)

# ---- 3. vias in the way --------------------------------------------------------------------------
moves = {('GND', (43.41, 40.7)): (43.41, 41.7), ('GND', (87.41, 41.1)): (87.41, 41.7),   # south: the U300/U500 MB_3V3 stubs run at y 39.95
         ('MB_3V3', (45.0, 40.65)): (45.0, 40.4)}
moved = []
for t in tracks:
    if not isinstance(t, pcb.PCB_VIA): continue
    at = (mm(t.GetPosition().x), mm(t.GetPosition().y))
    for (net, old), new in moves.items():
        if t.GetNetname() == net and near(at, old, 0.02):
            t.SetPosition(pt(50 + new[0], 50 + new[1])); moved.append(f'{net} via {old} -> {new}')
# MB_3V3 at (45.0, 40.4): F drop extends 0.25 mm, B stub from U300 pin 1 gets a 45-degree entry
for t in tracks:
    if isinstance(t, pcb.PCB_VIA) or t.GetNetname() != 'MB_3V3': continue
    s, e = ends(t)
    for get, set_, p in ((t.GetStart, t.SetStart, s), (t.GetEnd, t.SetEnd, e)):
        if near(p, (45.0, 40.65), 0.02):
            if t.GetLayer() == F: set_(pt(50 + 45.0, 50 + 40.4))
            elif t.GetLayer() == B: set_(pt(50 + 44.749, 50 + 40.4)); add('MB_3V3', B, pcb.ToMM(t.GetWidth()), [(44.749, 40.4), (45.0, 40.4)], lock=False)
# MB_3V3 hop between U400 and U500 along y 41.05: both vias up 0.6 mm
HOP = {(73.85, 41.05): (73.85, 41.65), (82.65, 41.05): (82.65, 40.45)}    # 73.85 goes south, clear of CAM3_3V3 at y 39.95
hop_done = False
for t in tracks:
    if isinstance(t, pcb.PCB_VIA) and t.GetNetname() == 'MB_3V3':
        at = (mm(t.GetPosition().x), mm(t.GetPosition().y))
        for old, new in HOP.items():
            if near(at, old, 0.02): t.SetPosition(pt(50 + new[0], 50 + new[1])); moved.append(f'MB_3V3 via {old} -> {new}'); hop_done = True
if hop_done:
    for t in list(tracks):
        if isinstance(t, pcb.PCB_VIA) or t.GetNetname() != 'MB_3V3': continue
        s, e = ends(t); w = pcb.ToMM(t.GetWidth())
        if t.GetLayer() == B and near(s, (67.743, 41.05), 0.02) and near(e, (73.85, 41.05), 0.02) or \
           t.GetLayer() == B and near(e, (67.743, 41.05), 0.02) and near(s, (73.85, 41.05), 0.02):
            doomed.append(t); add('MB_3V3', B, w, [(67.743, 41.05), (73.25, 41.05), (73.85, 41.65)], lock=False)
        elif t.GetLayer() == F and {tuple(round(v, 2) for v in s), tuple(round(v, 2) for v in e)} == {(73.85, 41.05), (82.65, 41.05)}:
            doomed.append(t); add('MB_3V3', F, w, [(73.85, 41.65), (74.45, 41.05), (82.05, 41.05), (82.65, 40.45)], lock=False)
        elif t.GetLayer() == B and {tuple(round(v, 2) for v in s), tuple(round(v, 2) for v in e)} == {(82.65, 41.05), (85.93, 41.05)}:
            doomed.append(t); add('MB_3V3', B, w, [(82.65, 40.45), (83.25, 41.05), (85.93, 41.05)], lock=False)
for t in doomed: b.Remove(t)
pcb.SaveBoard(str(TARGET), b)

# ---- 4. fixed-route record -----------------------------------------------------------------------
path = ROOT / 'outputs/A02-FIXED-ROUTES.json'
fixed = [r for r in json.loads(path.read_text()) if not (r['net'] == 'SYNC_MASTER' and r['layer'] == 'In2.Cu')]
fixed.append({'net': 'SYNC_MASTER', 'layer': 'In2.Cu', 'width_mm': 0.2, 'points': [list(p) for p in BUS]})
for d in DROPS: fixed.append({'net': 'SYNC_MASTER', 'layer': 'In2.Cu', 'width_mm': 0.2, 'points': [list(p) for p in d]})
path.write_text(json.dumps(fixed, indent=2) + '\n')
print('sync bus: removed', removed, 'old In2 items;', 'bus present' if have_bus else 'drew bus + 2 drops', ';', '; '.join(moved) or 'no via moves', flush=True)
import os; os._exit(0)
