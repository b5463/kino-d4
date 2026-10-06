"""Fit the front-copper keepouts under the back-side switching inductors to their bodies.

ODD JOBS 8: no sensitive routing on another layer directly under a switch node.
"""
import pcbnew as pcb
from rework import TARGET

b = pcb.LoadBoard(str(TARGET))
fs = {f.GetReference(): f for f in b.GetFootprints()}
areas = [z for z in b.Zones() if z.GetIsRuleArea() and list(z.GetLayerSet().Seq()) == [pcb.F_Cu]]
for ref in ('L1100', 'L1200', 'L1201'):
    body = [g.GetBoundingBox() for g in fs[ref].GraphicalItems() if g.GetLayer() == pcb.B_Fab]
    cy = body[0]
    for g in body[1:]: cy.Merge(g)
    zone = next(z for z in areas if z.GetBoundingBox().Intersects(cy))   # own switch-node vias stay outside the body
    o = zone.Outline(); o.RemoveAllContours(); o.NewOutline()
    for x, y in ((cy.GetLeft(), cy.GetTop()), (cy.GetRight(), cy.GetTop()), (cy.GetRight(), cy.GetBottom()), (cy.GetLeft(), cy.GetBottom())):
        o.Append(x, y)
    zone.SetZoneName(f'SW keepout {ref}')
    print(ref, [round(pcb.ToMM(v) - 50, 2) for v in (cy.GetLeft(), cy.GetTop(), cy.GetRight(), cy.GetBottom())])
pcb.SaveBoard(str(TARGET), b)
