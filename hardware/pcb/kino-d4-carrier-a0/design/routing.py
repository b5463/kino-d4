"""Two-face placement and local Specctra routing preparation for A0.

Reads the preserved original PCB. Writes the separate Routed engineering review
board so an open KiCad editor cannot overwrite the new routing on saving A0.
Run with KiCad Python. This does not qualify power electronics or release CAM.
"""
import json, math, sys, re
from functools import lru_cache
from pathlib import Path
import pcbnew as pcb
from mechanical import WIDTH, HEIGHT, INSERT_CENTRES, CAMERA_CENTRES, LENS_OFFSET_Y

ROOT=Path(__file__).resolve().parent.parent
CACHE=ROOT.parents[2]/'.cache/carrier-routing'
NAME='KINO_D4_Carrier_A0_Routed'
TARGET=ROOT/(NAME+'.kicad_pcb')
def pt(x,y):return pcb.VECTOR2I(round(x*1e6),round(y*1e6))
def mm(v):return v/1e6
def pos(obj):return (mm(obj.GetPosition().x)-50,mm(obj.GetPosition().y)-50)
def rect(fp,pad=.12):
    r=fp.GetBoundingBox(False,False)
    return (mm(r.GetX())-50-pad,mm(r.GetY())-50-pad,mm(r.GetRight())-50+pad,mm(r.GetBottom())-50+pad)
def intersects(a,b):return a[0]<b[2]-1e-5 and b[0]<a[2]-1e-5 and a[1]<b[3]-1e-5 and b[1]<a[3]-1e-5
def restore_through_hole_mask(board):
    originals={}
    for f in board.GetFootprints():
        if not any(p.GetAttribute() in (pcb.PAD_ATTRIB_PTH,pcb.PAD_ATTRIB_NPTH) for p in f.Pads()):continue
        lib=str(f.GetFPID().GetLibNickname());name=str(f.GetFPID().GetLibItemName())
        folder=ROOT/'KINO_A0.pretty' if lib=='KINO_A0' else Path('C:/Program Files/KiCad/10.0/share/kicad/footprints')/(lib+'.pretty')
        key=(lib,name)
        if key not in originals:originals[key]=pcb.FootprintLoad(str(folder),name)
        original=originals[key]
        for p in f.Pads():
            if p.GetAttribute() in (pcb.PAD_ATTRIB_PTH,pcb.PAD_ATTRIB_NPTH):
                matches=[q for q in original.Pads() if q.GetNumber()==p.GetNumber() and q.GetAttribute()==p.GetAttribute() and q.GetDrillSize()==p.GetDrillSize()]
                assert matches,(f.GetReference(),p.GetNumber())
                q=matches[0];layers=p.GetLayerSet()
                for mask in (pcb.F_Mask,pcb.B_Mask):
                    source=(pcb.B_Mask if mask==pcb.F_Mask else pcb.F_Mask) if f.IsFlipped() else mask
                    if q.IsOnLayer(source):layers.AddLayer(mask)
                    else:layers.RemoveLayer(mask)
                p.SetLayerSet(layers)
@lru_cache(None)
def offsets(limit):
    return sorted((ix*ix+iy*iy,ix,iy) for ix in range(-limit,limit+1) for iy in range(-limit,limit+1))

def prepare():
    board=pcb.LoadBoard(str(ROOT/'KINO_D4_Carrier_A0.kicad_pcb'))
    assert not list(board.GetTracks()),'Original capture has changed: preserve and review manual routing first.'
    fps={f.GetReference():f for f in board.GetFootprints()}
    parts={p['ref']:p for p in json.loads((ROOT/'design/parts.json').read_text())}
    front={r for r in fps if r.startswith(('J','H'))} | {'U800','C800','C801','U801','C802','R800','U802','C803','D1300','D1301'}
    placed={};occupied={'F':[],'B':[]};local={}
    for ref,f in fps.items():
        f.SetOrientationDegrees(0);f.SetPosition(pt(50,50))
        if ref not in front:f.Flip(f.GetPosition(),pcb.FLIP_DIRECTION_LEFT_RIGHT)
        f.SetOrientationDegrees(0)
        f.Reference().SetLayer(pcb.F_Fab if ref in front else pcb.B_Fab)
        f.Reference().SetVisible(True);f.Value().SetVisible(False)
        local[ref]={}
        for a in (0,90,180,270):
            f.SetOrientationDegrees(a);local[ref][a]=rect(f)
        f.SetOrientationDegrees(0)
    def side(ref):return 'F' if ref in front else 'B'
    def setat(ref,x,y,a=0,force=False):
        f=fps[ref];f.SetOrientationDegrees(a);f.SetPosition(pt(x+50,y+50))
        r=rect(f)
        if not force:
            assert r[0]>.45 and r[1]>.45 and r[2]<WIDTH-.45 and r[3]<HEIGHT-.45,(ref,'outside',r)
            bad=[other for other,box in occupied[side(ref)] if intersects(r,box)]
            assert not bad,(ref,'collision',bad,r)
        placed[ref]=(x,y,a);occupied[side(ref)].append((ref,r))
        # Through-hole tails require rear component clearance even when the
        # front module's body is clear of all rear components.
        if ref in front:
            for p in f.Pads():
                if p.GetAttribute() in (pcb.PAD_ATTRIB_PTH,pcb.PAD_ATTRIB_NPTH):
                    b=p.GetBoundingBox();gap=.4
                    occupied['B'].append((ref+'.'+p.GetNumber(),(mm(b.GetX())-50-gap,mm(b.GetY())-50-gap,mm(b.GetRight())-50+gap,mm(b.GetBottom())-50+gap)))
        f.Reference().SetPosition(pt(x+50,y+50))
    # The same 7 mm square fastener exclusion applies on BOTH component faces.
    for i,(x,y) in enumerate(INSERT_CENTRES,1):
        setat(f'H{i}',x,y,force=True)
        for s in occupied:occupied[s].append((f'H{i} clearance',(x-3.5,y-3.5,x+3.5,y+3.5)))
    setat('J100',6,18,force=True)
    for i,(x,y) in enumerate(CAMERA_CENTRES):setat(f'J{200+100*i}',x,y)
    setat('J1000',109,HEIGHT-4.2,force=True)
    setat('J1100',88,58)
    # Breakouts are parallel to the optical row, rather than scattered around
    # the power converters. Camera identities run left-to-right in PCB view.
    for i,(x,y) in enumerate(CAMERA_CENTRES):
        base=200+100*i
        setat(f'J{base+1}',x-5.08,18,90)
        setat(f'JP{base}',x+5,48,90)

    # All major switching loops are on the rear; no rear inductor is placed
    # between a socket body and the front PCB surface.
    anchors={
      'U1100':(90,45.5,180),'L1100':(90,51.3,0),
      'U1200':(60,55,0),'L1200':(60,49.4,0),
      'Q1200':(59,64,0),'Q1201':(69,64,180),
      'U1201':(47,56,0),'L1201':(42.5,55.8,0),
      'U1000':(108,55,0),'Q1000':(109,44,90),'Q1001':(109,35,270),
      'U701':(102.8,53,0),'RS700':(103,59,90),'F1100':(97,62.5,0),
      'U600':(47.5,30,0),'U601':(69.5,30,0),'U700':(91.5,30,0),
      'U100':(19,48,0),'U1300':(34,56,0),'U900':(108,24,0),'U901':(22,15,0),
      'U800':(58.5,55,0),'U801':(43,57,0),'U802':(29,56,0),
    }
    # Local nearest-space search uses actual rotated courtyard bounds. Power
    # loop IC/inductor anchors are exact; secondary anchors may slide slightly.
    def near(ref,x,y,angles=(0,90,180,270),limit=140,targets=()):
        f=fps[ref];best=None
        for a in angles:
            l,t,r,b=local[ref][a]
            for d2,ix,iy in offsets(limit):
                d=d2*.0625
                if best and d>best[0]:break
                xx=round(x+ix*.25,5)
                if xx+l<.6 or xx+r>WIDTH-.6:continue
                yy=round(y+iy*.25,5)
                if yy+t<.6 or yy+b>HEIGHT-.6:continue
                bb=(xx+l,yy+t,xx+r,yy+b)
                if any(intersects(bb,box) for _,box in occupied[side(ref)]):continue
                score=d
                # Orientation tie-break keeps each decoupling supply pad
                # closest to the associated IC supply pad.
                if targets:
                    f.SetOrientationDegrees(a);f.SetPosition(pt(50+xx,50+yy))
                    score+=sum(min((pos(p)[0]-tx)**2+(pos(p)[1]-ty)**2 for p in f.Pads() if p.GetNetname()==net)*.15 for net,tx,ty in targets)
                if best is None or score<best[0]:best=(score,xx,yy,a)
        if best is None:raise ValueError(('No placement',ref,x,y))
        setat(ref,*best[1:])
    for ref,(x,y,a) in anchors.items():near(ref,x,y,(a,),limit=25)
    for i,(x,y) in enumerate(CAMERA_CENTRES):
        base=200+100*i
        # Signal buffers below each XIAO; supply switches near its 5V entry.
        near(f'U{base}',x,39,(0,),limit=25)
        near(f'U{base+1}',x+3,25,(0,),limit=25)
        near(f'RS{base}',x+3,20,(0,90),limit=25)
        near(f'D{base}',x+3,30,(0,90),limit=25)

    # Essential local capacitors and compensation first, bulk capacitors next,
    # then slow controls and connectors. High-fanout rails are never used as
    # the sole association for choosing an unrelated IC.
    owners={'C100':'U100','C600':'U600','C601':'U600','C602':'U601',
      'C700':'U700','C701':'U700','C702':'U701','C703':'U701',
      'C800':'U800','C801':'U800','C802':'U801','C803':'U802',
      'C900':'U900','C901':'U900','C902':'U900','C905':'U901',
      'C1000':'U1000','C1001':'U1000','C1002':'U1000',
      'C1300':'U1300','C1301':'U1300','C1212':'U1201','C1213':'L1201'}
    for i in range(4):
        base=200+100*i
        owners.update({f'C{base}':f'U{base}',f'C{base+1}':f'U{base}',f'C{base+2}':f'U{base+1}',f'C{base+3}':f'U{base+1}',f'C{base+4}':f'U{base+1}'})
    for i in range(1100,1120):owners[f'C{i}']='U1100'
    for i in range(1200,1212):owners[f'C{i}']='U1200'
    for r in ('R1200','R1201','R1202'):owners[r]='U1200'
    # Prevent a large, distant bulk capacitor from taking the bootstrap or
    # feedback part's position.
    first=['C1102','C1103','C1101','C1203','C1202','R1200','R1201','R1202','C1200','C1201','C1205']
    rest=sorted((r for r in owners if r in fps and r not in placed and r not in first),key=lambda r: (not parts[r]['value'].startswith('100n'),r))
    def associated(ref,owner):
        f=fps[owner];nets=set(parts[ref]['nets'].values())-{'GND',None}
        pads=[p for p in f.Pads() if p.GetNetname() in nets]
        targets=[(p.GetNetname(),*pos(p)) for p in pads]
        x,y=pos(f)
        if pads:
            x=sum(pos(p)[0] for p in pads)/len(pads);y=sum(pos(p)[1] for p in pads)/len(pads)
        near(ref,x,y,limit=65,targets=targets)
    for ref in first+rest:
        if ref not in placed:associated(ref,owners[ref])
    groupanchors={'01_p4':(19,48),'06_control':(48,35),'07_monitoring':(90,35),'08_sensors':(50,56),'09_controls':(109,20),'10_usb_pd':(108,52),'11_charger':(90,47),'12_boost':(59,56),'13_power_button':(34,58)}
    for i,(x,y) in enumerate(CAMERA_CENTRES):groupanchors[f'0{i+2}_camera{i+1}']=(x,31)
    remaining=[r for r in fps if r not in placed]
    # Larger external connectors must have access at edges; then place the
    # remaining passive networks by their already placed signal neighbours.
    remaining.sort(key=lambda r:(0 if r.startswith('J') else 1,-(local[r][0][2]-local[r][0][0])*(local[r][0][3]-local[r][0][1]),r))
    special={'J101':(4,5),'J102':(36,62),'J800':(44,64),'J900':(110,8),'J901':(110,18),'J902':(7,61),'J903':(7,7),'J904':(98,7),'J1300':(26,63),'JP1200':(7,57)}
    highfan={'GND','MB_3V3','SYS_5V','I2C_SDA','I2C_SCL','SYS_RAW','BAT_PROTECTED','BOOST_5V'}
    for ref in remaining:
        x,y=groupanchors[parts[ref]['sheet']]
        target=[]
        if ref in special:x,y=special[ref]
        elif not ref.startswith('J'):
            nn=set(parts[ref]['nets'].values())-highfan-{None}
            for r in placed:
                if r.startswith('H') or side(r)!=side(ref):continue
                for p in fps[r].Pads():
                    if p.GetNetname() in nn:target.append((p.GetNetname(),*pos(p)))
            if target:x=sum(t[1] for t in target)/len(target);y=sum(t[2] for t in target)/len(target)
        near(ref,x,y,limit=190,targets=target)

    # Mounting keepouts have physical and copper meaning, on every layer.
    for x,y in INSERT_CENTRES:
        z=pcb.ZONE(board);z.SetIsRuleArea(True);z.SetLayerSet(pcb.LSET.AllCuMask())
        z.SetDoNotAllowTracks(True);z.SetDoNotAllowVias(True);z.SetDoNotAllowZoneFills(True)
        # The mounting footprint itself is allowed. Separate geometry checks
        # reject every OTHER footprint in the screw square on either face.
        z.SetDoNotAllowPads(False);z.SetDoNotAllowFootprints(False)
        poly=z.Outline();poly.NewOutline()
        for dx,dy in [(-3.5,-3.5),(3.5,-3.5),(3.5,3.5),(-3.5,3.5)]:poly.Append(round((50+x+dx)*1e6),round((50+y+dy)*1e6))
        board.Add(z)
    for d in board.GetDrawings():
        if isinstance(d,pcb.PCB_TEXT) and 'UNROUTED' in d.GetText():d.SetText('KINO D4 A0 / TWO-FACE ROUTING REVIEW / NOT FOR FABRICATION')
    def line(a,b,layer=pcb.Dwgs_User,w=.1):
        d=pcb.PCB_SHAPE(board);d.SetShape(pcb.SHAPE_T_SEGMENT);d.SetStart(pt(50+a[0],50+a[1]));d.SetEnd(pt(50+b[0],50+b[1]));d.SetLayer(layer);d.SetWidth(pcb.FromMM(w));board.Add(d)
    for i,(x,y) in enumerate(CAMERA_CENTRES,1):
        lensy=y+LENS_OFFSET_Y
        line((x-2,lensy),(x+2,lensy));line((x,lensy-2),(x,lensy+2))
        f=fps[f'J{100+i*100}'];f.Reference().SetLayer(pcb.F_Fab)
        f.Reference().SetText(f'J{100+i*100}')
        label=pcb.PCB_TEXT(board);label.SetText(f'CAM {i}');label.SetPosition(pt(x+50,y+50));label.SetTextSize(pt(1,1));label.SetTextThickness(pcb.FromMM(.15));label.SetLayer(pcb.F_SilkS);board.Add(label)
    line((CAMERA_CENTRES[0][0],HEIGHT/2+LENS_OFFSET_Y),(CAMERA_CENTRES[-1][0],HEIGHT/2+LENS_OFFSET_Y))
    restore_through_hole_mask(board)
    pcb.SaveBoard(str(TARGET),board)
    (ROOT/'design/placement-routed.json').write_text(json.dumps([{'reference':r,'x_mm':v[0],'y_mm':v[1],'rotation_deg':v[2],'side':side(r)} for r,v in placed.items()],indent=2)+'\n')
    setup_project(board)
    print(json.dumps({'front':len(front),'back':len(fps)-len(front),'placed':len(placed),'board':str(TARGET)}))

def setup_project(board):
    pro=json.loads((ROOT/'KINO_D4_Carrier_A0.kicad_pro').read_text())
    pro['meta']['filename']=NAME+'.kicad_pro'
    rules=pro['board']['design_settings']['rules']
    # Four-layer 1 oz capability target, with fine-pitch IC escape geometry.
    # USB alignment-hole copper clearance is checked against actual land pattern.
    rules.update(min_clearance=.125,min_track_width=.15,min_via_diameter=.6,min_through_hole_diameter=.2,min_hole_clearance=.2)
    default=pro['net_settings']['classes'][0]
    default.update(clearance=.15,track_width=.2,via_diameter=.6,via_drill=.3)
    pro['net_settings']['classes']=[default]
    power_nets=['USB_VBUS','CHG_VBUS','PD_COMMON_SOURCE','CHG_PMID','BAT_PROTECTED','PACK_PLUS','PACK_MINUS','SYS_RAW','BOOST_5V','MAIN_COMMON','SYS_5V','P4_5V_ISO','P4_5V']
    camera_nets=[f'CAM{i}_{n}' for i in range(1,5) for n in ['SHUNT_OUT','SW5V','5V_ISO','5V']]
    pro['net_settings']['netclass_patterns']=[]
    signal_nets=[n.GetNetname() for n in board.GetNetInfo().NetsByNetcode().values() if re.fullmatch(r'P4_(TX|RX)[1-4]|SYNC_MASTER|CAM[1-4]_(TX|RX|SYNC|RX_BUF|RX_RETURN|SYNC_BUF)',n.GetNetname())]
    for name,width,nets in [('MainPower',1.2,power_nets),('CameraPower',.6,camera_nets),('LogicPower',.3,['MB_3V3']),('Switching',.8,['BOOST_SW','CHG_SW1','CHG_SW2','BUCK_SW']),('CameraSignals',.2,signal_nets)]:
        c=dict(default);c.update(name=name,track_width=width,priority=len(pro['net_settings']['classes']))
        pro['net_settings']['classes'].append(c)
        pro['net_settings']['netclass_patterns'] += [{'netclass':name,'pattern':n} for n in nets]
    (ROOT/(NAME+'.kicad_pro')).write_text(json.dumps(pro,indent=2)+'\n')

def export():
    board=pcb.LoadBoard(str(TARGET))
    for z in board.Zones():
        if z.GetIsRuleArea():
            z.SetDoNotAllowPads(False);z.SetDoNotAllowFootprints(False);z.SetDoNotAllowZoneFills(True)
    for f in board.GetFootprints():
        if f.GetReference() in ('J200','J300','J400','J500'):f.Reference().SetLayer(pcb.F_Fab)
    setup_project(board)
    pcb.SaveBoard(str(TARGET),board)
    # Reload after writing net classes; the Specctra exporter reads these.
    board=pcb.LoadBoard(str(TARGET))
    if not any(not z.GetIsRuleArea() for z in board.Zones()):
        z=pcb.ZONE(board);z.SetLayer(pcb.In1_Cu);z.SetNet(board.FindNet('GND'))
        z.SetLocalClearance(pcb.FromMM(.2));z.SetMinThickness(pcb.FromMM(.2));z.SetPadConnection(pcb.ZONE_CONNECTION_FULL)
        poly=z.Outline();poly.NewOutline()
        for x,y in [(50.5,50.5),(49.5+WIDTH,50.5),(49.5+WIDTH,49.5+HEIGHT),(50.5,49.5+HEIGHT)]:poly.Append(round(x*1e6),round(y*1e6))
        board.Add(z)
        pcb.ZONE_FILLER(board).Fill(board.Zones())
    pcb.SaveBoard(str(TARGET),board)
    pcb.ExportSpecctraDSN(board,str(CACHE/'carrier.dsn'))
    dsn=(CACHE/'carrier.dsn').read_text()
    # Keep switching nodes on their component face. Do not allow a router to
    # solve these critical loops by sending them across the board on a plane.
    dsn=re.sub(r'(\(class Switching.*?\(circuit)',r'\1\n        (use_layer B.Cu)',dsn,flags=re.S)
    (CACHE/'carrier.dsn').write_text(dsn)
    print('Exported local routing exchange')

def import_route():
    board=pcb.LoadBoard(str(TARGET))
    assert pcb.ImportSpecctraSES(board,str(CACHE/'carrier.ses'))
    restore_through_hole_mask(board)
    pcb.SaveBoard(str(TARGET),board)
    print('Imported',len(list(board.GetTracks())),'track/via objects')

if __name__=='__main__':
    {'place':prepare,'export':export,'import':import_route}[sys.argv[1]]()
