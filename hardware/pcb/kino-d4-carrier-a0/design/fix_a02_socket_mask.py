"""Solder mask openings on the XIAO socket pads (KiCad 10 python). Release review: BOM/CPL cross-check E1.

build.py generated KINO_A0:XIAO_Socket_15.24mm with its 14 through-hole pads on copper only (the mask
layers added to LSET.AllCuMask() never reached the saved pads), so J200-J500 had no mask opening on
either face and could not be soldered. The library footprint now has "*.Cu" "*.Mask" pads; this adds
F.Mask and B.Mask to the 56 pads on the board. No copper changes.
"""
import pcbnew as pcb
from rework import TARGET

b = pcb.LoadBoard(str(TARGET))
n = 0
for f in b.GetFootprints():
    if str(f.GetFPID().GetLibItemName()) != 'XIAO_Socket_15.24mm': continue
    for p in f.Pads():
        if p.GetAttribute() != pcb.PAD_ATTRIB_PTH: continue
        ls = pcb.LSET(p.GetLayerSet()); ls.AddLayer(pcb.F_Mask); ls.AddLayer(pcb.B_Mask); p.SetLayerSet(ls)
        assert p.IsOnLayer(pcb.F_Mask) and p.IsOnLayer(pcb.B_Mask), (f.GetReference(), p.GetNumber())
        n += 1
assert n == 56, n
pcb.SaveBoard(str(TARGET), b)
print('socket pads with mask openings:', n, flush=True)
import os; os._exit(0)
