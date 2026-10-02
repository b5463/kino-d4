"""Swap smoothed route copper on the board (KiCad 10 python): .cache/carrier-routing/smoothed.json.

Removes each old route's segments (matched by net, layer and end points to 3 um) and adds the new
ones. Vias are unchanged. Run tidy_copper.py and clean_dangling.py afterwards, then DRC.
"""
import json
import pcbnew as pcb
from rework import TARGET
from routing import CACHE, pt

LAYER = {'F': pcb.F_Cu, 'I2': pcb.In2_Cu, 'B': pcb.B_Cu}
import sys
SRC, DST = (sys.argv[1], sys.argv[2]) if len(sys.argv) > 2 else (str(TARGET), str(TARGET))   # optional: copy in, copy out
pairs = json.loads((CACHE / 'smoothed.json').read_text())
b = pcb.LoadBoard(SRC)
every = list(b.GetTracks())             # read first: SWIG order trap; keep the list alive
tracks = [t for t in every if not isinstance(t, pcb.PCB_VIA)]
mm = lambda v: pcb.ToMM(v) - 50
close = lambda a, c: abs(a[0] - c[0]) < 0.003 and abs(a[1] - c[1]) < 0.003
gone = added = 0
for pr in pairs:
    old, new = pr['old'], pr['new']
    for lay, ax, ay, bx, by in old['segments']:
        for k, t in enumerate(tracks):
            if t.GetNetname() != old['net'] or t.GetLayer() != LAYER[lay]: continue
            s, e = (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))
            if (close(s, (ax, ay)) and close(e, (bx, by))) or (close(s, (bx, by)) and close(e, (ax, ay))):
                b.Remove(t); del tracks[k]; gone += 1; break    # by index: SWIG proxies do not compare reliably
    net = b.FindNet(new['net'])
    for lay, ax, ay, bx, by in new['segments']:
        t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + ax, 50 + ay)); t.SetEnd(pt(50 + bx, 50 + by))
        t.SetWidth(pcb.FromMM(new['width'])); t.SetLayer(LAYER[lay]); t.SetNet(net); b.Add(t); added += 1
pcb.SaveBoard(DST, b)
print('replaced', len(pairs), 'routes: removed', gone, 'segments, added', added, flush=True)
import os; os._exit(0)
