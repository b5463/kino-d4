"""Turn the TCA9539 expander U600 through 180 degrees so its pin columns face their loads (KiCad 10 python).

U600 sits on the back at the top edge between the camera 2 header and U601. As placed, 10 of the 12
pins on its west column (REQ1-4 to U601, FAULT2-4 to cameras 2-4, EXP_RESET_N to R600/C600) had to
cross under the package to reach loads east of it; their routes criss-crossed the area between the
two expanders on F.Cu. Turned 180 degrees about its centre (45.0, 5.25) the REQ/FAULT/RESET column
faces east, towards U601 and the camera control bus, and the interrupt / I2C column faces west and
south. Crossings under the package drop from 8 signals to 4 (FAULT1, COVER_N, FN_N, HAPTIC_EN).
No net changes. C601 (100 nF on pin 24, MB_3V3) moves with its pin to the north-west corner so the
decoupling path stays IC - capacitor - ground via (ODD JOBS 14/16).

Phases, each its own process (this KiCad build's SWIG layer is unreliable after a Remove()):
    python place_a02_u600.py place     rotate U600, place C601
    python place_a02_u600.py rip       remove U600-side copper that no longer meets the pads
Then DRC, drop_dangling.py until clean, grid_dump.py, and route the U600 nets.
"""
import re, sys
import pcbnew as pcb
from rework import TARGET
from routing import pt

PHASE = sys.argv[1] if len(sys.argv) > 1 else ''
assert PHASE in ('place', 'rip'), 'run: place, then rip'
CENTRE = (45.0, 5.25)
C601_AT, C601_ROT = (39.5, 1.675), 0          # pads at x 38.72 (GND) and 40.28 (MB_3V3), on pin 24's row
ZONE = (37.0, 0.0, 62.0, 15.6)                 # the expander area
SIGNALS = re.compile(r'(EXP_RESET_N|CAM\d_(REQ|FAULT_N)|COVER_N|POWER_INT_N|SOFT_KILL|FN_N|IMU_INT|RTC_INT_N|HAPTIC_EN|CHARGE_STAT_N)$')
STUB_NETS = ('I2C_SCL', 'I2C_SDA', 'MB_3V3', 'GND')

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                   # SWIG order trap: read before pad lists
fs = {f.GetReference(): f for f in b.GetFootprints()}
mm = lambda v: pcb.ToMM(v) - 50
inzone = lambda p: ZONE[0] <= p[0] <= ZONE[2] and ZONE[1] <= p[1] <= ZONE[3]

if PHASE == 'place':
    u = fs['U600']
    assert abs(mm(u.GetPosition().x) - CENTRE[0]) < 0.01 and abs(mm(u.GetPosition().y) - CENTRE[1]) < 0.01, 'U600 moved?'
    rot = u.GetOrientationDegrees()
    if abs(rot) < 1:                           # only once: 0 -> 180
        u.SetOrientationDegrees(180)
    c = fs['C601']; c.SetPosition(pt(50 + C601_AT[0], 50 + C601_AT[1])); c.SetOrientationDegrees(C601_ROT)
    pads = {p.GetNumber(): (round(mm(p.GetPosition().x), 3), round(mm(p.GetPosition().y), 3), p.GetNetname()) for p in c.Pads()}
    # pad 1 (MB_3V3) must face U600 pin 24 (east)
    if pads['1'][0] < pads['2'][0]: c.SetOrientationDegrees(180); pads = {p.GetNumber(): (round(mm(p.GetPosition().x), 3), round(mm(p.GetPosition().y), 3), p.GetNetname()) for p in c.Pads()}
    c.Reference().SetPosition(c.GetPosition())
    p24 = next(p for p in u.Pads() if p.GetNumber() == '24')
    pcb.SaveBoard(str(TARGET), b)
    print('U600 at 180 deg (was', rot, '); pin 24 at', (round(mm(p24.GetPosition().x), 3), round(mm(p24.GetPosition().y), 3)), '; C601 pads', pads, flush=True)
    import os; os._exit(0)

# rip: signal copper in the zone, and supply / I2C stubs that touched U600's old pad positions
u = fs['U600']; c = u.GetPosition()
old = [(2 * mm(c.x) - mm(p.GetPosition().x), 2 * mm(c.y) - mm(p.GetPosition().y)) for p in u.Pads()]
oldc601 = [(39.5, 6.025), (39.5, 4.475)]
def near_old(p): return any(abs(p[0] - q[0]) < 1.2 and abs(p[1] - q[1]) < 0.5 for q in old) or any(abs(p[0] - q[0]) < 1.6 and abs(p[1] - q[1]) < 0.8 for q in oldc601)
doomed, counts = [], {}
for t in tracks:
    if t.IsLocked(): continue
    n = t.GetNetname()
    pts = [(mm(t.GetPosition().x), mm(t.GetPosition().y))] if isinstance(t, pcb.PCB_VIA) else \
          [(mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))]
    if (SIGNALS.match(n) and all(inzone(p) for p in pts)) or (n in STUB_NETS and any(near_old(p) for p in pts)):
        doomed.append(t); counts[n] = counts.get(n, 0) + 1
for t in doomed: b.Remove(t)
pcb.SaveBoard(str(TARGET), b)
print('rip:', len(doomed), 'items;', ', '.join(f'{k} {v}' for k, v in sorted(counts.items())), flush=True)
import os; os._exit(0)
