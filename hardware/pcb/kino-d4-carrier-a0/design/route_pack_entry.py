"""Pack entry at the charger: J1100 -> F1100 -> RS700 -> charger BAT pins, gauge Kelvin taps.

Chain (front): J1100.1 PACK_PLUS -> F1100 (7 A) -> PACK_FUSED -> RS700 (5 mOhm) -> BAT_PROTECTED.
J1100.3 is GND with a solid pad connection. Planning case 4.4 A at a 3.3 V cell (13 W).
BAT_PROTECTED runs on the front to three vias at y 58.4, then on In2 (2.4 mm) to the C1119 node,
which it reaches through three vias and a short back drop at x 84.6, clear of the U1100 west pins.
Gauge taps leave the RS700 pads themselves (TI BQ27441-G1: SRP pack side, SRN system side).
Rerunning removes and redraws only the copper this script owns. Coordinates are carrier mm.
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())            # read first: this SWIG build fails if read after pad lists
fs = {f.GetReference(): f for f in b.GetFootprints()}
net = lambda n: b.FindNet(n)

def pad(ref, num):
    p = next(p for p in fs[ref].Pads() if p.GetNumber() == num)
    return pcb.ToMM(p.GetPosition().x) - 50, pcb.ToMM(p.GetPosition().y) - 50

def seg(n, layer, pts, w):
    for a, c in zip(pts, pts[1:]):
        t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + a[0], 50 + a[1])); t.SetEnd(pt(50 + c[0], 50 + c[1]))
        t.SetWidth(pcb.FromMM(w)); t.SetLayer(layer); t.SetNet(net(n)); b.Add(t)

def via(n, x, y):
    v = pcb.PCB_VIA(b); v.SetPosition(pt(50 + x, 50 + y)); v.SetWidth(pcb.FromMM(0.6)); v.SetDrill(pcb.FromMM(0.3))
    v.SetLayerPair(pcb.F_Cu, pcb.B_Cu); v.SetNet(net(n)); b.Add(v)

def ends(t):
    ps = [t.GetPosition()] if isinstance(t, pcb.PCB_VIA) else [t.GetStart(), t.GetEnd()]
    return [(pcb.ToMM(v.x) - 50, pcb.ToMM(v.y) - 50) for v in ps]

# A GND stitching via left from the old R1107 position touches the RS700 system-side pad; the planes
# are stitched by the neighbouring vias.
for t in tracks:
    if isinstance(t, pcb.PCB_VIA) and t.GetNetname() == 'GND':
        p = t.GetPosition()
        if abs(pcb.ToMM(p.x) - 50 - 99.0) < 0.05 and abs(pcb.ToMM(p.y) - 50 - 57.42) < 0.05: b.Remove(t)

# Owned copper: the whole chain, and BAT copper between the charger and the shunt
# (earlier front trunk, vias, back trunk east of x 92.45). The back trunk west of it stays.
for t in tracks:
    n = t.GetNetname(); pts = ends(t)
    if n in ('PACK_PLUS', 'PACK_FUSED'):
        b.Remove(t)
    elif n == 'BAT_PROTECTED' and (all(89.5 <= x <= 111.5 and 57.2 <= y <= 68.8 for x, y in pts)
                                   or all(84.2 <= x <= 88.2 and 53.9 <= y <= 54.7 for x, y in pts)
                                   or all(79.85 <= x <= 84.7 and 53.6 <= y <= 55.0 for x, y in pts)
                                   or sorted((round(x, 2), round(y, 2)) for x, y in pts) == [(84.1, 54.28), (89.82, 60.0)]
                                   or sorted((round(x, 2), round(y, 2)) for x, y in pts) == [(84.22, 54.4), (89.82, 60.0)]
                                   or all(84.1 <= x <= 84.7 and 54.3 <= y <= 57.8 for x, y in pts)
                                   or (t.GetLayer() == pcb.In2_Cu and all(84.0 <= x <= 93.0 and 55.0 <= y <= 60.0 for x, y in pts))):
        b.Remove(t)      # this script's copper: shunt side, via stubs, In2 leg, BAT pin escape
    elif n == 'GND' and isinstance(t, pcb.PCB_VIA) and \
            any(abs(x - vx) < 0.05 and abs(y - vy) < 0.05 for x, y in pts for vx, vy in ((83.38, 56.7), (83.0, 56.9))):
        b.Remove(t)      # stitching via beside C1117, redrawn clear of the In2 BAT leg

j1 = pad('J1100', '1')
f1, f2 = pad('F1100', '1'), pad('F1100', '2')
r1, r2 = pad('RS700', '1'), pad('RS700', '2')
assert f1[1] > f2[1] > r1[1] > r2[1] and abs(r1[0] - r2[0]) < 0.01, 'chain must stand vertically, bottom to top'

# Power chain.
seg('PACK_PLUS', pcb.F_Cu, [j1, (j1[0] + f1[1] - j1[1], f1[1]), f1], 2.0)
seg('PACK_FUSED', pcb.F_Cu, [f2, r1], 1.75)
seg('BAT_PROTECTED', pcb.F_Cu, [r2, (r2[0], 58.4), (90.3, 58.4)], 1.6)
for x in (92.1, 91.2, 90.3):
    via('BAT_PROTECTED', x, 58.4)

# Charger BAT pins 22/23 into the back trunk node (84.3, 54.66): 0.5 mm x 4 mm between the
# C1119 GND via, NC pin 21 and the BTST2 via. About 4 mOhm, 76 mW at 4.4 A; bench thermal check.
seg('BAT_PROTECTED', pcb.B_Cu, [(88.1, 54.0), (87.55, 54.0), (86.89, 54.66), (84.48, 54.66)], 0.5)   # one 45-degree step, ends on the trunk
# BAT node at C1119: one junction, 45-degree legs to the trunk and the C1117/C1118 branch.
NODE = (84.22, 54.4)
seg('BAT_PROTECTED', pcb.B_Cu, [NODE, pad('C1119', '1')], 1.2)
# Node to shunt on In2, clear of the U1100 west pins (16-20 need their fan-out room on the back):
# 1.2 mm drop at x 84.6, three vias, then 2.4 mm on In2 along y 58.4 to the shunt-side vias.
# 2.4 mm x 7.5 mm of 1 oz inner copper is about 1.8 mOhm, 35 mW at 4.4 A.
seg('BAT_PROTECTED', pcb.B_Cu, [NODE, (84.6, NODE[1] + 0.38), (84.6, 57.7)], 1.2)
for y in (56.3, 57.0, 57.7):
    via('BAT_PROTECTED', 84.6, y)
seg('BAT_PROTECTED', pcb.In2_Cu, [(84.6, 56.3), (84.6, 57.7)], 1.2)
seg('BAT_PROTECTED', pcb.In2_Cu, [(84.6, 57.7), (85.3, 58.4), (92.1, 58.4)], 2.4)
gv = pcb.PCB_VIA(b); gv.SetPosition(pt(50 + 83.0, 50 + 56.9)); gv.SetWidth(pcb.FromMM(0.6)); gv.SetDrill(pcb.FromMM(0.3))
gv.SetLayerPair(pcb.F_Cu, pcb.B_Cu); gv.SetNet(net('GND')); b.Add(gv)
seg('BAT_PROTECTED', pcb.B_Cu, [NODE, (83.81, 54.81), (79.9, 54.81)], 1.2)

# Gauge corner (U701, back). The low-side wiring left pin 8 with a GND via; pin 8 is SRP now.
# The pin 3 GND via is redundant with the exposed-pad vias and blocks the VDD run. Both go.
# C702 (VDD) moves below the gauge, C703 (BAT, 1 uF) beside pin 6, as TI asks.
for t in tracks:
    if t.GetNetname() == 'GAUGE_1V8' and all(104 <= x <= 114 and 58.5 <= y <= 69 for x, y in ends(t)):
        b.Remove(t)
    elif isinstance(t, pcb.PCB_VIA) and t.GetNetname() == 'GND' and \
            any(abs(x - vx) < 0.05 and abs(y - vy) < 0.05 for x, y in ends(t) for vx, vy in ((111.4, 64.65), (105.6, 65.45))):
        b.Remove(t)
fs['C702'].SetOrientationDegrees(0); fs['C702'].SetPosition(pt(50 + 107.5, 50 + 68.3))
fs['C703'].SetOrientationDegrees(0); fs['C703'].SetPosition(pt(50 + 108.1, 50 + 62.4))
fs['R1106'].SetPosition(pt(50 + 96.0, 50 + 55.6))      # courtyard clear of RS700
g5, g6, g7, g8 = pad('U701', '5'), pad('U701', '6'), pad('U701', '7'), pad('U701', '8')
c702, c703 = pad('C702', '1'), pad('C703', '1')
assert c702[0] < 107.5 and c703[0] < 108.1, 'C702/C703 pad 1 must face the gauge pins'
seg('GAUGE_1V8', pcb.B_Cu, [g5, (106.0, g5[1]), (106.0, c702[1]), c702], 0.25)

# Gauge Kelvin taps, 0.2 mm, from the outer edge of each RS700 pad. The J1000 locator holes
# (106.1, 62.6) and (111.9, 62.6) and shell tabs set the corridors.
k1 = (r1[0] + 0.7, r1[1]); k2 = (r2[0] + 0.7, r2[1])
KX = r1[0] + 1.9                 # tap vias 1.9 mm right of the shunt centre line
# SRP / BAT (PACK_FUSED): via by the shunt; back branch to pin 6 and C703, In2 branch to pin 8.
seg('PACK_FUSED', pcb.F_Cu, [k1, (KX, r1[1] + 0.24)], 0.2); via('PACK_FUSED', KX, r1[1] + 0.24)
seg('PACK_FUSED', pcb.B_Cu, [(KX, r1[1] + 0.24), (KX + 0.8, 60.5), (106.8, 60.5), (106.8, g6[1]), g6], 0.2)
seg('PACK_FUSED', pcb.B_Cu, [(106.8, c703[1]), c703], 0.2)
seg('PACK_FUSED', pcb.In2_Cu, [(KX, r1[1] + 0.24), (KX + 0.8, 60.5), (111.25, 60.5), (111.25, g8[1])], 0.2)
via('PACK_FUSED', 111.25, g8[1])                            # level with pin 8: 0.2 mm to pins 7 and 9
seg('PACK_FUSED', pcb.B_Cu, [(111.25, g8[1]), g8], 0.2)
# SRN (BAT_PROTECTED): via clear of the GND via at (99.0, 57.42), back along y 59.2, into pin 7 from above.
seg('BAT_PROTECTED', pcb.F_Cu, [k2, (KX, 59.0)], 0.2); via('BAT_PROTECTED', KX, 59.0)   # clear of R1109 pad 1
seg('BAT_PROTECTED', pcb.B_Cu, [(KX, 59.0), (KX + 0.2, 59.2), (g7[0], 59.2), g7], 0.2)

pcb.SaveBoard(str(TARGET), b)
print('pack entry routed: J1100.1', j1, 'F1100', f1, f2, 'RS700', r1, r2)
