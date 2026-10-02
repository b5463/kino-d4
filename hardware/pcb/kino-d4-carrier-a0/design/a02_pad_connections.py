"""Zone connection overrides for A0.2 pads whose thermal relief cannot form (KiCad 10 python).

J201 pad 1 and J501 pad 1 (GND, camera GPIO breakout headers) sit between the front UART bus and
the camera 3V3 branch; the pour reaches them through a single spoke on each face and DRC reports
the relief as starved. As with J300 pad 13 (a02_drc_fixes.py), the pad takes a solid connection:
it is also tied to the In1 ground plane through its barrel, and the breakout pins are hand
soldered only on prototypes. Re-running is harmless.
"""
import pcbnew as pcb
from rework import TARGET

SOLID = [('J201', '1'), ('J501', '1')]
b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                      # SWIG order trap
fs = {f.GetReference(): f for f in b.GetFootprints()}
for ref, num in SOLID:
    pad = next(p for p in fs[ref].Pads() if p.GetNumber() == num)
    assert pad.GetNetname() == 'GND', (ref, num, pad.GetNetname())
    pad.SetLocalZoneConnection(pcb.ZONE_CONNECTION_FULL)
pcb.SaveBoard(str(TARGET), b)
print('solid zone connection on', ', '.join(f'{r}.{n}' for r, n in SOLID), flush=True)
import os; os._exit(0)
