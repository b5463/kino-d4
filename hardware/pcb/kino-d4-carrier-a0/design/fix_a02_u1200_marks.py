"""U1200 (TPS61288, KINO_A0:TPS61288_RQQ0011A_DRAFT) body outline and pin-1 mark (KiCad 10 python). Release BOM review W1.

The fab outline was drawn 2.5 x 3.0 mm; in this pad orientation the RQQ body is 3.0 (x) x 2.5 (y) (TI
RQQ0011A), and the footprint had no pin-1 mark. The outline now has a chamfer at pin 1 and a 0.2 mm
silkscreen dot sits outside the pin-1 corner, 0.34 mm from the pads. build.py and the library
footprint carry the same graphics. U1200 is on the back, flipped top to bottom: pin 1 is at the lower
left of the body in board coordinates. No copper changes.
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt

b = pcb.LoadBoard(str(TARGET))
f = next(f for f in b.GetFootprints() if f.GetReference() == 'U1200')
cx, cy = pcb.ToMM(f.GetPosition().x) - 50, pcb.ToMM(f.GetPosition().y) - 50
assert f.IsFlipped() and f.GetOrientationDegrees() == 0, 'placement changed: recompute the mark'
p1 = [q for q in f.Pads() if q.GetNumber() == '1']
assert all(pcb.ToMM(q.GetPosition().x) - 50 < cx and pcb.ToMM(q.GetPosition().y) - 50 > cy for q in p1), 'pin 1 not lower left'
old = [g for g in f.GraphicalItems() if g.GetLayer() == pcb.B_Fab and isinstance(g, pcb.PCB_SHAPE)]
outline = [(-1.0, 1.25), (1.5, 1.25), (1.5, -1.25), (-1.5, -1.25), (-1.5, 0.75), (-1.0, 1.25)]
for a, c in zip(outline, outline[1:]):
    s = pcb.PCB_SHAPE(f); s.SetShape(pcb.SHAPE_T_SEGMENT); s.SetLayer(pcb.B_Fab); s.SetWidth(pcb.FromMM(.1))
    s.SetStart(pt(50 + cx + a[0], 50 + cy + a[1])); s.SetEnd(pt(50 + cx + c[0], 50 + cy + c[1])); f.Add(s)
dot = pcb.PCB_SHAPE(f); dot.SetShape(pcb.SHAPE_T_CIRCLE); dot.SetLayer(pcb.B_SilkS); dot.SetWidth(pcb.FromMM(.1)); dot.SetFilled(True)
dot.SetStart(pt(50 + cx - 1.8, 50 + cy + 1.5)); dot.SetEnd(pt(50 + cx - 1.7, 50 + cy + 1.5)); f.Add(dot)
for g in old: f.Remove(g)                # last: Remove() invalidates the other proxies
pcb.SaveBoard(str(TARGET), b)
print('U1200: fab outline 3.0 x 2.5 with pin-1 chamfer, silk dot at', (round(cx - 1.8, 2), round(cy + 1.5, 2)), flush=True)
import os; os._exit(0)
