"""Final A0.2 bank placement and clearance corrections before secondary routing."""
import json
import pcbnew as pcb
from rework import ROOT,TARGET
from routing import pt,pos,rect,intersects
from mechanical import INSERT_CENTRES
b=pcb.LoadBoard(str(TARGET));fs={f.GetReference():f for f in b.GetFootprints()}
placements={'C1117':(80.5,56.7),'C1118':(74.8,56.7),'TP1100':(90,63),
            'TP1101':(75,64),'R1001':(103.5,56)}
for i in range(4):placements[f'JP{200+100*i}']=(23.755+22*i,11)
for r,(x,y) in placements.items():
    fs[r].SetPosition(pt(50+x,50+y))
fs['R1001'].SetOrientationDegrees(0)
for r in placements:
    f=fs[r];q=rect(f,.1)
    bad=[g.GetReference() for g in fs.values() if g!=f and g.IsFlipped()==f.IsFlipped() and intersects(q,rect(g,.1))]
    assert not bad,(r,bad)
    assert not any(intersects(q,(x-3.5,y-3.5,x+3.5,y+3.5)) for x,y in INSERT_CENTRES),r
old_bias=[]
for t in b.GetTracks():
    if isinstance(t,pcb.PCB_VIA):continue
    if t.GetNetname()=='SYS_RAW' and t.GetLayer() in (pcb.F_Cu,pcb.In2_Cu):
        a=t.GetStart();c=t.GetEnd()
        if all(112.9<v.x/1e6<117.1 and 106<v.y/1e6<110.6 for v in [a,c]):
            old_bias.append(t)
points=[(63.2,56.3),(63.2,59.2),(64.25,60.25),(66.8,60.25)]
for a,c in zip(points,points[1:]):
    t=pcb.PCB_TRACK(b);t.SetStart(pt(a[0]+50,a[1]+50));t.SetEnd(pt(c[0]+50,c[1]+50))
    t.SetLayer(pcb.In2_Cu);t.SetWidth(pcb.FromMM(.4));t.SetNet(b.FindNet('SYS_RAW'));t.SetLocked(True);b.Add(t)
for t in old_bias:b.Remove(t)
# Remove duplicate same-net vias from the shared ground terminal pairs.
seen=set()
for t in list(b.GetTracks()):
    if not isinstance(t,pcb.PCB_VIA):continue
    key=(t.GetPosition().x,t.GetPosition().y,t.GetNetname())
    if key in seen:b.Remove(t)
    else:seen.add(key)
pcb.SaveBoard(str(TARGET),b)
(ROOT/'outputs/A02-PLACEMENT-REFINEMENTS.json').write_text(json.dumps({
    'placements_local_mm':placements,
    'sys_raw_bias_escape_layer':'In2.Cu; avoids front boost capacitor lands',
    'note':'Component banks and adjacent reference rows; camera socket datums unchanged.'},indent=2)+'\n')
print('Placement and locked route clearances refined.')
