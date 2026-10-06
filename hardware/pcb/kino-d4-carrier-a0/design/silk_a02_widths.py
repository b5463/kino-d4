"""Silkscreen lines and text strokes to the fab's 0.15 mm legend minimum (KiCad 10 python). Release manufacturing review.

Stock footprints draw silk at 0.12 mm and the 0.8 mm references used a 0.12 mm stroke; the fab's legend
minimum is 0.15 mm. Every silkscreen line, arc and unfilled circle or polygon (footprint graphics and board drawings) and
every silkscreen text stroke under 0.15 mm goes to 0.15 mm; filled marks (pin-1 triangles, dots) print as drawn. The Gerbers clip silk at mask
openings, so a wider line cannot print on a pad. assembly_labels.py places references with a 0.15 mm stroke.
"""
import pcbnew as pcb
from rework import TARGET

W = pcb.FromMM(0.15)
b = pcb.LoadBoard(str(TARGET))
silk = (pcb.F_SilkS, pcb.B_SilkS)
n_line = n_text = 0
def fix(item):
    global n_line, n_text
    if item.GetLayer() not in silk: return
    if isinstance(item, pcb.PCB_TEXT) or isinstance(item, pcb.PCB_FIELD):
        if item.GetTextThickness() < W: item.SetTextThickness(W); n_text += 1
    elif isinstance(item, pcb.PCB_SHAPE) and not item.IsAnyFill():   # filled marks print as drawn
        if 0 < item.GetWidth() < W: item.SetWidth(W); n_line += 1
for f in b.GetFootprints():
    for g in f.GraphicalItems(): fix(g)
    for fld in f.GetFields(): fix(fld)
for d in b.GetDrawings(): fix(d)
pcb.SaveBoard(str(TARGET), b)
print(f'silk widened to 0.15 mm: {n_line} lines, {n_text} text strokes', flush=True)
import os; os._exit(0)
