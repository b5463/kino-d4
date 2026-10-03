"""Stitch GND pour fragments that carry pads but reach no via to the In1 plane (KiCad 10 python).

For each outer-layer GND fill fragment with no GND via or plated hole inside, one 0.6/0.3 mm via
is placed where the fragment is widest: the via ring plus clearance must lie inside the fragment
on its own layer, inside a GND fill on the other outer layer where one exists there, 0.6 mm from
any In2 track, 0.75 mm from any via and clear of other holes. Fragments too small for that are
left for KiCad's island removal and listed. Run DRC with --refill-zones --save-board first and
again afterwards; gnd_islands.py lists what remains. --dry only reports.
"""
import json, math, sys
import pcbnew as pcb
from rework import TARGET
from routing import pt, CACHE

DRY = '--dry' in sys.argv
PLACED = CACHE / 'gnd-stitch.json'      # vias this script owns; removed and re-planned on every run
b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())            # SWIG order trap: read before pad lists
gnd = b.FindNet('GND')
code = gnd.GetNetCode()
mm = lambda v: pcb.ToMM(v) - 50
pads = [p for f in b.GetFootprints() for p in f.Pads()]     # and before any Remove(): footprints break after one
holes = [p for p in pads if p.GetAttribute() in (pcb.PAD_ATTRIB_PTH, pcb.PAD_ATTRIB_NPTH)]
own = json.loads(PLACED.read_text()) if PLACED.exists() else []
def is_own(t): return isinstance(t, pcb.PCB_VIA) and any(abs(mm(t.GetPosition().x) - x) < .02 and abs(mm(t.GetPosition().y) - y) < .02 for x, y in own)
stale = [t for t in tracks if is_own(t)]    # removed only at the end: Remove() invalidates the other proxies
tracks = [t for t in tracks if not is_own(t)]
vias = [t for t in tracks if isinstance(t, pcb.PCB_VIA)]
in2 = [t for t in tracks if not isinstance(t, pcb.PCB_VIA) and t.GetLayer() == pcb.In2_Cu]
outer = [t for t in tracks if not isinstance(t, pcb.PCB_VIA) and t.GetLayer() in (pcb.F_Cu, pcb.B_Cu)]
anchors = [v.GetPosition() for v in vias if v.GetNetCode() == code] + [p.GetPosition() for p in holes if p.GetNetCode() == code]
fills = {}
for z in b.Zones():
    if z.GetNetCode() != code or z.GetIsRuleArea(): continue
    for layer in z.GetLayerSet().Seq():
        polys = z.GetFilledPolysList(layer)
        fills.setdefault(layer, []).extend(polys.Outline(i) for i in range(polys.OutlineCount()))
other = {pcb.F_Cu: pcb.B_Cu, pcb.B_Cu: pcb.F_Cu}

def inside(outline, x, y, r):
    for k in range(12):
        a = k * math.pi / 6
        if not outline.PointInside(pt(50 + x + r * math.cos(a), 50 + y + r * math.sin(a))): return False
    return outline.PointInside(pt(50 + x, 50 + y))

def clear(x, y):
    p = pt(50 + x, 50 + y)
    if any((v.GetPosition() - p).EuclideanNorm() < pcb.FromMM(0.75) for v in vias): return False
    for h in holes:
        if (h.GetPosition() - p).EuclideanNorm() < h.GetDrillSize().x / 2 + pcb.FromMM(0.3 + 0.25): return False
    for t in in2 + outer:                   # any copper of another net on a layer the via touches
        if t.GetNetCode() == code: continue
        seg = pcb.SEG(t.GetStart(), t.GetEnd())
        if seg.Distance(p) < t.GetWidth() / 2 + pcb.FromMM(0.3 + 0.2): return False
    for q in pads:                          # SMD lands and unconnected pads on either face
        if q.GetAttribute() == pcb.PAD_ATTRIB_NPTH: continue
        same = q.GetNetCode() == code
        if same and q.GetAttribute() != pcb.PAD_ATTRIB_SMD: continue
        if (q.GetPosition() - p).EuclideanNorm() > pcb.FromMM(3): continue
        gap = 0.1 if same else 0.2           # GND lands too: no via in or touching a pad (ODD JOBS 82)
        for layer in (pcb.F_Cu, pcb.B_Cu):
            if q.IsOnLayer(layer) and q.GetEffectiveShape(layer).Collide(p, pcb.FromMM(0.3 + gap)): return False
    return True

added, skipped = [], []
for layer, outlines in fills.items():
    if layer not in other: continue
    for o in outlines:
        if any(o.PointInside(a) for a in anchors): continue
        bb = o.BBox()
        touching = [p.GetParentFootprint().GetReference() + '.' + p.GetNumber() for p in pads
                    if p.GetNetCode() == code and p.IsOnLayer(layer) and o.PointInside(p.GetPosition())]
        best = None
        for r in (0.65, 0.55, 0.47):
            x = mm(bb.GetLeft())
            while x <= mm(bb.GetRight()) and not best:
                y = mm(bb.GetTop())
                while y <= mm(bb.GetBottom()):
                    if inside(o, x, y, r) and clear(x, y):
                        far = [q for q in fills.get(other[layer], []) if q.PointInside(pt(50 + x, 50 + y))]
                        if not far or inside(far[0], x, y, r):
                            best = (x, y, r); break
                    y += 0.1
                x += 0.1
            if best: break
        where = f'{b.GetLayerName(layer)} {round(o.Area() / 1e12, 2)} mm2 at ({round(mm(bb.GetCenter().x), 1)}, {round(mm(bb.GetCenter().y), 1)}) pads {touching}'
        if not best: skipped.append(where); continue
        x, y, r = best
        added.append((x, y, where))
        if DRY: continue
        v = pcb.PCB_VIA(b); v.SetPosition(pt(50 + x, 50 + y)); v.SetWidth(pcb.FromMM(.6)); v.SetDrill(pcb.FromMM(.3))
        v.SetViaType(pcb.VIATYPE_THROUGH); v.SetLayerPair(pcb.F_Cu, pcb.B_Cu); v.SetNet(gnd); b.Add(v)
        vias.append(v)
for x, y, where in added: print('via', round(x, 2), round(y, 2), 'stitches', where, flush=True)
for where in skipped: print('no site:', where, flush=True)
if not DRY:
    for t in stale: b.Remove(t)
    pcb.SaveBoard(str(TARGET), b)
    PLACED.write_text(json.dumps([[round(x, 3), round(y, 3)] for x, y, _ in added]))
print(len(added), 'stitching vias', 'planned' if DRY else 'added;', len(skipped), 'fragments without a site', flush=True)
import os; os._exit(0)
