"""Apply .cache/carrier-routing/grid-routes.json (grid_router.py) to the A0.2 board. KiCad 10 python."""
import json
import pcbnew as pcb
from rework import TARGET
from routing import CACHE, pt

LAYER = {'F': pcb.F_Cu, 'I2': pcb.In2_Cu, 'B': pcb.B_Cu}
data = json.loads((CACHE / 'grid-routes.json').read_text())
b = pcb.LoadBoard(str(TARGET))
n_seg = n_via = 0
for r in data['routes']:
    net = b.FindNet(r['net'])
    for layer, ax, ay, bx, by in r['segments']:
        t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + ax, 50 + ay)); t.SetEnd(pt(50 + bx, 50 + by))
        t.SetWidth(pcb.FromMM(r['width'])); t.SetLayer(LAYER[layer]); t.SetNet(net); b.Add(t); n_seg += 1
    for x, y in r['vias']:
        v = pcb.PCB_VIA(b); v.SetPosition(pt(50 + x, 50 + y)); v.SetWidth(pcb.FromMM(0.6)); v.SetDrill(pcb.FromMM(0.3))
        v.SetLayerPair(pcb.F_Cu, pcb.B_Cu); v.SetNet(net); b.Add(v); n_via += 1
pcb.SaveBoard(str(TARGET), b)
print('applied', len(data['routes']), 'routes:', n_seg, 'segments,', n_via, 'vias;', len(data['failed']), 'failed', flush=True)
import os; os._exit(0)
