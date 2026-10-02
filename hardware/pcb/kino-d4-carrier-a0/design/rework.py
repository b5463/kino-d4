"""A0.2 circuit-led layout. Keep A0.1 intact as rejected review evidence.

Critical placements/routes are explicit. General routing may use F/In2/B;
In1 is reserved for ground and independently checked after import.
"""
import json, math, re, sys
from pathlib import Path
import pcbnew as pcb
from routing import ROOT, CACHE, pt, pos, rect, intersects, offsets, restore_through_hole_mask
from mechanical import WIDTH, HEIGHT, INSERT_CENTRES

NAME='KINO_D4_Carrier_A0_2'
TARGET=ROOT/(NAME+'.kicad_pcb')
SEED=ROOT/'KINO_D4_Carrier_A0_Routed.kicad_pcb'

def prepare():
    # Removing many owned ZONE objects through this KiCad SWIG build can
    # invalidate the board. Strip only top-level routing objects before load.
    source=SEED.read_text()
    for m in reversed(list(re.finditer(r'\n\t\((segment|via|zone)\b',source))):
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
        if m[1]=='zone' and '(keepout' in source[start:end]:continue
        source=source[:m.start()]+source[end+1:]
    scratch=CACHE/'a02-seed.kicad_pcb';scratch.write_text(source)
    b=pcb.LoadBoard(str(scratch))
    fs={f.GetReference():f for f in b.GetFootprints()}
    parts={p['ref']:p for p in json.loads((ROOT/'design/parts.json').read_text())}
    old={r:(*pos(f),f.GetOrientationDegrees()) for r,f in fs.items()}
    placed=set();occupied={'F':[],'B':[]};moves={}
    def side(f):return 'B' if f.IsFlipped() else 'F'
    def record(r):
        f=fs[r];placed.add(r);occupied[side(f)].append((r,rect(f,.2)))
        moves[r]=dict(x_mm=pos(f)[0],y_mm=pos(f)[1],rotation_deg=f.GetOrientationDegrees(),side=side(f))
        for p in f.Pads():
            if p.GetAttribute() in (pcb.PAD_ATTRIB_PTH,pcb.PAD_ATTRIB_NPTH):
                q=p.GetBoundingBox();margin=.35
                occupied['B' if side(f)=='F' else 'F'].append((r+' tail',
                    (q.GetX()/1e6-50-margin,q.GetY()/1e6-50-margin,
                     q.GetRight()/1e6-50+margin,q.GetBottom()/1e6-50+margin)))
    # Socket optical datums and host mounting are fixed.
    for r,f in fs.items():
        if f.GetLayer()!=pcb.F_Cu:continue
        if r=='J1100':f.SetPosition(pt(104,55))
        if r in ('JP200','JP300','JP400','JP500'):
            i=(int(r[2:])-200)//100
            f.SetPosition(pt(50+23.505+22*i,61))
        record(r)
    # Bootstrap capacitors are opposite the charger, following TI fig. 8-21.
    for r in ('C1102','C1103'):
        fs[r].Flip(fs[r].GetPosition(),pcb.FLIP_DIRECTION_LEFT_RIGHT)
    for x,y in INSERT_CENTRES:
        for s in ('F','B'):occupied[s].append(('screw envelope',(x-3.5,y-3.5,x+3.5,y+3.5)))
    def setat(r,x,y,a=0,slide=False):
        f=fs[r];s=side(f)
        opts=offsets(80) if slide else [(0,0,0)]
        for _,ix,iy in opts:
            xx=x+ix*.25;yy=y+iy*.25
            f.SetOrientationDegrees(a);f.SetPosition(pt(50+xx,50+yy));q=rect(f,.2)
            if q[0]<.6 or q[1]<.6 or q[2]>WIDTH-.6 or q[3]>HEIGHT-.6:continue
            conflicts=[r2 for r2,q2 in occupied[s] if intersects(q,q2)]
            if conflicts:continue
            f.Reference().SetPosition(f.GetPosition());f.Reference().SetLayer(pcb.B_Fab if f.IsFlipped() else pcb.F_Fab)
            record(r);return
        raise ValueError((r,'placement blocked',(x,y,a),q,[(n,bb) for n,bb in occupied[s] if n in conflicts]))

    # Charger: L above IC; closest PMID/SYS ceramics flank central ground.
    # Mirrored orientation follows TI fig. 8-21 on the rear face.
    power={
      'U1100':(90,55,180),'L1100':(90,46,180),
      'C1110':(91.75,51.25,180),'C1116':(88.25,51.25,0),
      'C1106':(95,53.75,180),'C1119':(85,53.75,0),
      'C1104':(96.5,50,90),'C1105':(99.5,50,90),
      'C1107':(96.5,65,90),'C1108':(99.5,65,90),'C1109':(102.25,65,90),
      'C1111':(84.5,46.25,90),'C1112':(81.5,46.25,90),
      'C1113':(78.5,46.25,90),'C1114':(75.5,46.25,90),'C1115':(72.5,46.25,90),
      'C1117':(83.25,50.5,0),'C1118':(83.25,56.5,0),
      'C1102':(93.75,55.5,270),'C1103':(86.25,55.5,90),
      'C1101':(95,58.5,180),'C1100':(86,59,0),
      'R1100':(86,61,90),'R1101':(84.5,56.5,90),
      'R1102':(97,61,0),'Q1100':(93.5,63,0),'R1103':(96.5,64,0),
      'R1104':(88.5,61,90),'R1105':(88.5,64,90),
      'R1106':(90.5,61,90),'R1107':(90.5,64,90),'R1108':(84.5,64,0),
      'R1109':(99,57,90),'F1100':(101,62,90),
      'U1200':(61,55,0),'L1200':(61,48,0),
      'C1204':(54.25,49,180),'C1205':(65,60.25,180),
      'C1206':(66,53.5,0),'C1207':(71.5,53.5,0),'C1208':(77,53.5,0),
      'C1209':(66,57,0),'C1210':(71.5,57,0),'C1211':(77,57,0),
      'C1203':(61.5,58.5,180),'C1202':(58.5,59,270),
      'R1200':(56,55,180),'R1201':(56,57,180),'R1202':(56,60,180),
      'C1200':(53.5,60,90),'C1201':(58.5,62.5,90),
      'Q1200':(59,65,0),'Q1201':(69,65,180),
      'U1201':(43,54,0),'L1201':(47,54.25,0),
      'C1212':(39.25,54.25,180),'C1213':(51,54.25,0),
    }
    for r in sorted(power,key=lambda r:r.startswith(('R','Q','F'))):
        setat(r,*power[r],slide=r.startswith(('R','Q','F')))

    # Identical camera channels use one placement template.
    # No per-channel packing drift is allowed in this group.
    camera={
      'U':(0,38,0),'U1':(0,24.5,0),'RS':(0,21,0),'D':(2,29,0),
      'C':(-5.3,40,90),'C1':(5.3,40,270),'C2':(-3.5,24.5,90),
      'C3':(-4,32.5,180),'C4':(0,34,180),
      'R':(5.3,36.25,90),'R1':(5.3,32.75,90),'R2':(-5.3,36.25,90),
      'R3':(3.75,24.5,90),'R4':(3.75,21,90),'R5':(-3.75,21,90),
      'TP':(-10.5,30,0),'TP1':(-10.5,34,0),
    }
    for i in range(4):
        base=200+100*i;x=25.505+22*i
        for key,(dx,y,a) in camera.items():
            m=re.fullmatch(r'([A-Z]+)(\d*)',key);r=m[1]+str(base+int(m[2] or 0))
            setat(r,x+dx,y,a)
    anchors={'U600':(45,7,0),'U601':(66,8,0),'U700':(94,10,0),
             'U100':(19,48,0),'U1300':(32,56,0),'U900':(108,22,0),
             'U901':(22,14,0),'U1000':(108,55,0),'U701':(106,61,0),
             'RS700':(109,65,90),'Q1000':(109,44,90),'Q1001':(109,35,270)}
    for r,v in anchors.items():setat(r,*v,slide=True)
    # Remaining slow support parts stay with their circuit. IC decouplers
    # are placed before unrelated bias/test parts, with grid-aligned centres.
    owners={'C100':'U100','C600':'U600','C601':'U600','C602':'U601',
            'C700':'U700','C701':'U700','C702':'U701','C703':'U701',
            'C900':'U900','C901':'U900','C902':'U900','C905':'U901',
            'C1000':'U1000','C1001':'U1000','C1002':'U1000',
            'C1300':'U1300','C1301':'U1300'}
    groups={'01_p4':(19,49),'06_control':(55,10),'07_monitoring':(94,10),
            '08_sensors':(50,60),'09_controls':(107,22),'10_usb_pd':(108,55),
            '11_charger':(93,61),'12_boost':(62,61),'13_power_button':(32,58)}
    for r in sorted(fs,key=lambda r:(r not in owners,not r.startswith('C'),r)):
        if r in placed:continue
        x,y=pos(fs[owners[r]]) if r in owners else groups[parts[r]['sheet']]
        setat(r,round(x*4)/4,round(y*4)/4,old[r][2],slide=True)
    for d in b.GetDrawings():
        if isinstance(d,pcb.PCB_TEXT):
            if d.GetText()=='A0.1 DRAFT':d.SetText('A0.2 DRAFT')
            if d.GetText()=='PACK + / NTC / -':d.SetPosition(pt(142,60.5))
    # Board-level rule area prevents accidental routing on the reference plane.
    z=pcb.ZONE(b);z.SetIsRuleArea(True);z.SetLayer(pcb.In1_Cu)
    z.SetDoNotAllowTracks(True);z.SetDoNotAllowVias(False);z.SetDoNotAllowZoneFills(False)
    z.SetDoNotAllowPads(False);z.SetDoNotAllowFootprints(False)
    poly=z.Outline();poly.NewOutline()
    for x,y in [(50,50),(50+WIDTH,50),(50+WIDTH,50+HEIGHT),(50,50+HEIGHT)]:poly.Append(round(x*1e6),round(y*1e6))
    b.Add(z)
    z=pcb.ZONE(b);z.SetLayer(pcb.In1_Cu);z.SetNet(b.FindNet('GND'))
    z.SetLocalClearance(pcb.FromMM(.2));z.SetMinThickness(pcb.FromMM(.2))
    z.SetPadConnection(pcb.ZONE_CONNECTION_THT_THERMAL)
    z.SetThermalReliefGap(pcb.FromMM(.25));z.SetThermalReliefSpokeWidth(pcb.FromMM(.3))
    poly=z.Outline();poly.NewOutline()
    for x,y in [(50.5,50.5),(49.5+WIDTH,50.5),(49.5+WIDTH,49.5+HEIGHT),(50.5,49.5+HEIGHT)]:poly.Append(round(x*1e6),round(y*1e6))
    b.Add(z)
    restore_through_hole_mask(b)
    pcb.SaveBoard(str(TARGET),b)
    pro=json.loads((ROOT/'KINO_D4_Carrier_A0_Routed.kicad_pro').read_text())
    pro['meta']['filename']=NAME+'.kicad_pro'
    (ROOT/(NAME+'.kicad_pro')).write_text(json.dumps(pro,indent=2)+'\n')
    (ROOT/'design/placement-a02.json').write_text(json.dumps(moves,indent=2)+'\n')
    print('A0.2 placement:',len(placed),'footprints')

if __name__=='__main__':prepare()
