"""Straighten staircases and chamfer right angles on A0.2 (KiCad 10 python). ODD JOBS 87/88.

Every unlocked chain of same-net, same-width tracks between junctions, pads and vias is rebuilt
greedily: from a vertex, the farthest later vertex that one straight run plus one 45-degree jog
reaches without touching foreign copper replaces everything between (the grid router's own
smoothing, applied again on the finished board, where the cells it had to avoid are now known
exactly). Remaining 90-degree corners get a 45-degree chamfer of up to 0.4 mm where the diagonal
is clear. Chain ends never move, so connectivity is unchanged; locked tracks (the explicit power
routes of route_a02.py and later scripts) are never touched.

Clearance for every new segment: CLR to tracks, pads and vias of other nets on its layer (more
than the 0.15 mm rule, so nothing hugs), no entry into a rule area that forbids tracks, and no
new run shorter than MIN_RUN. Run DRC afterwards; this script checks copper, not silk or mask.

Run it LAST. The hand-route scripts remove their own copper by matching the geometry they drew; once
this pass has reshaped that copper they no longer recognise it, so re-running one of them after a tidy
duplicates its routes. To re-run a hand script, start from a board saved before the tidy pass.

    python tidy_routes.py            # rewrite the board
    python tidy_routes.py --dry      # report only
"""
import math, os, sys
from collections import defaultdict
import pcbnew as pcb
from rework import TARGET

DRY = '--dry' in sys.argv
CLR = pcb.FromMM(0.17)                # new straight runs keep this from foreign copper (rule is 0.15)
CLR_CH = pcb.FromMM(0.15)             # chamfers and moved vias: the rule itself
JOG = pcb.FromMM(0.35)                # a sideways step shorter than this is a jog, not a route
MIN_RUN = pcb.FromMM(0.25)            # shortest segment this script will create
CHAMFER = pcb.FromMM(0.4)
COPPER = (pcb.F_Cu, pcb.In2_Cu, pcb.B_Cu)

b = pcb.LoadBoard(str(TARGET))
tracks = [t for t in b.GetTracks() if not isinstance(t, pcb.PCB_VIA)]
vias = [t for t in b.GetTracks() if isinstance(t, pcb.PCB_VIA)]
pads = [p for f in b.GetFootprints() for p in f.Pads()]
areas = [z for z in b.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowTracks()]

# ---- obstacle index: 1 mm cells per layer ------------------------------------------------
CELL = pcb.FromMM(1.0)
grid = {l: defaultdict(list) for l in COPPER}
def cells(bb, pad=0):
    x0 = (bb.GetLeft() - pad) // CELL; x1 = (bb.GetRight() + pad) // CELL
    y0 = (bb.GetTop() - pad) // CELL; y1 = (bb.GetBottom() + pad) // CELL
    return [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
def index(layer, net, shape, bb):
    for c in cells(bb, CLR): grid[layer][c].append((net, shape))
for t in tracks:
    if t.GetLayer() in COPPER: index(t.GetLayer(), t.GetNetCode(), t.GetEffectiveShape(), t.GetBoundingBox())
for v in vias:
    for l in COPPER:
        if v.IsOnLayer(l): index(l, v.GetNetCode(), v.GetEffectiveShape(l), v.GetBoundingBox())
for p in pads:
    for l in COPPER:
        if p.IsOnLayer(l): index(l, p.GetNetCode(), p.GetEffectiveShape(l), p.GetBoundingBox())

def clear(layer, net, a, c, width, ignore=(), clr=None):
    clr = CLR if clr is None else clr
    """True if a track a-c of this width on this layer keeps CLR from everything of another net."""
    seg = pcb.SHAPE_SEGMENT(a, c, width)
    bb = pcb.BOX2I(pcb.VECTOR2I(min(a.x, c.x), min(a.y, c.y)), pcb.VECTOR2I(abs(a.x - c.x), abs(a.y - c.y)))
    bb.Inflate(width // 2 + clr)
    seen = set()
    for cell in cells(bb):
        for n, shape in grid[layer][cell]:
            if n == net or id(shape) in seen or id(shape) in ignore: continue
            seen.add(id(shape))
            if seg.Collide(shape, clr): return False
    for z in areas:
        if z.IsOnLayer(layer) and z.Outline().Collide(seg, 0): return False
    return True

def legal(a, c):
    dx, dy = abs(a.x - c.x), abs(a.y - c.y)
    return dx == 0 or dy == 0 or abs(dx - dy) <= 2       # axis-aligned or exact 45 degrees
def sgn(v): return (v > 0) - (v < 0)
def length(a, c): return math.hypot(a.x - c.x, a.y - c.y)

def connectors(a, c):
    """Candidate point lists a..c: one segment, or straight+45 / 45+straight; each leg >= MIN_RUN."""
    if legal(a, c): return [[a, c]] if length(a, c) >= MIN_RUN else []
    dx, dy = c.x - a.x, c.y - a.y; d = min(abs(dx), abs(dy))
    m1 = pcb.VECTOR2I(a.x + sgn(dx) * d, a.y + sgn(dy) * d)      # 45 first, then straight
    m2 = pcb.VECTOR2I(c.x - sgn(dx) * d, c.y - sgn(dy) * d)      # straight first, then 45
    out = []
    for m in (m2, m1):
        if length(a, m) >= MIN_RUN and length(m, c) >= MIN_RUN: out.append([a, m, c])
    return out

# ---- chains --------------------------------------------------------------------------------
def key(t, v): return (t.GetNetCode(), t.GetLayer(), t.GetWidth(), v.x, v.y)
bylayer = defaultdict(list)
for t in tracks: bylayer[(t.GetNetCode(), t.GetLayer())].append(t)
at = defaultdict(list)
for t in tracks:
    if t.IsLocked() or t.GetLayer() not in COPPER or t.GetLength() == 0: continue
    at[key(t, t.GetStart())].append(t); at[key(t, t.GetEnd())].append(t)
def stop(k):
    """A chain end: junction, width change, or a same-net pad or via under the vertex."""
    if len(at[k]) != 2: return True
    net, layer, w, x, y = k; p = pcb.VECTOR2I(x, y)
    for v in vias:
        if v.GetNetCode() == net and v.GetPosition() == p: return True
    for q in pads:
        if q.GetNetCode() == net and q.IsOnLayer(layer) and q.GetBoundingBox().Contains(p) and q.GetEffectiveShape(layer).Collide(p, 0): return True
    # any other same-net track on this layer touching the vertex is a junction: a different width, a
    # locked track, or one this vertex joins square-on in the middle (the router's track joins)
    mine = at[k]
    for t in bylayer[(net, layer)]:
        if any(t is m for m in mine): continue
        if t.GetBoundingBox().Contains(p) and t.HitTest(p, 0): return True
    return False

used = set(); chains = []
for t in list(at.values()):
    for t0 in t:
        if id(t0) in used: continue
        for start in (t0.GetStart(), t0.GetEnd()):
            if not stop(key(t0, start)): continue
            # walk from a stop vertex through degree-2 vertices
            pts = [start]; cur = t0; v = start; members = []
            while True:
                members.append(cur); used.add(id(cur))
                v = cur.GetEnd() if cur.GetStart() == v else cur.GetStart(); pts.append(v)
                k = key(cur, v)
                if stop(k): break
                nxt = [u for u in at[k] if u is not cur]
                if len(nxt) != 1 or id(nxt[0]) in used: break
                cur = nxt[0]
            # other same-net tracks ending on a member's centreline (square joins made onto this chain):
            # those points must stay on whatever replaces the chain
            net, layer, w = t0.GetNetCode(), t0.GetLayer(), t0.GetWidth()
            joins = []
            for m, a, c in zip(members, pts, pts[1:]):
                L2 = (c.x - a.x) ** 2 + (c.y - a.y) ** 2
                if L2 == 0: continue
                for t in bylayer[(net, layer)]:
                    if any(t is mm_ for mm_ in members): continue
                    for e in (t.GetStart(), t.GetEnd()):
                        u = ((e.x - a.x) * (c.x - a.x) + (e.y - a.y) * (c.y - a.y)) / L2
                        if 0.02 < u < 0.98:
                            px, py = a.x + u * (c.x - a.x), a.y + u * (c.y - a.y)
                            if math.hypot(e.x - px, e.y - py) < pcb.FromMM(0.005): joins.append(e)
            if len(pts) >= 3: chains.append((net, layer, w, pts, members, joins))
            break

# ---- rebuild -----------------------------------------------------------------------------
removed = added = straightened = chamfered = 0
def own_ids(members): return {id(m.GetEffectiveShape()) for m in members}
new_tracks = []
def joins_in(pts, i, j, joins):
    """Join points lying on the original segments between vertices i and j."""
    out = []
    for e in joins:
        for a, c in zip(pts[i:j], pts[i + 1:j + 1]):
            if pcb.SHAPE_SEGMENT(a, c, 1).Collide(e, pcb.FromMM(0.01)): out.append(e); break
    return out
gone = set()
def keeps(e, path, w):
    for a, c in zip(path, path[1:]):
        if pcb.SHAPE_SEGMENT(a, c, w).Collide(e, 0): return True
    return False
for net, layer, w, pts, members, joins in chains:
    ignore = own_ids(members)
    # the shapes indexed for these members are the same objects GetEffectiveShape returned? No: fresh
    # objects each call. Index by segment geometry instead: rebuild ignore from coordinates.
    own_geo = {(m.GetStart().x, m.GetStart().y, m.GetEnd().x, m.GetEnd().y) for m in members}
    def clear_own(a, c):
        # foreign copper only: shapes of our own members are same-net and skipped by net anyway
        return clear(layer, net, a, c, w)
    # jogs: A-B-C-D with AB parallel to CD on the same axis and BC short - move CD onto AB's line
    # (or AB onto CD's) when the next segment is perpendicular, so the step simply vanishes
    def axis(a, c):
        if a.x == c.x and a.y != c.y: return 'v'
        if a.y == c.y and a.x != c.x: return 'h'
        return None
    k = 0
    while k + 3 < len(pts):
        A, B, C, D = pts[k:k + 4]
        ax_ = axis(A, B)
        if ax_ and ax_ == axis(C, D) and length(B, C) < JOG:
            fixed = []
            for e in joins:
                if keeps(e, [B, C], w): fixed.append(e)
            if not fixed:
                # option 1: shift C, D onto AB's line (D's successor must be perpendicular or absent-as-chain-end is not allowed)
                if k + 4 < len(pts) and axis(D, pts[k + 4]) == ('h' if ax_ == 'v' else 'v'):
                    D2 = pcb.VECTOR2I(D.x, A.y) if ax_ == 'h' else pcb.VECTOR2I(A.x, D.y)
                    if length(A, D2) >= MIN_RUN and clear_own(A, D2) and clear_own(D2, pts[k + 4]) and all(keeps(e, [A, D2, pts[k + 4]], w) for e in joins_in(pts, k, k + 4, joins)):
                        pts[k:k + 4] = [A, D2]; continue
                # option 2: shift A, B onto CD's line (A's predecessor must be perpendicular)
                if k > 0 and axis(pts[k - 1], A) == ('h' if ax_ == 'v' else 'v'):
                    A2 = pcb.VECTOR2I(A.x, C.y) if ax_ == 'h' else pcb.VECTOR2I(C.x, A.y)
                    if length(A2, D) >= MIN_RUN and clear_own(pts[k - 1], A2) and clear_own(A2, D) and all(keeps(e, [pts[k - 1], A2, D], w) for e in joins_in(pts, k - 1, k + 3, joins)):
                        pts[k:k + 3] = [A2]; k = max(k - 1, 0); continue
        k += 1
    out = [pts[0]]; i = 0; n = len(pts) - 1
    while i < n:
        done = False
        for j in range(n, i + 1, -1):
            span = joins_in(pts, i, j, joins)
            for cand in connectors(pts[i], pts[j]):
                if all(clear_own(cand[k], cand[k + 1]) for k in range(len(cand) - 1)) and all(keeps(e, cand, w - pcb.FromMM(0.02)) for e in span):
                    out.extend(cand[1:]); i = j; done = True; break
            if done: break
        if not done:
            out.append(pts[i + 1]); i += 1
    if len(out) < len(pts): straightened += len(pts) - len(out)
    # chamfer right angles left in the rebuilt chain
    k = 1
    while k < len(out) - 1:
        a, v, c = out[k - 1], out[k], out[k + 1]
        u1 = pcb.VECTOR2I(a.x - v.x, a.y - v.y); u2 = pcb.VECTOR2I(c.x - v.x, c.y - v.y)
        if u1.x * u2.x + u1.y * u2.y == 0 and legal(a, v) and legal(v, c):
            l1, l2 = length(a, v), length(v, c)
            dmax = min(CHAMFER, l1 - MIN_RUN, l2 - MIN_RUN)
            for d in (dmax, pcb.FromMM(0.3), pcb.FromMM(0.2), pcb.FromMM(0.15)):   # the largest chamfer that clears
                if d > dmax or d < pcb.FromMM(0.15): continue
                p1 = pcb.VECTOR2I(int(v.x + u1.x * d / l1), int(v.y + u1.y * d / l1))
                p2 = pcb.VECTOR2I(int(v.x + u2.x * d / l2), int(v.y + u2.y * d / l2))
                if clear(layer, net, p1, p2, w, clr=CLR_CH) and not any(math.hypot(e.x - v.x, e.y - v.y) < d + w for e in joins):
                    out[k:k + 1] = [p1, p2]; chamfered += 1; k += 1; break
        k += 1
    if os.environ.get('TIDY_DEBUG') and b.FindNet(net).GetNetname() == os.environ['TIDY_DEBUG']:
        f = lambda q: (round(pcb.ToMM(q.x) - 50, 3), round(pcb.ToMM(q.y) - 50, 3))
        print('  chain', b.GetLayerName(layer), 'pts', [f(q) for q in pts], '\n     out', [f(q) for q in out], 'members', len(members), flush=True)
    if out == pts: continue
    for m in members:
        if id(m) in gone: continue
        gone.add(id(m))
        if not DRY: b.Remove(m)
        removed += 1
    for a, c in zip(out, out[1:]):
        if a == c: continue
        if not DRY:
            t = pcb.PCB_TRACK(b); t.SetStart(a); t.SetEnd(c); t.SetWidth(w); t.SetLayer(layer); t.SetNetCode(net); b.Add(t)
        added += 1
        index(layer, net, pcb.SHAPE_SEGMENT(a, c, w), pcb.BOX2I(pcb.VECTOR2I(min(a.x, c.x), min(a.y, c.y)), pcb.VECTOR2I(abs(a.x - c.x), abs(a.y - c.y))))
# ---- vias: a 90-degree bend at a via with exactly two tracks becomes a 45 by sliding the via ----
def via_clear(layer_list, net, m, ring):
    c = pcb.SHAPE_CIRCLE(m, ring // 2)
    bb = pcb.BOX2I(pcb.VECTOR2I(m.x - ring // 2, m.y - ring // 2), pcb.VECTOR2I(ring, ring)); bb.Inflate(CLR_CH)
    for layer in layer_list:
        seen = set()
        for cell in cells(bb):
            for n, shape in grid[layer][cell]:
                if n == net or id(shape) in seen: continue
                seen.add(id(shape))
                if shape.Collide(c, CLR_CH): return False      # SHAPE::Collide(SHAPE*, clearance); the circle overload is ambiguous in SWIG
    for v2 in vias:                                   # hole to hole, any net
        if v2.GetPosition() != m and (v2.GetPosition() - m).EuclideanNorm() < ring + CLR_CH: return False
    for q in holes:
        if (q.GetPosition() - m).EuclideanNorm() < ring // 2 + q.GetDrillSize().x // 2 + pcb.FromMM(0.25): return False
    for z in areas:
        if z.GetDoNotAllowVias() and z.Outline().Collide(m, ring // 2): return False
    return True
holes = [p for p in pads if p.GetAttribute() in (pcb.PAD_ATTRIB_PTH, pcb.PAD_ATTRIB_NPTH)]
alltracks = [t for t in b.GetTracks() if not isinstance(t, pcb.PCB_VIA)]
slid = 0
for v in vias:
    if v.IsLocked(): continue
    pv = v.GetPosition(); net = v.GetNetCode()
    ends = [t for t in alltracks if t.GetNetCode() == net and (t.GetStart() == pv or t.GetEnd() == pv)]
    if len(ends) != 2 or any(t.IsLocked() for t in ends): continue
    if any(q.GetNetCode() == net and q.GetBoundingBox().Contains(pv) for q in pads): continue
    t1, t2 = ends
    A = t1.GetEnd() if t1.GetStart() == pv else t1.GetStart()
    B = t2.GetEnd() if t2.GetStart() == pv else t2.GetStart()
    u1 = pcb.VECTOR2I(A.x - pv.x, A.y - pv.y); u2 = pcb.VECTOR2I(B.x - pv.x, B.y - pv.y)
    if u1.x * u2.x + u1.y * u2.y != 0 or not (legal(A, pv) and legal(pv, B)): continue
    for cand in connectors(A, B):
        if len(cand) != 3: continue
        m = cand[1]
        if not via_clear(COPPER, net, m, v.GetWidth(pcb.F_Cu)): continue
        if not (clear(t1.GetLayer(), net, A, m, t1.GetWidth(), clr=CLR_CH) and clear(t2.GetLayer(), net, m, B, t2.GetWidth(), clr=CLR_CH)): continue
        if not DRY:
            v.SetPosition(m)
            for t, far in ((t1, A), (t2, B)):
                if t.GetStart() == pv: t.SetStart(m)
                else: t.SetEnd(m)
        slid += 1; break
print(f'tidy: {slid} vias slid onto 45-degree bends', flush=True)
if not DRY: pcb.SaveBoard(str(TARGET), b)
print(f'tidy: {len(chains)} chains; {straightened} vertices removed, {chamfered} corners chamfered; {removed} segments -> {added}' + (' (dry)' if DRY else ''), flush=True)
import os; os._exit(0)
