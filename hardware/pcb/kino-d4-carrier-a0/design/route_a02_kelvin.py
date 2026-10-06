"""PAC1954 Kelvin sense pairs from the four camera shunts to U700, and U700's own copper (KiCad 10 python).
ODD JOBS 152 (Kelvin connections), 87/88, 79.

Each shunt RS(k)00 (20 mOhm, 1206 on B) gets the same taps: SENSE+ from the inner south corner of
pad 1 (SYS_5V; the trunk's current enters at the north centre of the pad), SENSE- from the inner
north corner of pad 2 (the camera current leaves to the south). The pair runs 0.15 mm, 0.32 mm
apart (centre lines offset from one path, mitred, so the gap holds through the bends), between the pads and up through the header column gap beside them, so neither line carries
camera current. U700 (front, centre (58.75, 15.5), see place_a02_u700.py) has camera 1 and 4 pins
on its north side, camera 2 on the west, camera 3 on the east.
  camera 2   along its header's row gap on B, vias to F at x 54.86 / 54.83, into pins 13 / 14.
  camera 3   along its row gap the other way; its S+ (lower line) takes the eastern via and
             crosses over S- on F (the board is mirror-symmetric, the PAC1954 channel order is
             not).
  camera 1/4 the risers jog 1 mm east above the header (clear of JP200/JP500 and R701), vias to
             In2 north of the In2 control lanes, a corridor on In2 at y 11.06 / 11.36, a row of
             four vias at y 11.6 and a fan on F into pins 12, 11, 10, 9. Camera 4's S+ takes its
             In2 via 0.7 mm further north than S-, so it runs above S- heading west and S- leaves
             the corridor first, at the eastern via, as pin 9 needs.
U700 local: a GND via in the exposed pad, pins 1 and 3 joined to it; C700 straight below pin 2;
pin 16 through a via to C701 on B, C701's GND back to the pad via; PAC_ADDR around pin 5 to R700,
R700's GND via in the window between CAM3_5V_ISO and J401.
Moved for it ('clear'): the CAM2_5V via 1.2 mm south (its F and B runs follow), the CAM3_5V_ISO via
0.6 mm north (new F and B stubs in 'add'), GND stitching vias in the way to the nearest clear spot;
removed: camera 1's SHUNT_OUT stub left from the In2 trunk (route_a02_sys5v.py) and every unlocked
copper item of another net the new copper would touch (re-routed by the grid router afterwards).
Locked copper of another net in the way stops the script. Phases: clear, add (separate processes).
"""
import math, sys
import pcbnew as pcb
from rework import TARGET
from routing import pt

PHASE = sys.argv[1] if len(sys.argv) > 1 else ''
assert PHASE in ('clear', 'add'), 'run: clear, add'
W = 0.15
X0 = {k: 24.04 + 22.0 * (k - 1) for k in (1, 2, 3, 4)}
net_p = 'SYS_5V'; net_m = {k: f'CAM{k}_SHUNT_OUT' for k in (1, 2, 3, 4)}
items = []          # (tag, net, layer, pts) ; vias: (tag, net, None, [(x,y)])
def T(tag, net, layer, pts): items.append((tag, net, layer, [(round(x, 3), round(y, 3)) for x, y in pts]))
def V(tag, net, x, y): items.append((tag, net, 'V', [(round(x, 3), round(y, 3))]))

def offset(pts, d):
    """Polyline offset by d to the left of travel (y down), mitred: a pair keeps its spacing through bends."""
    import math as _m
    segs = []
    for a, c in zip(pts, pts[1:]):
        dx, dy = c[0] - a[0], c[1] - a[1]; L = _m.hypot(dx, dy); nx, ny = dy / L * d, -dx / L * d
        segs.append(((a[0] + nx, a[1] + ny), (c[0] + nx, c[1] + ny)))
    out = [segs[0][0]]
    for (a1, b1), (a2, b2) in zip(segs, segs[1:]):
        d1 = (b1[0] - a1[0], b1[1] - a1[1]); d2 = (b2[0] - a2[0], b2[1] - a2[1])
        den = d1[0] * d2[1] - d1[1] * d2[0]
        if abs(den) < 1e-12: out.append(b1); continue
        t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / den
        out.append((a1[0] + t * d1[0], a1[1] + t * d1[1]))
    out.append(segs[-1][1])
    return out
H = 0.16                                          # half the pair pitch: 0.17 mm gap
for k in (1, 2, 3, 4):
    x0 = X0[k]; m = net_m[k]
    # Kelvin taps: SENSE+ from the inner south corner of pad 1, SENSE- from the inner north corner of
    # pad 2; then one pair, between the pads, 45 degrees into the header column gap beside them
    C = [(x0 + 1.65, 21.4), (x0 + 1.65, 20.0), (x0 + 2.73, 18.92)]
    if k == 2: C += [(x0 + 2.73, 17.23), (x0 + 3.23, 16.73), (54.33, 16.73)]
    if k == 3: C += [(x0 + 2.73, 17.23), (x0 + 2.23, 16.73), (63.57, 16.73)]
    if k in (1, 4): C += [(x0 + 2.73, 14.3), (x0 + 3.73, 13.3), (x0 + 3.73, 12.0 if k == 1 else 11.5)]
    sp = [(x0 + 0.45, 21.4)] + offset(C, H)
    sm = [(x0 + 2.5, 20.6), (x0 + 1.65 + H, 20.6)] + offset(C, -H)[1:]
    up, lo = 16.73 - H, 16.73 + H
    if k == 2:      # inter-row gap east; S- leaves before S+'s via, both F diagonals 0.5 mm apart
        T(f'c{k}+', net_p, 'B', sp + [(54.86, up)])
        V(f'c{k}+v', net_p, 54.86, up)
        T(f'c{k}+f', net_p, 'F', [(54.86, up), (54.86 + up - 14.75, 14.75), (57.29, 14.75)])
        T(f'c{k}-', m, 'B', sm + [(54.83, lo + 0.5)])
        V(f'c{k}-v', m, 54.83, lo + 0.5)
        T(f'c{k}-f', m, 'F', [(54.83, lo + 0.5), (54.83 + lo + 0.5 - 15.25, 15.25), (57.29, 15.25)])
    if k == 3:      # inter-row gap west; S+ (lower on B) takes the eastern via and passes over S- on F
        T(f'c{k}-', m, 'B', sm + [(62.3, up)])
        V(f'c{k}-v', m, 62.3, up)
        T(f'c{k}-f', m, 'F', [(62.3, up), (62.3, 15.65), (61.9, 15.25), (60.21, 15.25)])
        T(f'c{k}+', net_p, 'B', sp + [(63.57 - 0.47, lo + 0.47)])
        V(f'c{k}+v', net_p, 63.1, lo + 0.47)
        T(f'c{k}+f', net_p, 'F', [(63.1, lo + 0.47), (63.1, 14.75), (60.21, 14.75)])
    if k in (1, 4):  # the riser jogs 1 mm east above the header, then B -> In2 north of the control lanes
        vy = 10.6 if k == 1 else 10.3; ey = C[-1][1]; xp, xm = x0 + 3.73 - H, x0 + 3.73 + H
        T(f'c{k}+', net_p, 'B', sp + [(xp, vy)])
        V(f'c{k}+v1', net_p, xp, vy)
        T(f'c{k}-', m, 'B', sm + [(xm + 0.5, ey - 0.5)])
        V(f'c{k}-v1', m, xm + 0.5, ey - 0.5)
    if k == 1:      # corridor east (S+ upper), via row, F fan into pins 12 (S-) / 11 (S+)
        T(f'c{k}+i', net_p, 'I2', [(xp, 10.6), (x0 + 4.88, 10.6), (x0 + 5.34, 11.06), (58.21, 11.06), (58.75, 11.6)])
        T(f'c{k}-i', m, 'I2', [(xm + 0.5, ey - 0.5), (xm + 0.64, 11.36), (57.51, 11.36), (57.75, 11.6)])
        V(f'c{k}+v2', net_p, 58.75, 11.6); V(f'c{k}-v2', m, 57.75, 11.6)
        T(f'c{k}-f', m, 'F', [(57.75, 11.6), (57.75, 12.9), (58.0, 13.15), (58.0, 14.04)])
        T(f'c{k}+f', net_p, 'F', [(58.75, 11.6), (58.75, 13.1), (58.5, 13.35), (58.5, 14.04)])
    if k == 4:      # S+ via further north: S+ runs above S- heading west, so S- leaves first (pin 9)
        T(f'c{k}+i', net_p, 'I2', [(xp, 10.3), (xp - 0.76, 11.06), (60.29, 11.06), (59.75, 11.6)])
        T(f'c{k}-i', m, 'I2', [(xm + 0.5, ey - 0.5), (xm + 0.14, 11.36), (61.0, 11.36), (60.76, 11.6), (60.75, 11.6)])
        V(f'c{k}+v2', net_p, 59.75, 11.6); V(f'c{k}-v2', m, 60.75, 11.6)
        T(f'c{k}+f', net_p, 'F', [(59.75, 11.6), (59.75, 12.6), (59.0, 13.35), (59.0, 14.04)])
        T(f'c{k}-f', m, 'F', [(60.75, 11.6), (60.75, 12.1), (59.5, 13.35), (59.5, 14.04)])
# U700 local copper (F unless noted) and the two moved vias with their new stubs
L = []
def U(tag, net, layer, pts, w): items.append((tag, net, layer, [(round(x, 3), round(y, 3)) for x, y in pts])); L.append((tag, w))
V('u-ep', 'GND', 58.75, 15.5)
U('u-p3', 'GND', 'F', [(59.0, 16.96), (59.0, 16.05)], 0.2)
U('u-p1', 'GND', 'F', [(58.0, 16.96), (58.0, 16.45), (58.2, 16.25)], 0.2)
U('u-c700p', 'MB_3V3', 'F', [(58.5, 16.96), (58.5, 18.42)], 0.25)
U('u-c700g', 'GND', 'F', [(56.95, 18.42), (56.1, 18.42)], 0.3); V('u-c700gv', 'GND', 56.1, 18.42)
V('u-p16v', 'MB_3V3', 57.29, 16.8)
U('u-p16', 'MB_3V3', 'F', [(57.29, 16.25), (57.29, 16.8)], 0.25)
U('u-c701p', 'MB_3V3', 'B', [(57.29, 16.8), (57.29, 17.25)], 0.25)
U('u-c701g', 'GND', 'B', [(58.85, 17.25), (58.85, 15.6), (58.75, 15.5)], 0.25)
U('u-addr', 'PAC_ADDR', 'F', [(60.21, 15.75), (60.85, 15.75), (60.85, 17.65), (60.08, 18.42)], 0.2)
U('u-r700g', 'GND', 'F', [(61.72, 18.42), (62.39, 17.75)], 0.25); V('u-r700gv', 'GND', 62.39, 17.75)
V('m-cam2_5v', 'CAM2_5V', 54.05, 18.45)
V('m-cam3iso', 'CAM3_5V_ISO', 66.75, 10.4)
U('m-cam3iso-f', 'CAM3_5V_ISO', 'F', [(67.75, 11.0), (67.15, 10.4), (66.75, 10.4)], 0.5)
U('m-cam3iso-b', 'CAM3_5V_ISO', 'B', [(66.75, 10.4), (66.75, 11.0)], 0.5)
WIDTH = dict(L)

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                     # SWIG order trap: read before pad lists
fps = list(b.GetFootprints())
mm = lambda v: pcb.ToMM(v) - 50
P = lambda x, y: pt(50 + x, 50 + y)
near = lambda p, x, y, e=0.03: abs(mm(p.x) - x) < e and abs(mm(p.y) - y) < e
LAY = {'F': pcb.F_Cu, 'B': pcb.B_Cu, 'I2': pcb.In2_Cu}
CU = (pcb.F_Cu, pcb.In2_Cu, pcb.B_Cu)
def shapes():
    """(net, layers, shape) of every planned item."""
    out = []
    for tag, net, layer, pts in items:
        if layer == 'V': out.append((net, CU, pcb.SHAPE_CIRCLE(P(*pts[0]), pcb.FromMM(0.3))))
        else:
            w = pcb.FromMM(WIDTH.get(tag, W))
            for a, c in zip(pts, pts[1:]): out.append((net, (LAY[layer],), pcb.SHAPE_SEGMENT(P(*a), P(*c), w)))
    return out
MOVES = [('CAM2_5V', (54.05, 17.25), (54.05, 18.45)), ('CAM3_5V_ISO', (66.75, 11.0), (66.75, 10.4))]
CAM1_STUB = [((26.97, 21.0), (26.57, 20.6)), ((26.57, 20.6), (25.85, 20.6))]

if PHASE == 'clear':
    plan = shapes(); doomed, stuck, moved = [], [], []
    for net, old, new in MOVES:
        for t in tracks:
            if t.GetNetname() != net: continue
            if isinstance(t, pcb.PCB_VIA):
                if near(t.GetPosition(), *old): t.SetPosition(P(*new)); moved.append(f'{net} via {old}->{new}')
            elif net == 'CAM2_5V':                   # vertical runs: the end follows the via
                for get, put in ((t.GetStart, t.SetStart), (t.GetEnd, t.SetEnd)):
                    if near(get(), *old): put(P(*new))
            elif net == 'CAM3_5V_ISO' and t.GetLayer() == pcb.F_Cu and (near(t.GetStart(), *old) or near(t.GetEnd(), *old)):
                doomed.append(t)                     # the F stub to the old via; 'add' draws the new one
    for t in tracks:
        if t.GetNetname() == 'CAM1_SHUNT_OUT':
            if isinstance(t, pcb.PCB_VIA):
                if near(t.GetPosition(), 25.85, 20.6): doomed.append(t)
            elif any((near(t.GetStart(), *a) and near(t.GetEnd(), *c)) or (near(t.GetStart(), *c) and near(t.GetEnd(), *a)) for a, c in CAM1_STUB):
                doomed.append(t)
    gnd_attached = set()
    for t in tracks:
        if not isinstance(t, pcb.PCB_VIA) and t.GetNetname() == 'GND':
            for v in tracks:
                if isinstance(v, pcb.PCB_VIA) and v.GetNetname() == 'GND' and v.GetPosition() in (t.GetStart(), t.GetEnd()): gnd_attached.add(id(v))
    def hits(t):
        for net, layers, s in plan:
            if net == t.GetNetname(): continue
            for l in layers:
                if t.IsOnLayer(l) and t.GetEffectiveShape(l).Collide(s, pcb.FromMM(0.15) - 1): return True
        return False
    stitch = []
    for t in tracks:
        if any(t is d for d in doomed) or not hits(t): continue
        if isinstance(t, pcb.PCB_VIA) and t.GetNetname() == 'GND' and id(t) not in gnd_attached: stitch.append(t)
        elif not t.IsLocked(): doomed.append(t)
        else: stuck.append(f'{t.GetNetname()} {pcb.LayerName(t.GetLayer())} ({mm(t.GetPosition().x):.2f},{mm(t.GetPosition().y):.2f})')
    for f in fps:                                    # pads are fixed: report them
        for p in f.Pads():
            for net, layers, s in plan:
                if net == p.GetNetname(): continue
                if any(p.IsOnLayer(l) and p.GetEffectiveShape(l).Collide(s, pcb.FromMM(0.15) - 1) for l in layers):
                    stuck.append(f'pad {f.GetReference()}.{p.GetNumber()}'); break
    assert not stuck, ('fixed copper in the way', sorted(set(stuck)))
    vias = [t for t in tracks if isinstance(t, pcb.PCB_VIA)]
    def clear_at(v, at):
        s = pcb.SHAPE_CIRCLE(at, pcb.FromMM(0.3))
        if any(o is not v and (o.GetPosition() - at).EuclideanNorm() < pcb.FromMM(0.6) for o in vias): return False
        for _, _, sh in plan:                        # this binding has no circle-to-circle Collide
            if isinstance(sh, pcb.SHAPE_CIRCLE):
                if (sh.GetCenter() - at).EuclideanNorm() < pcb.FromMM(0.3 + 0.3 + 0.2): return False
            elif sh.Collide(s, pcb.FromMM(0.2)): return False
        for t in tracks:
            if t is v or t.GetNetname() == 'GND' or any(t is d for d in doomed): continue
            if any(t.IsOnLayer(l) and t.GetEffectiveShape(l).Collide(s, pcb.FromMM(0.2)) for l in CU): return False
        for f in fps:
            for p in f.Pads():
                if p.GetNetname() != 'GND' and any(p.IsOnLayer(l) and p.GetEffectiveShape(l).Collide(s, pcb.FromMM(0.2)) for l in CU): return False
        return True
    for v in stitch:
        home = v.GetPosition(); best = None
        for ring in range(1, 41):
            r = ring * 0.05; n = max(8, int(2 * math.pi * r / 0.1))
            for i in range(n):
                at = home + pcb.VECTOR2I(pcb.FromMM(r * math.cos(2 * math.pi * i / n)), pcb.FromMM(r * math.sin(2 * math.pi * i / n)))
                if clear_at(v, at): best = at; break
            if best: break
        assert best, ('no spot for stitching via', mm(home.x), mm(home.y))
        v.SetPosition(best); moved.append(f'GND stitch ({mm(home.x):.2f},{mm(home.y):.2f})->({mm(best.x):.2f},{mm(best.y):.2f})')
    names = sorted({t.GetNetname() for t in doomed}); k = len(doomed)
    for t in doomed: b.Remove(t)                 # last: Remove() invalidates the other proxies
    pcb.SaveBoard(str(TARGET), b)
    print('kelvin clear: moved', '; '.join(moved), f'| removed {k} items on {names}', flush=True)
    import os; os._exit(0)

codes = {}
for tag, net, layer, pts in items:
    if net not in codes: codes[net] = b.FindNet(net).GetNetCode()
for net, old, new in MOVES:                      # a moved via with nothing of its own net attached yet can
    for t in tracks:                             # take the pour's net on a save in between: set it back
        if isinstance(t, pcb.PCB_VIA) and near(t.GetPosition(), *new): t.SetNetCode(b.FindNet(net).GetNetCode())
for tag, net, layer, pts in items:
    if layer == 'V':
        if tag in ('m-cam2_5v', 'm-cam3iso'): continue      # moved in 'clear'
        v = pcb.PCB_VIA(b); v.SetPosition(P(*pts[0])); v.SetWidth(pcb.FromMM(.6)); v.SetDrill(pcb.FromMM(.3))
        v.SetViaType(pcb.VIATYPE_THROUGH); v.SetLayerPair(pcb.F_Cu, pcb.B_Cu); v.SetNetCode(codes[net]); v.SetLocked(True); b.Add(v)
        continue
    for a, c in zip(pts, pts[1:]):
        dx, dy = abs(c[0] - a[0]), abs(c[1] - a[1])
        assert min(dx, dy) < 1e-6 or abs(dx - dy) < 2e-3, (tag, 'non-45', a, c)
        t = pcb.PCB_TRACK(b); t.SetStart(P(*a)); t.SetEnd(P(*c)); t.SetWidth(pcb.FromMM(WIDTH.get(tag, W)))
        t.SetLayer(LAY[layer]); t.SetNetCode(codes[net]); t.SetLocked(True); b.Add(t)
pcb.SaveBoard(str(TARGET), b)
print(f'kelvin add: {sum(1 for i in items if i[2] != "V")} polylines, {sum(1 for i in items if i[2] == "V")} vias', flush=True)
import os; os._exit(0)
