"""One readable assembly reference per component, clear of neighbouring parts.

The four camera circuits share the same reference-label offsets. Values remain
in the BOM and properties. This changes documentation geometry, never copper.
"""
import json,math,sys
from collections import defaultdict
import pcbnew as pcb
from rework import ROOT,TARGET
from routing import pt,pos,rect,intersects
from mechanical import WIDTH,HEIGHT,INSERT_CENTRES

prototype='--prototype-silk' in sys.argv
height,stroke=(1.0,.15) if prototype else (.8,.12)
b=pcb.LoadBoard(str(TARGET));fs={f.GetReference():f for f in b.GetFootprints()}
bins={'F':defaultdict(list),'B':defaultdict(list)};records=[]
def keys(q):
    return [(x,y) for x in range(math.floor(q[0]/5),math.floor(q[2]/5)+1)
                 for y in range(math.floor(q[1]/5),math.floor(q[3]/5)+1)]
def reserve(side,name,q):
    for k in keys(q):bins[side][k].append((name,q))
def free(side,q,own):
    if q[0]<.5 or q[1]<.5 or q[2]>WIDTH-.5 or q[3]>HEIGHT-.5:return False
    return not any(intersects(q,other) for k in keys(q) for name,other in bins[side][k])
def bbox(t,margin=.15):
    r=t.GetEffectiveTextShape().BBox() if hasattr(t,'GetEffectiveTextShape') else t.GetBoundingBox()
    return (r.GetLeft()/1e6-50-margin,r.GetTop()/1e6-50-margin,
            r.GetRight()/1e6-50+margin,r.GetBottom()/1e6-50+margin)
for f in fs.values():
    # Stock library centre references duplicated the moved reference fields.
    for g in list(f.GraphicalItems()):
        if isinstance(g,pcb.PCB_TEXT) and g.GetText() in ('${REFERENCE}','%R'):
            g.SetText('');g.SetVisible(False)
    f.Value().SetVisible(False)
    side='B' if f.IsFlipped() else 'F'
    t=f.Reference();t.SetVisible(True)
    t.SetLayer((pcb.B_SilkS if side=='B' else pcb.F_SilkS) if prototype else (pcb.B_Fab if side=='B' else pcb.F_Fab))
    t.SetTextAngle(pcb.EDA_ANGLE(0,pcb.DEGREES_T));t.SetMirrored(side=='B')
    t.SetTextSize(pt(height,height));t.SetTextThickness(pcb.FromMM(stroke))
    reserve(side,f.GetReference(),rect(f,.18))
    for p in f.Pads():
        if p.GetAttribute() in (pcb.PAD_ATTRIB_PTH,pcb.PAD_ATTRIB_NPTH):
            reserve('F' if side=='B' else 'B',f.GetReference()+' pad',bbox(p,.18))
for d in b.GetDrawings():
    if d.GetLayer() not in (pcb.F_SilkS,pcb.B_SilkS):continue
    reserve('B' if d.GetLayer()==pcb.B_SilkS else 'F','board marking',bbox(d,.18))
for x,y in INSERT_CENTRES:
    for s in ('F','B'):reserve(s,'fastener',(x-3.5,y-3.5,x+3.5,y+3.5))

offsets=sorted([(x*x+y*y,abs(x)>0 and abs(y)>0,angle,x,y) for x in range(-32,33) for y in range(-32,33) for angle in (0,90)])   # 8 mm: a label further away misleads the assembler
placed=set();unplaced=[]

# Explicit banks are preferred over scattering references into arbitrary gaps.
# These are board-local label locations, separate from component placement.
preferred={
    **{f'C{1111+i}':(83.75 if i==0 else 84.5-3*i,50.8,90) for i in range(5)},
    'C1117':(80.5,54.1,0),'C1118':(74.8,54.1,0),
    'C1119':(85.2,56.75,0),
    'U1100':(90,58.7,0),
    'C1207':(71.5,51.5,0),'C1208':(77,51.5,0),
    'C1209':(66,59.5,0),'C1210':(71.5,59.5,0),
    'C1211':(81.15,56.5,90),'Q1200':(63.5,61.1,0),'Q1201':(71.5,61.1,0),
    'C1206':(67.5,51.1,0),'U1200':(65.5,56.5,0),
    'U1201':(43,51.35,0),'L1201':(47,51.0,0),
    'C1212':(39.25,56.7,0),'C1213':(51,56.7,0),
    # R1100/R1105 moved beside the charger with the pack connector (0.1.8): placed by search.
}
if prototype:
    preferred['J1000']=(115.6,64,90)
    preferred.update({f'C{1111+i}':(84.5-3*i,51.3,90) for i in range(5)})
    preferred.update({'C1117':(80.5,54.65,0),'C1118':(74.8,54.65,0)})

def commit_label(r):
    f=fs[r];q=bbox(f.Reference());side='B' if f.IsFlipped() else 'F'
    if not free(side,q,r):
        conflicts=sorted({name for k in keys(q) for name,other in bins[side][k] if intersects(q,other)})
        raise RuntimeError(f'Preferred label {r} collides: {conflicts}')
    reserve(side,r+' label',q);placed.add(r);x,y=pos(f);tx,ty=pos(f.Reference())
    records.append({'reference':r,'side':side,'text_xy_mm':[tx,ty],
                    'offset_mm':[tx-x,ty-y],'angle_deg':f.Reference().GetTextAngle().AsDegrees(),
                    'bounding_box_mm':list(q),'placement':'explicit bank'})

for r,(x,y,a) in preferred.items():
    t=fs[r].Reference();t.SetPosition(pt(50+x,50+y));t.SetTextAngle(pcb.EDA_ANGLE(a,pcb.DEGREES_T))
    if prototype and not free('B' if fs[r].IsFlipped() else 'F',bbox(t),r):continue
    commit_label(r)
def place(refs):
    ff=[fs[r] for r in refs];centres=[pos(f) for f in ff]
    for _,_,angle,dx,dy in offsets:
        boxes=[]
        for f,(x,y) in zip(ff,centres):
            f.Reference().SetTextAngle(pcb.EDA_ANGLE(angle,pcb.DEGREES_T))
            f.Reference().SetPosition(pt(50+x+dx*.25,50+y+dy*.25))
            boxes.append(bbox(f.Reference(),.15))
        if not all(free('B' if f.IsFlipped() else 'F',q,f.GetReference()) for f,q in zip(ff,boxes)):continue
        for r,f,c,q in zip(refs,ff,centres,boxes):
            side='B' if f.IsFlipped() else 'F';reserve(side,r+' label',q);placed.add(r)
            if r in unplaced:unplaced.remove(r)        # a failed group member placed on its own
            f.Reference().SetLayer((pcb.B_SilkS if side=='B' else pcb.F_SilkS) if prototype else (pcb.B_Fab if side=='B' else pcb.F_Fab))
            records.append({'reference':r,'side':side,'text_xy_mm':list(pos(f.Reference())),
                            'offset_mm':[dx*.25,dy*.25],'angle_deg':angle,'bounding_box_mm':list(q)})
        return
    unplaced.extend(r for r in refs if r not in unplaced)          # recorded, not silently dropped: see A02-ASSEMBLY-LABELS-UNFINISHED.json
    for f,(x,y) in zip(ff,centres):          # assembly drawing keeps the reference at the part centre
        t=f.Reference();t.SetLayer(pcb.B_Fab if f.IsFlipped() else pcb.F_Fab)
        t.SetTextAngle(pcb.EDA_ANGLE(0,pcb.DEGREES_T));t.SetPosition(pt(50+x,50+y))

# Reserve the same offset on all four cameras simultaneously.
for stem,offset in [('U',0),('U',1),('RS',0),('D',0),*[(s,i) for s,n in [('C',5),('R',6),('TP',2)] for i in range(n)]]:
    place([stem+str(200+100*i+offset) for i in range(4)])
density={r:sum(abs(pos(f)[0]-pos(fs[r])[0])<5 and abs(pos(f)[1]-pos(fs[r])[1])<5 and f.IsFlipped()==fs[r].IsFlipped() for f in fs.values()) for r in fs}
for r in sorted(fs,key=lambda r:(-density[r],pos(fs[r])[1],pos(fs[r])[0])):
    if r not in placed:place([r])
unfinished=ROOT/'outputs/A02-ASSEMBLY-LABELS-UNFINISHED.json'
if unplaced:unfinished.write_text(json.dumps({'unplaced':unplaced,'reason':'no clear position within 8 mm per axis; reference kept on Fab at the part centre'},indent=2)+chr(10))
elif unfinished.exists():unfinished.unlink()
assert len(placed)+len(unplaced)==len(fs),(len(placed),len(unplaced),len(fs))
pcb.SaveBoard(str(TARGET),b)
(ROOT/'outputs/A02-ASSEMBLY-LABELS.json').write_text(json.dumps({
    'board':TARGET.name,'text_height_mm':height,'text_stroke_mm':stroke,
    'reference_layers':'F.SilkS/B.SilkS' if prototype else 'F.Fab/B.Fab',
    'reference_count':len(records),'duplicate_centre_references_removed':True,
    'component_outline_margin_mm':.18,'label_margin_mm':.15,
    'placement':'outside all component outlines and pads, clear of fasteners, markings and other labels',
    'labels':records},indent=2)+'\n')
print('Placed',len(records),'unique assembly references, clear of other components and labels.')
