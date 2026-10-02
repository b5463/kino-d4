"""Camera GPIO breakout: header J(k)01 to XIAO socket J(k)00 on In2 (KiCad 10 python). ODD JOBS 79, 87, 88.

The same fan-out for every camera k (22 mm pitch):
  lanes  the eight GPIO pins leave the 2 x 5 header on In2: row 2 pins straight down, row 1 pins
         at 45 degrees into the gap to their left, then down: eight vertical lanes at 1.27 mm pitch.
         In2 is the only layer free to cross the band below the header (F carries the P4 bus and
         the SYS_5V trunk, B the shunt row).
  fans   each lane turns 45 degrees at the depth of its socket pin and enters it on its centre line:
         D0, D2, D3, D4, D5 to the left column (shallowest leftmost), D8, D9, D10 to the right
         (deepest innermost), so no two lines cross. Straight entry 1.1 mm on the left, 1.4 mm on
         the right. 0.2 mm tracks.
Header pin 2 (3V3) and the socket TX/RX pins are not part of the fan (routed separately).

Before the lanes go in, everything in their way moves (phase 'clear'):
  - GND stitching vias (no track attached) move to the nearest spot 0.2 mm clear of all copper
    of other nets, the lanes included, searching rings out to 2 mm;
  - the per-camera EDITS below move signal vias to a lane midpoint and redraw their stubs.
Phases: plan <k> (report only), clear <k>, add <k>; each in its own process.
"""
import math, sys
import pcbnew as pcb
from rework import TARGET
from routing import pt

PHASE, K = sys.argv[1], int(sys.argv[2])
assert PHASE in ('plan', 'clear', 'add') and K in (1, 2, 3, 4), 'run: plan|clear|add <camera>'
W, CLR = 0.2, 0.15
DX = 22.0 * (K - 2)
HX, Y1, Y2 = 42.42 + DX, 15.46, 18.0
SL, SR = 39.89 + DX, 55.12 + DX
E_L, E_R = 1.1, 1.4
FAN = [('D0', 1, 1, 27.08, 'L'), ('D2_STRAP', 1, 2, 32.17, 'L'), ('D3', 2, 1, 34.70, 'L'), ('D4', 2, 2, 37.25, 'L'),
       ('D5', 3, 1, 39.78, 'L'), ('D8_SD', 3, 2, 39.78, 'R'), ('D9_SD', 4, 1, 37.25, 'R'), ('D10_SD', 4, 2, 34.70, 'R')]

def lines():
    out = []
    for name, col, row, yt, side in FAN:
        x = HX + 2.54 * col
        head, xl = ([(x, Y1), (x - 1.27, Y1 + 1.27)], x - 1.27) if row == 1 else ([(x, Y2)], x)
        if side == 'L': xe = SL + E_L; ty = yt - (xl - xe); end = [(xl, ty), (xe, yt), (SL, yt)]
        else: xe = SR - E_R; ty = yt - (xe - xl); end = [(xl, ty), (xe, yt), (SR, yt)]
        out.append((f'CAM{K}_{name}', [(round(a, 3), round(b, 3)) for a, b in head + end]))
    return out

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                     # SWIG order trap: read before pad lists
mm = lambda v: pcb.ToMM(v) - 50
def seg_shape(a, c, w):
    s = pcb.SHAPE_SEGMENT(pt(50 + a[0], 50 + a[1]), pt(50 + c[0], 50 + c[1]), pcb.FromMM(w)); return s
plan = lines()
lane_shapes = [(net, seg_shape(a, c, W)) for net, pts in plan for a, c in zip(pts, pts[1:])]
LAYERS = (pcb.F_Cu, pcb.In1_Cu, pcb.In2_Cu, pcb.B_Cu)

def foreign_hits(net, shape, layer, clr):
    """Copper of other nets on `layer` within clr of shape: tracks, vias, pads (not zones)."""
    hits = []
    bb = shape.BBox(); bb.Inflate(pcb.FromMM(clr + 1))
    for t in tracks:
        if t.GetNetname() == net or not t.IsOnLayer(layer): continue
        if not bb.Intersects(t.GetBoundingBox()): continue
        if t.GetEffectiveShape(layer).Collide(shape, pcb.FromMM(clr) - 1): hits.append(t)
    for f in b.GetFootprints():
        if not bb.Intersects(f.GetBoundingBox(False, False)): continue
        for p in f.Pads():
            if p.GetNetname() == net and p.GetNetname() != '' or not p.IsOnLayer(layer): continue
            if p.GetEffectiveShape(layer).Collide(shape, pcb.FromMM(clr) - 1): hits.append(p)
    return hits

def describe(o):
    if isinstance(o, pcb.PAD): return f'pad {o.GetParentFootprint().GetReference()}.{o.GetNumber()} {o.GetNetname()}'
    if isinstance(o, pcb.PCB_VIA): return f'via {o.GetNetname()} ({mm(o.GetPosition().x):.2f},{mm(o.GetPosition().y):.2f})'
    return f'track {o.GetNetname()} {pcb.LayerName(o.GetLayer())} ({mm(o.GetStart().x):.2f},{mm(o.GetStart().y):.2f})-({mm(o.GetEnd().x):.2f},{mm(o.GetEnd().y):.2f})'

if PHASE == 'plan':
    for net, pts in plan:
        found = []
        for a, c in zip(pts, pts[1:]):
            for o in foreign_hits(net, seg_shape(a, c, W), pcb.In2_Cu, CLR):
                d = describe(o)
                if d not in found: found.append(d)
        print(net, ' -> '.join(f'({x:.2f},{y:.2f})' for x, y in pts), '|', '; '.join(found) or 'clear', flush=True)
    import os; os._exit(0)

if PHASE == 'clear':
    moved = []
    stitch = [t for t in tracks if isinstance(t, pcb.PCB_VIA) and t.GetNetname() == 'GND']
    attached = set()
    for t in tracks:
        if isinstance(t, pcb.PCB_VIA) or t.GetNetname() != 'GND': continue
        for v in stitch:
            if v.GetPosition() in (t.GetStart(), t.GetEnd()): attached.add(id(v))
    def via_clear(v, at):
        s = pcb.SHAPE_CIRCLE(at, pcb.FromMM(0.3))
        for net, ls in lane_shapes:
            if ls.Collide(s, pcb.FromMM(0.2)): return False
        return all(not foreign_hits('GND', s, l, 0.2) for l in LAYERS if l != pcb.In1_Cu)
    for v in stitch:
        if id(v) in attached: continue
        s = pcb.SHAPE_CIRCLE(v.GetPosition(), pcb.FromMM(0.3))
        if not any(ls.Collide(s, pcb.FromMM(CLR)) for _, ls in lane_shapes): continue
        home = v.GetPosition(); best = None
        for ring in range(1, 41):
            r = ring * 0.05; n = max(8, int(2 * math.pi * r / 0.1))
            for i in range(n):
                at = home + pcb.VECTOR2I(pcb.FromMM(r * math.cos(2 * math.pi * i / n)), pcb.FromMM(r * math.sin(2 * math.pi * i / n)))
                if via_clear(v, at): best = at; break
            if best: break
        assert best, ('no spot for stitching via', mm(home.x), mm(home.y))
        v.SetPosition(best); moved.append(f'({mm(home.x):.2f},{mm(home.y):.2f})->({mm(best.x):.2f},{mm(best.y):.2f})')
    pcb.SaveBoard(str(TARGET), b)
    print(f'camera {K} clear: {len(moved)} stitching vias moved', '; '.join(moved), flush=True)
    import os; os._exit(0)

if PHASE == 'add':
    code = {net: b.FindNet(net).GetNetCode() for net, _ in plan}
    for net, pts in plan:
        for a, c in zip(pts, pts[1:]):
            dx, dy = abs(c[0] - a[0]), abs(c[1] - a[1])
            assert min(dx, dy) < 1e-6 or abs(dx - dy) < 1e-6, (net, 'non-45', a, c)
            t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + a[0], 50 + a[1])); t.SetEnd(pt(50 + c[0], 50 + c[1]))
            t.SetWidth(pcb.FromMM(W)); t.SetLayer(pcb.In2_Cu); t.SetNetCode(code[net]); t.SetLocked(True); b.Add(t)
    pcb.SaveBoard(str(TARGET), b)
    print(f'camera {K} add: {len(plan)} GPIO lines on In2', flush=True)
    import os; os._exit(0)
