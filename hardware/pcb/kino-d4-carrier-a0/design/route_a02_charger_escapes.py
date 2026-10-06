"""BQ25798 left-column escapes (KiCad 10 python). Design package 0.1.8, A0.2.

The charger is a 0.4 mm-pitch QFN on the back. Its left column (pads 16-24) had no usable
escape: the CHG_BTST2 via at (87.25, 55.5) sat 0.85 mm in front of pads 18-20, the BAT escape
dipped to y 54.66 under C1119, and the 2.4 mm In2 pack trace at y 58.4 forbids any via below
y 56.75 between x 85.3 and 92.1. Four signal pads (PROG, BTST2, BATP, ILIM) and the SDRV pad
could not leave the part, so the grid router reported them exhausted.

Changes, all local to the charger corner, no net changes:

* C1119 (BAT bulk, back) moves up 0.625 mm so the BAT escape from pads 22/23 runs straight at
  y 54.0 into the 1.2 mm BAT stub, which is extended to the new pad centre. The dip is gone.
* C1103 (BTST2 bootstrap, front) moves onto the front face over the charger body, next to the
  CHG_SW2 crossover vias: SW2 reaches it with a 0.9 mm front stub, BTST2 through one via.
* C1100 (1 nF on SDRV, back) moves to the front above-left of the part; SDRV reaches it through
  one via at (86.7, 53.15), the only via site in that corner clear of the In2 CHG_SW2 trace.
* R1104 and R1105 (ILIM_HIZ divider, front) move to the back below the charger, between the
  REGN front trace and the pack connector. ILIM then stays on the back from pad 17 to the
  divider; REGN reaches R1104 through a via on the corner of its own front trace.
* Escapes, straight out of each pad on its centre line, 0.2 mm (ILIM 0.15 mm where it passes
  pad 16): PROG via (87.1, 54.75) above the lanes to R1100 on the front; BTST2 via (86.0, 56.65)
  and BATP via (87.0, 56.7) below the lanes, 0.25 mm above the In2 pack trace; BATP continues
  on the front up the corridor between R1101 and the field to R1101 pad 2; TS leaves pad 16
  downward as a stub for the router.

Removed: the pass-1 CHG_TS and CHG_SDRV routes, the old BTST2 via and stubs, the old CHG_SW2
front stub, the dipped BAT escape and the C1119 ground via (ground vias are re-planned by
gnd_stitch.py). Re-running removes and redraws only the copper listed here.
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                       # SWIG order trap: read before pad lists
fs = {f.GetReference(): f for f in b.GetFootprints()}
pads = {(f.GetReference(), p.GetNumber()): p for f in b.GetFootprints() for p in f.Pads()}
mm = lambda v: pcb.ToMM(v) - 50
def pos(p): return (mm(p.GetPosition().x), mm(p.GetPosition().y))
def P(r, n): return pos(pads[(r, str(n))])
F, B, I2 = pcb.F_Cu, pcb.B_Cu, pcb.In2_Cu
near = lambda a, c: abs(a[0] - c[0]) < 0.01 and abs(a[1] - c[1]) < 0.01

# ---- placement -------------------------------------------------------------------------
def place(ref, x, y, back, pad1_dx=None, pad1_dy=None):
    """Put ref at (x, y) on the chosen face, rotated so pad 1 lies in the requested direction."""
    f = fs[ref]
    if f.IsFlipped() != back: f.Flip(f.GetPosition(), pcb.FLIP_DIRECTION_LEFT_RIGHT)
    f.SetPosition(pt(50 + x, 50 + y))
    for a in (0, 90, 180, 270):
        f.SetOrientationDegrees(a)
        px, py = P(ref, 1)
        if (pad1_dx is None or (px - x) * pad1_dx > 0.1) and (pad1_dy is None or (py - y) * pad1_dy > 0.1): break
    else: raise AssertionError((ref, 'orientation'))
    f.Reference().SetPosition(f.GetPosition())
    return P(ref, 1), P(ref, 2)

fs['C1119'].SetPosition(pt(50 + 85.0, 50 + 53.125))        # was (85.0, 53.75): 0.625 mm up, orientation kept
place('C1103', 88.5, 55.75, back=False, pad1_dy=+1)      # pad 1 BTST2 below, pad 2 SW2 above
place('C1100', 86.4, 51.6, back=False, pad1_dy=+1)       # pad 1 SDRV below
place('R1104', 85.25, 60.5, back=True, pad1_dx=-1)       # pad 1 REGN left, pad 2 ILIM right
place('R1105', 88.4, 60.5, back=True, pad1_dx=-1)        # pad 1 ILIM left, pad 2 GND right
for ref, exp in [('C1119', {'1': (84.225, 53.125), '2': (85.775, 53.125)}),
                 ('C1103', {'1': (88.5, 56.525), '2': (88.5, 54.975)}),
                 ('C1100', {'1': (86.4, 52.375), '2': (86.4, 50.825)}),
                 ('R1104', {'1': (84.425, 60.5), '2': (86.075, 60.5)}),
                 ('R1105', {'1': (87.575, 60.5), '2': (89.225, 60.5)})]:
    for n, (x, y) in exp.items():
        assert near(P(ref, n), (x, y)), (ref, n, P(ref, n), (x, y))

# ---- copper this script owns --------------------------------------------------------------
RIP_NETS = ('CHG_TS', 'CHG_SDRV', 'CHARGE_CE_N')    # pass-1 routes: redrawn below or left to a later pass;
                                                     # CE_N hugged R1106 (via at 96.4/53.55 plus an In2 drop) and sealed the TS pad
OLD = [  # (net, layer, polyline) removed if present
    ('CHG_BTST2', B, [(88.137, 55.4), (87.35, 55.4)]),
    ('CHG_BTST2', F, [(87.025, 55.5), (86.25, 56.275)]),
    ('CHG_SW2', F, [(86.25, 54.725), (88.875, 54.725), (89.4, 55.25)]),
    ('BAT_PROTECTED', B, [(88.1, 54.0), (87.55, 54.0), (86.89, 54.66), (84.48, 54.66)]),
    ('BAT_PROTECTED', B, [(84.22, 54.4), (84.225, 53.75)]),
    ('BAT_PROTECTED', B, [(88.1, 54.2), (88.1, 54.0)]),                 # stub from an earlier run of this script
    # front stubs that served R1104/R1105 at their old position
    ('CHG_REGN', F, [(84.1, 59.7), (84.1, 58.15), (82.85, 58.15), (82.85, 57.825), (82.0, 57.825)]),
    ('CHG_ILIM', F, [(82.75, 54.575), (81.15, 54.575), (81.15, 56.175), (82.0, 56.175)]),
    # right column: the BTST1 via sat in front of pad 5 (REGN); the pass-1 VBUS sense run to R1002 walled the
    # bottom edge of the part at y 56.85 and is left to pass 3
    ('CHG_BTST1', B, [(91.9, 54.6), (92.45, 54.6), (92.85, 55.0)]),
    ('CHG_BTST1', F, [(92.85, 55.0), (93.125, 54.725), (93.75, 54.725)]),
    ('CHG_VBUS', B, [(91.4, 56.85), (96.9, 56.85), (98.3, 58.25), (98.3, 66.5), (100.1, 66.5)]),
    ('CHG_VBUS', F, [(100.1, 66.5), (100.975, 66.5)]),
]
OLD_VIAS = [('CHG_BTST2', (87.25, 55.5)), ('GND', (86.775, 53.75)), ('CHG_BTST1', (92.85, 55.0)), ('CHG_VBUS', (100.1, 66.5))]
ROUTES = [  # (net, layer, width, polyline)
    ('BAT_PROTECTED', B, 1.2, [(84.22, 54.4), (84.22, 53.125)]),     # 5 um off the pad centre, as the old stub was
    ('BAT_PROTECTED', B, 0.5, [(88.1, 54.0), (84.5, 54.0)]),            # 0.5 mm centred between pads 22 and 23 covers both
    # PROG: lane, via above the lanes, front to R1100 pad 1 entered from below
    ('CHG_PROG', B, 0.2, [P('U1100', 20), (87.5, 55.0), (87.25, 54.75), (87.1, 54.75)]),
    ('CHG_PROG', F, 0.2, [(87.1, 54.75), (87.1, 54.4), (87.5, 54.0), (88.0, 54.0), P('R1100', 1)]),
    # BTST2: lane over the BATP corner, down to its via, front to C1103 pad 1
    ('CHG_BTST2', B, 0.2, [P('U1100', 19), (86.0, 55.4), (86.0, 56.65)]),
    ('CHG_BTST2', F, 0.2, [(86.0, 56.65), (86.0, 56.3), (86.25, 56.05), (88.025, 56.05), P('C1103', 1)]),
    ('CHG_SW2', F, 0.2, [P('C1103', 2), (88.875, 54.975), (89.4, 54.45)]),
    # BATP: lane, down to its via, front corridor between R1101 and the field to R1101 pad 2
    ('CHG_BATP', B, 0.2, [P('U1100', 18), (87.0, 55.8), (87.0, 56.7)]),
    ('CHG_BATP', F, 0.2, [(87.0, 56.7), (87.0, 56.95), (86.7, 57.25), (85.6, 57.25), (85.35, 57.0), (85.35, 53.925), (85.1, 53.675), P('R1101', 2)]),
    # ILIM: lane, down past pad 16 into R1105 pad 1, across to R1104 pad 2 - all on the back
    ('CHG_ILIM', B, 0.15, [P('U1100', 17), (87.55, 56.2), (87.55, 60.5), P('R1104', 2)]),
    ('CHG_REGN', B, 0.2, [(84.1, 59.7), (84.1, 60.175), P('R1104', 1)]),
    # SDRV: lane to its via, front up into C1100 pad 1
    ('CHG_SDRV', B, 0.2, [P('U1100', 24), (86.95, P('U1100', 24)[1]), (86.7, 53.15)]),   # pad 24 anchor is (88.1375, 53.4)
    ('CHG_SDRV', F, 0.2, [(86.7, 53.15), (86.7, 52.675), P('C1100', 1)]),
    # right column: BTST1 via moved 0.2 mm right and 0.05 mm up, clear of the REGN lane; REGN (pad 5) runs
    # down the outside of pads 6-8 on the back and along y 57.4 into C1101 pad 1
    ('CHG_BTST1', B, 0.2, [P('U1100', 4), (92.7, 54.6), (93.05, 54.95)]),
    ('CHG_BTST1', F, 0.25, [(93.05, 54.95), (93.275, 54.725), P('C1102', 1)]),
    ('CHG_REGN', B, 0.15, [P('U1100', 5), (92.45, 55.0), (92.45, 57.1)]),
    ('CHG_REGN', B, 0.2, [(92.45, 57.1), (92.75, 57.4), (95.6, 57.4), (95.95, 57.75), P('C1101', 1)]),
    # TS at R1106 pad 2: up out of the pad into a via above it, the only via site around that pad
    ('CHG_TS', F, 0.2, [P('R1106', 2), (96.0, 53.55), (96.2, 53.35)]),
    # TS: stub down out of the corner pad, between the R1105 pads, for the router
    ('CHG_TS', B, 0.2, [P('U1100', 16), (P('U1100', 16)[0], 57.9), (88.4, 57.9 + 88.4 - P('U1100', 16)[0]), (88.4, 61.0)]),
]
VIAS = [('CHG_PROG', (87.1, 54.75)), ('CHG_BTST2', (86.0, 56.65)), ('CHG_BATP', (87.0, 56.7)),
        ('CHG_SDRV', (86.7, 53.15)), ('CHG_REGN', (84.1, 59.7)), ('CHG_BTST1', (93.05, 54.95)),
        ('CHG_TS', (96.2, 53.35))]

def owned(t):
    s, e = (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))
    for net, layer, *rest in OLD + [(n, l, p) for n, l, w, p in ROUTES]:
        poly = rest[-1]
        if t.GetNetname() != net or t.GetLayer() != layer: continue
        for a, c in zip(poly, poly[1:]):
            if (near(s, a) and near(e, c)) or (near(s, c) and near(e, a)): return True
    return False

removed = 0
for t in tracks:
    if t.GetNetname() in RIP_NETS: b.Remove(t); removed += 1; continue
    if isinstance(t, pcb.PCB_VIA):
        at = (mm(t.GetPosition().x), mm(t.GetPosition().y))
        if any(t.GetNetname() == n and near(at, p) for n, p in VIAS + OLD_VIAS): b.Remove(t); removed += 1
    elif owned(t): b.Remove(t); removed += 1

for net, layer, width, poly in ROUTES:
    for a, c in zip(poly, poly[1:]):
        dx, dy = abs(c[0] - a[0]), abs(c[1] - a[1])
        assert min(dx, dy) < 2e-3 or abs(dx - dy) < 2e-3, (net, 'non-45 segment', a, c)
        t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + a[0], 50 + a[1])); t.SetEnd(pt(50 + c[0], 50 + c[1]))
        t.SetWidth(pcb.FromMM(width)); t.SetLayer(layer); t.SetNet(b.FindNet(net)); b.Add(t)
for net, (x, y) in VIAS:
    v = pcb.PCB_VIA(b); v.SetPosition(pt(50 + x, 50 + y)); v.SetWidth(pcb.FromMM(.6)); v.SetDrill(pcb.FromMM(.3))
    v.SetViaType(pcb.VIATYPE_THROUGH); v.SetLayerPair(F, B); v.SetNet(b.FindNet(net)); b.Add(v)
pcb.SaveBoard(str(TARGET), b)
print('charger escapes: removed', removed, 'items; drew', sum(len(p) - 1 for *_, p in ROUTES), 'segments,', len(VIAS), 'vias; moved C1119 C1103 C1100 R1104 R1105', flush=True)
import os; os._exit(0)
