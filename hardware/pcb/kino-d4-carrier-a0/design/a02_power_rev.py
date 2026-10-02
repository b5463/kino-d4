"""A0.2 power revision: autonomous charging, fitted NTC network, verified inductors.

Applies circuit.py changes to the native A0.2 board in place. Placement and all
unrelated copper are kept. Run with KiCad 10 python from this folder.
"""
import pcbnew as pcb
from rework import ROOT, TARGET
from routing import pt
from circuit import PARTS
from build import uid, ROOT_ID, FP_LIB, line, schematics, outputs

parts = {p['ref']: p for p in PARTS}
folder = ROOT / 'KINO_A0.pretty'

# TDK SPM6530 catalogue 20160825 p5: body 7.1 x 6.5 mm, land 1.85 x 3.4 mm, 3.7 mm gap.
fp = pcb.FOOTPRINT(None); fp.SetFPID(pcb.LIB_ID('KINO_A0', 'L_TDK_SPM6530'))
fp.SetLibDescription('TDK SPM6530 metal power inductor, 7.1 x 6.5 x 3.0 mm. Land per TDK catalogue 20160825 p5.')
fp.SetAttributes(pcb.FP_SMD); fp.SetReference('L**'); fp.SetValue('L_TDK_SPM6530')
for n, x in (('1', -2.775), ('2', 2.775)):
    p = pcb.PAD(fp); p.SetNumber(n); p.SetAttribute(pcb.PAD_ATTRIB_SMD); p.SetShape(pcb.PAD_SHAPE_RECT)
    p.SetSize(pt(1.85, 3.4)); p.SetPosition(pt(x, 0))
    s = pcb.LSET(); [s.AddLayer(l) for l in (pcb.F_Cu, pcb.F_Mask, pcb.F_Paste)]; p.SetLayerSet(s); fp.Add(p)
for layer, (w, h), width in ((pcb.F_Fab, (7.1, 6.5), .1), (pcb.F_CrtYd, (8.0, 7.0), .05)):
    c = [(-w/2, -h/2), (w/2, -h/2), (w/2, h/2), (-w/2, h/2), (-w/2, -h/2)]
    for a, b in zip(c, c[1:]): line(fp, a, b, layer, width)
pcb.FootprintSave(str(folder), fp)

b = pcb.LoadBoard(str(TARGET))
fs = {f.GetReference(): f for f in b.GetFootprints()}

def net(name):
    if not b.FindNet(name): b.Add(pcb.NETINFO_ITEM(b, name))
    return b.FindNet(name)

def strip_net(name):
    for t in list(b.GetTracks()):
        if t.GetNetname() == name: b.Remove(t)

def swap(ref):
    old = fs[ref]; part = parts[ref]
    lib, name = part['footprint'].split(':')
    new = pcb.FootprintLoad(str(folder if lib == 'KINO_A0' else FP_LIB / (lib + '.pretty')), name)
    new.SetFPID(pcb.LIB_ID(lib, name))
    new.SetReference(ref); new.SetValue(part['value'])
    new.SetUuid(old.m_Uuid); new.SetPath(old.GetPath())
    b.Add(new)
    if old.IsFlipped(): new.Flip(new.GetPosition(), pcb.FLIP_DIRECTION_LEFT_RIGHT)
    new.SetOrientation(old.GetOrientation()); new.SetPosition(old.GetPosition())
    new.Value().SetVisible(False)
    new.Reference().SetLayer(pcb.B_Fab if new.IsFlipped() else pcb.F_Fab)
    new.Reference().SetPosition(old.Reference().GetPosition())
    for p in new.Pads(): p.SetNet(net(part['nets'][p.GetNumber()]))
    b.Remove(old); fs[ref] = new

# Charger enable: CE low by default; the charge-arm switch is gone.
for ref in ('Q1100', 'R1103'):
    if ref in fs: b.Remove(fs.pop(ref))
strip_net('CHARGE_ARM')
strip_net('CHG_REGN')          # R1102 pad 2 leaves REGN for GND; REGN is rerouted
for p in fs['U600'].Pads():
    if p.GetNumber() == '20': p.SetNet(net('CHARGE_STAT_N'))
for p in fs['R1102'].Pads(): p.SetNet(net(parts['R1102']['nets'][p.GetNumber()]))

if 'R1110' not in fs:
    part = parts['R1110']; lib, name = part['footprint'].split(':')
    f = pcb.FootprintLoad(str(FP_LIB / (lib + '.pretty')), name)
    f.SetFPID(pcb.LIB_ID(lib, name)); f.SetReference('R1110'); f.SetValue(part['value'])
    f.SetUuid(pcb.KIID(uid('R1110')))
    f.SetPath(pcb.KIID_PATH('/' + ROOT_ID + '/' + uid(part['sheet']) + '/' + uid('R1110')))
    f.Value().SetVisible(False); f.Reference().SetLayer(pcb.F_Fab)
    f.SetAttributes(f.GetAttributes() | pcb.FP_DNP)
    f.SetOrientation(fs['R1102'].GetOrientation())
    f.SetPosition(pt(50 + 92.75, 50 + 63.0))   # footprint space freed by Q1100
    b.Add(f)
    for p in f.Pads(): p.SetNet(net(part['nets'][p.GetNumber()]))
    fs['R1110'] = f

# NTC network fitted for a 103AT-2 pack thermistor.
for ref in ('R1106', 'R1107', 'R1108'):
    f = fs[ref]
    f.SetAttributes(f.GetAttributes() & ~(pcb.FP_DNP | pcb.FP_EXCLUDE_FROM_BOM | pcb.FP_EXCLUDE_FROM_POS_FILES))
    f.SetValue(parts[ref]['value'])

for ref in ('L1100', 'L1200'): swap(ref)
for ref in ('R1202', 'C1200', 'R1102'): fs[ref].SetValue(parts[ref]['value'])

pcb.SaveBoard(str(TARGET), b)
schematics()
outputs({'status': 'A02_POWER_REVISION', 'board': TARGET.name, 'components': len(PARTS)}, 'A02-CAPTURE-STATUS.json')
print('A0.2 power revision applied')
