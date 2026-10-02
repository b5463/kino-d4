"""Close the residual A0.2 DRC items that are not routing.

1. Zero-length track stubs.
2. J300 pad 13 (GND): the B.Cu thermal cannot resolve two spokes between its neighbours.
   Solid connection on that one pad; it is also tied to the In1 ground plane through the barrel.
3. J1000: the USB4105 land with four outer GND lands shortened 0.05 mm (A02-REVIEW, GCT drawing B4)
   becomes a named project footprint instead of a silently modified library part.
"""
import pcbnew as pcb
from rework import ROOT, TARGET

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())
n = 0
for t in tracks:
    if not isinstance(t, pcb.PCB_VIA) and t.GetLength() < pcb.FromMM(0.01):
        b.Remove(t); n += 1
fs = {f.GetReference(): f for f in b.GetFootprints()}
pad13 = next(p for p in fs['J300'].Pads() if p.GetNumber() == '13')
pad13.SetLocalZoneConnection(pcb.ZONE_CONNECTION_FULL)

usb = fs['J1000']
name = 'USB_C_GCT_USB4105_KINO_GND0.05'
lib = ROOT / 'KINO_A0.pretty'
copy = pcb.FOOTPRINT(usb)
copy.SetFPID(pcb.LIB_ID('KINO_A0', name))
copy.SetLibDescription('GCT USB4105-GF-A, drawing B4. Outer GND lands 0.60 x 1.10 mm (stock 1.15), '
                       'trimmed 0.05 mm at the locator end for 0.20 mm hole clearance. KINO local deviation.')
copy.SetPosition(pcb.VECTOR2I(0, 0)); copy.SetOrientationDegrees(0)
if copy.IsFlipped(): copy.Flip(copy.GetPosition(), pcb.FLIP_DIRECTION_LEFT_RIGHT)
copy.SetOrientationDegrees(0); copy.SetReference('J**')
for p in copy.Pads(): p.SetNetCode(0)
pcb.FootprintSave(str(lib), copy)
usb.SetFPID(pcb.LIB_ID('KINO_A0', name))
pcb.SaveBoard(str(TARGET), b)
print('removed', n, 'zero-length tracks; J300.13 solid; J1000 ->', name)
