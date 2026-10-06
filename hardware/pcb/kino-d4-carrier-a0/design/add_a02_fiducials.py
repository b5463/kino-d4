"""Three global fiducials on each face (KiCad 10 python). ODD JOBS 82; release review H-6.

Both faces carry fine-pitch parts (0.4 and 0.5 mm QFNs, 0.5 mm TSSOP), so each face gets three
stock Fiducial_1mm_Mask2mm marks (1 mm bare copper, 2 mm mask opening) as an asymmetric triangle, and
the back set mirrored is not the front set, so a wrong-side or rotated load is caught. Each site keeps:
  - its centre 4 mm from the board edge (conveyor and panel rails),
  - 1.5 mm from any pad, track or via copper and from every non-plated hole,
  - 1.5 mm from silkscreen and from every courtyard on its face, and is outside every keep-out.
The pad's local clearance is 1.0 mm, so the ground pours stay 1.5 mm from the centre too. Sites from a
0.25 mm grid search over the routed board, each re-checked against every item (release review H-6).
Board only: no schematic symbol, not in the BOM or the placement file. The reference stays on Fab;
assembly_labels.py treats the marks as obstacles and never labels them. Re-running replaces the marks.
"""
import pcbnew as pcb
from rework import TARGET
from build import STOCK_FP

SITES = {
    'FID1': ((5.25, 6.25), 'F'), 'FID2': ((102.5, 30.0), 'F'), 'FID3': ((4.5, 62.0), 'F'),
    'FID4': ((94.75, 5.25), 'B'), 'FID5': ((4.0, 58.5), 'B'), 'FID6': ((109.0, 54.5), 'B'),
}
b = pcb.LoadBoard(str(TARGET))
old = [f for f in b.GetFootprints() if f.GetReference().startswith('FID')]
if old:                                  # Remove() leaves this build's bindings unreliable: drop, save, start again
    for f in old: b.Remove(f)
    pcb.SaveBoard(str(TARGET), b)
    import os, sys; os.execv(sys.executable, [sys.executable] + sys.argv)
for ref, ((x, y), side) in SITES.items():
    f = pcb.FootprintLoad(str(STOCK_FP / 'Fiducial.pretty'), 'Fiducial_1mm_Mask2mm')
    f.SetFPID(pcb.LIB_ID('Fiducial', 'Fiducial_1mm_Mask2mm'))
    f.SetReference(ref); f.SetValue('Fiducial')
    f.SetBoardOnly(True); f.SetExcludedFromBOM(True); f.SetExcludedFromPosFiles(True)
    f.SetPosition(pcb.VECTOR2I(pcb.FromMM(50 + x), pcb.FromMM(50 + y)))
    b.Add(f)
    if side == 'B': f.Flip(f.GetPosition(), pcb.FLIP_DIRECTION_LEFT_RIGHT)
    t = f.Reference(); t.SetLayer(pcb.B_Fab if side == 'B' else pcb.F_Fab); t.SetMirrored(side == 'B')
    t.SetTextSize(pcb.VECTOR2I(pcb.FromMM(.5), pcb.FromMM(.5))); t.SetTextThickness(pcb.FromMM(.08))
    t.SetPosition(f.GetPosition())
    for g in f.GraphicalItems():            # the stock centre reference duplicates the field
        if isinstance(g, pcb.PCB_TEXT) and g.GetText() == '${REFERENCE}': g.SetText(''); g.SetVisible(False)
    f.Value().SetVisible(False)
    for q in f.Pads(): q.SetLocalClearance(pcb.FromMM(1.0))
pcb.SaveBoard(str(TARGET), b)
for ref, ((x, y), side) in SITES.items(): print(ref, side, x, y, flush=True)
import os; os._exit(0)
