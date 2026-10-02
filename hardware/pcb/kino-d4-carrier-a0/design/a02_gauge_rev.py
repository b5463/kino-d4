"""A0.2 gauge revision: high-side RS700 per TI BQ27441-G1, 1206 pack fuse, CC protection 24 V.

Pack chain: J1100.1 PACK_PLUS -> F1100 -> PACK_FUSED -> RS700 (5 mOhm) -> BAT_PROTECTED.
J1100.3 is GND. Placement: F1100 and RS700 stand vertically on the front, right of J1100.
Copper for the chain is drawn by route_pack_entry.py.
"""
import pcbnew as pcb
from rework import ROOT, TARGET
from routing import pt
from circuit import PARTS
from build import uid, ROOT_ID, FP_LIB, schematics, outputs

parts = {p['ref']: p for p in PARTS}
b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())            # read first: this SWIG build fails if read after pad lists
fs = {f.GetReference(): f for f in b.GetFootprints()}

def net(name):
    if not b.FindNet(name): b.Add(pcb.NETINFO_ITEM(b, name))
    return b.FindNet(name)

def sync(ref):
    for p in fs[ref].Pads():
        n = parts[ref]['nets'].get(p.GetNumber())
        p.SetNet(net(n) if n else b.FindNet(''))
    fs[ref].SetValue(parts[ref]['value'])

def load(ref):
    lib, name = parts[ref]['footprint'].split(':')
    f = pcb.FootprintLoad(str((ROOT / 'KINO_A0.pretty') if lib == 'KINO_A0' else FP_LIB / (lib + '.pretty')), name)
    f.SetFPID(pcb.LIB_ID(lib, name)); f.SetReference(ref); f.SetValue(parts[ref]['value'])
    f.SetUuid(pcb.KIID(uid(ref)))
    f.SetPath(pcb.KIID_PATH('/' + ROOT_ID + '/' + uid(parts[ref]['sheet']) + '/' + uid(ref)))
    f.Value().SetVisible(False)
    return f

# Old pack-return copper and the shunt's ground stitching go; route_pack_entry.py redraws the chain.
for t in tracks:
    if t.GetNetname() in ('PACK_MINUS', 'PACK_PLUS', 'PACK_FUSED'):
        b.Remove(t)
    elif t.GetNetname() == 'GND':
        pos = t.GetPosition() if isinstance(t, pcb.PCB_VIA) else t.GetStart()
        x, y = pcb.ToMM(pos.x) - 50, pcb.ToMM(pos.y) - 50
        if 79.3 <= x <= 83.2 and 65.3 <= y <= 68.6:
            b.Remove(t)

# F1100: 1812 -> 1206 (Bourns SF-1206F700-2), vertical, pad 1 (PACK_PLUS) at the bottom.
old = fs.pop('F1100'); b.Remove(old)
f = load('F1100'); b.Add(f); f.SetOrientationDegrees(90); f.SetPosition(pt(50 + 97.0, 50 + 64.3))
if next(p for p in f.Pads() if p.GetNumber() == '1').GetPosition().y < f.GetPosition().y:
    f.SetOrientationDegrees(270)
fs['F1100'] = f

# RS700: back, low side -> front, high side, vertical above the fuse, pad 1 (PACK_FUSED) at the bottom.
r = fs['RS700']
if r.IsFlipped(): r.Flip(r.GetPosition(), pcb.FLIP_DIRECTION_LEFT_RIGHT)
r.SetOrientationDegrees(90); r.SetPosition(pt(50 + 97.0, 50 + 59.6))
if next(p for p in r.Pads() if p.GetNumber() == '1').GetPosition().y < r.GetPosition().y:
    r.SetOrientationDegrees(270)
r.Reference().SetLayer(pcb.F_SilkS)

for ref in ('F1100', 'RS700', 'U701', 'C703', 'J1100', 'D1002', 'D1003', 'C1202', 'U1300', 'C1301'):
    sync(ref)
pin3 = next(p for p in fs['J1100'].Pads() if p.GetNumber() == '3')
pin3.SetLocalZoneConnection(pcb.ZONE_CONNECTION_FULL)      # 4.4 A return: solid, not four spokes

# R702: GPOUT pull-up, on the back beside U701.
if 'R702' not in fs:
    g = load('R702'); b.Add(g)
    g.Flip(g.GetPosition(), pcb.FLIP_DIRECTION_LEFT_RIGHT); g.Reference().SetLayer(pcb.B_SilkS)
    g.SetPosition(pt(300, 300)); sync_ref = 'R702'; fs['R702'] = g
    for p in g.Pads(): p.SetNet(net(parts['R702']['nets'][p.GetNumber()]))

pcb.SaveBoard(str(TARGET), b)
schematics()
outputs({'status': 'A02_GAUGE_REVISION', 'board': TARGET.name, 'components': len(PARTS)}, 'A02-CAPTURE-STATUS.json')
print('gauge revision applied')
