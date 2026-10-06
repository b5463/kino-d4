"""Pack entry placement beside the charger (explicit, repeatable).

J1100 sits on the bottom edge under the charger, rotated 180 deg: pin 3 (GND) left, pin 1 (PACK+)
right. Its body must stay outside the 7 mm fastener exclusion of H4 (x <= 83.66): courtyard left
edge 83.74 mm. F1100 and RS700 stand vertically to its right; R1108 (NTC link) sits under pin 2.
R1107, R1109 and R1110 were re-seated with free_spot.py around the chain (0.1.8).
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt

J1100_PIN1_X = 94.15          # pin 3 at 86.23, courtyard 83.74-96.65
CHAIN_X = 98.25               # F1100 / RS700 centre line, courtyards 97.07-99.43, clear of the J1100 pin-1 mark

b = pcb.LoadBoard(str(TARGET))
fs = {f.GetReference(): f for f in b.GetFootprints()}

def pad_y(f, num):
    return next(p for p in f.Pads() if p.GetNumber() == num).GetPosition().y

fs['J1100'].SetOrientationDegrees(180); fs['J1100'].SetPosition(pt(50 + J1100_PIN1_X, 50 + 63.0))
for ref, y in (('F1100', 64.3), ('RS700', 59.6)):
    f = fs[ref]; f.SetOrientationDegrees(90); f.SetPosition(pt(50 + CHAIN_X, 50 + y))
    if pad_y(f, '1') < f.GetPosition().y: f.SetOrientationDegrees(270)   # pad 1 at the bottom
fs['R1108'].SetPosition(pt(50 + J1100_PIN1_X - 3.96 - 0.04, 50 + 66.25))
for ref in ():
    fs[ref].SetPosition(pt(300, 300))            # re-seated by free_spot.py

cy = fs['J1100'].GetCourtyard(pcb.F_CrtYd).BBox()
assert pcb.ToMM(cy.GetLeft()) - 50 >= 83.7, 'J1100 inside the H4 fastener exclusion'
pcb.SaveBoard(str(TARGET), b)
print('J1100 courtyard x', round(pcb.ToMM(cy.GetLeft()) - 50, 2), '-', round(pcb.ToMM(cy.GetRight()) - 50, 2))
