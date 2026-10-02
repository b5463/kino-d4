"""A0.2 labels, documented local land adjustment and ground fills.

This is a review board, not a released manufacturing package. The USB land
adjustment retains the connector's hole and contact datums; see A02-REVIEW.md.
"""
import json
import pcbnew as pcb
from rework import ROOT,TARGET
from routing import pt,rect,intersects,restore_through_hole_mask
from mechanical import WIDTH,HEIGHT,INSERT_CENTRES

b=pcb.LoadBoard(str(TARGET))
fps={f.GetReference():f for f in b.GetFootprints()}
restore_through_hole_mask(b)
usb=fps['J1000']
assert usb.GetOrientationDegrees()==0 and not usb.IsFlipped()
modified=[]
for p in usb.Pads():
    if p.GetNumber() not in ('A1','B12','A12','B1'):continue
    if p.GetSize().y==pcb.FromMM(1.15):
        xy=p.GetPosition();p.SetPosition(pcb.VECTOR2I(xy.x,xy.y-pcb.FromMM(.025)))
        p.SetSize(pt(.6,1.10))
    assert p.GetSize().y==pcb.FromMM(1.10)
    modified.append(p.GetNumber())
for d in b.GetDrawings():
    if not isinstance(d,pcb.PCB_TEXT):continue
    t=d.GetText()
    for i in range(4):
        x=25.505+22*i
        if t in (f'CAM {i+1} GPIO',f'CAM{i+1} GPIO'):
            d.SetText(f'CAM{i+1} GPIO');d.SetPosition(pt(50+x,70.7))
        if t in (f'CAM {i+1} PWR',f'CAM{i+1} PWR'):
            d.SetText(f'CAM{i+1} PWR');d.SetPosition(pt(50+x-(2 if i==3 else .5),57.8))
        if t==f'CAM {i+1}':d.SetPosition(pt(50+x,73.0))
    if t=='PACK + / NTC / -':d.SetPosition(pt(107.96,61.7))
    if t in ('TEST / SENSE ONLY','POGO / SENSE'):
        d.SetText('POGO / SENSE');d.SetPosition(pt(70,104))
    if t in ('P4 / PIN 1','P4 / PIN1'):
        d.SetText('P4 / PIN1');d.SetPosition(pt(56,105.225))
    if t in ('FLASH LOGIC','FLASH'):
        d.SetText('FLASH');d.SetPosition(pt(81.5,99.5));d.SetTextAngle(pcb.EDA_ANGLE(90,pcb.DEGREES_T))
    if t in ('USB-C CHARGE','CHARGE USB'):
        d.SetText('CHARGE USB');d.SetPosition(pt(148.3,118));d.SetTextSize(pt(.8,.8))
    if t=='KINO D4 A0 / TWO-FACE ROUTING REVIEW / NOT FOR FABRICATION':
        d.SetText('KINO D4 A0.2 / ENGINEERING REVIEW / NOT FOR FABRICATION')
if not any(isinstance(d,pcb.PCB_TEXT) and d.GetText()=='CARRIER REV 1' for d in b.GetDrawings()):
    t=pcb.PCB_TEXT(b);t.SetText('CARRIER REV 1');t.SetLayer(pcb.F_SilkS)
    t.SetPosition(pt(160,83));t.SetTextSize(pt(.8,.8));t.SetTextThickness(pcb.FromMM(.12));b.Add(t)
for t in b.GetDrawings():
    if isinstance(t,pcb.PCB_TEXT) and t.GetLayer() in (pcb.F_SilkS,pcb.B_SilkS):
        t.SetTextSize(pt(max(1,t.GetTextSize().x/1e6),max(1,t.GetTextSize().y/1e6)))
        t.SetTextThickness(pcb.FromMM(.15))

# Printed text must be visible beside fitted parts, not only clear of pads.
occupied={s:[rect(f,.15) for f in fps.values() if f.IsFlipped()==(s==pcb.B_SilkS)]
          +[(x-3.5,y-3.5,x+3.5,y+3.5) for x,y in INSERT_CENTRES]
          for s in (pcb.F_SilkS,pcb.B_SilkS)}
labels=[]
offsets=sorted((x*x+y*y,x,y) for x in range(-24,25) for y in range(-24,25))
for t in b.GetDrawings():
    if not isinstance(t,pcb.PCB_TEXT) or t.GetLayer() not in occupied:continue
    start=t.GetPosition();found=False
    for _,dx,dy in offsets:
        t.SetPosition(pcb.VECTOR2I(start.x+dx*250000,start.y+dy*250000))
        r=t.GetEffectiveTextShape().BBox()
        q=(r.GetLeft()/1e6-50-.15,r.GetTop()/1e6-50-.15,r.GetRight()/1e6-50+.15,r.GetBottom()/1e6-50+.15)
        if q[0]<.5 or q[1]<.5 or q[2]>WIDTH-.5 or q[3]>HEIGHT-.5:continue
        if any(intersects(q,o) for o in occupied[t.GetLayer()]):continue
        occupied[t.GetLayer()].append(q);found=True
        labels.append({'text':t.GetText(),'xy_mm':[t.GetPosition().x/1e6-50,t.GetPosition().y/1e6-50],
                       'height_mm':t.GetTextSize().y/1e6,'stroke_mm':t.GetTextThickness()/1e6})
        break
    assert found,('No clear printed label location',t.GetText())

# Outer ground fills give local return copper. The dedicated In1 plane remains
# continuous except for required pad/via antipads and mounting exclusions.
for layer in (pcb.F_Cu,pcb.B_Cu):
    if any(not z.GetIsRuleArea() and z.GetLayer()==layer for z in b.Zones()):continue
    z=pcb.ZONE(b);z.SetLayer(layer);z.SetNet(b.FindNet('GND'))
    z.SetLocalClearance(pcb.FromMM(.2));z.SetMinThickness(pcb.FromMM(.2))
    z.SetPadConnection(pcb.ZONE_CONNECTION_THT_THERMAL)
    z.SetThermalReliefGap(pcb.FromMM(.25));z.SetThermalReliefSpokeWidth(pcb.FromMM(.3))
    poly=z.Outline();poly.NewOutline()
    for x,y in [(50.5,50.5),(49.5+WIDTH,50.5),(49.5+WIDTH,49.5+HEIGHT),(50.5,49.5+HEIGHT)]:poly.Append(round(x*1e6),round(y*1e6))
    b.Add(z)
assert not any(t.GetLayer()==pcb.In1_Cu for t in b.GetTracks() if not isinstance(t,pcb.PCB_VIA))
pcb.ZONE_FILLER(b).Fill(b.Zones())
pcb.SaveBoard(str(TARGET),b)
(ROOT/'outputs/A02-PRINTED-LABELS.json').write_text(json.dumps(labels,indent=2)+'\n')
(ROOT/'outputs/A02-USB-LAND-ADJUSTMENT.json').write_text(json.dumps({
    'reference':'J1000','pads':modified,'source':'https://gct.co/files/drawings/usb4105.pdf',
    'source_drawing_revision':'B4, 18 December 2023','stock_land_mm':[.6,1.15],
    'adjusted_land_mm':[.6,1.10],'centre_shift_y_mm':-.025,
    'hole_and_contact_x_datums_changed':False,'assembly_qualification_complete':False
},indent=2)+'\n')
print('A0.2 labels updated, USB land adjustment recorded, ground zones filled.')
