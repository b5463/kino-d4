"""Place the user-supplied ODD JOBS symbol on clear front silkscreen.

Artwork is reserved separately from the hardware licence. The alpha contour
was traced from the supplied symbol, not recreated or generated.
"""
import json
import pcbnew as pcb
from routing import ROOT, TARGET, rect, intersects, pt
from mechanical import WIDTH, HEIGHT

b = pcb.LoadBoard(str(TARGET))
for g in list(b.Groups()):
    if g.GetName() == 'ODD JOBS maker mark':
        for item in list(g.GetItems()):
            g.RemoveItem(item)
            b.Remove(item)
        b.Remove(g)
data = json.loads((ROOT/'brand/odd-jobs-symbol.json').read_text())
w = 9.0
scale = w/(data['pixel_bounds'][2]-1)
h = (data['pixel_bounds'][3]-1)*scale
occupied = [rect(f, .5) for f in b.GetFootprints() if f.GetLayer() == pcb.F_Cu]
for d in b.GetDrawings():
    if d.GetLayer() != pcb.F_SilkS:
        continue
    r = d.GetBoundingBox()
    occupied.append((r.GetX()/1e6-50-.3, r.GetY()/1e6-50-.3,
                     r.GetRight()/1e6-50+.3, r.GetBottom()/1e6-50+.3))
candidates = [(x/2,y/2) for y in range(4,int((HEIGHT-h-5)*2))
              for x in range(4,int((WIDTH-w-2)*2))]
# Prefer an exposed upper-right location. Never shrink into illegibility.
candidates.sort(key=lambda p:(WIDTH-w-2-p[0])**2+(p[1]-2)**2)
x,y = next((x,y) for x,y in candidates
           if not any(intersects((x-.5,y,x+w+.5,y+h+3),o) for o in occupied))
poly = pcb.SHAPE_POLY_SET()
poly.NewOutline()
for a,c in data['points']:
    poly.Append(round((50+x+a*scale)*1e6),round((50+y+c*scale)*1e6))
shape = pcb.PCB_SHAPE(b)
shape.SetShape(pcb.SHAPE_T_POLY)
shape.SetPolyShape(poly)
shape.SetFilled(True)
shape.SetWidth(0)
shape.SetLayer(pcb.F_SilkS)
b.Add(shape)
group = pcb.PCB_GROUP(b)
group.SetName('ODD JOBS maker mark')
b.Add(group)
group.AddItem(shape)
for caption,dy in [('KINO D4',h+1),('A0.1 DRAFT',h+2.3)]:
    label=pcb.PCB_TEXT(b)
    label.SetText(caption)
    label.SetPosition(pt(50+x+w/2,50+y+dy))
    label.SetTextSize(pt(.8,.8))
    label.SetTextThickness(pcb.FromMM(.15))
    label.SetLayer(pcb.F_SilkS)
    b.Add(label)
    group.AddItem(label)
pcb.SaveBoard(str(TARGET),b)
report = {'source':data['source'],'source_sha256':data['source_sha256'],
          'layer':'F.SilkS','colour':'white','width_mm':w,'height_mm':round(h,4),
          'board_top_left_mm':[x,y],'artwork_licence':data['license']}
(ROOT/'outputs/BRAND-PLACEMENT.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
