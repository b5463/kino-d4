"""Project footprint for U700 (PAC1954, VQFN-16 3 x 3 mm): the stock land with the pin 1 triangle at the corner (KiCad 10 python).

The stock Package_DFN_QFN:VQFN-16-1EP_3x3mm_P0.5mm_EP1.1x1.1mm puts its pin 1 triangle 0.3 mm
beyond the pin 1 pad, along the pin. On the carrier, C700 sits straight below pin 2 (its pad
0.15 mm north of the SYS_5V trunk), so that triangle would lie on C700's pad (ODD JOBS 94). Here
it moves into the corner beside pin 1, pointing at the pin 1 corner of the package, the same size.
Pads, exposed pad, fab, courtyard and paste are the stock ones. The triangle is given in carrier
board mm at U700's placement (place_a02_u700.py: (58.75, 15.5), 90 degrees, front) and written in
footprint coordinates. Writes KINO_A0.pretty/VQFN-16-1EP_3x3mm_P0.5mm_EP1.1x1.1mm_Pin1Corner.
"""
from pathlib import Path
import pcbnew as pcb

ROOT = Path(__file__).resolve().parent.parent
NAME = 'VQFN-16-1EP_3x3mm_P0.5mm_EP1.1x1.1mm_Pin1Corner'
AT, ROT = (58.75, 15.5), 90
TRI = ((57.35, 17.22), (57.25, 17.67), (56.9, 17.32))       # board mm, pointing north-east at pin 1; 0.1 mm clear of C700's 0.15 mm silk
STOCK_TRI = ((58.0, 17.62), (58.24, 17.95), (57.76, 17.95))  # where the stock triangle lands
_KS = [Path.home() / 'Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints',
       Path('/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints'),
       Path('C:/Program Files/KiCad/10.0/share/kicad/footprints')]
stock = next(p for p in _KS if p.exists()) / 'Package_DFN_QFN.pretty'
fp = pcb.FootprintLoad(str(stock), 'VQFN-16-1EP_3x3mm_P0.5mm_EP1.1x1.1mm')
P = lambda x, y: pcb.VECTOR2I(pcb.FromMM(50 + x), pcb.FromMM(50 + y))     # the boards sit at a 50 mm offset
fp.SetPosition(P(*AT)); fp.SetOrientationDegrees(ROT)
tri = [g for g in fp.GraphicalItems() if g.GetLayer() == pcb.F_SilkS and g.GetShape() == pcb.SHAPE_T_POLY]
assert len(tri) == 1
o = tri[0].GetPolyShape().Outline(0)
got = sorted((round(pcb.ToMM(o.CPoint(i).x) - 50, 3), round(pcb.ToMM(o.CPoint(i).y) - 50, 3)) for i in range(o.PointCount()))
assert got == sorted(STOCK_TRI), ('stock triangle moved', got)
ps = pcb.SHAPE_POLY_SET(); ps.NewOutline()
for x, y in TRI: ps.Append(P(x, y))
tri[0].SetPolyShape(ps)
fp.SetOrientationDegrees(0); fp.SetPosition(pcb.VECTOR2I(0, 0))
fp.SetLibDescription('VQFN-16 3 x 3 mm, 0.5 mm pitch, 1.1 mm exposed pad (stock KiCad land); pin 1 triangle '
                     'beside the pin 1 corner instead of beyond pin 1. KINO carrier U700, PAC1954.')
fp.SetKeywords('VQFN NoLead PAC1954')
fp.SetFPID(pcb.LIB_ID('KINO_A0', NAME))
pcb.FootprintSave(str(ROOT / 'KINO_A0.pretty'), fp)
o = tri[0].GetPolyShape().Outline(0)
print('saved', NAME, 'triangle (footprint mm):', [(round(pcb.ToMM(o.CPoint(i).x), 3), round(pcb.ToMM(o.CPoint(i).y), 3)) for i in range(o.PointCount())], flush=True)
import os; os._exit(0)
