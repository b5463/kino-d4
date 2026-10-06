"""SYS_5V camera trunk, riser and feed from Q1201 (KiCad 10 python). ODD JOBS 12, 17, 79, 152.

Loads: four TPS2553 camera switches (ILIM 25.5k, about 1 A each) behind the 20 mOhm shunts
RS200-RS500. Source: Q1201 (boost output switch, 2.6 A boost limit) and D1200 (P4 feed). Sizes from
IPC-2221 for 1 oz copper at 20 degrees C rise: 2.6 A needs 0.75 mm outer or 1.9 mm inner.

  trunk  F 0.7 mm along y 19.4 from RS200 to RS500, between the GPIO header pads (edge y 18.9)
         and P4_TX4 (edge y 19.9): the P4 bus already walls this band on F, so the trunk shares
         that layer and In2 stays free for the header-to-socket GPIO runs to cross it. 0.7 mm
         outer carries 2.5 A at 20 degrees C (an In2 trunk here could be 1.1 mm: 1.7 A). The feed
         enters in the middle, so each half carries two cameras, at most 2 A.
  drops  per shunt: two vias at y 19.4, 0.45 mm either side of pad 1, and a 0.8 mm B stub.
  riser  In2 2.0 mm at x 58.55 between the camera 2 and 3 sockets, one 45 degree step at the top
         to three vias into the trunk at x 59.5 (clear of the CAM2_EN B diagonal), on B for
         3.3 mm under the SYNC bus (In2, y 41.05), three vias at each layer change.
  feed   In2 2.0 mm along y 44.5 under the socket rows to x 80.6, down to y 51.2, then 1.4 mm
         45 degrees between the boost output vias to three vias at Q1201's SYS_5V pins (x 73.97);
         F 1.2 mm to Q1201.8. 1.4 mm for the last 10 mm: the BOOST_5V via pair at y 58.7 and the
         H4 keep-out leave no more.
Cleared for it (rip): every SYS_5V item north of y 30 (the old partial stubs, the RS500-to-U700
feed and the tie of U700's four SENSE+ pins, which become separate Kelvin pairs), camera 1's
SHUNT_OUT via at (26.2, 19.4) in the trunk band (it moves to (25.85, 20.6), the slot between
P4_TX4 and P4_TX3), the middle of IMU_INT (F stub end, In2 hop and B run on x 57.65; re-routed by
the grid router) and GND stitching via (78.12, 55.25). Moved (add): the CAM2/CAM4 5V_ISO vias
0.35 mm north out of the trunk, GND stitching via (81.50, 46.17) to (82.60, 46.17).
  J600   pogo pad 2 leaves on its centre line to a via between it and pad 8 (the slot between
         the pad rows is taken by the other pins' vias); the grid router joins that via.

  link   D1200 (P4 feed) to the same foot vias: B 1.6 mm from D1200.2 to three vias at x 52.0,
         In2 1.4 mm up to y 63.0, east, 45 degrees to y 62.4 past the MAIN_GATE via (64.70, 63.70),
         into the foot. Replaces the 0.8 mm F/B chain through five single vias (link-rip); the
         Q1201.8 - TP1200 branch of that chain stays. 1.4 mm is what the boost control vias at
         y 61.6-61.8 and y 63.7 leave.
Phases: rip, add, link-rip, link-add (separate processes, in that order).
"""
import sys
import pcbnew as pcb
from rework import TARGET
from routing import pt

PHASE = sys.argv[1] if len(sys.argv) > 1 else ''
assert PHASE in ('rip', 'add', 'link-rip', 'link-add'), 'run: rip, add, link-rip, link-add'
b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())
mm = lambda v: pcb.ToMM(v) - 50
near = lambda a, c, e=0.02: abs(a[0] - c[0]) < e and abs(a[1] - c[1]) < e
def ends(t): return [(mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))]
def at(t): return (mm(t.GetPosition().x), mm(t.GetPosition().y))
F, I2, B = pcb.F_Cu, pcb.In2_Cu, pcb.B_Cu
LAYER = {'F': F, 'I2': I2, 'B': B}
SHUNTS = [24.04, 46.04, 68.04, 90.04]

RIP_SEGS = [('CAM1_SHUNT_OUT', 'B', (26.2, 19.4), (26.2, 20.23)), ('CAM1_SHUNT_OUT', 'B', (26.2, 20.23), (26.97, 21.0)),
            ('CAM1_SHUNT_OUT', 'I2', (26.2, 19.4), (26.55, 19.75)), ('CAM1_SHUNT_OUT', 'I2', (26.55, 19.75), (26.55, 24.85)),
            ('IMU_INT', 'F', (56.8, 16.0), (56.8, 19.15)), ('IMU_INT', 'I2', (56.8, 19.15), (56.8, 19.75)), ('IMU_INT', 'I2', (56.8, 19.75), (57.65, 20.6)),
            ('IMU_INT', 'B', (57.65, 41.5), (57.65, 20.6)), ('IMU_INT', 'B', (55.5, 43.65), (57.65, 41.5)),
            ('IMU_INT', 'B', (55.5, 45.6), (55.5, 43.65))]
RIP_VIAS = [('CAM1_SHUNT_OUT', (26.2, 19.4)), ('IMU_INT', (56.8, 19.15)), ('IMU_INT', (57.65, 20.6)), ('GND', (78.12, 55.25))]
MOVE_VIAS = [('CAM2_5V_ISO', (40.95, 18.8), (40.95, 18.45)), ('CAM4_5V_ISO', (84.95, 18.8), (84.95, 18.45)),
             ('GND', (81.5, 46.17), (82.6, 46.17))]

LINK_RIP = [('F', (65.55, 61.75), (69.35, 61.75)), ('B', (65.55, 61.75), (64.95, 62.35)), ('B', (64.95, 62.35), (61.9, 62.35)),
            ('B', (61.9, 62.35), (60.25, 60.7)), ('F', (60.25, 60.7), (56.7, 60.7)), ('F', (56.7, 60.7), (56.3, 60.3)),
            ('F', (56.3, 60.3), (56.3, 56.6)), ('F', (56.3, 56.6), (55.9, 56.2)), ('F', (55.9, 56.2), (53.55, 56.2)),
            ('B', (53.23, 56.27), (50.5, 59.0))]
LINK_RIP_VIAS = [(65.55, 61.75), (60.25, 60.7), (53.55, 56.2)]
if PHASE == 'link-rip':
    doomed = []
    for t in tracks:
        if t.GetNetname() != 'SYS_5V': continue
        if isinstance(t, pcb.PCB_VIA):
            if any(near(at(t), p) for p in LINK_RIP_VIAS): doomed.append(t)
            continue
        e = ends(t); lay = {F: 'F', I2: 'I2', B: 'B'}.get(t.GetLayer())
        if any(lay == rl and ((near(e[0], p) and near(e[1], q)) or (near(e[0], q) and near(e[1], p))) for rl, p, q in LINK_RIP): doomed.append(t)
    n = len(doomed)
    assert n == len(LINK_RIP) + len(LINK_RIP_VIAS), ('link-rip found', n)
    for t in doomed: b.Remove(t)
    pcb.SaveBoard(str(TARGET), b)
    print(f'sys5v link-rip: {n} items of the old D1200 - Q1201 chain', flush=True)
    import os; os._exit(0)

if PHASE == 'rip':
    doomed = []
    for t in tracks:
        n = t.GetNetname()
        if isinstance(t, pcb.PCB_VIA):
            if (n == 'SYS_5V' and at(t)[1] < 30) or any(n == rn and near(at(t), p) for rn, p in RIP_VIAS): doomed.append(t)
            continue
        e = ends(t)
        if n == 'SYS_5V' and max(e[0][1], e[1][1]) < 30: doomed.append(t); continue
        lay = {F: 'F', I2: 'I2', B: 'B'}.get(t.GetLayer())
        for rn, rl, p, q in RIP_SEGS:
            if n == rn and lay == rl and ((near(e[0], p) and near(e[1], q)) or (near(e[0], q) and near(e[1], p))): doomed.append(t); break
    names = sorted({t.GetNetname() for t in doomed})
    n = len(doomed)
    for t in doomed: b.Remove(t)                 # last: Remove() invalidates the other proxies
    pcb.SaveBoard(str(TARGET), b)
    print(f'sys5v rip: {n} items on {names}', flush=True)
    import os; os._exit(0)

codes = {n: b.FindNet(n).GetNetCode() for n in ('SYS_5V', 'CAM1_SHUNT_OUT')}
def trk(net, layer, w, pts):
    for a, c in zip(pts, pts[1:]):
        dx, dy = abs(c[0] - a[0]), abs(c[1] - a[1])
        assert min(dx, dy) < 1e-6 or abs(dx - dy) < 1e-6, (net, 'non-45', a, c)
        t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + a[0], 50 + a[1])); t.SetEnd(pt(50 + c[0], 50 + c[1]))
        t.SetWidth(pcb.FromMM(w)); t.SetLayer(LAYER[layer]); t.SetNetCode(codes[net]); t.SetLocked(True); b.Add(t)
def via(net, x, y):
    v = pcb.PCB_VIA(b); v.SetPosition(pt(50 + x, 50 + y)); v.SetWidth(pcb.FromMM(.6)); v.SetDrill(pcb.FromMM(.3))
    v.SetViaType(pcb.VIATYPE_THROUGH); v.SetLayerPair(F, B); v.SetNetCode(codes[net]); v.SetLocked(True); b.Add(v)

if PHASE == 'link-add':
    trk('SYS_5V', 'B', 1.6, [(50.5, 59.0), (52.0, 59.0)])
    trk('SYS_5V', 'B', 1.2, [(52.0, 58.3), (52.0, 59.7)])
    for y in (58.3, 59.0, 59.7): via('SYS_5V', 52.0, y)
    trk('SYS_5V', 'I2', 1.4, [(52.0, 58.3), (52.0, 63.0), (63.0, 63.0), (63.6, 62.4), (73.47, 62.4), (73.97, 61.9)])
    pcb.SaveBoard(str(TARGET), b)
    print('sys5v link-add: D1200 - foot on In2 1.4 mm', flush=True)
    import os; os._exit(0)

moved = []
for net, old, new in MOVE_VIAS:                  # vias with their track ends; attached tracks run along the move
    hit = [t for t in tracks if isinstance(t, pcb.PCB_VIA) and t.GetNetname() == net and near(at(t), old)]
    assert len(hit) == 1, (net, old, len(hit))
    hit[0].SetPosition(pt(50 + new[0], 50 + new[1]))
    for t in tracks:
        if isinstance(t, pcb.PCB_VIA) or t.GetNetname() != net: continue
        s, e = ends(t)
        if near(s, old): t.SetStart(pt(50 + new[0], 50 + new[1]))
        elif near(e, old): t.SetEnd(pt(50 + new[0], 50 + new[1]))
        else: continue
        s, e = ends(t); dx, dy = abs(e[0] - s[0]), abs(e[1] - s[1])
        assert min(dx, dy) < 1e-6 or abs(dx - dy) < 1e-6, (net, 'move made a non-45 track', s, e)
    moved.append(f'{net} {old}->{new}')

# camera 1 shunt output: via in the P4_TX4 / P4_TX3 slot, clear of the trunk band
via('CAM1_SHUNT_OUT', 25.85, 20.6)
trk('CAM1_SHUNT_OUT', 'B', 0.5, [(26.97, 21.0), (26.57, 20.6), (25.85, 20.6)])
trk('CAM1_SHUNT_OUT', 'I2', 0.5, [(25.85, 20.6), (26.55, 21.3), (26.55, 24.85)])
# trunk and drops
trk('SYS_5V', 'F', 0.7, [(SHUNTS[0] - 0.45, 19.4), (SHUNTS[-1] + 0.45, 19.4)])
for x0 in SHUNTS:
    for dx in (-0.45, 0.45): via('SYS_5V', round(x0 + dx, 3), 19.4)
    trk('SYS_5V', 'B', 0.8, [(x0, 21.0), (x0, 19.4)])
    trk('SYS_5V', 'B', 0.8, [(round(x0 - 0.45, 3), 19.4), (round(x0 + 0.45, 3), 19.4)])
# riser between cameras 2 and 3, on B under the SYNC bus
X = 58.55
for x in (58.8, 59.5, 60.2): via('SYS_5V', x, 19.4)
trk('SYS_5V', 'I2', 2.0, [(59.5, 19.4), (59.5, 20.35), (X, 21.3), (X, 39.4)])
for y in (39.4, 42.7):
    for dx in (-0.7, 0, 0.7): via('SYS_5V', round(X + dx, 3), y)
    trk('SYS_5V', 'B', 1.2, [(X - 0.7, y), (X + 0.7, y)])
trk('SYS_5V', 'B', 2.0, [(X, 39.4), (X, 42.7)])
trk('SYS_5V', 'I2', 2.0, [(X, 42.7), (X, 44.5)])
# feed from Q1201
trk('SYS_5V', 'I2', 2.0, [(X, 44.5), (80.6, 44.5), (80.6, 51.2)])
trk('SYS_5V', 'I2', 1.4, [(80.6, 51.2), (73.97, 57.83), (73.97, 61.9)])
for y in (60.3, 61.1, 61.9): via('SYS_5V', 73.97, y)
trk('SYS_5V', 'F', 1.2, [(73.97, 60.3), (73.97, 63.09)])
# J600 pogo pad 2 escape
trk('SYS_5V', 'F', 0.4, [(18.54, 49.0), (18.54, 50.27)])
via('SYS_5V', 18.54, 50.27)
pcb.SaveBoard(str(TARGET), b)
print('sys5v add: trunk, 4 drops, riser, feed; moved', '; '.join(moved), flush=True)
import os; os._exit(0)
