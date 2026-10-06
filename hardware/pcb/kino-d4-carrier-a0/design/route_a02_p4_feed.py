"""P4 5 V feed around the JP1200 0 ohm link (KiCad 10 python). ODD JOBS 12, 17, 79, 152.

JP1200 is now a front SMD link (pad 1 P4_5V_ISO at (12.75, 57.0), pad 2 P4_5V at (12.75, 59.54)).
Before, a 1.2 mm B.Cu run carried P4_5V_ISO from D1200 along y 64.51 to the old through-hole pin,
and the P4_5V In2 trunk and the TP102 link ended on the other pin. On the back that run now passes
under the J1300, J102 and J800 connectors, and both link pins changed layer.

  P4_5V_ISO  D1200.1 -> B 1.2 mm stub -> 3 vias at x 49.0 -> In2 2.0 mm along y 63.75, 45 degrees
             up clear of H3 -> 3 vias at y 55.85 -> F to JP1200 pad 1. In2 at 2.0 mm: an inner
             1 oz layer carries less than the outer 1.2 mm did for the same temperature rise.
  P4_5V      JP1200 pad 2 -> F -> 3 vias at y 60.70 -> In2 trunk (from (10.5, 59.54), 45 degrees)
             and the TP102 B link.
Three 0.3 mm vias per layer change for an assumed 3 A. The GND stitching vias at (34.12, 62.55)
and (27.62, 64.95) move clear of the In2 run. Phases: rip, add (separate processes).
"""
import sys
import pcbnew as pcb
from rework import TARGET
from routing import pt

PHASE = sys.argv[1] if len(sys.argv) > 1 else ''
assert PHASE in ('rip', 'add'), 'run: rip, add'
b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())
mm = lambda v: pcb.ToMM(v) - 50
near = lambda a, c: abs(a[0] - c[0]) < 0.01 and abs(a[1] - c[1]) < 0.01
def ends(t): return (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))
F, I2, B = pcb.F_Cu, pcb.In2_Cu, pcb.B_Cu

OLD = [('P4_5V_ISO', B, None),                                   # every P4_5V_ISO track (the old run)
       ('P4_5V', I2, ((10.5, 59.54), (12.75, 59.54))),
       ('P4_5V', B, ((9.0, 59.54), (12.75, 59.54)))]
MOVE_VIAS = {('GND', (34.12, 62.55)): (34.12, 62.0), ('GND', (27.62, 64.95)): (27.62, 65.55)}

if PHASE == 'rip':
    doomed = []
    for t in tracks:
        if isinstance(t, pcb.PCB_VIA): continue
        for net, layer, seg in OLD:
            if t.GetNetname() != net or t.GetLayer() != layer: continue
            s, e = ends(t)
            if seg is None or (near(s, seg[0]) and near(e, seg[1])) or (near(s, seg[1]) and near(e, seg[0])):
                doomed.append(t); break
    n = len(doomed)
    for t in doomed: b.Remove(t)
    pcb.SaveBoard(str(TARGET), b)
    print('p4 feed rip:', n, 'segments', flush=True)
    import os; os._exit(0)

codes = {n: b.FindNet(n).GetNetCode() for n in ('P4_5V_ISO', 'P4_5V')}
def trk(net, layer, w, pts):
    for a, c in zip(pts, pts[1:]):
        dx, dy = abs(c[0] - a[0]), abs(c[1] - a[1])
        assert min(dx, dy) < 1e-6 or abs(dx - dy) < 1e-6, (net, 'non-45', a, c)
        t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + a[0], 50 + a[1])); t.SetEnd(pt(50 + c[0], 50 + c[1]))
        t.SetWidth(pcb.FromMM(w)); t.SetLayer(layer); t.SetNetCode(codes[net]); t.SetLocked(True); b.Add(t)
def via(net, x, y):
    v = pcb.PCB_VIA(b); v.SetPosition(pt(50 + x, 50 + y)); v.SetWidth(pcb.FromMM(.6)); v.SetDrill(pcb.FromMM(.3))
    v.SetViaType(pcb.VIATYPE_THROUGH); v.SetLayerPair(F, B); v.SetNetCode(codes[net]); v.SetLocked(True); b.Add(v)

for t in tracks:                                   # stitching vias out of the In2 run (no tracks on them)
    if isinstance(t, pcb.PCB_VIA):
        at = (mm(t.GetPosition().x), mm(t.GetPosition().y))
        for (net, old), new in MOVE_VIAS.items():
            if t.GetNetname() == net and near(at, old): t.SetPosition(pt(50 + new[0], 50 + new[1]))

# P4_5V_ISO
for y in (62.9, 63.65, 64.4): via('P4_5V_ISO', 49.0, y)
trk('P4_5V_ISO', B, 1.2, [(50.5, 63.0), (49.0, 63.0)])
trk('P4_5V_ISO', B, 1.2, [(49.0, 62.9), (49.0, 64.4)])
trk('P4_5V_ISO', I2, 2.0, [(49.0, 63.75), (28.75, 63.75), (20.85, 55.85), (12.0, 55.85)])   # 45 degrees clear of the H3 keep-out corner (21.76, 58.6)
trk('P4_5V_ISO', I2, 1.2, [(49.0, 62.9), (49.0, 64.4)])
for x in (12.0, 12.75, 13.5): via('P4_5V_ISO', x, 55.85)
trk('P4_5V_ISO', F, 1.2, [(12.0, 55.85), (13.5, 55.85)])
trk('P4_5V_ISO', F, 1.6, [(12.75, 55.85), (12.75, 57.0)])
# P4_5V
for x in (12.0, 12.75, 13.5): via('P4_5V', x, 60.70)
trk('P4_5V', F, 1.2, [(12.0, 60.70), (13.5, 60.70)])
trk('P4_5V', F, 1.6, [(12.75, 59.54), (12.75, 60.70)])
trk('P4_5V', I2, 1.2, [(10.5, 59.54), (11.66, 60.70), (13.5, 60.70)])
trk('P4_5V', B, 0.3, [(9.0, 59.54), (10.16, 60.70), (12.0, 60.70)])
pcb.SaveBoard(str(TARGET), b)
print('p4 feed add: P4_5V_ISO In2 2.0 mm with 2 x 3 vias; P4_5V 3 vias at the link', flush=True)
import os; os._exit(0)
