"""Move the ODD JOBS maker mark and its product lines into the clear area below the COVER connector.

apply_brand.py put the mark directly under J901, over the J901 tracks and three vias, so the
silkscreen was clipped at the via openings. 7.2 mm lower, the symbol and the lines KINO D4 /
A0.2 DRAFT / CARRIER REV 1 sit on unbroken pour between J901 and R1004 (ODD JOBS 96/97: mark
above the product identity, visible, not over copper features). The symbol keeps 0.55 mm from the
REMOTE_FILTER via above it, the caption 0.67 mm from the R1004 reference below. No copper changes. Re-running is harmless: the mark is moved
to the recorded target, not by a fixed offset.
"""
import json
import pcbnew as pcb
from rework import ROOT, TARGET

TOP_LEFT = (105.5, 29.2)                       # symbol bounding box, board mm

b = pcb.LoadBoard(str(TARGET))
mm = lambda v: pcb.ToMM(v) - 50
group = next(g for g in b.Groups() if g.GetName() == 'ODD JOBS maker mark')
symbol = next(i for i in group.GetItems() if isinstance(i, pcb.PCB_SHAPE))
bb = symbol.GetBoundingBox()
dx, dy = TOP_LEFT[0] - mm(bb.GetLeft()), TOP_LEFT[1] - mm(bb.GetTop())
delta = pcb.VECTOR2I(pcb.FromMM(dx), pcb.FromMM(dy))
group.Move(delta)
rev = [d for d in b.GetDrawings() if isinstance(d, pcb.PCB_TEXT) and d.GetText() == 'CARRIER REV 1']
for t in rev: t.Move(delta)
pcb.SaveBoard(str(TARGET), b)

path = ROOT / 'outputs/BRAND-PLACEMENT.json'
rec = json.loads(path.read_text()); rec['board_top_left_mm'] = list(TOP_LEFT)
path.write_text(json.dumps(rec, indent=2) + '\n')
print(f'maker mark moved by ({dx:+.2f}, {dy:+.2f}) mm to {TOP_LEFT}; CARRIER REV 1 moved with it ({len(rev)})', flush=True)
import os; os._exit(0)
