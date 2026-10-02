"""Measure the actual review PCB; never equate DRC with functional approval."""
import json, math, re, sys
from collections import defaultdict, Counter
from pathlib import Path
import pcbnew as pcb
from routing import ROOT, TARGET
if '--a02' in sys.argv:
    from rework import TARGET
suffix='A02' if '--a02' in sys.argv else 'ROUTED'

b=pcb.LoadBoard(str(TARGET))
tracks=[t for t in b.GetTracks() if not isinstance(t,pcb.PCB_VIA)]
vias=[t for t in b.GetTracks() if isinstance(t,pcb.PCB_VIA)]
fps=list(b.GetFootprints());pads=[p for f in fps for p in f.Pads()]
def xy(p):return [round(p.x/1e6,6),round(p.y/1e6,6)]
def ident(p):return p.GetParentFootprint().GetReference()+'.'+p.GetNumber()
netstats=defaultdict(lambda:{'length_mm':0,'width_length_mm':defaultdict(float),'via_count':0,'layers':set()})
vertices=defaultdict(list)
for t in tracks:
    n=t.GetNetname();s=netstats[n];length=t.GetLength()/1e6;width=t.GetWidth()/1e6
    s['length_mm']+=length;s['width_length_mm'][str(round(width,4))]+=length;s['layers'].add(b.GetLayerName(t.GetLayer()))
    for v,other in [(t.GetStart(),t.GetEnd()),(t.GetEnd(),t.GetStart())]:
        vertices[(n,t.GetLayer(),v.x,v.y)].append((other.x-v.x,other.y-v.y,t))
for v in vias:netstats[v.GetNetname()]['via_count']+=1
right_angles=[]
for (net,layer,x,y),edges in vertices.items():
    if len(edges)!=2:continue  # A T junction is not a trace bend.
    (ax,ay,_),(bx,by,_)=edges
    if ax*bx+ay*by!=0:continue
    pos=pcb.VECTOR2I(x,y)
    # Turns ending in copper pads/vias are junctions, not exposed corners.
    if any(p.GetNetname()==net and p.IsOnLayer(layer) and p.HitTest(pos) for p in pads):continue
    if any(v.GetNetname()==net and v.GetPosition()==pos for v in vias):continue
    right_angles.append({'net':net,'layer':b.GetLayerName(layer),'xy_mm':xy(pos)})

# With zero mask expansion, copper outlines are the nominal mask apertures.
# Check this separately: a plotter may REMOVE a narrow dam instead of failing
# DRC, which is not proof that a black dam was manufactured.
assert b.GetDesignSettings().m_SolderMaskExpansion==0
black_mask_failures=[];shared_apertures=[]
for cu,mask in [(pcb.F_Cu,pcb.F_Mask),(pcb.B_Cu,pcb.B_Mask)]:
    pp=[p for p in pads if p.IsOnLayer(mask) and p.GetAttribute()!=pcb.PAD_ATTRIB_NPTH]
    for i,p in enumerate(pp):
        r=p.GetBoundingBox();r.Inflate(130000)
        for q in pp[i+1:]:
            if ident(p)==ident(q) or not r.Intersects(q.GetBoundingBox()):continue
            a=p.GetEffectiveShape(cu);c=q.GetEffectiveShape(cu)
            if p.GetPosition()==q.GetPosition() and p.GetSize()==q.GetSize() and p.GetNetname()==q.GetNetname():
                shared_apertures.append([ident(p),ident(q)]);continue
            if a.Collide(c,130000):
                lo,hi=0,130000
                while hi-lo>100:
                    mid=(lo+hi)//2
                    if a.Collide(c,mid):hi=mid
                    else:lo=mid
                black_mask_failures.append({'pads':[ident(p),ident(q)],'side':b.GetLayerName(mask),'nominal_gap_mm':round(lo/1e6,4),'same_net':p.GetNetname()==q.GetNetname()})

for s in netstats.values():
    s['length_mm']=round(s['length_mm'],3)
    s['width_length_mm']={w:round(l,3) for w,l in s['width_length_mm'].items()}
    s['layers']=sorted(s['layers'])
drc=json.loads((ROOT/f'outputs/DRC-{suffix}.json').read_text())
result={'board':TARGET.name,'manufacturer_target':'JLCPCB','mask':'black','silkscreen':'white','outer_copper_oz':1,
 'black_nominal_mask_gap_min_mm':.13,'black_mask_gap_failures':black_mask_failures,'intentional_shared_apertures':shared_apertures,
 'right_angle_bends':right_angles,'net_routing':dict(sorted(netstats.items())),
 'track_segments_by_layer':dict(Counter(b.GetLayerName(t.GetLayer()) for t in tracks)),
 'switching_nodes_with_layer_changes':[n for n in ('BOOST_SW','CHG_SW1','CHG_SW2','BUCK_SW')
                                     if n in netstats and netstats[n]['via_count']],
 'drc_counts':dict(Counter(v['type'] for v in drc['violations'])),'unconnected_items':len(drc['unconnected_items']),
 'order_verdict':'DO NOT ORDER','electrical_function_verified':False,'thermal_verified':False,'physical_stack_verified':False}
(ROOT/('outputs/A02-ROUTING-AUDIT.json' if suffix=='A02' else 'outputs/ROUTING-AUDIT.json')).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='net_routing'},indent=2))
