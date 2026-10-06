"""Three parts added in the release review (KiCad 10 python). Placement only; release_a02_parts_route.py draws the copper.

  R1204  100k BOOST_ENABLE to SYS_RAW (U-1): the LTC2955-1 EN output is a 2 uA current source and the
         TPS61288 EN pull-down can hold it at 1.02 V. Back, between the In2 BOOST_ENABLE run at y 61.0
         and C1205's SYS_RAW pad, south of the boost.
  R105   100k SYNC_MASTER to GND (M-4): the P4 sync GPIO is Hi-Z through reset. Back, under the SYNC_MASTER
         via south of TP101, clear of J100's header body.
  D903   PESD5V0S1BA on FN_N (M-5): the cased function button, as D902 is for the shutter. Back, just
         south of J904.
Footprints carry the schematic UUID and sheet path (as a02_gauge_rev.py), so DRC parity matches. Re-running
replaces them.
"""
import pcbnew as pcb
from rework import ROOT, TARGET
from routing import pt
from circuit import PARTS
from build import uid, ROOT_ID, FP_LIB

PLACE = {'R1204': ((64.3, 62.15), 0), 'R105': ((14.175, 54.0), 180), 'D903': ((100.52, 8.9), 0)}   # all on the back
parts = {p['ref']: p for p in PARTS}
b = pcb.LoadBoard(str(TARGET))
old = [f for f in b.GetFootprints() if f.GetReference() in PLACE]
if old:                                  # Remove() leaves this build's bindings unreliable: drop, save, start again
    for f in old: b.Remove(f)
    pcb.SaveBoard(str(TARGET), b)
    import os, sys; os.execv(sys.executable, [sys.executable] + sys.argv)

def net(name):
    if not b.FindNet(name): b.Add(pcb.NETINFO_ITEM(b, name))
    return b.FindNet(name)

for ref, ((x, y), rot) in PLACE.items():
    p = parts[ref]; lib, name = p['footprint'].split(':')
    f = pcb.FootprintLoad(str((ROOT / 'KINO_A0.pretty') if lib == 'KINO_A0' else FP_LIB / (lib + '.pretty')), name)
    f.SetFPID(pcb.LIB_ID(lib, name)); f.SetReference(ref); f.SetValue(p['value'])
    f.SetUuid(pcb.KIID(uid(ref))); f.SetPath(pcb.KIID_PATH('/' + ROOT_ID + '/' + uid(p['sheet']) + '/' + uid(ref)))
    f.Value().SetVisible(False)
    b.Add(f)
    f.Flip(f.GetPosition(), pcb.FLIP_DIRECTION_LEFT_RIGHT)
    f.SetOrientationDegrees(rot); f.SetPosition(pt(50 + x, 50 + y)); f.Reference().SetPosition(f.GetPosition())
    for q in f.Pads():
        q.SetNet(net(p['nets'][q.GetNumber()]))
pcb.SaveBoard(str(TARGET), b)
mm = lambda v: round(pcb.ToMM(v) - 50, 3)
for f in b.GetFootprints():
    if f.GetReference() in PLACE:
        print(f.GetReference(), 'B' if f.IsFlipped() else 'F', [(q.GetNumber(), q.GetNetname(), (mm(q.GetPosition().x), mm(q.GetPosition().y))) for q in f.Pads()], flush=True)
import os; os._exit(0)
