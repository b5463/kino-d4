"""Move every external connection except the pogo field to the back, opposite the XIAOs (KiCad 10 python).

The XIAO sockets are on the front and the XIAOs must be the tallest parts on that face so the
cameras seat firmly in the case. Cable connectors and pin headers go to the back (the P4 side);
the J600 pogo field, J1100 (pack) and J1000 (USB-C) stay on the front. J100 moved in
place_a02_j100.py.

  flip    J101 and JP200-JP500 (one row along x) mirror top-bottom about their own row, JP1200
          (one row along y) left-right: every pad stays where it was, so their copper is kept.
          J201-J501 (2 x 5) mirror top-bottom and shift 2.54 mm back into their outline: the two
          rows swap, so their copper is re-routed. The nine JST-GH cable connectors mirror
          left-right about their outline centre onto B.Cu (pin order reverses along the row).
  tofront swap the low back-side parts under J901, J102 and J1300 to the front in place
  rip     remove tracks and vias that now touch a pad of another net (the swapped header rows);
          F.Cu copper left at the old JST pads is then cleared with drop_dangling.py.
After 'flip', run free_spot.py for each connector that lands on back-side parts. Each phase runs
in its own process.
"""
import sys
import pcbnew as pcb
from rework import TARGET
from routing import pt

PHASE = sys.argv[1] if len(sys.argv) > 1 else ''
assert PHASE in ('flip', 'tofront', 'rip'), 'run: flip, tofront, rip'
ROW_X = ['J101', 'JP200', 'JP300', 'JP400', 'JP500']          # pins share y
ROW_Y = ['JP1200']                                            # pins share x
HEADERS = ['J201', 'J301', 'J401', 'J501']                   # 2 x 5, rot 90
JST = ['J102', 'J601', 'J800', 'J900', 'J901', 'J902', 'J903', 'J904', 'J1300']
# Low back-side parts under a connector's new outline swap to the front in place (all under 1.5 mm,
# so the XIAOs stay the tallest parts there). Power-stage parts are not moved: J601 relocates.
TO_FRONT = ['U900', 'Q900', 'D901', 'C900', 'C904', 'R902', 'R906',     # haptic driver, under J901
            'Q1300', 'R1301', 'R1304',                                # power controller, under J102
            'R1300']                                                  # under J1300

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                   # SWIG order trap: read before pad lists
fs = {f.GetReference(): f for f in b.GetFootprints()}
mm = lambda v: round(pcb.ToMM(v) - 50, 3)
def pads(f): return sorted((p.GetNumber(), mm(p.GetPosition().x), mm(p.GetPosition().y)) for p in f.Pads())

if PHASE == 'flip':
    report = []
    for r in ROW_X + ROW_Y:
        f = fs[r]
        if f.IsFlipped(): continue
        before = pads(f)
        f.Flip(f.GetPosition(), pcb.FLIP_DIRECTION_TOP_BOTTOM if r in ROW_X else pcb.FLIP_DIRECTION_LEFT_RIGHT)
        assert pads(f) == before, (r, 'pads moved', before, pads(f))
        report.append(r)
    for r in HEADERS:
        f = fs[r]
        if f.IsFlipped(): continue
        p = f.GetPosition()
        f.Flip(p, pcb.FLIP_DIRECTION_TOP_BOTTOM)
        f.SetPosition(p - pcb.VECTOR2I(0, pcb.FromMM(2.54)))   # rows back onto y 15.46 / 18.0
        ys = sorted({y for _, _, y in pads(f)})
        assert ys == [15.46, 18.0], (r, ys)
        report.append(r + ' (rows swapped)')
    for r in JST:
        f = fs[r]
        if f.IsFlipped(): continue
        cy = f.GetCourtyard(pcb.F_CrtYd)
        c = (cy.BBox() if cy.OutlineCount() else f.GetBoundingBox(False, False)).GetCenter()
        f.Flip(c, pcb.FLIP_DIRECTION_LEFT_RIGHT)    # about the outline centre: the body stays in place
        report.append(r)
    pcb.SaveBoard(str(TARGET), b)
    print('to the back:', ', '.join(report), flush=True)
    import os; os._exit(0)

if PHASE == 'tofront':
    done = []
    for r in TO_FRONT:
        f = fs[r]
        if not f.IsFlipped(): continue
        cy = f.GetCourtyard(pcb.B_CrtYd)
        c = (cy.BBox() if cy.OutlineCount() else f.GetBoundingBox(False, False)).GetCenter()
        f.Flip(c, pcb.FLIP_DIRECTION_LEFT_RIGHT); done.append(r)
    pcb.SaveBoard(str(TARGET), b)
    print('to the front:', ', '.join(done), flush=True)
    import os; os._exit(0)

if PHASE == 'rip':
    allpads = [p for f in b.GetFootprints() for p in f.Pads()]
    doomed = []
    for t in tracks:
        if t.IsLocked(): continue
        pts = [t.GetPosition()] if isinstance(t, pcb.PCB_VIA) else [t.GetStart(), t.GetEnd()]
        layers = [l for l in (pcb.F_Cu, pcb.In1_Cu, pcb.In2_Cu, pcb.B_Cu) if t.IsOnLayer(l)]
        for p in allpads:
            if p.GetNetCode() == t.GetNetCode() or p.GetNetCode() == 0: continue
            if any(p.IsOnLayer(l) for l in layers) and any(p.HitTest(q) for q in pts):
                doomed.append(t); break
    n = len(doomed)
    for t in doomed: b.Remove(t)
    pcb.SaveBoard(str(TARGET), b)
    print('rip:', n, 'items touching a pad of another net', flush=True)
    import os; os._exit(0)
