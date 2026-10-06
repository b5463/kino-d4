"""Replace the JP 2.54 mm headers with 0 ohm links on the front (KiCad 10 python).

circuit.py now captures JP200-JP500 and JP1200 as Vishay CRCW12060000Z0EAHP 0 ohm links on
KINO_A0:R_1206_3216Metric_Vishay_CRCW-HP (see fp_a02_link_1206.py). Each header is replaced in
place: the link goes on the front, centred between the old pins, turned so pad 1 sits on the old
pin 1. The pads are 2.55 mm apart, 5 um from the old 2.54 mm pitch, so F.Cu copper that ended on
a pin still meets its pad. Copper that reached a pin on another layer is left dangling for
drop_dangling.py and re-routed. The old footprint is removed last, before the save.
"""
from pathlib import Path
import pcbnew as pcb
from rework import ROOT, TARGET
from routing import pt

LINKS = ['JP200', 'JP300', 'JP400', 'JP500', 'JP1200']
LIB, NAME = ROOT / 'KINO_A0.pretty', 'R_1206_3216Metric_Vishay_CRCW-HP'

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                   # SWIG order trap: read before pad lists
fs = {f.GetReference(): f for f in b.GetFootprints()}
mm = lambda v: pcb.ToMM(v) - 50
old, report = [], []
for ref in LINKS:
    f = fs[ref]
    if str(f.GetFPID().GetLibItemName()) == NAME: continue        # already replaced
    pins = {p.GetNumber(): (p.GetPosition(), p.GetNetCode(), p.GetNetname()) for p in f.Pads()}
    c = pcb.VECTOR2I((pins['1'][0].x + pins['2'][0].x) // 2, (pins['1'][0].y + pins['2'][0].y) // 2)
    new = pcb.FootprintLoad(str(LIB), NAME)
    new.SetFPID(pcb.LIB_ID('KINO_A0', NAME))
    new.SetReference(ref); new.SetValue(f.GetValue())
    b.Add(new)
    new.SetPosition(c)
    best = None
    for a in (0, 90, 180, 270):                  # the turn that puts pad 1 on old pin 1
        new.SetOrientationDegrees(a)
        p1 = next(p for p in new.Pads() if p.GetNumber() == '1').GetPosition()
        d = (p1 - pins['1'][0]).EuclideanNorm()
        if best is None or d < best[0]: best = (d, a)
    new.SetOrientationDegrees(best[1])
    for p in new.Pads(): p.SetNetCode(pins[p.GetNumber()][1])
    new.Reference().SetPosition(new.GetPosition())
    off = max((next(q for q in new.Pads() if q.GetNumber() == n).GetPosition() - pins[n][0]).EuclideanNorm() for n in ('1', '2'))
    assert off < pcb.FromMM(0.01), (ref, 'pad offset', pcb.ToMM(off))
    report.append(f'{ref} at ({mm(c.x):.3f}, {mm(c.y):.3f}) rot {best[1]} ({pins["1"][2]} / {pins["2"][2]})')
    old.append(f)
for f in old: b.Remove(f)                      # last: Remove() invalidates the other proxies
pcb.SaveBoard(str(TARGET), b)
print('0 ohm links on the front:', '; '.join(report) or 'nothing to do', flush=True)
import os; os._exit(0)
