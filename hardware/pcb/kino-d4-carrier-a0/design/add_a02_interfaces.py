"""Add authorised test/flash provisions without regenerating existing layout."""
import json
import pcbnew as pcb
from rework import ROOT,TARGET
from routing import pt,rect,intersects
from circuit import PARTS
from build import uid,ROOT_ID,FP_LIB,line,schematics,outputs

name='Pogo_12_Asymmetric';folder=ROOT/'KINO_A0.pretty'
f=pcb.FOOTPRINT(None);f.SetFPID(pcb.LIB_ID('KINO_A0',name))
f.SetLibDescription('Twelve 1.5 mm surface probe lands; first pad offset 0.8 mm; no paste. Original KINO fixture pattern.')
f.SetAttributes(pcb.FP_EXCLUDE_FROM_BOM|pcb.FP_EXCLUDE_FROM_POS_FILES)
f.SetReference('J600');f.SetValue(name)
for n in range(1,13):
    p=pcb.PAD(f);p.SetNumber(str(n));p.SetAttribute(pcb.PAD_ATTRIB_SMD)
    p.SetShape(pcb.PAD_SHAPE_RECT if n==1 else pcb.PAD_SHAPE_CIRCLE)
    p.SetSize(pt(1.5,1.5));p.SetPosition(pt(((n-1)%6)*2.54,-.8 if n==1 else 0 if n<=6 else 2.54))
    layers=pcb.LSET();layers.AddLayer(pcb.F_Cu);layers.AddLayer(pcb.F_Mask);p.SetLayerSet(layers);f.Add(p)
for layer in (pcb.F_CrtYd,pcb.F_Fab):
    corners=[(-1.1,-1.9),(13.8,-1.9),(13.8,3.64),(-1.1,3.64),(-1.1,-1.9)]
    for a,c in zip(corners,corners[1:]):line(f,a,c,layer,.05 if layer==pcb.F_CrtYd else .1)
pcb.FootprintSave(str(folder),f)
b=pcb.LoadBoard(str(TARGET));fs={f.GetReference():f for f in b.GetFootprints()}
# TI BQ25798 Rev C, table 7-5: unused second input sense follows VBUS.
vac2=next(p for p in fs['U1100'].Pads() if p.GetNumber()=='8')
assert vac2.GetNetname() in ('GND','CHG_VBUS')
vac2.SetNet(b.FindNet('CHG_VBUS'))
for ref in ('R1104','R1105'):
    part=next(p for p in PARTS if p['ref']==ref)
    fs[ref].SetValue(part['value'])
positions={'J600':(16,49),'J601':(39,50),'R605':(48,50)}
for part in PARTS:
    if part['ref'] not in positions or part['ref'] in fs:continue
    lib,fpname=part['footprint'].split(':')
    f=pcb.FootprintLoad(str(folder if lib=='KINO_A0' else FP_LIB/(lib+'.pretty')),fpname)
    f.SetFPID(pcb.LIB_ID(lib,fpname));f.SetReference(part['ref']);f.SetValue(part['value'])
    f.SetUuid(pcb.KIID(uid(part['ref'])))
    f.SetPath(pcb.KIID_PATH('/'+ROOT_ID+'/'+uid(part['sheet'])+'/'+uid(part['ref'])))
    f.Value().SetVisible(False);f.Reference().SetLayer(pcb.F_Fab)
    if part['dnp']:f.SetAttributes(f.GetAttributes()|pcb.FP_DNP)
    x,y=positions[part['ref']];f.SetPosition(pt(50+x,50+y));b.Add(f)
    for p in f.Pads():
        net=part['nets'].get(p.GetNumber())
        if net:
            if not b.FindNet(net):b.Add(pcb.NETINFO_ITEM(b,net))
            p.SetNet(b.FindNet(net))
    box=rect(f,.1)
    assert not any(intersects(box,rect(other,.1)) for other in fs.values() if not other.IsFlipped()),part['ref']
    fs[part['ref']]=f
for text,x,y in [('TEST / SENSE ONLY',22.35,54),('FLASH LOGIC',39,46.1)]:
    aliases=(text,'POGO / SENSE') if text=='TEST / SENSE ONLY' else (text,'FLASH')
    if any(isinstance(d,pcb.PCB_TEXT) and d.GetText() in aliases for d in b.GetDrawings()):continue
    t=pcb.PCB_TEXT(b);t.SetText(text);t.SetLayer(pcb.F_SilkS);t.SetTextSize(pt(.8,.8));t.SetTextThickness(pcb.FromMM(.12));t.SetPosition(pt(x+50,y+50));b.Add(t)
pcb.SaveBoard(str(TARGET),b)
schematics()
outputs({'status':'A02_ENGINEERING_DRAFT','board':TARGET.name,'components':len(PARTS)},'A02-CAPTURE-STATUS.json')
print('Added asymmetric pogo field and optional external flash logic interface.')
