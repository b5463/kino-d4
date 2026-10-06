"""Camera enable test pads TP600-TP602 in place of pogo field pads J600.9-11 (KiCad 10 python).

CAM2_EN, CAM3_EN and CAM4_EN have no layout path from the top of the board down to the pogo field
J600 (circuit.py). Each gets a 1.5 mm surface probe land on the front beside its existing line;
J600 pads 9-11 lose their nets. Run once on the board, then route_a02_enable_tps.py.
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt
from circuit import PARTS
from build import uid, ROOT_ID, FP_LIB

POS = {'TP600': (56.45, 11.8), 'TP601': (64.4, 12.0), 'TP602': (88.35, 13.5)}
b = pcb.LoadBoard(str(TARGET))
fs = {f.GetReference(): f for f in b.GetFootprints()}
for p in fs['J600'].Pads():
    if p.GetNumber() in ('9', '10', '11'): p.SetNetCode(0)
for ref, (x, y) in POS.items():
    assert ref not in fs, ref
    part = next(p for p in PARTS if p['ref'] == ref)
    lib, fpname = part['footprint'].split(':')
    f = pcb.FootprintLoad(str(FP_LIB / (lib + '.pretty')), fpname)
    f.SetFPID(pcb.LIB_ID(lib, fpname)); f.SetReference(ref); f.SetValue(part['value'])
    f.SetUuid(pcb.KIID(uid(ref)))
    f.SetPath(pcb.KIID_PATH('/' + ROOT_ID + '/' + uid(part['sheet']) + '/' + uid(ref)))
    f.Value().SetVisible(False)
    f.SetPosition(pt(50 + x, 50 + y)); b.Add(f)
    for p in f.Pads(): p.SetNet(b.FindNet(part['nets'][p.GetNumber()]))
pcb.SaveBoard(str(TARGET), b)
print('added', ', '.join(POS), flush=True)
