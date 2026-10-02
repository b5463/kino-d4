"""Clear the placement conflicts left by moving the external connections to the back (KiCad 10 python).

  move   1. Each camera's EN pull-down R(k)05 and FAULT pull-up R(k)04 moves 0.3 mm south, out of
            the back-side courtyard of its breakout header (the header rows cannot move).
         2. R603, R701, U901 and R1301 step along a fixed direction, in 0.05 mm steps, until their
            courtyard clears the part they overlap, plus 0.05 mm.
         3. J601 (DNP flash provision) moves to the nearest spot within 16 mm where its courtyard is
            clear of back-side parts and through-holes and its pads keep 0.2 mm from locked copper
            of other nets (unlocked copper under them is removed by 'rip' and re-routed). Cable connectors elsewhere stay where the cable exits are.
  rip    Removes, unlocked only: copper ending on a pad of a part moved here (it is re-routed), and
         copper of another net that touches any pad on the board (shorts and mask bridges the moves
         created). Locked copper that touches a foreign pad is reported, not removed.
Each phase runs in its own process.
"""
import math, sys
import pcbnew as pcb
from rework import TARGET
from routing import pt

PHASE = sys.argv[1] if len(sys.argv) > 1 else ''
assert PHASE in ('move', 'rip'), 'run: move, rip'
SOUTH = [f'R{b}' for k in range(4) for b in (205 + 100 * k, 204 + 100 * k)]
STEP = [('R603', 'J301', (1, 0)), ('R701', 'J501', (0, -1)), ('U901', 'J201', (-1, 0)), ('R1301', 'D1300', (1, 0))]
MOVED = SOUTH + [r for r, _, _ in STEP] + ['J601']

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                   # SWIG order trap: read before pad lists
fs = {f.GetReference(): f for f in b.GetFootprints()}
mm = lambda v: pcb.ToMM(v) - 50
def cy(f):
    c = f.GetCourtyard(pcb.B_CrtYd if f.IsFlipped() else pcb.F_CrtYd)
    return c.BBox() if c.OutlineCount() else f.GetBoundingBox(False, False)

if PHASE == 'move':
    log = []
    for r in SOUTH:
        f = fs[r]; f.SetPosition(f.GetPosition() + pcb.VECTOR2I(0, pcb.FromMM(0.3))); log.append(f'{r} +0.30 y')
    for r, other, (dx, dy) in STEP:
        f, o = fs[r], fs[other]; n = 0
        ob = cy(o); ob.Inflate(pcb.FromMM(0.05))
        while cy(f).Intersects(ob) and n < 40:
            f.SetPosition(f.GetPosition() + pcb.VECTOR2I(pcb.FromMM(0.05 * dx), pcb.FromMM(0.05 * dy))); n += 1
        assert n < 40, (r, 'still overlaps', other)
        log.append(f'{r} {0.05 * n:.2f} mm {"E" if dx > 0 else "W" if dx < 0 else "N" if dy < 0 else "S"}')
    # J601: nearest clear spot on the back
    j = fs['J601']; home = j.GetPosition(); code_pads = list(j.Pads())
    same = [cy(f) for r, f in fs.items() if r != 'J601' and f.IsFlipped()]
    holes = [p.GetBoundingBox() for r, f in fs.items() if r != 'J601' for p in f.Pads()
             if p.GetAttribute() in (pcb.PAD_ATTRIB_PTH, pcb.PAD_ATTRIB_NPTH)]
    copper = [t for t in tracks if t.IsLocked() and (isinstance(t, pcb.PCB_VIA) or t.GetLayer() == pcb.B_Cu)]   # unlocked copper is re-routed
    outline = b.GetBoardEdgesBoundingBox(); outline.Inflate(-pcb.FromMM(0.8))
    clr = pcb.FromMM(0.2)
    def fits():
        me = cy(j)
        if not outline.Contains(me) or any(me.Intersects(o) for o in same + holes): return False
        for p in j.Pads():
            sh = p.GetEffectiveShape(pcb.B_Cu); pb = p.GetBoundingBox(); pb.Inflate(clr + pcb.FromMM(1))
            for t in copper:
                if t.GetNetCode() == p.GetNetCode() and p.GetNetCode() != 0: continue
                if not pb.Intersects(t.GetBoundingBox()): continue
                if sh.Collide(t.GetEffectiveShape(pcb.B_Cu), clr): return False
        return True
    best = None
    for ring in range(0, 321):                  # 0.05 mm rings out to 16 mm
        r_mm = ring * 0.05
        for k in range(max(1, int(2 * math.pi * r_mm / 0.25))):
            a = 2 * math.pi * k / max(1, int(2 * math.pi * r_mm / 0.25))
            j.SetPosition(home + pcb.VECTOR2I(pcb.FromMM(r_mm * math.cos(a)), pcb.FromMM(r_mm * math.sin(a))))
            if fits(): best = (r_mm, j.GetPosition()); break
        if best: break
    assert best, 'J601: no clear spot within 16 mm'
    j.SetPosition(best[1]); j.Reference().SetPosition(j.GetPosition())
    log.append(f'J601 -> ({mm(best[1].x):.2f}, {mm(best[1].y):.2f}), {best[0]:.2f} mm')
    pcb.SaveBoard(str(TARGET), b)
    print('move:', '; '.join(log), flush=True)
    import os; os._exit(0)

if PHASE == 'rip':
    pads = [p for f in b.GetFootprints() for p in f.Pads()]
    mine = [p for r in MOVED for p in fs[r].Pads()]
    clr = pcb.FromMM(0.15)
    doomed, locked = [], []
    for t in tracks:
        pts = [t.GetPosition()] if isinstance(t, pcb.PCB_VIA) else [t.GetStart(), t.GetEnd()]
        layers = [l for l in (pcb.F_Cu, pcb.In1_Cu, pcb.In2_Cu, pcb.B_Cu) if t.IsOnLayer(l)]
        hit = any(p.HitTest(q) for p in mine for q in pts) and not t.IsLocked()
        if not hit:
            tb = t.GetBoundingBox(); tb.Inflate(clr)
            for p in pads:
                if p.GetNetCode() == t.GetNetCode() and p.GetNetCode() != 0: continue
                if not tb.Intersects(p.GetBoundingBox()): continue
                l = next((l for l in layers if p.IsOnLayer(l)), None)
                if l is None: continue
                if t.GetEffectiveShape(l).Collide(p.GetEffectiveShape(l), clr - 1):
                    if t.IsLocked(): locked.append((t.GetNetname(), p.GetParentFootprint().GetReference() + '.' + p.GetNumber()))
                    else: hit = True
                    break
        if hit: doomed.append(t)
    n = len(doomed)
    for t in doomed: b.Remove(t)
    pcb.SaveBoard(str(TARGET), b)
    print('rip:', n, 'items; locked copper touching a foreign pad:', locked or 'none', flush=True)
    import os; os._exit(0)
