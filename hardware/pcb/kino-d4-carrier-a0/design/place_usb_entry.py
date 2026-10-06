"""Bring USB VBUS/CC clamps to the connector before final local routing.

Rip up only unlocked front-face copper and vias intersecting the moved parts'
old/new envelopes. Preserve unrelated routes and every manually locked route.
"""
import json
import pcbnew as pcb
from rework import ROOT,TARGET
from routing import pt,pos,rect,intersects
from mechanical import INSERT_CENTRES
b=pcb.LoadBoard(str(TARGET));fs={f.GetReference():f for f in b.GetFootprints()}
plan={'U1000':(108.75,54.4,90),'R1001':(113.5,54.5,90),
      'C1000':(108.75,50.3,180),
      'C1001':(103.5,55,180),'C1002':(103.5,57,180),
      'D1001':(109,59,180),'D1002':(104,59,180),'D1003':(114,59,0)}
if all(abs(pos(fs[r])[0]-x)<1e-6 and abs(pos(fs[r])[1]-y)<1e-6 and abs(fs[r].GetOrientationDegrees()-a)<1e-6 for r,(x,y,a) in plan.items()):
    print('USB entry placement already applied.');raise SystemExit
old={r:list(pos(fs[r])) for r in plan};boxes=[rect(fs[r],.35) for r in plan]
for r,(x,y,a) in plan.items():
    fs[r].SetPosition(pt(50+x,50+y));fs[r].SetOrientationDegrees(a)
boxes += [rect(fs[r],.35) for r in plan]
for r in plan:
    f=fs[r];q=rect(f,.1)
    bad=[g.GetReference() for g in fs.values() if g!=f and not g.IsFlipped() and intersects(q,rect(g,.1))]
    assert not bad,(r,bad)
    assert not any(intersects(q,(x-3.5,y-3.5,x+3.5,y+3.5)) for x,y in INSERT_CENTRES),r
removed=[]
for t in list(b.GetTracks()):
    if not isinstance(t,pcb.PCB_VIA) and t.GetLayer()!=pcb.F_Cu:continue
    q=t.GetBoundingBox();box=(q.GetLeft()/1e6-50,q.GetTop()/1e6-50,q.GetRight()/1e6-50,q.GetBottom()/1e6-50)
    if any(intersects(box,o) for o in boxes):
        assert not t.IsLocked(),('Protected route intersects moved USB entry',t.GetNetname())
        removed.append({'net':t.GetNetname(),'uuid':str(t.m_Uuid.AsString())});b.Remove(t)
pcb.SaveBoard(str(TARGET),b)
(ROOT/'outputs/A02-USB-ENTRY-PLACEMENT.json').write_text(json.dumps({
    'old_positions_mm':old,'new_positions_and_angles':plan,
    'removed_local_routing':removed,'entry_clamps':['D1001','D1002','D1003'],
    'note':'Placement correction only. Local protection routing must be completed and reviewed.'},indent=2)+'\n')
print('USB entry clamps relocated; removed',len(removed),'local routing items.')
