"""SYS_RAW from the charger SYS bank (C1111-C1115) to the boost inductor L1200 and U1200 VIN.

The SYS bank sits east of L1200 and the inductor input pad faces west; the back is closed
by the J400 socket pins to the north and the switch-node keepout covers the front under
L1200. The feed runs on In2: 3.0 mm, four vias at the bank, three below the L1200 pad.
Planning current 4.4 A at a 3.3 V cell. Requires 1 oz inner copper (fab note).
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

EAST = [(70.4, 47.0), (70.4, 47.9), (70.4, 48.8), (69.5, 48.8)]
WEST = [(56.75, 45.3), (56.75, 46.2), (56.75, 47.1)]   # left of the L1200 input pad, outside the front keepout (x 57.1)
owned = EAST + WEST
for t in tracks:
    if t.GetNetname() != 'SYS_RAW': continue
    if isinstance(t, pcb.PCB_VIA):
        p = t.GetPosition()
        if any(abs(pcb.ToMM(p.x) - 50 - x) < 0.05 and abs(pcb.ToMM(p.y) - 50 - y) < 0.05 for x, y in owned): b.Remove(t)
    elif t.GetLayer() == pcb.In2_Cu and pcb.ToMM(t.GetWidth()) > 2.9:
        b.Remove(t)

l_in = pad('L1200', '1'); c1115 = pad('C1115', '1')
assert l_in[0] < 60 and c1115[0] > 70, 'expected L1200 input west, SYS bank east'
for v in owned: via('SYS_RAW', *v)
# Back: bank pad -> east vias; west vias -> inductor input pad (pad bottom edge at y 51.25).
seg('SYS_RAW', pcb.B_Cu, [c1115, (70.4, 47.72)], 1.2)
seg('SYS_RAW', pcb.B_Cu, [(70.4, 47.0), (70.4, 48.8), (69.5, 48.8)], 1.2)
for x, y in WEST: seg('SYS_RAW', pcb.B_Cu, [(x, y), (l_in[0] - 0.8, y)], 0.9)
# In2 trunk, 3.0 mm along y 47.2: clear of the camera bus at y 43.8, the U1200 GND vias from y 53
# and the BOOST_5V vias at y 51.8.
seg('SYS_RAW', pcb.In2_Cu, [(70.4, 48.8), (70.4, 47.0)], 1.5)
seg('SYS_RAW', pcb.In2_Cu, [(70.4, 47.2), (56.75, 47.2)], 3.0)
seg('SYS_RAW', pcb.In2_Cu, [(56.75, 45.3), (56.75, 47.2)], 1.5)
# U1200 VIN via (63.2, 56.3) onto the trunk.
seg('SYS_RAW', pcb.In2_Cu, [(63.2, 47.2), (63.2, 56.3)], 0.6)

pcb.SaveBoard(str(TARGET), b)
print('boost input routed: L1200 in', l_in, 'C1115', c1115)
