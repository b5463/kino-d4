"""List GND pour fragments that reach no GND via or plated hole (KiCad 10 python, read-only).

Run after a DRC with --refill-zones --save-board so the fills are current. Each fragment is
reported with its layer, area and bounding box so it can be stitched to In1 or removed
(ODD JOBS 126/127: no floating copper islands).
"""
import pcbnew as pcb
from rework import TARGET

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())            # SWIG order trap
gnd = b.FindNet('GND').GetNetCode()
mm = lambda v: pcb.ToMM(v) - 50
anchors = [t.GetPosition() for t in tracks if isinstance(t, pcb.PCB_VIA) and t.GetNetCode() == gnd]
anchors += [p.GetPosition() for f in b.GetFootprints() for p in f.Pads()
            if p.GetNetCode() == gnd and p.GetAttribute() == pcb.PAD_ATTRIB_PTH]
smd = [(p.GetParentFootprint().GetReference() + '.' + p.GetNumber(), p) for f in b.GetFootprints() for p in f.Pads()
       if p.GetNetCode() == gnd and p.GetAttribute() == pcb.PAD_ATTRIB_SMD]
found = 0
for z in b.Zones():
    if z.GetNetCode() != gnd or z.GetIsRuleArea(): continue
    for layer in z.GetLayerSet().Seq():
        polys = z.GetFilledPolysList(layer)
        for i in range(polys.OutlineCount()):
            outline = polys.Outline(i)
            if any(outline.PointInside(a) for a in anchors): continue
            bb = outline.BBox()
            touching = [n for n, p in smd if p.IsOnLayer(layer) and outline.PointInside(p.GetPosition())]
            found += 1
            print(f'{b.GetLayerName(layer)}: island {round(outline.Area() / 1e6, 2)} mm2 at '
                  f'x {round(mm(bb.GetLeft()), 2)}..{round(mm(bb.GetRight()), 2)} y {round(mm(bb.GetTop()), 2)}..{round(mm(bb.GetBottom()), 2)}'
                  f' pads: {touching}', flush=True)
print(found, 'GND fragments without a via or plated hole', flush=True)
import os; os._exit(0)
