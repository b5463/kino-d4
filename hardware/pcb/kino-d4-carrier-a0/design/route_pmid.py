"""PMID bulk capacitors C1107-C1109 (3 x 10 uF) beside the BQ25798 PMID pin.

TI BQ25798 8.4.1: the 0.1 uF PMID capacitor (C1110) sits on the IC layer next to pin 29;
the remaining bulk capacitors connect with low impedance, same layer or through multiple
vias. C1107-C1109 were 13 mm away past the pack connector; they now stand on the front
over the charger, east of the L1100 switch-node keepout, tied down by five vias.
Rerunning removes and redraws only CHG_PMID copper north of y 47 and south of y 53.
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

for t in tracks:
    if t.GetNetname() != 'CHG_PMID': continue
    ps = [t.GetPosition()] if isinstance(t, pcb.PCB_VIA) else [t.GetStart(), t.GetEnd()]
    ys = [pcb.ToMM(p.y) - 50 for p in ps]; xs = [pcb.ToMM(p.x) - 50 for p in ps]
    pts = list(zip(xs, ys))
    base = [(90.9, 53.28), (90.9, 52.65), (92.3, 51.25)]     # pin 29 -> C1110 link, not ours
    if not isinstance(t, pcb.PCB_VIA) and all(min(abs(x - bx) + abs(y - by) for bx, by in base) < 0.02 for x, y in pts):
        continue
    if all(88.0 < x < 99.5 and 47.0 < y < 53.3 for x, y in pts):
        b.Remove(t)                      # everything else on CHG_PMID here is this script's copper

c1107, c1108, c1109, c1110 = pad('C1107', '1'), pad('C1108', '1'), pad('C1109', '1'), pad('C1110', '1')
assert all(p[1] < 53 for p in (c1107, c1108, c1109)), 'PMID capacitors expected above the charger'

# CHG_SW1 crosses on In2 (TI figure 8-21): diagonal x + y = 145.05 from (90.6, 54.45) to (94.25, 50.8),
# then x = 94.25 up to the inductor, 1.0 mm wide. Through vias keep 0.95 mm from that centreline,
# so the tie-down vias sit in the pocket west of the diagonal, beside C1110 and pin 29.
V1, V2 = (91.9, 51.65), (91.2, 52.35)   # on the pin 29 -> C1110 45-degree trace (x + y = 143.55): no extra links
for v in (V1, V2): via('CHG_PMID', *v)
# Front: C1107 pad to both vias; C1109 skirts the L1100 keepout corner (93.6, 49.3); C1108 runs
# along y 52.4, clear of the GND vias left by the VBUS capacitors.
seg('CHG_PMID', pcb.F_Cu, [V2, V1, c1107], 0.8)
seg('CHG_PMID', pcb.F_Cu, [c1109, (94.0, 49.9), c1107], 0.8)
seg('CHG_PMID', pcb.F_Cu, [c1108, (97.6, 52.4), (c1107[0], 52.4), c1107], 0.8)
# Back: both vias sit on the existing 0.4 mm pin 29 -> C1110 trace; no back links needed.

pcb.SaveBoard(str(TARGET), b)
print('PMID bulk routed:', dict(C1107=c1107, C1108=c1108, C1109=c1109, C1110=c1110))
