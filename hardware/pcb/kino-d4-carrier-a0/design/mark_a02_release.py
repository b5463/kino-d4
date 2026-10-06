"""Product, revision, date code and serial area on the A0.2 silkscreen (KiCad 10 python). ODD JOBS 97-101; release review L-6.

The silk read KINO D4 / A0.2 DRAFT / CARRIER REV 1: two revision names for one board. Now the product line
stays KINO D4, the PCB revision is CARRIER A0.2 (the name the files, BOM and README use) and the third line
is the 2026-10 date code. An 8 x 4 mm open box with S/N beside it on the front, bottom middle, is kept clear
for a serial label or hand marking. 'P4 / PIN1' beside J100 sat at the pin 25/26 end and now reads P4 JP1 (pin 1 is
marked by the square pad and the arrow). The drawing-layer note under the outline carries the release status.
Re-running is harmless: texts are matched by their old or new wording; the box and its label are redrawn.
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt

LINES = {'A0.2 DRAFT': 'CARRIER A0.2', 'CARRIER REV 1': '2026-10', 'P4 / PIN1': 'P4 JP1'}   # J100's pin 1 is the other end
NOTE = 'KINO D4 CARRIER A0.2 / RELEASE 2026-10 / FABRICATE AFTER THE MANUAL CHECKS IN README'
SN_BOX = (40.0, 64.0, 48.0, 68.0)                 # S/N label to its left, outside the box

b = pcb.LoadBoard(str(TARGET))
mm = lambda v: round(pcb.ToMM(v) - 50, 2)
old = [d for d in b.GetDrawings() if d.GetLayer() == pcb.F_SilkS and ((isinstance(d, pcb.PCB_TEXT) and d.GetText() == 'S/N') or
       (isinstance(d, pcb.PCB_SHAPE) and d.GetShape() == pcb.SHAPE_T_RECT and mm(d.GetStart().y) == SN_BOX[1]))]
if old:                                  # Remove() leaves this build's bindings unreliable: drop, save, start again
    for d in old: b.Remove(d)
    pcb.SaveBoard(str(TARGET), b)
    import os, sys; os.execv(sys.executable, [sys.executable] + sys.argv)
texts = [d for d in b.GetDrawings() if isinstance(d, pcb.PCB_TEXT)]
for d in texts:
    if d.GetText() in LINES: d.SetText(LINES[d.GetText()])
    elif d.GetLayer() == b.GetLayerID('User.Drawings') and d.GetText().startswith('KINO D4 '): d.SetText(NOTE)
if True:
    x0, y0, x1, y1 = SN_BOX
    r = pcb.PCB_SHAPE(b); r.SetShape(pcb.SHAPE_T_RECT); r.SetLayer(pcb.F_SilkS); r.SetWidth(pcb.FromMM(.15))
    r.SetStart(pt(50 + x0, 50 + y0)); r.SetEnd(pt(50 + x1, 50 + y1)); b.Add(r)
    t = pcb.PCB_TEXT(b); t.SetText('S/N'); t.SetLayer(pcb.F_SilkS); t.SetTextSize(pt(.8, .8)); t.SetTextThickness(pcb.FromMM(.15))
    t.SetHorizJustify(pcb.GR_TEXT_H_ALIGN_RIGHT); t.SetPosition(pt(50 + x0 - .6, 50 + (y0 + y1) / 2)); b.Add(t)
pcb.SaveBoard(str(TARGET), b)
print('release marking:', ' / '.join(LINES.values()), '| S/N box', SN_BOX, flush=True)
import os; os._exit(0)
