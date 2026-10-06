"""Remote dry-contact chain next to its connector J903, shutter clamp next to J902 (KiCad 10 python). ODD JOBS 24, 118.

J903 (remote dry contact) sits in the top-left corner, but its ESD clamp D900, the RC filter
(R903, R904, C904), the Schmitt inverter U901's pull-down R905 and the shutter FET Q900 were on the
right edge, 100 mm away, and U901 / C905 at the left: the contact ran across the board unclamped
and three more nets crossed it twice. D902, the clamp for the local shutter jack J902 (bottom left),
was on the right edge too. ODD JOBS 24: an ESD device extremely close to its connector, before the
signal travels into the board.
Now: the clamp, series resistor and filter on the back beside J903 (D900 2 mm from pin 1), the
inverter, its decoupling cap, R905 and Q900 on the front above it, D902 beside J902 pin 1. Only
SHUTTER_N leaves the corner (Q900 drain to J100 pin 21, routed down the left edge).
  dry   print pad positions and courtyard overlaps for the PLACE table, change nothing
  place move the parts (copper on their pads is removed first by 'rip')
  rip   remove unlocked copper attached to the moved parts' pads
"""
import sys
import pcbnew as pcb
from rework import TARGET
from routing import pt

PHASE = sys.argv[1] if len(sys.argv) > 1 else ''
assert PHASE in ('dry', 'rip', 'place'), 'run: dry, rip, place'
PLACE = {   # ref: ((x, y), rotation, side)
    'D900': ((12.35, 8.95), 180, 'B'),
    'R903': ((12.35, 11.25), 0, 'B'),
    'C904': ((15.45, 11.25), 0, 'B'),
    'R904': ((15.5, 12.9), 0, 'B'),
    'U901': ((12.0, 6.5), 180, 'F'),
    'C905': ((10.862, 9.8), -90, 'F'),
    'R905': ((8.3, 4.9), 180, 'F'),
    'Q900': ((6.2, 10.6), 180, 'F'),
    'D902': ((11.6, 65.6), 90, 'B'),
}
b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                     # SWIG order trap: read before pad lists
fs = {f.GetReference(): f for f in b.GetFootprints()}
mm = lambda v: pcb.ToMM(v) - 50

if PHASE == 'rip':
    pads = [p for r in PLACE for p in fs[r].Pads()]
    doomed = [t for t in tracks if not t.IsLocked() and not isinstance(t, pcb.PCB_VIA)
              and any(p.GetNetCode() == t.GetNetCode() and p.HitTest(e) for p in pads for e in (t.GetStart(), t.GetEnd()))]
    names = sorted({t.GetNetname() for t in doomed}); k = len(doomed)
    for t in doomed: b.Remove(t)
    pcb.SaveBoard(str(TARGET), b)
    print(f'remote rip: {k} tracks on {names}', flush=True)
    import os; os._exit(0)

FLIP = pcb.FLIP_DIRECTION_TOP_BOTTOM if hasattr(pcb, 'FLIP_DIRECTION_TOP_BOTTOM') else False
for ref, ((x, y), rot, side) in PLACE.items():
    f = fs[ref]
    if f.IsFlipped() != (side == 'B'): f.Flip(f.GetPosition(), FLIP)
    f.SetPosition(pt(50 + x, 50 + y)); f.SetOrientationDegrees(rot)
    f.Reference().SetPosition(f.GetPosition())
for ref in PLACE:
    f = fs[ref]
    print(ref, 'B' if f.IsFlipped() else 'F', ', '.join(f'{p.GetNumber()} {p.GetNetname() or "nc"} ({mm(p.GetPosition().x):.3f},{mm(p.GetPosition().y):.3f})' for p in f.Pads()))
clash = []
for ref in PLACE:
    f = fs[ref]; L = pcb.B_CrtYd if f.IsFlipped() else pcb.F_CrtYd
    me = f.GetCourtyard(L)
    for o in b.GetFootprints():
        if o.GetReference() == ref or o.IsFlipped() != f.IsFlipped(): continue
        oc = o.GetCourtyard(L)
        if me.OutlineCount() and oc.OutlineCount() and me.Collide(oc.Outline(0)): clash.append(f'{ref}-{o.GetReference()}')
    for o in b.GetFootprints():                  # holes of the other side's parts
        for p in o.Pads():
            if p.GetAttribute() in (pcb.PAD_ATTRIB_PTH, pcb.PAD_ATTRIB_NPTH) and me.Collide(pcb.SHAPE_CIRCLE(p.GetPosition(), max(p.GetDrillSize().x // 2, 1))):
                clash.append(f'{ref}-hole {o.GetReference()}')
print('courtyard clashes:', sorted(set(clash)) or 'none', flush=True)
if PHASE == 'place': pcb.SaveBoard(str(TARGET), b)
import os; os._exit(0)
