"""USB-C VBUS from J1000 to the PD input FET Q1000 (drain row, north side).

9 V / 2 A PD contract: 2 A through two VBUS pads. Each pad escapes straight up at 0.5 mm,
then vias drop to a 1.0 mm back trunk that passes west of Q1000 into its drain row.
CC1/CC2 front escapes crossed both VBUS columns; they are removed here and rerouted
with a back-side hop. The gauge BAT feed that crossed the trunk path is removed and
rerouted as a sense-width trace. Coordinates are carrier mm.
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())            # read first: this SWIG build fails if read after pad lists
net = lambda n: b.FindNet(n)

def seg(n, layer, pts, w):
    for a, c in zip(pts, pts[1:]):
        t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + a[0], 50 + a[1])); t.SetEnd(pt(50 + c[0], 50 + c[1]))
        t.SetWidth(pcb.FromMM(w)); t.SetLayer(layer); t.SetNet(net(n)); b.Add(t)

def via(n, x, y):
    v = pcb.PCB_VIA(b); v.SetPosition(pt(50 + x, 50 + y)); v.SetWidth(pcb.FromMM(0.6)); v.SetDrill(pcb.FromMM(0.3))
    v.SetLayerPair(pcb.F_Cu, pcb.B_Cu); v.SetNet(net(n)); b.Add(v)

def inside(t, x0, y0, x1, y1):
    pts = [t.GetPosition()] if isinstance(t, pcb.PCB_VIA) else [t.GetStart(), t.GetEnd()]
    return any(x0 <= pcb.ToMM(p.x) - 50 <= x1 and y0 <= pcb.ToMM(p.y) - 50 <= y1 for p in pts)

for t in tracks:
    name = t.GetNetname()
    if name in ('USB_CC1', 'USB_CC2') and inside(t, 104.5, 56.0, 113.5, 62.0):
        b.Remove(t)
    elif name == 'BAT_PROTECTED' and not isinstance(t, pcb.PCB_VIA) and inside(t, 98.7, 55.0, 113.0, 58.0):
        b.Remove(t)                          # (98.61,60)-(103.25,55.36)-(110.34,55.36)-(112.72,57.75)

# A4/B9 column: pad -> U1000 pin 24 (VBUS sense) and a via to the back trunk.
seg('USB_VBUS', pcb.F_Cu, [(106.6, 61.0), (106.6, 56.2)], 0.5)
seg('USB_VBUS', pcb.F_Cu, [(106.6, 56.2), (106.79, 55.65)], 0.25)      # clear of pin 23 PD_2V7
via('USB_VBUS', 106.6, 57.4)
# A9/B4 column: pad -> D1001 TVS pad 1 -> two vias between the TVS and U1000.
seg('USB_VBUS', pcb.F_Cu, [(111.4, 61.0), (111.4, 59.0), (110.4, 59.0)], 0.5)
seg('USB_VBUS', pcb.F_Cu, [(110.4, 59.0), (110.2, 57.6), (109.4, 57.6)], 0.6)
via('USB_VBUS', 110.2, 57.6); via('USB_VBUS', 109.4, 57.6)
# Back trunk, 1.0 mm: vias -> west of Q1000 -> drain row link at (105.97, 41.53).
seg('USB_VBUS', pcb.B_Cu, [(109.4, 57.6), (110.2, 57.6)], 1.0)
seg('USB_VBUS', pcb.B_Cu, [(109.4, 57.6), (108.8, 56.9), (107.3, 56.9), (106.6, 57.4)], 1.0)   # under D1001 GND via
seg('USB_VBUS', pcb.B_Cu, [(106.6, 57.4), (105.2, 56.0), (105.2, 49.3), (105.6, 48.9)], 1.0)
# Front hop over the back CHG_VBUS diagonal (x + y = 151), two vias each end.
for y in (48.4, 49.3): via('USB_VBUS', 105.6, y)
via('USB_VBUS', 106.15, 42.9); via('USB_VBUS', 105.3, 42.5)   # north of the diagonal, clear of Q1000 pin 5
seg('USB_VBUS', pcb.B_Cu, [(105.2, 49.3), (105.6, 49.3), (105.6, 48.4)], 1.0)
seg('USB_VBUS', pcb.F_Cu, [(105.6, 49.3), (105.6, 48.4), (106.15, 47.85), (106.15, 42.9), (105.3, 42.5)], 0.8)   # clear of R1004
seg('USB_VBUS', pcb.B_Cu, [(106.15, 42.9), (105.97, 42.53), (105.97, 41.53)], 1.0)
seg('USB_VBUS', pcb.B_Cu, [(105.3, 42.5), (105.97, 42.53)], 1.0)

pcb.SaveBoard(str(TARGET), b)
print('USB VBUS routed')
