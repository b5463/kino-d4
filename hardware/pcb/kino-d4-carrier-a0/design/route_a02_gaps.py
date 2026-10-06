"""Explicit closes for the A0.2 gaps the grid router cannot reach (KiCad 10 python).

Each is a short hand route under the pad-entry rules, drawn once from the pad centre:

1. CHG_VBUS: BQ25798 pads 8 and 9 share the corner of the QFN. One 0.25 mm jog joins them
   (pad 8 down 0.15 mm, then 45 degrees into the centre of pad 9).
2. MB_3V3 to U800 pad 12 (top row): up out of the pad, right along y 53.65 past the GND vias,
   down the outside of the right column, into the existing C801 branch at (60.55, 55.78).
3. MB_3V3 to U800 pad 5 (bottom-left corner): every outside exit is within 0.6 mm of the C800
   ground via or the BOOST_FB feedback track on the back, and no clear via site exists beside
   C800 pad 2 (searched at 0.05 mm). The package has no exposed pad, so pad 5 joins pad 12 across
   the package interior at 0.25 mm: 0.2 mm clear of pads 6, 13 and 14, 0.2 mm clear of pads 10/11.
4. BOOST_5V sense tap for the feedback divider: its layer-change via sat under the U800 body at
   (58.75, 55.0), in the way of item 3, and its In2 run was an eleven-segment staircase. The via
   moves beside R1200 at (55.95, 54.1), outside the U800 land; the In2 run is three straight
   legs that pass below the TPS61288 pins instead of under the switch pads, into the existing
   via at (62.35, 57.1).

Run DRC afterwards. Re-running removes and redraws only these items (matched by net and points).
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())              # read first: this SWIG build fails if read after pad lists
fs = {f.GetReference(): f for f in b.GetFootprints()}
mm = lambda v: pcb.ToMM(v) - 50
def pad(r, n): return next(p for p in fs[r].Pads() if p.GetNumber() == str(n))
def pos(p): return (mm(p.GetPosition().x), mm(p.GetPosition().y))
F, B, I2 = pcb.F_Cu, pcb.B_Cu, pcb.In2_Cu
V1 = (55.95, 54.1)

ROUTES = [
    ('CHG_VBUS', B, 0.25, [pos(pad('U1100', 8)), (91.9, 56.35), pos(pad('U1100', 9))]),
    ('MB_3V3', F, 0.3, [pos(pad('U800', 12)), (59.0, 53.8), (59.15, 53.65), (60.25, 53.65), (60.4, 53.8), (60.4, 55.63), (60.55, 55.78)]),
    ('MB_3V3', F, 0.25, [pos(pad('U800', 5)), (58.0, 55.0), (58.25, 54.75), (58.75, 54.75), (59.0, 54.5), pos(pad('U800', 12))]),
    ('BOOST_5V', B, 0.3, [pos(pad('R1200', 1)), (56.3, 55.0), (55.95, 54.65), V1]),
    ('BOOST_5V', I2, 0.3, [V1, (57.0, 55.15), (58.3, 55.15), (59.9, 56.75), (62.0, 56.75), (62.35, 57.1)]),
]
VIAS = [('BOOST_5V', V1)]
# Copper this script supersedes: earlier attempts and the original sense-tap staircase.
OBSOLETE = [
    ('MB_3V3', F, [pos(pad('U800', 5)), (58.0, 56.45), (58.15, 56.6), (59.41, 56.6)]),
    ('BOOST_5V', B, [(58.75, 55.0), pos(pad('R1200', 1))]),
    ('BOOST_5V', I2, [(58.75, 55.0), (59.15, 55.4), (59.45, 55.4), (59.8, 55.75), (60.1, 55.75), (60.45, 56.1), (60.75, 56.1),
                      (61.1, 56.45), (61.4, 56.45), (61.75, 56.8), (62.05, 56.8), (62.35, 57.1)]),
]
OBSOLETE_VIAS = [('BOOST_5V', (58.75, 55.0))]
# The C800 ground via stays at its original site, on GND, whatever a previous run did to it.
C800_VIA, STRAY = (57.86, 56.75), (57.26, 57.0)

def near(a, c): return abs(a[0] - c[0]) < 0.003 and abs(a[1] - c[1]) < 0.003
def owned(t):
    s, e = (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))
    for net, layer, *_, poly in [(n, l, p) for n, l, w, p in ROUTES] + OBSOLETE:
        if t.GetNetname() != net or t.GetLayer() != layer: continue
        for a, c in zip(poly, poly[1:]):
            if (near(s, a) and near(e, c)) or (near(s, c) and near(e, a)): return True
    return False

removed = fixed = 0
for t in tracks:
    if isinstance(t, pcb.PCB_VIA):
        at = (mm(t.GetPosition().x), mm(t.GetPosition().y))
        if any(t.GetNetname() == n and near(at, p) for n, p in VIAS + OBSOLETE_VIAS): b.Remove(t); removed += 1
        elif near(at, STRAY) or near(at, C800_VIA):
            t.SetPosition(pt(50 + C800_VIA[0], 50 + C800_VIA[1])); t.SetNet(b.FindNet('GND')); fixed += 1
    elif owned(t): b.Remove(t); removed += 1
assert fixed == 1, fixed

for net, layer, width, poly in ROUTES:
    for a, c in zip(poly, poly[1:]):
        dx, dy = abs(c[0] - a[0]), abs(c[1] - a[1])
        assert min(dx, dy) < 1e-6 or abs(dx - dy) < 1e-6, (net, 'non-45 segment', a, c)
        t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + a[0], 50 + a[1])); t.SetEnd(pt(50 + c[0], 50 + c[1]))
        t.SetWidth(pcb.FromMM(width)); t.SetLayer(layer); t.SetNet(b.FindNet(net)); b.Add(t)
for net, (x, y) in VIAS:
    v = pcb.PCB_VIA(b); v.SetPosition(pt(50 + x, 50 + y)); v.SetWidth(pcb.FromMM(.6)); v.SetDrill(pcb.FromMM(.3))
    v.SetViaType(pcb.VIATYPE_THROUGH); v.SetLayerPair(F, B); v.SetNet(b.FindNet(net)); b.Add(v)
pcb.SaveBoard(str(TARGET), b)
print('gaps: removed', removed, 'items; drew', sum(len(p) - 1 for *_, p in ROUTES), 'segments and', len(VIAS), 'via; C800 via on GND', flush=True)
import os; os._exit(0)
