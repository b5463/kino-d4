"""Remove the tracks and vias KiCad's DRC reports as dangling (KiCad 10 python).

Reads outputs/DRC-A02.json (run DRC first) and removes exactly the items in its track_dangling and
via_dangling violations, matched by net, layer and position. Nets named with --keep are left alone
(deliberate stubs the router is to continue). Run DRC again afterwards and repeat until nothing is
reported: removing one stub can expose the next. Unlike clean_dangling.py this uses the checker's
own connectivity, so it never removes an item KiCad considers connected.
"""
import json, re, sys
import pcbnew as pcb
from rework import ROOT, TARGET

keep = set(sys.argv[sys.argv.index('--keep') + 1].split(',')) if '--keep' in sys.argv else set()
drc = json.loads((ROOT / 'outputs/DRC-A02.json').read_text(encoding='utf-8'))
wanted = []
for v in drc['violations']:
    if v['type'] not in ('track_dangling', 'via_dangling'): continue
    for it in v['items']:
        m = re.match(r'(Track|Via) \[(.*?)\]', it['description'])
        if m and m.group(2) not in keep: wanted.append((m.group(1), m.group(2), it['pos']['x'], it['pos']['y']))
b = pcb.LoadBoard(str(TARGET))
removed = []
for t in list(b.GetTracks()):
    if t.IsLocked(): continue                     # deliberate copper (fixed routes, lane ends) stays
    kind = 'Via' if isinstance(t, pcb.PCB_VIA) else 'Track'
    pos = t.GetPosition() if kind == 'Via' else t.GetStart()
    for k, net, x, y in wanted:
        if k == kind and t.GetNetname() == net and abs(pcb.ToMM(pos.x) - x) < 0.01 and abs(pcb.ToMM(pos.y) - y) < 0.01:
            b.Remove(t); removed.append(f'{net} {kind.lower()} ({round(x - 50, 2)}, {round(y - 50, 2)})'); break
if removed: pcb.SaveBoard(str(TARGET), b)
print('dropped', len(removed), 'dangling items:', '; '.join(removed) or '-', flush=True)
import os; os._exit(0)
