"""BAT_PROTECTED pour over the battery capacitor bank (C1117, C1118) on B.Cu.

Replaces a chain of short 1.2 mm segments that zig-zagged around GND vias. TI BQ25798 8.4.2
uses copper pours for the power nodes. The pour flows around foreign copper with 0.2 mm
clearance and connects BAT pads solidly; it joins the C1119 node at (84.22, 54.4).
Rerunning replaces the pour and removes the traces it supersedes.
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt

AREA = [(72.6, 54.0), (84.75, 54.0), (84.75, 55.1), (80.9, 55.1), (80.9, 57.35), (72.6, 57.35)]
X0, Y0, X1, Y1 = 72.6, 53.6, 84.3, 57.5

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())            # read first: this SWIG build fails if read after pad lists
net = b.FindNet('BAT_PROTECTED')
n = 0
for t in tracks:
    if t.GetNetname() != 'BAT_PROTECTED' or isinstance(t, pcb.PCB_VIA) or t.GetLayer() != pcb.B_Cu: continue
    ps = [(pcb.ToMM(p.x) - 50, pcb.ToMM(p.y) - 50) for p in (t.GetStart(), t.GetEnd())]
    if all(X0 <= x <= X1 and Y0 <= y <= Y1 for x, y in ps):
        b.Remove(t); n += 1
for z in list(b.Zones()):
    if not z.GetIsRuleArea() and z.GetNetname() == 'BAT_PROTECTED' and z.GetZoneName() == 'BAT bank':
        b.Remove(z)
z = pcb.ZONE(b)
z.SetLayer(pcb.B_Cu); z.SetNet(net); z.SetZoneName('BAT bank')
o = z.Outline(); o.NewOutline()
for x, y in AREA: o.Append(pt(50 + x, 50 + y))
z.SetAssignedPriority(5)
z.SetPadConnection(pcb.ZONE_CONNECTION_FULL)
z.SetLocalClearance(pcb.FromMM(0.2))
z.SetMinThickness(pcb.FromMM(0.25))
b.Add(z)
pcb.SaveBoard(str(TARGET), b)
print('BAT bank pour added; removed', n, 'superseded segments', flush=True)
import os; os._exit(0)
