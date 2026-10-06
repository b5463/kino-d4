"""Conservative corner bevels and ground stitching on the review PCB.

Each added segment/via is checked against existing foreign-net pad and track
shapes. KiCad DRC remains authoritative and must run after this script.
"""
import math, json, sys
from collections import defaultdict
import pcbnew as pcb
from routing import ROOT,TARGET,pt
if '--a02' in sys.argv:
    from rework import TARGET
from mechanical import WIDTH,HEIGHT,INSERT_CENTRES

b=pcb.LoadBoard(str(TARGET))
pads=[p for f in b.GetFootprints() for p in f.Pads()]
def clear(item,layer,net):
    sh=item.GetEffectiveShape(layer);bb=item.GetBoundingBox();bb.Inflate(pcb.FromMM(.151))
    for p in pads:
        if p.GetNetname()==net or not p.IsOnLayer(layer) or not bb.Intersects(p.GetBoundingBox()):continue
        if sh.Collide(p.GetEffectiveShape(layer),pcb.FromMM(.15)):return False
    for t in b.GetTracks():
        if t.GetNetname()==net or not t.IsOnLayer(layer) or not bb.Intersects(t.GetBoundingBox()):continue
        if sh.Collide(t.GetEffectiveShape(layer),pcb.FromMM(.15)):return False
    return True

changed=0
for iteration in range(5):
    vertices=defaultdict(list)
    vias=[t for t in b.GetTracks() if isinstance(t,pcb.PCB_VIA)]
    for t in b.GetTracks():
        if isinstance(t,pcb.PCB_VIA):continue
        for v,o,end in [(t.GetStart(),t.GetEnd(),False),(t.GetEnd(),t.GetStart(),True)]:
            vertices[(t.GetNetname(),t.GetLayer(),v.x,v.y)].append((t,o,end))
    pass_changes=0
    for (net,layer,x,y),edges in vertices.items():
        if len(edges)!=2:continue
        (a,ao,ae),(c,co,ce)=edges
        if (a.IsLocked() or c.IsLocked()) and '--review-fixed-corners' not in sys.argv:continue
        v=pcb.VECTOR2I(x,y)
        if (a.GetEnd() if ae else a.GetStart())!=v or (c.GetEnd() if ce else c.GetStart())!=v:continue
        ax,ay=ao.x-x,ao.y-y;cx,cy=co.x-x,co.y-y
        if ax*cx+ay*cy!=0:continue
        if any(p.GetNetname()==net and p.IsOnLayer(layer) and p.HitTest(v) for p in pads):continue
        if any(t.GetNetname()==net and t.GetPosition()==v for t in vias):continue
        n=min(300000,max(abs(ax),abs(ay))//3,max(abs(cx),abs(cy))//3)
        for div in (1,2,4,8,16):
            step=n//div
            if step<10000:continue
            va=pcb.VECTOR2I(x+(step if ax>0 else -step if ax<0 else 0),y+(step if ay>0 else -step if ay<0 else 0))
            vc=pcb.VECTOR2I(x+(step if cx>0 else -step if cx<0 else 0),y+(step if cy>0 else -step if cy<0 else 0))
            t=pcb.PCB_TRACK(b);t.SetStart(va);t.SetEnd(vc);t.SetWidth(min(a.GetWidth(),c.GetWidth()));t.SetLayer(layer);t.SetNetCode(a.GetNetCode());t.SetLocked(a.IsLocked() or c.IsLocked())
            if not clear(t,layer,net):continue
            if ae:a.SetEnd(va)
            else:a.SetStart(va)
            if ce:c.SetEnd(vc)
            else:c.SetStart(vc)
            b.Add(t);changed+=1;pass_changes+=1;break
    if not pass_changes:break

via_count=0
added=[]
# Vias have a local purpose: a nearby SMT ground connection or a camera
# signal's layer transition. No board-wide decorative grid.
anchors=[]
for p in pads:
    if p.GetNetname()=='GND' and p.GetAttribute()==pcb.PAD_ATTRIB_SMD:
        anchors.append((p.GetPosition(),p.GetParentFootprint().GetReference()+'.'+p.GetNumber()))
for t in list(b.GetTracks()):
    if isinstance(t,pcb.PCB_VIA) and any(s in t.GetNetname() for s in ('TX','RX','SYNC')):
        anchors.append((t.GetPosition(),'return for '+t.GetNetname()))
for anchor,reason in ([] if '--corners-only' in sys.argv else anchors):
    near=[t for t in b.GetTracks() if isinstance(t,pcb.PCB_VIA) and t.GetNetname()=='GND'
          and (t.GetPosition().x-anchor.x)**2+(t.GetPosition().y-anchor.y)**2 < 1200000**2]
    if near:continue
    for radius,angle in [(r,a) for r in (.65,1.0,1.4,1.8) for a in range(0,360,45)]:
        x=anchor.x/1e6-50+radius*math.cos(math.radians(angle))
        y=anchor.y/1e6-50+radius*math.sin(math.radians(angle))
        if not (.8<x<WIDTH-.8 and .8<y<HEIGHT-.8):continue
        if any(abs(x-u)<4 and abs(y-v)<4 for u,v in INSERT_CENTRES):continue
        v=pcb.PCB_VIA(b);v.SetPosition(pt(50+x,50+y));v.SetWidth(pcb.FromMM(.6));v.SetDrill(pcb.FromMM(.3));v.SetViaType(pcb.VIATYPE_THROUGH);v.SetLayerPair(pcb.F_Cu,pcb.B_Cu);v.SetNet(b.FindNet('GND'))
        if any(z.GetIsRuleArea() and z.GetDoNotAllowVias() and z.GetBoundingBox().Contains(v.GetPosition()) for z in b.Zones()):continue
        # Do not add vias within another pad or close to any drilled hole.
        if any(v.GetEffectiveShape(l).Collide(p.GetEffectiveShape(l),210000)
               for p in pads for l in (pcb.F_Cu,pcb.B_Cu) if p.IsOnLayer(l)):continue
        if any((t.GetPosition().x-v.GetPosition().x)**2+(t.GetPosition().y-v.GetPosition().y)**2<800000**2 for t in b.GetTracks() if isinstance(t,pcb.PCB_VIA)):continue
        if all(clear(v,l,'GND') for l in (pcb.F_Cu,pcb.In1_Cu,pcb.In2_Cu,pcb.B_Cu)):
            b.Add(v);via_count+=1
            added.append({'xy_mm':[round(x,4),round(y,4)],'purpose':reason})
            break
for layer in (pcb.F_Cu,pcb.B_Cu):
    if any(not z.GetIsRuleArea() and z.GetLayer()==layer for z in b.Zones()):continue
    z=pcb.ZONE(b);z.SetLayer(layer);z.SetNet(b.FindNet('GND'));z.SetLocalClearance(pcb.FromMM(.2));z.SetMinThickness(pcb.FromMM(.2));z.SetPadConnection(pcb.ZONE_CONNECTION_THT_THERMAL)
    poly=z.Outline();poly.NewOutline()
    for x,y in [(50.5,50.5),(49.5+WIDTH,50.5),(49.5+WIDTH,49.5+HEIGHT),(50.5,49.5+HEIGHT)]:poly.Append(round(x*1e6),round(y*1e6))
    b.Add(z)
for z in b.Zones():
    if not z.GetIsRuleArea() and z.GetNetname()=='GND':
        z.SetPadConnection(pcb.ZONE_CONNECTION_THT_THERMAL)
        z.SetThermalReliefGap(pcb.FromMM(.25))
        z.SetThermalReliefSpokeWidth(pcb.FromMM(.3))
pcb.ZONE_FILLER(b).Fill(b.Zones());pcb.SaveBoard(str(TARGET),b)
(ROOT/('outputs/A02-GROUND-VIA-PURPOSES.json' if '--a02' in sys.argv else 'outputs/GROUND-VIA-PURPOSES.json')).write_text(json.dumps(added,indent=2)+'\n')
print('Bevelled corners:',changed,'; added GND stitching vias:',via_count)
