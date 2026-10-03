"""Show actual test-land outlines on assembly layers without printing on copper.

Board-level Fab graphics leave stock test-point library footprints unchanged.
Regenerate these graphics if any test lands move; outlines of removed test lands are deleted.
"""
import json
import pcbnew as pcb
from rework import ROOT,TARGET
from routing import pt
b=pcb.LoadBoard(str(TARGET))
record=ROOT/'outputs/A02-ASSEMBLY-PAD-GRAPHICS.json'
prior=json.loads(record.read_text()) if record.exists() else {}
drawings={str(d.m_Uuid.AsString()):d for d in b.GetDrawings()}
created={}
for f in b.GetFootprints():
    if not f.GetReference().startswith('TP') and f.GetReference()!='J600':continue
    layer=pcb.B_Fab if f.IsFlipped() else pcb.F_Fab
    for p in f.Pads():
        xy=p.GetPosition();size=p.GetSize()
        shape=pcb.SHAPE_T_RECT if p.GetShape()==pcb.PAD_SHAPE_RECT else pcb.SHAPE_T_CIRCLE
        a=pcb.VECTOR2I(xy.x-size.x//2,xy.y-size.y//2) if shape==pcb.SHAPE_T_RECT else xy
        c=pcb.VECTOR2I(xy.x+size.x//2,xy.y+size.y//2) if shape==pcb.SHAPE_T_RECT else pcb.VECTOR2I(xy.x+size.x//2,xy.y)
        key=f.GetReference()+'.'+p.GetNumber()
        g=drawings.get(prior.get(key,''))
        if g is None:
            g=next((g for g in b.GetDrawings() if isinstance(g,pcb.PCB_SHAPE) and g.GetLayer()==layer and g.GetShape()==shape and g.GetStart()==a and g.GetEnd()==c),None)
        if g is None:g=pcb.PCB_SHAPE(b);b.Add(g)
        g.SetShape(shape);g.SetStart(a);g.SetEnd(c);g.SetLayer(layer);g.SetWidth(pcb.FromMM(.1))
        created[key]=str(g.m_Uuid.AsString())
keep=set(created.values())
stale=[d for d in b.GetDrawings() if isinstance(d,pcb.PCB_SHAPE) and d.GetLayer() in (pcb.F_Fab,pcb.B_Fab)
       and d.GetShape() in (pcb.SHAPE_T_CIRCLE,pcb.SHAPE_T_RECT) and d.GetWidth()==pcb.FromMM(.1) and str(d.m_Uuid.AsString()) not in keep]
for d in stale:b.Remove(d)                # outlines of removed test lands; last, Remove() invalidates the other proxies
pcb.SaveBoard(str(TARGET),b)
record.write_text(json.dumps(created,indent=2)+'\n')
print('Test-land outlines on assembly layers:',len(created),'; stale removed:',len(stale))
