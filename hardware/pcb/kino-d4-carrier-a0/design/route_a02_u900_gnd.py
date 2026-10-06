"""Ground the haptic driver U900 (DRV2605L) after its move to the front (KiCad 10 python). ODD JOBS 13.

On the front its two GND pins (4 and 8, on the inner sides of the two pin rows) reached no ground:
the router had run REMOTE_ACTIVE and HAPTIC_REG under the body, and the F pour fragments there
had no via. Those two nets are ripped under the body first (rip_box.py REMOTE_ACTIVE 106.3 18.5
111.0 26.0, rip_box.py HAPTIC_REG 106.3 18.5 109.7 23.7) and re-routed by the grid router
afterwards. Then: one GND via under the body at (107.20, 20.60), the only spot clear on every
layer, and a 0.25 mm F stub from each pin, leaving on the pin's centre line, 45 degrees into the via.
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt

b = pcb.LoadBoard(str(TARGET))
code = b.FindNet('GND').GetNetCode()
def trk(pts):
    for a, c in zip(pts, pts[1:]):
        t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + a[0], 50 + a[1])); t.SetEnd(pt(50 + c[0], 50 + c[1]))
        t.SetWidth(pcb.FromMM(0.25)); t.SetLayer(pcb.F_Cu); t.SetNetCode(code); t.SetLocked(True); b.Add(t)
v = pcb.PCB_VIA(b); v.SetPosition(pt(50 + 107.2, 50 + 20.6)); v.SetWidth(pcb.FromMM(.6)); v.SetDrill(pcb.FromMM(.3))
v.SetViaType(pcb.VIATYPE_THROUGH); v.SetLayerPair(pcb.F_Cu, pcb.B_Cu); v.SetNetCode(code); v.SetLocked(True); b.Add(v)
trk([(105.85, 22.0), (106.8, 22.0), (107.2, 21.6), (107.2, 20.6)])      # U900.8
trk([(110.15, 21.5), (109.3, 21.5), (108.4, 20.6), (107.2, 20.6)])      # U900.4
pcb.SaveBoard(str(TARGET), b)
print('U900 GND: via under the body, stubs from pins 4 and 8', flush=True)
import os; os._exit(0)
