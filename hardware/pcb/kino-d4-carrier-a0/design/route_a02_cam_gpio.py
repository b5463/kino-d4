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

Before the lanes go in, everything in their way goes (phase 'clear'):
  - GND stitching vias (no track attached) move to the nearest spot 0.2 mm clear of all copper
    of other nets, the lanes included, searching rings out to 2 mm;
  - the SYS_5V drop via 0.45 mm east of the shunt's pad 1 (route_a02_sys5v.py before this
    template) moves to the lane midpoint 0.825 mm east, its B bar with it;
  - the two locked GND vias every camera block has in the lanes: the one for the TPS2553 GND
    pin (x0 + 1.46, 24.5) goes, and the pin joins its input capacitor C(k)02's GND pad on B
    instead (the pin carries only quiescent current; C(k)02 has its own via and the pour); the
    one for C(k)03 (x0 - 3.48, 31.25) steps 0.23 mm east (0.2 mm clear of the D2 lane and of
    P4_TX(k) on F), its stub ending at 45 degrees;
  - unlocked copper of other nets that the lanes would touch (In2 tracks, vias) is removed; the
    grid router re-routes those connections around the locked lanes afterwards. Camera 1's
    SHUNT_OUT jog from route_a02_sys5v.py goes the same way.
  Locked copper of any other net in the way stops the script. Older unlocked copper of the eight
  GPIO nets themselves (partial routes from earlier passes) is removed too: each net joins only a
  header pin and a socket pin, and the lane replaces it.
Then drop_dangling.py, add <k>, and the grid router for the opened nets.
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
    moved, doomed, stuck = [], [], []
    x0 = 24.04 + 22.0 * (K - 1)
    for t in tracks:                         # SYS_5V drop via 0.45 east of pad 1 -> lane midpoint
        if t.GetNetname() != 'SYS_5V' or abs(mm(t.GetPosition().y if isinstance(t, pcb.PCB_VIA) else t.GetStart().y) - 19.4) > 0.01: continue
        old, new = pt(50 + x0 + 0.45, 50 + 19.4), pt(50 + x0 + 0.825, 50 + 19.4)
        if isinstance(t, pcb.PCB_VIA):
            if (t.GetPosition() - old).EuclideanNorm() < 20000: t.SetPosition(new); moved.append(f'SYS_5V drop {x0 + 0.45:.2f}->{x0 + 0.825:.3f}')
        elif t.GetLayer() == pcb.B_Cu:
            for get, put in ((t.GetStart, t.SetStart), (t.GetEnd, t.SetEnd)):
                if (get() - old).EuclideanNorm() < 20000: put(new)
    fp = {f.GetReference(): f for f in b.GetFootprints()}
    padc = lambda ref, n: next(q for q in fp[ref].Pads() if q.GetNumber() == n).GetPosition()
    near_ = lambda p_, x, y: (p_ - pt(50 + x, 50 + y)).EuclideanNorm() < 20000
    gnd_code = b.FindNet('GND').GetNetCode()
    def gtrk(a, c):
        t = pcb.PCB_TRACK(b); t.SetStart(a); t.SetEnd(c); t.SetWidth(pcb.FromMM(0.25)); t.SetLayer(pcb.B_Cu)
        t.SetNetCode(gnd_code); t.SetLocked(True); b.Add(t)
    for t in tracks:
        if t.GetNetname() != 'GND': continue
        if isinstance(t, pcb.PCB_VIA):
            if near_(t.GetPosition(), x0 + 1.46, 24.5): doomed.append(t)
            elif near_(t.GetPosition(), x0 - 3.48, 31.25): t.SetPosition(pt(50 + x0 - 3.25, 50 + 31.25)); moved.append(f'C{K + 1}03 GND via east')
        elif t.GetLayer() == pcb.B_Cu:
            ends_ = (t.GetStart(), t.GetEnd())
            if any(near_(e, x0 + 1.46, 24.5) for e in ends_): doomed.append(t)
            elif any(near_(e, x0 - 3.48, 31.25) for e in ends_):
                for get, put in ((t.GetStart, t.SetStart), (t.GetEnd, t.SetEnd)):
                    if near_(get(), x0 - 3.48, 31.25): put(pt(50 + x0 - 3.48, 50 + 31.48))
                gtrk(pt(50 + x0 - 3.48, 50 + 31.48), pt(50 + x0 - 3.25, 50 + 31.25))
    u, c = padc(f'U{K + 1}01', '2'), padc(f'C{K + 1}02', '2')      # TPS2553 GND pin -> C(k)02 GND pad
    dy = abs(mm(u.y) - mm(c.y)); knee = pt(50 + mm(c.x) + dy, 50 + mm(u.y))
    gtrk(u, knee); gtrk(knee, c)
    stitch = [t for t in tracks if isinstance(t, pcb.PCB_VIA) and t.GetNetname() == 'GND']
    attached = set()
    for t in tracks:
        if isinstance(t, pcb.PCB_VIA) or t.GetNetname() != 'GND': continue
        for v in stitch:
            if v.GetPosition() in (t.GetStart(), t.GetEnd()): attached.add(id(v))
    all_vias = [t for t in tracks if isinstance(t, pcb.PCB_VIA)]
    def via_clear(v, at):
        s = pcb.SHAPE_CIRCLE(at, pcb.FromMM(0.3))
        if any(o is not v and (o.GetPosition() - at).EuclideanNorm() < pcb.FromMM(0.6) for o in all_vias): return False   # hole to hole 0.25 mm, any net
        for net, ls in lane_shapes:
            if ls.Collide(s, pcb.FromMM(0.2)): return False
        return all(not foreign_hits('GND', s, l, 0.2) for l in LAYERS if l != pcb.In1_Cu)
    lanes_all = [ls for _, ls in lane_shapes]
    for net, _ in plan:                      # fan nets are two-pin: header and socket only
        n_pads = sum(1 for f in b.GetFootprints() for q in f.Pads() if q.GetNetname() == net)
        assert n_pads == 2, (net, n_pads, 'pads: not a two-pin net')
    for t in tracks:                         # unlocked copper in the lanes' way
        n = t.GetNetname()
        if n in {net for net, _ in plan} and not isinstance(t, pcb.PCB_VIA) and t.GetLayer() != pcb.In2_Cu:
            if not t.IsLocked(): doomed.append(t)
            continue
        if isinstance(t, pcb.PCB_VIA):
            if n == 'GND' and id(t) not in attached: continue          # stitching: moved below
            if any(t is d_ for d_ in doomed) or n == 'GND' and (near_(t.GetPosition(), x0 + 1.46, 24.5) or near_(t.GetPosition(), x0 - 3.25, 31.25)): continue
            sh = t.GetEffectiveShape(pcb.In2_Cu)
        elif t.GetLayer() == pcb.In2_Cu: sh = t.GetEffectiveShape(pcb.In2_Cu)
        else: continue
        own = {net for net, _ in plan}
        if n in own:
            if not t.IsLocked(): doomed.append(t)          # earlier partial route of a fan net
            continue
        if not any(ls.Collide(sh, pcb.FromMM(CLR) - 1) for ls in lanes_all): continue
        if n == 'CAM1_SHUNT_OUT' or not t.IsLocked(): doomed.append(t)
        else: stuck.append(describe(t))
    assert not stuck, ('locked copper in the lanes', stuck)
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
    names = sorted({t.GetNetname() for t in doomed}); n = len(doomed)
    for t in doomed: b.Remove(t)                 # last: Remove() invalidates the other proxies
    pcb.SaveBoard(str(TARGET), b)
    print(f'camera {K} clear: moved', '; '.join(moved) or 'nothing', f'| removed {n} items on {names}', flush=True)
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
