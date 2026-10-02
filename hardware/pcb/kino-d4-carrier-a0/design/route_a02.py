"""Explicit A0.2 critical paths and orderly camera buses, followed by DRC.

Coordinates are board-local millimetres. Fixed routes are exported as protected
wiring. L2 is a reference plane; L3 carries only the deliberate switch crossover
and secondary routing. No automatic fine-pitch width implies thermal approval.
"""
import json, math, re, sys, shutil
import pcbnew as pcb
from rework import ROOT, CACHE, NAME, TARGET
from routing import pt, pos, restore_through_hole_mask

def seed():
    b=pcb.LoadBoard(str(CACHE/'a02-placed.kicad_pcb'))
    assert not list(b.GetTracks())
    fs={f.GetReference():f for f in b.GetFootprints()}
    F,B,L3=pcb.F_Cu,pcb.B_Cu,pcb.In2_Cu
    routes=[]
    def pad(r,n):return next(p for p in fs[r].Pads() if p.GetNumber()==str(n))
    def p(r,n):return pos(pad(r,n))
    def path(net,points,width=.2,layer=B):
        points=[(round(x,6),round(y,6)) for x,y in points]
        for a,c in zip(points,points[1:]):
            if a==c:continue
            dx=abs(c[0]-a[0]);dy=abs(c[1]-a[1])
            assert min(dx,dy)<1e-5 or abs(dx-dy)<1e-5,(net,'non-45 segment',a,c)
            t=pcb.PCB_TRACK(b);t.SetStart(pt(a[0]+50,a[1]+50));t.SetEnd(pt(c[0]+50,c[1]+50))
            t.SetLayer(layer);t.SetWidth(pcb.FromMM(width));t.SetNet(b.FindNet(net));t.SetLocked(True);b.Add(t)
        routes.append({'net':net,'layer':b.GetLayerName(layer),'width_mm':width,'points':points})
    def connect(net,a,c,width=.2,layer=B,diagonal_first=False):
        dx=c[0]-a[0];dy=c[1]-a[1];d=min(abs(dx),abs(dy))
        sx=1 if dx>=0 else -1;sy=1 if dy>=0 else -1
        mid=(a[0]+sx*d,a[1]+sy*d) if diagonal_first else (c[0]-sx*d,c[1]-sy*d)
        path(net,[a,mid,c],width,layer)
    def join(r,n,s,m,width=.2,layer=B):
        assert pad(r,n).GetNetname()==pad(s,m).GetNetname(),(r,n,s,m)
        connect(pad(r,n).GetNetname(),p(r,n),p(s,m),width,layer)
    def via(net,x,y):
        v=pcb.PCB_VIA(b);v.SetPosition(pt(50+x,50+y));v.SetWidth(pcb.FromMM(.6));v.SetDrill(pcb.FromMM(.3))
        v.SetViaType(pcb.VIATYPE_THROUGH);v.SetLayerPair(F,B);v.SetNet(b.FindNet(net));v.SetLocked(True);b.Add(v)
        return (x,y)

    # Buck: IC SW terminal faces the inductor, with the output capacitor beyond.
    a=p('U1201',7);path('BUCK_SW',[a,(45.2,a[1])],.25)
    path('BUCK_SW',[(45.2,a[1]),p('L1201',1)],.6)
    join('L1201',2,'C1213',1,.8)
    path('MB_3V3',[p('U1201',6),(44.7,53.75),(44.7,52.3),(49.7,52.3),(50.7,53.3),(50.7,54.25),p('C1213',1)],.2)
    join('U1201',2,'U1201',3,.25)
    join('U1201',2,'C1212',1,.25)

    # Boost hot paths. Immediate pad escape remains narrow; widen outside pins.
    path('BOOST_SW',[p('U1200',4),(61,52.7)],.4)
    path('BOOST_SW',[(61,52.7),(63.5,50.2),p('L1200',2)],1.0)
    path('BOOST_SW',[p('U1200',4),(61,55.25),(61.25,55.5),p('U1200',9)],.25)
    connect('BOOST_SW',p('U1200',9),p('C1203',2),.2)
    join('U1200',8,'C1203',1,.2)
    join('U1200',11,'C1202',1,.2)
    connect('SYS_RAW',p('U1200',7),(63.2,56.3),.25)
    via('SYS_RAW',63.2,56.3);via('SYS_RAW',66.8,60.25)
    connect('SYS_RAW',(63.2,56.3),(66.8,60.25),.4,F)
    connect('SYS_RAW',(66.8,60.25),p('C1205',1),.4)
    join('L1200',1,'C1204',1,1.2)
    # Parallel capacitor branches from rails outside the pad rows. A rail must
    # never run through the intervening ground pads.
    connect('BOOST_5V',(62.0875,54.8),(64.425,53.5),.4)
    path('BOOST_5V',[(64.425,51.8),(75.425,51.8)],1.2)
    path('BOOST_5V',[(64.425,58.7),(75.425,58.7)],1.2)
    path('BOOST_5V',[(64.425,51.8),(64.425,58.7)],1.2)
    for r in range(1206,1212):
        a=p('C'+str(r),1);y=51.8 if r<1209 else 58.7
        path('BOOST_5V',[(a[0],y),a],.8)

    # Charger follows TI fig. 8-21's local inner-layer switch crossover. Two
    # parallel 0.3 mm drills at each end avoid relying on a single power via.
    # Vias beside the inductor are outside its solder lands: no via-in-pad.
    for net,pin,x,outer,lp,boot in [
        ('CHG_SW1',28,90.6,94.25,1,'C1102'),
        ('CHG_SW2',26,89.4,85.75,2,'C1103')]:
        a=p('U1100',pin)
        connect(net,a,(x,54.45),.2)
        path(net,[(x,54.45),(x,55.25)],.4)
        via(net,x,54.45);via(net,x,55.25)
        via(net,outer,46.0);via(net,outer,46.8)
        path(net,[(outer,46),(outer,46.8)],.8)
        connect(net,(outer,46),p('L1100',lp),1.2)
        connect(net,(x,54.45),(outer,46.8),1.0,L3,diagonal_first=True)
        # A parallel branch lands on the same broad L3 conductor.
        path(net,[(x,54.45),(x,55.25)],1.0,L3)
        path(net,[(outer,46),(outer,46.8)],1.0,L3)
        connect(net,p(boot,2),(x,55.25),.2,F)
    # Closest high-frequency capacitors precede bulk-capacitor routing.
    net=pad('U1100',29).GetNetname()
    path(net,[p('U1100',29),(90.9,52.65)],.2)
    path(net,[(90.9,52.65),(92.3,51.25),p('C1110',1)],.4)
    net=pad('U1100',25).GetNetname()
    path(net,[p('U1100',25),(89.1,52.65)],.2)
    path(net,[(89.1,52.65),(87.7,51.25),p('C1116',1)],.4)
    for pin,ref,vpos in [(4,'C1102',(92.75,54.4)),(19,'C1103',(87.25,55.5))]:
        net=pad('U1100',pin).GetNetname()
        connect(net,p('U1100',pin),vpos,.2);via(net,*vpos)
        connect(net,vpos,p(ref,1),.2,F)
    g=via('GND',90,56.0);connect('GND',p('U1100',27),g,.2)
    v=via('GND',90,51.25)
    for ref in ('C1110','C1116'):
        connect('GND',p(ref,2),v,.3)

    # Repeated camera channels. F.Cu UART pairs use the corridor between the
    # GPIO headers and optical row, clear of all switching inductors.
    sync=[]
    for i in range(4):
        base=200+100*i;x=25.505+22*i;u='U'+str(base);r='R'+str(base+2)
        n=i+1
        a=p(u,2);tv=via(f'P4_TX{n}',x-4.1,a[1]);connect(f'P4_TX{n}',a,tv)
        a=p(r,2);rv=via(f'P4_RX{n}',a[0],a[1]-1.05);connect(f'P4_RX{n}',a,rv)
        join(u,5,r,1)
        for k,(net,end) in enumerate([(f'P4_RX{n}',rv),(f'P4_TX{n}',tv)]):
            lane=24.2-1.2*i-.6*k
            start=via(net,10.7+.8*k,lane)
            ex=end[0]-(.7 if k==0 else 0)
            ey=end[1]-(.7 if k==0 else 0)
            path(net,[start,(ex-.8,lane),(ex,lane+.8),(ex,ey),end],.2,F)
        a=p(u,3);sv=via('SYNC_MASTER',x-1.6,a[1]);connect('SYNC_MASTER',a,sv)
        path('SYNC_MASTER',[sv,(sv[0],19.4)],.2,L3);sync.append((sv[0],19.4))
        join(u,1,'C'+str(base),1,.25)
        join(u,14,'C'+str(base+1),1,.25)
        for pin,v in [(4,(x-.8,38)),(7,(x-.8,36.05))]:
            via('GND',*v);connect('GND',p(u,pin),v,.25)
        for ref,location in [('C'+str(base),(x-6.3,38.125)),
                              ('C'+str(base+1),(x+5.3,41.85)),
                              ('C'+str(base+3),(x-4.95,31.25)),
                              ('C'+str(base+4),(x-.775,32.9))]:
            via('GND',*location);connect('GND',p(ref,2),location,.25)
        sw='U'+str(base+1)
        # ILIM and switch output have short local routes, clear of the UARTs.
        join(sw,5,'R'+str(base+3),1)
        join(sw,6,'D'+str(base),2,.6)
        gv=via('GND',x,24.5);connect('GND',p(sw,2),gv,.25)
    path('SYNC_MASTER',[(14,19.4),*sync],.2,L3)
    via('SYNC_MASTER',14,19.4)
    # No front-side signal may pass underneath a switching inductor.
    for ref in ('L1100','L1200','L1201'):
        box=fs[ref].GetBoundingBox(False,False)
        z=pcb.ZONE(b);z.SetIsRuleArea(True);z.SetLayer(F)
        z.SetDoNotAllowTracks(True);z.SetDoNotAllowVias(True)
        z.SetDoNotAllowPads(False);z.SetDoNotAllowFootprints(False);z.SetDoNotAllowZoneFills(False)
        poly=z.Outline();poly.NewOutline()
        for xx,yy in [(box.GetLeft(),box.GetTop()),(box.GetRight(),box.GetTop()),(box.GetRight(),box.GetBottom()),(box.GetLeft(),box.GetBottom())]:poly.Append(xx,yy)
        b.Add(z)
    restore_through_hole_mask(b)
    pcb.SaveBoard(str(TARGET),b)
    # Loading a scratch board creates a scratch project with default rules.
    # Restore the reviewed project rules after SaveBoard writes that project.
    pro=json.loads((ROOT/'KINO_D4_Carrier_A0_Routed.kicad_pro').read_text())
    pro['meta']['filename']=NAME+'.kicad_pro'
    TARGET.with_suffix('.kicad_pro').write_text(json.dumps(pro,indent=2)+'\n')
    (ROOT/'outputs/A02-FIXED-ROUTES.json').write_text(json.dumps(routes,indent=2)+'\n')
    print('Explicit routing:',len(list(b.GetTracks())),'segments/vias')

def export():
    b=pcb.LoadBoard(str(TARGET))
    pcb.ExportSpecctraDSN(b,str(CACHE/'a02.dsn'))
    text=(CACHE/'a02.dsn').read_text()
    text=text.replace('(layer In1.Cu\n      (type signal)','(layer In1.Cu\n      (type power)',1)
    settings='''(autoroute_settings
      (autoroute on) (postroute on) (vias on)
      (via_costs 80) (plane_via_costs 10) (start_ripup_costs 100)
      (layer_rule F.Cu (active on) (preferred_direction horizontal)
        (preferred_direction_trace_costs 1.0) (against_preferred_direction_trace_costs 2.5))
      (layer_rule In1.Cu (active off) (preferred_direction horizontal)
        (preferred_direction_trace_costs 99.0) (against_preferred_direction_trace_costs 99.0))
      (layer_rule In2.Cu (active on) (preferred_direction horizontal)
        (preferred_direction_trace_costs 1.8) (against_preferred_direction_trace_costs 3.0))
      (layer_rule B.Cu (active on) (preferred_direction vertical)
        (preferred_direction_trace_costs 1.0) (against_preferred_direction_trace_costs 2.0)))'''
    # The parser needs the layer declarations before resolving layer rules.
    text=text.replace('(boundary',settings+'\n    (boundary',1)
    (CACHE/'a02.dsn').write_text(text)
    print('Exported a02.dsn; In1 disabled explicitly and declared a power plane')

def import_route():
    b=pcb.LoadBoard(str(TARGET))
    session=sys.argv[2] if len(sys.argv)>2 else 'a02.ses'
    assert pcb.ImportSpecctraSES(b,str(CACHE/session))
    assert not any(t.GetLayer()==pcb.In1_Cu for t in b.GetTracks() if not isinstance(t,pcb.PCB_VIA)), 'Router used the reserved ground layer'
    restore_through_hole_mask(b);pcb.SaveBoard(str(TARGET),b)
    print('Imported secondary routing; reference-plane track count is zero')

if __name__=='__main__':{'seed':seed,'export':export,'import':import_route}[sys.argv[1]]()
