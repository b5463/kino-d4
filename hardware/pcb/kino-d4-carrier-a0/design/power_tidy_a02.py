"""Tidy hand-routed power paths to the pad-entry rule (ODD JOBS 87/88). KiCad 10 python.

CHG_VBUS (back): BQ25798 pins 2/3 are VBUS, pins 8/9 are VAC2/VAC1 sense inputs. The earlier
trunk fed the sense pins and left VBUS on a 0.2 mm bridge. Now 0.2 mm stubs on the pin 2/3 centre
lines meet a bar 0.3 mm outside the pin tips, a 0.6 mm link enters the C1106 VBUS pad (C1106 turned
to face the pins), and the 1.2 mm trunk climbs, takes one 45-degree step and runs through the C1104
and C1105 pad centres. The pin 4 BTST1 via moves to (92.85, 55.0); the GND stitching via in the
trunk path moves to (95.0, 55.3). The VAC pins get a signal-width connection from grid_router.py.

P4_5V: the In2 trunk from J100 ends on the JP1200 pad 2 centre. The back-layer run that wrapped
round the P4_5V_ISO pad only served TP102; it goes, and TP102 moves beside JP1200 (free_spot.py),
where the router gives it one straight stub. Rerunning is safe: the script owns this copper.
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())            # read first: this SWIG build fails if read after pad lists
fs = {f.GetReference(): f for f in b.GetFootprints()}
mm = lambda v: pcb.ToMM(v) - 50

def ends(t):
    return [(mm(v.x), mm(v.y)) for v in ((t.GetPosition(),) if isinstance(t, pcb.PCB_VIA) else (t.GetStart(), t.GetEnd()))]

def seg(net, layer, pts, w):
    for a, c in zip(pts, pts[1:]):
        t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + a[0], 50 + a[1])); t.SetEnd(pt(50 + c[0], 50 + c[1]))
        t.SetWidth(pcb.FromMM(w)); t.SetLayer(layer); t.SetNet(b.FindNet(net)); b.Add(t)

def pad(ref, num):
    p = next(p for p in fs[ref].Pads() if p.GetNumber() == num)
    return mm(p.GetPosition().x), mm(p.GetPosition().y)

# ---- CHG_VBUS input at U1100 (back) ----
VB = [pad('U1100', '2'), pad('U1100', '3')]           # VBUS power pins; 8/9 are VAC sense pins
assert abs(VB[0][0] - VB[1][0]) < 0.01 and abs(VB[1][1] - VB[0][1] - 0.4) < 0.01
XBAR = VB[0][0] + 0.6                                  # 0.3 mm outside the 0.6 mm lands
YM = (VB[0][1] + VB[1][1]) / 2                         # midline of the pin pair
C6 = (93.75, YM)                                       # C1106 VBUS pad, facing the pins
GV = (95.0, 55.3)                                      # GND stitch beside C1106: clear of C1102, R1106, PD_GATE
c1106 = fs['C1106']
if pad('C1106', '1')[0] > pad('C1106', '2')[0]:        # pad 1 (VBUS) must face west
    c1106.SetOrientationDegrees(c1106.GetOrientationDegrees() + 180)
p1 = pad('C1106', '1'); pos = c1106.GetPosition()
c1106.SetPosition(pcb.VECTOR2I(pos.x + pcb.FromMM(C6[0] - p1[0]), pos.y + pcb.FromMM(C6[1] - p1[1])))
for t in tracks:
    n = t.GetNetname(); ps = ends(t)
    if n == 'CHG_VBUS' and not isinstance(t, pcb.PCB_VIA) and t.GetLayer() == pcb.B_Cu and \
            all(91.3 <= x <= 99.6 and 51.3 <= y <= 57.3 for x, y in ps):
        b.Remove(t)                      # earlier trunk (it fed the VAC pins), its neck and the pin 2/3 bridge
    elif n == 'GND' and any(abs(x - 93.22) < 0.05 and abs(y - 53.75) < 0.05 for x, y in ps):
        b.Remove(t)                      # stitching via in the new trunk path, and its stub
    elif n == 'GND' and isinstance(t, pcb.PCB_VIA) and any(abs(x - gx) < 0.05 and abs(y - gy) < 0.05 for x, y in ps for gx, gy in ((96.6, 53.7), GV)):
        b.Remove(t)                      # this script's replacement via (rerun)
    elif n == 'CHG_BTST1' and all(91.8 <= x <= 93.5 and 54.2 <= y <= 55.1 for x, y in ps):
        b.Remove(t)                      # pin 4 bootstrap fan-out, redrawn clear of the VBUS bar
c1104, c1105 = pad('C1104', '1'), pad('C1105', '1')
assert abs(c1104[1] - c1105[1]) < 0.01 and c1104[0] > C6[0] + 1.5
XD = C6[0] + 1.125                                     # one 45-degree step into the C1104 row
for p in VB:
    seg('CHG_VBUS', pcb.B_Cu, [p, (XBAR, p[1])], 0.2)
seg('CHG_VBUS', pcb.B_Cu, [(XBAR, VB[0][1]), (XBAR, VB[1][1])], 0.2)     # 0.2 mm keeps 0.2 mm to the BTST1 stub
seg('CHG_VBUS', pcb.B_Cu, [(XBAR, YM), C6], 0.6)
seg('CHG_VBUS', pcb.B_Cu, [C6, (C6[0], c1104[1] + (XD - C6[0])), (XD, c1104[1]), c1104, c1105], 1.2)
b4 = pad('U1100', '4'); c2 = pad('C1102', '1'); VBT = (92.85, 55.0)
seg('CHG_BTST1', pcb.B_Cu, [b4, (VBT[0] - (VBT[1] - b4[1]), b4[1]), VBT], 0.2)
v = pcb.PCB_VIA(b); v.SetPosition(pt(50 + VBT[0], 50 + VBT[1])); v.SetWidth(pcb.FromMM(0.6)); v.SetDrill(pcb.FromMM(0.3))
v.SetLayerPair(pcb.F_Cu, pcb.B_Cu); v.SetNet(b.FindNet('CHG_BTST1')); b.Add(v)
seg('CHG_BTST1', pcb.F_Cu, [VBT, (VBT[0] + (VBT[1] - c2[1]), c2[1]), c2], 0.25)
g = pcb.PCB_VIA(b); g.SetPosition(pt(50 + GV[0], 50 + GV[1])); g.SetWidth(pcb.FromMM(0.6)); g.SetDrill(pcb.FromMM(0.3))
g.SetLayerPair(pcb.F_Cu, pcb.B_Cu); g.SetNet(b.FindNet('GND')); b.Add(g)
dx = 0.0

# ---- P4_5V at JP1200 ----
j2 = pad('JP1200', '2')
# In2: down the J100 side, one 45-degree run that clears the JP1200 pad 1 corner by 1.5 mm,
# then 2.25 mm straight into the pad 2 centre from the west.
XB = 10.5; YA = j2[1] - (XB - 4.01)
for t in tracks:
    if t.GetNetname() != 'P4_5V' or isinstance(t, pcb.PCB_VIA): continue
    ps = ends(t)
    if t.GetLayer() == pcb.B_Cu and all(10.5 <= x <= 24.5 and 51.5 <= y <= 60.5 for x, y in ps):
        b.Remove(t)
    elif t.GetLayer() == pcb.In2_Cu:
        if all(3.9 <= x <= 13.0 and 50.0 <= y <= 60.0 for x, y in ps):
            b.Remove(t)                  # old diagonal and entry; redrawn below
        elif all(abs(x - 4.01) < 0.02 for x, y in ps):
            lo = t.GetEnd() if t.GetEnd().y > t.GetStart().y else t.GetStart()
            (t.SetEnd if lo == t.GetEnd() else t.SetStart)(pt(50 + 4.01, 50 + YA))
seg('P4_5V', pcb.In2_Cu, [(4.01, YA), (XB, j2[1]), j2], 1.2)

# ---- BOOST_5V output loop at C1206 (back) ----
# The loop's vertical runs on the C1206 pad 1 centre line. The top corner is a 45-degree chamfer
# starting at x 65.5, about 0.6 mm from the BOOST_SW land corner of L1200 (64.37, 51.25); the
# earlier corner sat 0.155 mm from it. The U1200 feed joins the vertical square at y 54.8.
c6 = pad('C1206', '1'); XC = c6[0]; XT = 65.5
for t in tracks:
    if t.GetNetname() != 'BOOST_5V' or isinstance(t, pcb.PCB_VIA) or t.GetLayer() != pcb.B_Cu: continue
    if all(63.0 <= x <= 76.0 and 51.5 <= y <= 58.75 for x, y in ends(t)):
        b.Remove(t)
seg('BOOST_5V', pcb.B_Cu, [(75.425, 51.8), (XT, 51.8), (XC, 51.8 + (XT - XC)), (XC, 58.7)], 1.2)
seg('BOOST_5V', pcb.B_Cu, [(64.17, 58.7), (75.425, 58.7)], 1.2)
for t in tracks:                         # U1200 pin 5 feed: one 45-degree exit, no 0.09 mm jog
    if t.GetNetname() == 'BOOST_5V' and not isinstance(t, pcb.PCB_VIA) and t.GetLayer() == pcb.B_Cu and \
            all(61.6 <= x <= 63.2 and 54.2 <= y <= 54.85 for x, y in ends(t)):
        b.Remove(t)
P5 = (61.65, 54.28)
seg('BOOST_5V', pcb.B_Cu, [P5, (P5[0] + 54.8 - P5[1], 54.8), (XC, 54.8)], 0.4)
pcb.SaveBoard(str(TARGET), b)
print('C1106 moved', round(dx, 3), 'mm; CHG_VBUS trunk redrawn; P4_5V In2 ends on JP1200.2', j2, flush=True)
import os; os._exit(0)
