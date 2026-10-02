"""Apply review-board fabrication intent and readable connector labels.

These settings do not release manufacturing files. The 1.6 mm stack below is
a nominal stack for rendering; the fabricator's final stack still needs review.
"""
import json
from pathlib import Path
import pcbnew as pcb
from routing import ROOT,TARGET,NAME,restore_through_hole_mask,pt,rect,intersects
from mechanical import WIDTH,HEIGHT

b=pcb.LoadBoard(str(TARGET));restore_through_hole_mask(b)
ds=b.GetDesignSettings();ds.m_SolderMaskMinWidth=pcb.FromMM(.13);ds.m_SolderMaskExpansion=0
ds.m_AllowSoldermaskBridgesInFPs=False
fps={f.GetReference():f for f in b.GetFootprints()}
occupied=[rect(f,.3) for f in fps.values() if f.GetLayer()==pcb.F_Cu]
labels={'J100':'P4 / PIN 1','J101':'C6 SERVICE','J102':'3V3 I2C','J1100':'PACK + / NTC / -',
 'J1000':'USB-C CHARGE','J800':'RTC BACKUP','J900':'MOTOR','J901':'COVER',
 'J902':'SHUTTER','J903':'REMOTE','J904':'FUNCTION','J1300':'POWER','JP1200':'P4 PWR LINK'}
for i in range(4):
    labels[f'J{201+i*100}']=f'CAM {i+1} GPIO'
    labels[f'JP{200+i*100}']=f'CAM {i+1} PWR'
for ref,text in labels.items():
    if any(isinstance(d,pcb.PCB_TEXT) and d.GetText()==text for d in b.GetDrawings()):continue
    f=fps[ref];box=rect(f);cx=(box[0]+box[2])/2;cy=(box[1]+box[3])/2
    t=pcb.PCB_TEXT(b);t.SetText(text);t.SetLayer(pcb.F_SilkS);t.SetTextSize(pt(.85,.85));t.SetTextThickness(pcb.FromMM(.15))
    placed=False
    for delta in [1,2,3,4,5,6,8,10]:
        for x,y in [(cx,box[1]-delta),(cx,box[3]+delta),(box[0]-delta,cy),(box[2]+delta,cy)]:
            t.SetPosition(pt(x+50,y+50));r=t.GetBoundingBox();r=(r.GetX()/1e6-50,r.GetY()/1e6-50,r.GetRight()/1e6-50,r.GetBottom()/1e6-50)
            if r[0]<.7 or r[1]<.7 or r[2]>WIDTH-.7 or r[3]>HEIGHT-.7:continue
            if any(intersects(r,o) for o in occupied):continue
            b.Add(t);occupied.append(r);placed=True;break
        if placed:break
    if not placed:print('No clear front label position:',ref,text)
pcb.SaveBoard(str(TARGET),b)
s=TARGET.read_text()
if '(stackup' not in s:
    stack='''
        (stackup
            (layer "F.SilkS" (type "Top Silk Screen") (color "White"))
            (layer "F.Paste" (type "Top Solder Paste"))
            (layer "F.Mask" (type "Top Solder Mask") (color "Black") (thickness 0.01))
            (layer "F.Cu" (type "copper") (thickness 0.035))
            (layer "dielectric 1" (type "prepreg") (thickness 0.2) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))
            (layer "In1.Cu" (type "copper") (thickness 0.0175))
            (layer "dielectric 2" (type "core") (thickness 1.075) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))
            (layer "In2.Cu" (type "copper") (thickness 0.0175))
            (layer "dielectric 3" (type "prepreg") (thickness 0.2) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))
            (layer "B.Cu" (type "copper") (thickness 0.035))
            (layer "B.Mask" (type "Bottom Solder Mask") (color "Black") (thickness 0.01))
            (layer "B.Paste" (type "Bottom Solder Paste"))
            (layer "B.SilkS" (type "Bottom Silk Screen") (color "White"))
            (copper_finish "ENIG") (dielectric_constraints no)
        )'''
    s=s.replace('(setup','(setup'+stack,1);TARGET.write_text(s)
propath=ROOT/(NAME+'.kicad_pro');pro=json.loads(propath.read_text())
pro['board']['design_settings']['rules'].update(min_silk_clearance=.15,min_text_thickness=.12)
propath.write_text(json.dumps(pro,indent=2)+'\n')
print('Black / white / ENIG intent, 0.13 mm nominal mask web, connector labels applied.')
