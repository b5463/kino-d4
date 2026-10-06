"""Dump board copper geometry for grid_router.py (run with KiCad 10 python).

Writes .cache/carrier-routing/grid-dump.json in carrier mm (board origin offset removed).
Pads are exported as their axis-aligned bounding box (circles as circles), which is
conservative for rotated shapes. Zones are not exported: the GND pours refill around new
copper and In1 carries no tracks.
"""
import json
import pcbnew as pcb
from rework import TARGET
from routing import CACHE

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())            # read first: this SWIG build fails if read after pad lists
mm = lambda v: pcb.ToMM(v) - 50
LAYERS = {pcb.F_Cu: 'F', pcb.In1_Cu: 'I1', pcb.In2_Cu: 'I2', pcb.B_Cu: 'B'}

out = {'pads': [], 'tracks': [], 'vias': [], 'keepouts': [], 'classes': {}}
for t in tracks:
    if isinstance(t, pcb.PCB_VIA):
        p = t.GetPosition()
        out['vias'].append({'net': t.GetNetname(), 'x': mm(p.x), 'y': mm(p.y), 'd': pcb.ToMM(t.GetWidth(pcb.F_Cu))})
    elif t.GetLayer() in LAYERS:
        s, e = t.GetStart(), t.GetEnd()
        out['tracks'].append({'net': t.GetNetname(), 'layer': LAYERS[t.GetLayer()],
                              'x1': mm(s.x), 'y1': mm(s.y), 'x2': mm(e.x), 'y2': mm(e.y), 'w': pcb.ToMM(t.GetWidth())})
for f in b.GetFootprints():
    for p in f.Pads():
        attr = p.GetAttribute()
        kind = 'PTH' if attr == pcb.PAD_ATTRIB_PTH else 'NPTH' if attr == pcb.PAD_ATTRIB_NPTH else 'SMD'
        layers = [n for l, n in LAYERS.items() if p.IsOnLayer(l)] if kind == 'SMD' else ['F', 'I1', 'I2', 'B']
        bb = p.GetBoundingBox(); c = p.GetPosition()
        rec = {'ref': f.GetReference(), 'num': p.GetNumber(), 'net': p.GetNetname(), 'kind': kind, 'layers': layers,
               'x': mm(c.x), 'y': mm(c.y), 'box': [mm(bb.GetLeft()), mm(bb.GetTop()), mm(bb.GetRight()), mm(bb.GetBottom())]}
        if p.GetShape(pcb.F_Cu) == pcb.PAD_SHAPE_CIRCLE:
            rec['r'] = pcb.ToMM(p.GetSize(pcb.F_Cu).x) / 2
        if kind != 'SMD':
            rec['drill'] = pcb.ToMM(p.GetDrillSize().x)
        if kind == 'NPTH':
            rec['r'] = max(pcb.ToMM(p.GetDrillSize().x), pcb.ToMM(p.GetSize(pcb.F_Cu).x)) / 2
        out['pads'].append(rec)
for z in b.Zones():
    if not z.GetIsRuleArea(): continue
    o = z.Outline()
    pts = [(mm(o.CVertex(i).x), mm(o.CVertex(i).y)) for i in range(o.TotalVertices())]
    out['keepouts'].append({'layers': [n for l, n in LAYERS.items() if z.IsOnLayer(l)], 'pts': pts,
                            'tracks': z.GetDoNotAllowTracks(), 'vias': z.GetDoNotAllowVias()})
eb = b.GetBoardEdgesBoundingBox()
out['edge'] = [mm(eb.GetLeft()), mm(eb.GetTop()), mm(eb.GetRight()), mm(eb.GetBottom())]
(CACHE / 'grid-dump.json').write_text(json.dumps(out))
print('dumped', len(out['pads']), 'pads', len(out['tracks']), 'tracks', len(out['vias']), 'vias', len(out['keepouts']), 'keepouts', flush=True)
import os; os._exit(0)                  # skip SWIG teardown, which can hang this build
