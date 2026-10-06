"""U700 pin-1 triangle 0.1 mm further from C700 (KiCad 10 python). Release silk pass.

With the legend at 0.15 mm (silk_a02_widths.py), C700's upper silk line touched U700's filled pin-1
triangle. fp_a02_pac1954.py moves the triangle 0.1 mm north-west in the project footprint; this puts the
same triangle on the placed U700, so the board still matches its library. C700 keeps its stock silk.
"""
import pcbnew as pcb
from rework import TARGET

TRI = ((57.35, 17.22), (57.25, 17.67), (56.9, 17.32))     # fp_a02_pac1954.py, board mm
P = lambda x, y: pcb.VECTOR2I(pcb.FromMM(50 + x), pcb.FromMM(50 + y))
mm = lambda v: pcb.ToMM(v) - 50
b = pcb.LoadBoard(str(TARGET))
fs = {f.GetReference(): f for f in b.GetFootprints()}
tri = [g for g in fs['U700'].GraphicalItems() if g.GetLayer() == pcb.F_SilkS and g.GetShape() == pcb.SHAPE_T_POLY]
assert len(tri) == 1
ps = pcb.SHAPE_POLY_SET(); ps.NewOutline()
for x, y in TRI: ps.Append(P(x, y))
tri[0].SetPolyShape(ps)
c = fs['C700'].GetPosition()
for g in fs['C700'].GraphicalItems():       # stock 0603 silk lines are symmetric about the part centre
    if g.GetLayer() == pcb.F_SilkS and isinstance(g, pcb.PCB_SHAPE):
        g.SetEnd(pcb.VECTOR2I(2 * c.x - g.GetStart().x, g.GetStart().y))
pcb.SaveBoard(str(TARGET), b)
print('U700 pin-1 triangle moved; C700 silk restored', flush=True)
import os; os._exit(0)
