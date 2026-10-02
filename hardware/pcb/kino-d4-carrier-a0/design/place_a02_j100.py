"""Put the P4 ribbon header J100 on the back, opposite the XIAO sockets (KiCad 10 python).

The XIAO sockets are on the front; the P4 sits behind the carrier, so the 26-way IDC cable to it
leaves from the back. J100 is flipped onto B.Cu in its own outline (courtyard x 2.28-12.27 mm,
y 12.36-54.13 mm): after the mirror the pin columns swap, odd pins at x 8.54 and even pins at
x 6.00, pin 1 at (8.54, 18.0). Seen from the P4 side the header reads as it did from the front,
so pin 1 and the key stay at the top end. Pin-to-net mapping is unchanged; the cable twist and
the stack height (box header plus ribbon between carrier and P4) remain mechanical checks.

  place   flip J100, shift it back into its outline, R102 0.3 mm east out of the new back
          courtyard, "P4 / PIN1" to the back silkscreen
  rip     remove every track and via ending on a J100 pad, and the P4_5V pin 2/4 tie and the
          first three In2 segments of the P4_5V trunk (they met the old pin 2)
  add     P4_5V again at 1.2 mm: pin 2 - pin 4 tie on F at x 6.0; In2 from pin 2 by one
          45-degree step into the existing trunk at (4.013, 17.307)
Each phase runs in its own process. Then DRC, drop_dangling.py, and route the J100 nets.
"""
import sys
import pcbnew as pcb
from rework import TARGET
from routing import pt

PHASE = sys.argv[1] if len(sys.argv) > 1 else ''
assert PHASE in ('place', 'rip', 'add'), 'run: place, rip, add'
b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                   # SWIG order trap: read before pad lists
fs = {f.GetReference(): f for f in b.GetFootprints()}
mm = lambda v: pcb.ToMM(v) - 50
near = lambda a, c: abs(a[0] - c[0]) < 0.01 and abs(a[1] - c[1]) < 0.01
j = fs['J100']

if PHASE == 'place':
    if not j.IsFlipped():
        j.Flip(j.GetPosition(), pcb.FLIP_DIRECTION_LEFT_RIGHT)
        j.SetPosition(pt(50 + 8.54, 50 + 18.0))    # odd column onto the old even column
    pin = {p.GetNumber(): (round(mm(p.GetPosition().x), 3), round(mm(p.GetPosition().y), 3)) for p in j.Pads()}
    assert pin['1'] == (8.54, 18.0) and pin['2'] == (6.0, 18.0) and pin['26'] == (6.0, 48.48), pin
    r = fs['R102']
    if abs(mm(r.GetPosition().x) - 13.75) < 0.01:
        shift = pcb.VECTOR2I(pcb.FromMM(0.3), 0)
        old = {p.GetNumber(): p.GetPosition() for p in r.Pads()}
        r.SetPosition(r.GetPosition() + shift)
        for t in tracks:                           # keep R102's own stubs on its pads (horizontal only)
            if isinstance(t, pcb.PCB_VIA): continue
            for get, set_ in ((t.GetStart, t.SetStart), (t.GetEnd, t.SetEnd)):
                if any(get() == q for q in old.values()) and t.GetStart().y == t.GetEnd().y: set_(get() + shift)
    for d in b.GetDrawings():
        if isinstance(d, pcb.PCB_TEXT) and d.GetText() == 'P4 / PIN1' and d.GetLayer() == pcb.F_SilkS:
            d.SetLayer(pcb.B_SilkS); d.SetMirrored(True); d.SetPosition(pt(50 + 7.27, 50 + 55.225))
    pcb.SaveBoard(str(TARGET), b)
    print('J100 on the back: pin 1', pin['1'], 'pin 2', pin['2'], '; R102 at', (round(mm(r.GetPosition().x), 3), round(mm(r.GetPosition().y), 3)), flush=True)
    import os; os._exit(0)

OLD_TRUNK = [((8.54, 17.856), (7.036, 16.352)), ((7.036, 16.352), (4.968, 16.352)), ((4.968, 16.352), (4.013, 17.307))]
OLD_TIE = ((8.54, 20.54), (8.54, 18.0))
if PHASE == 'rip':
    pads = list(j.Pads())
    doomed = []
    for t in tracks:
        pts = [t.GetPosition()] if isinstance(t, pcb.PCB_VIA) else [t.GetStart(), t.GetEnd()]
        if any(p.HitTest(q) for p in pads for q in pts): doomed.append(t); continue
        if t.GetNetname() == 'P4_5V' and not isinstance(t, pcb.PCB_VIA):
            s, e = (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))
            if any((near(s, a) and near(e, c)) or (near(s, c) and near(e, a)) for a, c in OLD_TRUNK + [OLD_TIE]): doomed.append(t)
    n = len(doomed)
    for t in doomed: b.Remove(t)
    pcb.SaveBoard(str(TARGET), b)
    print('J100 rip:', n, 'items', flush=True)
    import os; os._exit(0)

if PHASE == 'add':
    code = b.FindNet('P4_5V').GetNetCode()
    def add(layer, w, pts):
        for a, c in zip(pts, pts[1:]):
            t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + a[0], 50 + a[1])); t.SetEnd(pt(50 + c[0], 50 + c[1]))
            t.SetWidth(pcb.FromMM(w)); t.SetLayer(layer); t.SetNetCode(code); b.Add(t)
    add(pcb.F_Cu, 1.2, [(6.0, 18.0), (6.0, 20.54)])
    add(pcb.In2_Cu, 1.2, [(6.0, 18.0), (5.307, 17.307), (4.013, 17.307)])
    pcb.SaveBoard(str(TARGET), b)
    print('J100 add: P4_5V tie and trunk entry redrawn at 1.2 mm', flush=True)
    import os; os._exit(0)
