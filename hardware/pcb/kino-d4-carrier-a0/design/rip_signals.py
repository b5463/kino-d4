"""Remove signal copper so grid_router.py can route it again under the pad-entry rules.

Kept: ground, power and switch nodes, the camera switch and ILIM nodes, the gauge supply and taps,
and every segment and via recorded in outputs/A02-FIXED-ROUTES.json (camera UART corridors, the
SYNC_MASTER bus, the buck output part of MB_3V3). Everything else on a signal net goes: the P4 UART
escapes, camera 3V3, camera 5V/5V_ISO/SHUNT_OUT and all logic nets.
Run with KiCad 10 python, then DRC to refresh outputs/DRC-A02.json, then grid_dump.py.
"""
import json, math, re
import pcbnew as pcb
from rework import TARGET
from pathlib import Path

KEEP = re.compile(r'(GND|SYS_RAW|SYS_5V|BOOST_\w+|BUCK_SW|CHG_\w+|USB_VBUS|PACK_\w+|BAT_PROTECTED|PD_\w+|MAIN_\w+'
                  r'|P4_5V\w*|CAM\d_(SW5V|ILIM|RX_RETURN)|GAUGE_1V8)$')
LAYER = {'F.Cu': pcb.F_Cu, 'In2.Cu': pcb.In2_Cu, 'B.Cu': pcb.B_Cu}
fixed = json.loads((Path(__file__).resolve().parent.parent / 'outputs/A02-FIXED-ROUTES.json').read_text())

def on_poly(x, y, pts):
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        dx, dy = bx - ax, by - ay; L2 = dx * dx + dy * dy
        u = 0 if L2 == 0 else max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / L2))
        if math.hypot(x - ax - u * dx, y - ay - u * dy) < 0.02: return True
    return False

def is_fixed(t):
    if isinstance(t, pcb.PCB_VIA):       # a via at a vertex of a recorded route belongs to it
        x, y = pcb.ToMM(t.GetPosition().x) - 50, pcb.ToMM(t.GetPosition().y) - 50
        return any(f['net'] == t.GetNetname() and any(math.hypot(x - px, y - py) < 0.02 for px, py in f['points'])
                   for f in fixed)
    ps = [(pcb.ToMM(v.x) - 50, pcb.ToMM(v.y) - 50) for v in (t.GetStart(), t.GetEnd())]
    return any(f['net'] == t.GetNetname() and LAYER.get(f['layer']) == t.GetLayer()
               and all(on_poly(x, y, f['points']) for x, y in ps) for f in fixed)

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())            # read first: this SWIG build fails if read after pad lists
gone = {}
for t in tracks:
    n = t.GetNetname()
    if not n or KEEP.match(n): continue
    if is_fixed(t): continue
    b.Remove(t); gone[n] = gone.get(n, 0) + 1
pcb.SaveBoard(str(TARGET), b)
print('ripped', sum(gone.values()), 'items on', len(gone), 'nets:', ' '.join(sorted(gone)), flush=True)
import os; os._exit(0)
