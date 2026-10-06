"""Move bulk storage and main load FETs into the unused front power area.

The first boost output capacitor stays beside the converter on the back.
Additional capacitors use two through vias per terminal, outside solder lands.
Only run on the manual routing seed; secondary routing must follow placement.
"""
import json
import pcbnew as pcb
from rework import ROOT, TARGET
from routing import pt, pos, rect, intersects
from mechanical import INSERT_CENTRES

b=pcb.LoadBoard(str(TARGET));fs={f.GetReference():f for f in b.GetFootprints()}
refs=[f'C{i}' for i in range(1207,1212)]+['Q1200','Q1201']
assert all(t.IsLocked() for t in b.GetTracks()), 'Do not discard secondary routing.'
if all(not fs[r].IsFlipped() for r in refs):
    print('Bulk components already moved.');raise SystemExit
assert all(fs[r].IsFlipped() for r in refs)
for ref in refs:
    f=fs[ref];angle=f.GetOrientationDegrees()
    f.Flip(f.GetPosition(),pcb.FLIP_DIRECTION_LEFT_RIGHT)
    if ref.startswith('C'):f.SetOrientationDegrees(angle)
    box=rect(f,.1)
    bad=[r for r,g in fs.items() if r!=ref and not g.IsFlipped() and intersects(box,rect(g,.1))]
    assert not bad,(ref,bad)
    assert not any(intersects(box,(x-3.5,y-3.5,x+3.5,y+3.5)) for x,y in INSERT_CENTRES),ref

def line(net,a,c,width,layer):
    if a==c:return
    t=pcb.PCB_TRACK(b);t.SetStart(pt(50+a[0],50+a[1]));t.SetEnd(pt(50+c[0],50+c[1]))
    t.SetLayer(layer);t.SetWidth(pcb.FromMM(width));t.SetNet(b.FindNet(net));t.SetLocked(True);b.Add(t)

connections=[]
for ref in refs[:5]:
    f=fs[ref]
    for p in f.Pads():
        x,y=pos(p);net=p.GetNetname()
        # Existing boost rails lie at 51.8 / 58.7. Paired vias meet the
        # rail outside the 1.8 mm high land without via-in-pad processing.
        vy=(51.8 if y<55 else 58.7) if net=='BOOST_5V' else 55.25
        for vx in (x-.35,x+.35):
            v=pcb.PCB_VIA(b);v.SetPosition(pt(50+vx,50+vy));v.SetWidth(pcb.FromMM(.6));v.SetDrill(pcb.FromMM(.3))
            v.SetViaType(pcb.VIATYPE_THROUGH);v.SetLayerPair(pcb.F_Cu,pcb.B_Cu)
            v.SetNet(b.FindNet(net));v.SetLocked(True);b.Add(v)
            line(net,(x,vy),(vx,vy),.6,pcb.F_Cu)
        line(net,(x,y),(x,vy),.8,pcb.F_Cu)
        # Remove the old branch that now ends at an empty back-face land.
        if net=='BOOST_5V':
            for t in list(b.GetTracks()):
                if isinstance(t,pcb.PCB_VIA) or t.GetLayer()!=pcb.B_Cu or t.GetNetname()!=net:continue
                ends={(round(t.GetStart().x/1e6-50,4),round(t.GetStart().y/1e6-50,4)),
                      (round(t.GetEnd().x/1e6-50,4),round(t.GetEnd().y/1e6-50,4))}
                if ends=={(round(x,4),round(y,4)),(round(x,4),vy)}:b.Remove(t)
        connections.append({'ref':ref,'pin':p.GetNumber(),'net':net,'via_xy':[[x-.35,vy],[x+.35,vy]]})
pcb.SaveBoard(str(TARGET),b)
(ROOT/'outputs/A02-FRONT-BULK.json').write_text(json.dumps({
    'moved_to_front':refs,'closest_boost_capacitor_remains_back':'C1206',
    'via_diameter_mm':.6,'via_drill_mm':.3,'connections':connections,
    'thermal_current_qualification':'pending'},indent=2)+'\n')
print('Moved seven parts to front and added paired capacitor vias.')
