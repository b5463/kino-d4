"""Explicit USB entry/CC and PD decoupling paths. Native DRC is required."""
import json,math
import pcbnew as pcb
from rework import ROOT,TARGET
from routing import pt,pos
b=pcb.LoadBoard(str(TARGET));fs={f.GetReference():f for f in b.GetFootprints()}
pads=[p for f in fs.values() for p in f.Pads()];records=[]
def pad(r,n):return next(p for p in fs[r].Pads() if p.GetNumber()==str(n))
def p(r,n):return pos(pad(r,n))
def blocked(item,layer,net):
    shape=item.GetEffectiveShape(layer)
    return [f'{q.GetParentFootprint().GetReference()}.{q.GetNumber()}' for q in pads
            if q.IsOnLayer(layer) and q.GetNetname()!=net and shape.Collide(q.GetEffectiveShape(layer),150000)] + [
            'track '+q.GetNetname() for q in b.GetTracks() if q.IsOnLayer(layer) and q.GetNetname()!=net and shape.Collide(q.GetEffectiveShape(layer),150000)]
def path(net,points,width=.2,layer=pcb.F_Cu):
    for a,c in zip(points,points[1:]):
        if a==c:continue
        dx=abs(c[0]-a[0]);dy=abs(c[1]-a[1]);assert min(dx,dy)<1e-5 or abs(dx-dy)<1e-5,(a,c)
        t=pcb.PCB_TRACK(b);t.SetStart(pt(50+a[0],50+a[1]));t.SetEnd(pt(50+c[0],50+c[1]));t.SetWidth(pcb.FromMM(width));t.SetLayer(layer);t.SetNet(b.FindNet(net));t.SetLocked(True)
        bad=blocked(t,layer,net);assert not bad,(net,a,c,bad)
        if not any(not isinstance(q,pcb.PCB_VIA) and q.GetLayer()==layer and q.GetNetname()==net and
                   ((q.GetStart()==t.GetStart() and q.GetEnd()==t.GetEnd()) or (q.GetEnd()==t.GetStart() and q.GetStart()==t.GetEnd())) for q in b.GetTracks()):b.Add(t)
    records.append({'net':net,'points_mm':points,'width_mm':width,'layer':b.GetLayerName(layer)})
def join(r,n,s,m):
    a=p(r,n);c=p(s,m);assert pad(r,n).GetNetname()==pad(s,m).GetNetname()
    dx=c[0]-a[0];dy=c[1]-a[1];d=min(abs(dx),abs(dy));mid=(c[0]-math.copysign(d,dx),c[1]-math.copysign(d,dy))
    path(pad(r,n).GetNetname(),[a,mid,c])
def via(net,x,y):
    v=pcb.PCB_VIA(b);v.SetPosition(pt(50+x,50+y));v.SetWidth(pcb.FromMM(.6));v.SetDrill(pcb.FromMM(.3));v.SetViaType(pcb.VIATYPE_THROUGH);v.SetLayerPair(pcb.F_Cu,pcb.B_Cu);v.SetNet(b.FindNet(net));v.SetLocked(True)
    bad=[(b.GetLayerName(l),blocked(v,l,net)) for l in (pcb.F_Cu,pcb.In1_Cu,pcb.In2_Cu,pcb.B_Cu) if blocked(v,l,net)]
    assert not bad,(net,x,y,bad)
    assert not any(v.GetEffectiveShape(l).Collide(q.GetEffectiveShape(l),150000) for q in pads for l in (pcb.F_Cu,pcb.B_Cu) if q.IsOnLayer(l)),('Via in/too close to pad',net,x,y)
    assert not any(isinstance(q,pcb.PCB_VIA) and q.GetPosition()!=v.GetPosition() and
                   (q.GetPosition().x-v.GetPosition().x)**2+(q.GetPosition().y-v.GetPosition().y)**2 < (q.GetDrill()/2+150000+250000)**2 for q in b.GetTracks()),('Hole spacing',net,x,y)
    if not any(isinstance(q,pcb.PCB_VIA) and q.GetPosition()==v.GetPosition() and q.GetNetname()==net for q in b.GetTracks()):b.Add(v)
    return (x,y)
path('USB_CC1',[p('J1000','A5'),(107.75,60.9),(107.1,60.25),(106.3,60.25),p('D1002',1)])
path('USB_CC1',[p('D1002',1),(105.85,58.2),(106.2,58.2),(107.5,56.9),p('U1000',1)])
join('U1000',1,'U1000',2)
path('USB_CC2',[p('J1000','B5'),(110.75,60.9),(111.4,60.25),(111.7,60.25),p('D1003',1)])
path('USB_CC2',[p('D1003',1),(112.95,58.4),(112,57.45),(110.05,57.45),(109.5,56.9),p('U1000',5)])
join('U1000',4,'U1000',5)
join('U1000',21,'C1001',1)
join('U1000',23,'C1002',1)
for r,n in [('D1001',2),('D1002',2),('D1003',2),('C1001',2),('C1002',2)]:
    a=p(r,n);done=False
    for radius,angle in [(d,v) for d in (1.05,1.3,1.6) for v in (270,180,0,90,225,315,135,45)]:
        dx=round(radius*math.cos(math.radians(angle)),6);dy=round(radius*math.sin(math.radians(angle)),6)
        c=(a[0]+dx,a[1]+dy)
        if not (.8<c[0]<116.21 and .8<c[1]<68.61):continue
        t=pcb.PCB_TRACK(b);t.SetStart(pt(50+a[0],50+a[1]));t.SetEnd(pt(50+c[0],50+c[1]));t.SetWidth(pcb.FromMM(.25));t.SetLayer(pcb.F_Cu);t.SetNet(b.FindNet('GND'))
        if blocked(t,pcb.F_Cu,'GND'):continue
        try:v=via('GND',*c)
        except AssertionError:continue
        path('GND',[a,v],.25);done=True;break
    assert done,('No short ground exit',r)
pcb.SaveBoard(str(TARGET),b)
(ROOT/'outputs/A02-USB-ENTRY-ROUTES.json').write_text(json.dumps(records,indent=2)+'\n')
print('Added',len(records),'explicit USB entry/decoupling paths. Ground/power completion remains required.')
