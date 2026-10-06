"""Use the free front power area for PD control and charger bias components.

Preserve manually locked routing; discard the now-invalid secondary trial.
"""
import json,re
import pcbnew as pcb
from rework import ROOT,TARGET,CACHE
from routing import pt,rect,intersects
from mechanical import INSERT_CENTRES

b=pcb.LoadBoard(str(TARGET));fs={f.GetReference():f for f in b.GetFootprints()}
refs=['U1000',*[f'R{1000+i}' for i in range(5)],*[f'C{1000+i}' for i in range(3)],
      *[f'D{1000+i}' for i in range(4)],*[f'R{1100+i}' for i in range(10)],'Q1100']
for ref in refs:
    f=fs[ref]
    if ref=='R1000':f.SetPosition(pt(158.75,96.5))
    if ref=='R1001':f.SetPosition(pt(165.5,107.75))
    if f.IsFlipped():f.Flip(f.GetPosition(),pcb.FLIP_DIRECTION_LEFT_RIGHT)
    box=rect(f,.1)
    collisions=[other.GetReference() for other in fs.values() if other!=f and other.IsFlipped()==f.IsFlipped() and intersects(box,rect(other,.1))]
    assert not collisions,(ref,collisions)
    assert not any(intersects(box,(x-3.5,y-3.5,x+3.5,y+3.5)) for x,y in INSERT_CENTRES),ref
pcb.SaveBoard(str(TARGET),b)
source=TARGET.read_text()
for m in reversed(list(re.finditer(r'\n\t\((segment|via)\b',source))):
    start=m.start()+2;depth=0;quoted=False;escaped=False
    for end in range(start,len(source)):
        c=source[end]
        if escaped:escaped=False;continue
        if c=='\\' and quoted:escaped=True;continue
        if c=='"':quoted=not quoted;continue
        if quoted:continue
        if c=='(':depth+=1
        elif c==')':
            depth-=1
            if depth==0:break
    if '(locked yes)' in source[start:end]:continue
    source=source[:m.start()]+source[end+1:]
TARGET.write_text(source)
(ROOT/'outputs/A02-FRONT-POWER-BLOCKS.json').write_text(json.dumps({'moved_to_front':refs,'reason':'Make physical room for readable component references and power-section assembly access.'},indent=2)+'\n')
print('Moved',len(refs),'parts to the front, retained locked critical routing.')
