"""Generate editable native KiCad A0 capture and placement from circuit.py.

No automatic fabrication output or claim of electrical completion is made.
Run using KiCad 10's bundled python.exe (pcbnew must be importable).
"""
import csv
import json
import math
from pathlib import Path
import os,sys
_WIN=Path('C:/Program Files/KiCad/10.0/share/kicad')
_MAC=Path.home()/'Applications/KiCad/KiCad.app/Contents/SharedSupport'
_KS=_WIN if _WIN.exists() else _MAC if _MAC.exists() else Path('/Applications/KiCad/KiCad.app/Contents/SharedSupport')
STOCK_FP=_KS/'footprints'; STOCK_SYM=_KS/'symbols'   # stock KiCad libraries, Windows or macOS install
from uuid import uuid5, NAMESPACE_URL
import pcbnew as pcb
from circuit import PARTS, SHEETS
from mechanical import WIDTH, HEIGHT, INSERT_CENTRES, FASTENER_KEEP_OUT, pack

ROOT=Path(__file__).resolve().parent.parent
NAME='KINO_D4_Carrier_A0'
FP_LIB=STOCK_FP
DATE='2026-09-30'
ROOT_ID=str(uuid5(NAMESPACE_URL,NAME))

# ERC supply declarations for connector sources and supplies passing through
# passive parts. These describe intended sources, not electrical qualification.
SUPPLIES = {
    'GND':'J1100 pin 3 pack return (gauge shunt is high side since 0.1.8)',
    'PACK_FUSED':'J1100 pin 1 pack positive through F1100',
    'MB_3V3':'U1201 switching output through L1201',
    'USB_VBUS':'J1000 USB source',
    'CHG_VBUS':'J1000 through PD input FETs Q1000/Q1001',
    'SYS_5V':'U1200 through main disconnect Q1200/Q1201',
    'RTC_BACKUP':'J800 external primary backup cell',
    **{f'CAM{i}_SHUNT_OUT':f'SYS_5V through RS{100+i*100}' for i in range(1,5)},
    **{f'CAM{i}_3V3':f'J{100+i*100} XIAO onboard regulator' for i in range(1,5)},
}

def uid(s):return str(uuid5(NAMESPACE_URL,NAME+'/'+s))
def q(s):return json.dumps(str(s),ensure_ascii=False)
def pt(x,y):return pcb.VECTOR2I(round(x*1e6),round(y*1e6))

def supply_symbol(full=True):
    name='KINO_A0:SUPPLY_DRIVE' if full else 'SUPPLY_DRIVE'
    return f'''(symbol {q(name)} (power) (pin_numbers hide) (pin_names (offset 0) hide) (in_bom no) (on_board no)
    (property "Reference" "#FLG" (at 0 0 0) (effects (font (size 1 1)) (hide yes)))
    (property "Value" "SUPPLY_DRIVE" (at 0 5.08 0) (effects (font (size 1 1)) (hide yes)))
    (symbol "SUPPLY_DRIVE_0_1" (polyline (pts (xy 0 0) (xy 0 2.54) (xy -1.27 3.81) (xy 0 5.08) (xy 1.27 3.81) (xy 0 2.54)) (stroke (width 0.15) (type default)) (fill (type none))))
    (symbol "SUPPLY_DRIVE_1_1" (pin power_out line (at 0 0 90) (length 0) (name "SUPPLY" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1)))))))'''
def text(s,x,y,size=1.27):
    return f'(text {q(s)} (at {x} {y} 0) (effects (font (size {size} {size})) (justify left top)) (uuid {q(uid(str(x)+str(y)+s))}))'

def geometry(p):
    pinlist=list(p['pins'])
    if len(pinlist)==2 and p['ref'][0] in 'RCLDF':
        return {'1':(-7.62,0,0),'2':(7.62,0,180)},7.62
    if len(pinlist)==1:return {pinlist[0]:(-7.62,0,0)},5.08
    rows=math.ceil(len(pinlist)/2)
    h=max(5.08,(rows+1)*1.27)
    loc={}
    for i,num in enumerate(pinlist):
        right=i>=rows
        j=i-rows if right else i
        loc[num]=(17.78 if right else -17.78,h-2.54-j*2.54,180 if right else 0)
    return loc,h

def libsym(p,full=True):
    loc,h=geometry(p)
    name=p['ref']
    libname='KINO_A0:'+name if full else name
    g=[]
    if len(p['pins'])==1:
        g.append('(circle (center -3.81 0) (radius 1.27) (stroke (width 0.25) (type default)) (fill (type none)))')
    elif len(p['pins'])==2 and p['ref'][0] in 'RCLDF':
        # Standard rectangle resistor / two-plate capacitor; other passives boxed and labelled.
        if p['ref'].startswith('C'):
            for x in (-1,1):g.append(f'(polyline (pts (xy {x} -2.54) (xy {x} 2.54)) (stroke (width 0.25) (type default)) (fill (type none)))')
            for a,b in [(-5.08,-1),(1,5.08)]:g.append(f'(polyline (pts (xy {a} 0) (xy {b} 0)) (stroke (width 0.15) (type default)) (fill (type none)))')
        elif p['ref'].startswith('D'):
            g.append('(polyline (pts (xy 1.27 -2.54) (xy -1.27 0) (xy 1.27 2.54) (xy 1.27 -2.54)) (stroke (width 0.25) (type default)) (fill (type none)))')
            for a,b in [((-1.27,-2.54),(-1.27,2.54)),((-5.08,0),(-1.27,0)),((1.27,0),(5.08,0))]:
                g.append(f'(polyline (pts (xy {a[0]} {a[1]}) (xy {b[0]} {b[1]})) (stroke (width 0.25) (type default)) (fill (type none)))')
        else:g.append('(rectangle (start -5.08 1.27) (end 5.08 -1.27) (stroke (width 0.25) (type default)) (fill (type background)))')
    else:g.append(f'(rectangle (start -15.24 {h}) (end 15.24 {-h}) (stroke (width 0.25) (type default)) (fill (type background)))')
    ps=[]
    for num,(x,y,angle) in loc.items():
        pin=p['pins'][num]
        ps.append(f'(pin {pin["type"]} line (at {x} {y} {angle}) (length 2.54) (name {q(pin["name"])} (effects (font (size 0.9 0.9)))) (number {q(num)} (effects (font (size 0.9 0.9)))))')
    return f'''(symbol {q(libname)} (pin_names (offset 0.508)) (in_bom yes) (on_board yes)
      (property "Reference" {q(name.rstrip('0123456789'))} (at 0 {h+3.81} 0) (effects (font (size 1.27 1.27))))
      (property "Value" {q(p['value'])} (at 0 {h+1.27} 0) (effects (font (size 1.0 1.0))))
      (property "Footprint" {q(p['footprint'])} (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Datasheet" {q(p['source'])} (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol {q(name+'_0_1')} {''.join(g)})
      (symbol {q(name+'_1_1')} {''.join(ps)}))'''

def sch_header(id,title,paper='A2'):
    return f'''(kicad_sch (version 20250114) (generator "eeschema") (generator_version "10.0")
    (uuid {q(id)}) (paper {q(paper)})
    (title_block (title {q(title)}) (date {q(DATE)}) (rev "A0-DRAFT")
      (company "KINO") (comment 1 "ENGINEERING DRAFT - NOT FOR FABRICATION")))'''

def schematics():
    symbols=[]
    for page,(key,info) in enumerate(SHEETS.items(),2):
        parts=[p for p in PARTS if p['sheet']==key and not p['ref'].startswith('H')]
        sid=uid(key)
        paper='A1' if key=='11_charger' else 'A2'
        body=[sch_header(sid,info['title'],paper)[:-1], '(lib_symbols '+''.join(libsym(p) for p in parts)+')',
              text(info['title'],15,12,2.5),text(info['note'],15,20,1.05)]
        ypos=48.26
        for start in range(0,len(parts),4):
            batch=parts[start:start+4]
            maxh=max(geometry(p)[1] for p in batch)
            cy=ypos+maxh
            for col,p in enumerate(batch):
                x=73.66+col*134.62
                loc,h=geometry(p)
                ref=p['ref'];pid=uid(ref)
                body.append(f'''(symbol (lib_id {q('KINO_A0:'+ref)}) (at {x} {cy} 0) (unit 1)
                  (in_bom yes) (on_board yes) (dnp {'yes' if p['dnp'] else 'no'}) (uuid {q(pid)})
                  (property "Reference" {q(ref)} (at {x} {cy-h-5} 0) (effects (font (size 1.27 1.27))))
                  (property "Value" {q(p['value'])} (at {x} {cy-h-2.5} 0) (effects (font (size 1.0 1.0))))
                  (property "Footprint" {q(p['footprint'])} (at {x} {cy} 0) (effects (font (size 1 1)) (hide yes)))
                  (property "Datasheet" {q(p['source'])} (at {x} {cy} 0) (effects (font (size 1 1)) (hide yes)))
                  (property "Design note" {q(p['note'])} (at {x} {cy} 0) (effects (font (size 1 1)) (hide yes)))
                  {''.join(f'(pin {q(n)} (uuid {q(uid(ref+"/"+n))}))' for n in p['pins'])}
                  (instances (project {q(NAME)} (path {q('/'+ROOT_ID+'/'+sid)} (reference {q(ref)}) (unit 1)))))''')
                for num,(px,py,angle) in loc.items():
                    a,b=x+px,cy-py
                    net=p['nets'][num]
                    if net is None:
                        body.append(f'(no_connect (at {a} {b}) (uuid {q(uid(ref+num+"nc"))}))')
                        continue
                    end=a+(-5.08 if px<0 else 5.08)
                    body.append(f'(wire (pts (xy {a} {b}) (xy {end} {b})) (stroke (width 0) (type default)) (uuid {q(uid(ref+num+"wire"))}))')
                    rot=0 if px<0 else 180
                    body.append(f'''(global_label {q(net)} (shape bidirectional) (at {end} {b} {rot})
                    (effects (font (size 0.9 0.9)) (justify {'right' if px<0 else 'left'})) (uuid {q(uid(ref+num+'label'))})
                    (property "Intersheetrefs" "${{INTERSHEET_REFS}}" (at {end} {b} {rot}) (effects (font (size 0.8 0.8)) (hide yes))))''')
            ypos=round(cy+maxh+20.32,6)
        assert ypos<(570 if paper=='A1' else 395),(key,ypos)
        body+=['(embedded_fonts no))']
        (ROOT/(key+'.kicad_sch')).write_text('\n'.join(body),encoding='utf-8')
        symbols.extend(libsym(p,False) for p in parts)
    root=[sch_header(ROOT_ID,'KINO D4 - four-XIAO carrier A0')[:-1],'(lib_symbols '+supply_symbol()+')',
          text('KINO D4 / CARRIER A0',20,15,3),
          text('Component-level draft + initial placement. No routed copper. NOT FOR FABRICATION.',20,25,1.5),
          text('Battery / NTC / USB coexistence / regulator compensation / final footprints and mechanical fit remain release gates.',20,32,1.15)]
    for i,(key,info) in enumerate(SHEETS.items()):
        x,y=25+(i%3)*180,55+(i//3)*57
        root.append(f'''(sheet (at {x} {y}) (size 158 34) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
        (stroke (width 0.25) (type solid)) (fill (color 0 0 0 0)) (uuid {q(uid(key))})
        (property "Sheetname" {q(info['title'])} (at {x} {y-1} 0) (effects (font (size 1.2 1.2)) (justify left bottom)))
        (property "Sheetfile" {q(key+'.kicad_sch')} (at {x} {y+35} 0) (effects (font (size 1 1)) (justify left top)))
        (instances (project {q(NAME)} (path {q('/'+ROOT_ID)} (page {q(i+2)})))))''')
    root.append(text('ERC supply declarations: intended connector/regulator sources; see each symbol source note. Not a power-validation result.',20,332,1.1))
    for i,(net,source) in enumerate(SUPPLIES.items()):
        x,y=30.48+(i%5)*109.22,347.98+(i//5)*17.78
        ref=f'#FLG{i+1:03d}'
        root.append(f'''(symbol (lib_id "KINO_A0:SUPPLY_DRIVE") (at {x} {y} 0) (unit 1) (in_bom no) (on_board no) (dnp no) (uuid {q(uid(ref))})
        (property "Reference" {q(ref)} (at {x} {y} 0) (effects (font (size 1 1)) (hide yes)))
        (property "Value" "SUPPLY_DRIVE" (at {x} {y} 0) (effects (font (size 1 1)) (hide yes)))
        (property "Source declaration" {q(source)} (at {x} {y} 0) (effects (font (size 1 1)) (hide yes)))
        (pin "1" (uuid {q(uid(ref+'pin'))}))
        (instances (project {q(NAME)} (path {q('/'+ROOT_ID)} (reference {q(ref)}) (unit 1)))))
        (global_label {q(net)} (shape bidirectional) (at {x} {y} 180) (effects (font (size 1 1)) (justify left)) (uuid {q(uid(ref+'label'))}))''')
    symbols.append(supply_symbol(False))
    root+=['(embedded_fonts no))']
    (ROOT/(NAME+'.kicad_sch')).write_text('\n'.join(root),encoding='utf-8')
    (ROOT/'KINO_A0.kicad_sym').write_text('(kicad_symbol_lib (version 20250114) (generator "kicad_symbol_editor")\n'+'\n'.join(symbols)+'\n)',encoding='utf-8')
    (ROOT/'sym-lib-table').write_text('(sym_lib_table (version 7) (lib (name "KINO_A0") (type "KiCad") (uri "${KIPRJMOD}/KINO_A0.kicad_sym") (options "") (descr "KINO pin tables; draft")))\n')

def line(fp,a,b,layer=pcb.F_SilkS,w=.12):
    s=pcb.PCB_SHAPE(fp);s.SetShape(pcb.SHAPE_T_SEGMENT);s.SetStart(pt(*a));s.SetEnd(pt(*b));s.SetWidth(round(w*1e6));s.SetLayer(layer);fp.Add(s)
def rect(fp,x1,y1,x2,y2,layer):
    for a,b in [((x1,y1),(x2,y1)),((x2,y1),(x2,y2)),((x2,y2),(x1,y2)),((x1,y2),(x1,y1))]:line(fp,a,b,layer)
def pad(fp,num,x,y,w,h,drill=None):
    p=pcb.PAD(fp);p.SetNumber(str(num));p.SetPosition(pt(x,y));p.SetSize(pt(w,h));p.SetShape(pcb.PAD_SHAPE_RECT)
    if drill:
        p.SetAttribute(pcb.PAD_ATTRIB_PTH);p.SetDrillSize(pt(drill,drill));layers=pcb.LSET.AllCuMask();layers.AddLayer(pcb.F_Mask);layers.AddLayer(pcb.B_Mask);p.SetLayerSet(layers);p.SetShape(pcb.PAD_SHAPE_OVAL)
    else:
        p.SetAttribute(pcb.PAD_ATTRIB_SMD);layers=pcb.LSET()
        for layer in (pcb.F_Cu,pcb.F_Paste,pcb.F_Mask):layers.AddLayer(layer)
        p.SetLayerSet(layers)
    fp.Add(p)
def custom_footprints():
    dest=ROOT/'KINO_A0.pretty';dest.mkdir(exist_ok=True)
    fp=pcb.FOOTPRINT(None);fp.SetReference('REF**');fp.SetValue('XIAO_Socket_15.24mm')
    fp.SetAttributes(pcb.FP_THROUGH_HOLE)
    for i in range(7):pad(fp,i+1,-7.62,-7.62+i*2.54,1.8,1.8,1.0)
    for i in range(7):pad(fp,14-i,7.62,-7.62+i*2.54,1.8,1.8,1.0)
    rect(fp,-9.0,-10.5,9.0,10.5,pcb.F_Fab);rect(fp,-9.3,-10.8,9.3,10.8,pcb.F_CrtYd)
    line(fp,(-5,-10.5),(5,-10.5));line(fp,(-9,-8),(-9,-10.5));line(fp,(-9,-10.5),(-7,-10.5))
    fp.SetFPID(pcb.LIB_ID('KINO_A0',fp.GetValue()));pcb.PCB_IO_MGR.FindPlugin(pcb.PCB_IO_MGR.KICAD_SEXP).FootprintSave(str(dest),fp)
    # TI RQQ0011A p28, copper land pattern; segmented same-number rectangles form L pads.
    fp=pcb.FOOTPRINT(None);fp.SetReference('REF**');fp.SetValue('TPS61288_RQQ0011A_DRAFT');fp.SetAttributes(pcb.FP_SMD)
    pad(fp,1,-1.425,-.875,.575,.25);pad(fp,1,-1.25,-1.10,.225,.70)
    pad(fp,2,-1.425,-.375,.575,.25)
    pad(fp,3,-1.0875,.20,1.25,.40);pad(fp,3,-.65,.725,.40,1.45)
    pad(fp,4,0,.25,.40,1.00)
    pad(fp,5,1.0875,.20,1.25,.40);pad(fp,5,.65,.725,.40,1.45)
    pad(fp,6,1.425,-.375,.575,.25)
    pad(fp,7,1.425,-.875,.575,.25);pad(fp,7,1.25,-1.10,.225,.70)
    for num,x in [(8,.75),(9,.25),(10,-.25),(11,-.75)]:pad(fp,num,x,-1.175,.25,.55)
    rect(fp,-1.25,-1.5,1.25,1.5,pcb.F_Fab);rect(fp,-1.95,-1.75,1.95,1.75,pcb.F_CrtYd)
    fp.SetFPID(pcb.LIB_ID('KINO_A0',fp.GetValue()));pcb.PCB_IO_MGR.FindPlugin(pcb.PCB_IO_MGR.KICAD_SEXP).FootprintSave(str(dest),fp)
    fp=pcb.FOOTPRINT(None);fp.SetReference('REF**');fp.SetValue('Inductor_6.5x6.5_DRAFT');fp.SetAttributes(pcb.FP_SMD)
    pad(fp,1,-2.5,0,2.0,6.0);pad(fp,2,2.5,0,2.0,6.0)
    rect(fp,-3.25,-3.25,3.25,3.25,pcb.F_Fab);rect(fp,-3.75,-3.75,3.75,3.75,pcb.F_CrtYd)
    fp.SetFPID(pcb.LIB_ID('KINO_A0',fp.GetValue()));pcb.PCB_IO_MGR.FindPlugin(pcb.PCB_IO_MGR.KICAD_SEXP).FootprintSave(str(dest),fp)
    (ROOT/'fp-lib-table').write_text('(fp_lib_table (version 7) (lib (name "KINO_A0") (type "KiCad") (uri "${KIPRJMOD}/KINO_A0.pretty") (options "") (descr "Socket geometry and provisional power footprints")))\n')

def pcb_design():
    board=pcb.BOARD();board.SetCopperLayerCount(4)
    board.GetDesignSettings().SetBoardThickness(pcb.FromMM(1.6))
    nets={}
    for name in sorted({n for p in PARTS for n in p['nets'].values() if n}):
        nn=pcb.NETINFO_ITEM(board,name);board.Add(nn);nets[name]=nn
    loaded=[]
    for p in PARTS:
        lib,name=p['footprint'].split(':',1)
        path=ROOT/'KINO_A0.pretty' if lib=='KINO_A0' else FP_LIB/(lib+'.pretty')
        fp=pcb.FootprintLoad(str(path),name)
        if not fp:raise ValueError('Missing footprint '+p['footprint'])
        fp.SetReference(p['ref']);fp.SetValue(p['value']);fp.SetFPID(pcb.LIB_ID(lib,name))
        fp.SetUuid(pcb.KIID(uid(p['ref'])))
        fp.SetPath(pcb.KIID_PATH('/'+ROOT_ID+'/'+uid(p['sheet'])+'/'+uid(p['ref'])))
        fp.Value().SetVisible(False)
        fp.Reference().SetTextSize(pt(.8,.8));fp.Reference().SetTextThickness(pcb.FromMM(.12))
        fp.Reference().SetLayer(pcb.F_Fab)
        if p['dnp']:fp.SetAttributes(fp.GetAttributes()|pcb.FP_DNP)
        pads={a.GetNumber() for a in fp.Pads() if a.GetNumber() and a.GetNumber()!='MP'}
        if pads!=set(p['nets']):raise ValueError((p['ref'],pads,set(p['nets'])))
        for a in fp.Pads():
            net=p['nets'].get(a.GetNumber())
            if net:a.SetNet(nets[net])
        mask_layers=[(a,a.IsOnLayer(pcb.F_Mask),a.IsOnLayer(pcb.B_Mask)) for a in fp.Pads()
                     if a.GetAttribute() in (pcb.PAD_ATTRIB_PTH,pcb.PAD_ATTRIB_NPTH)]
        board.Add(fp);loaded.append((p,fp))
        # Explicitly preserve openings on through-hole pads. KiCad 10's
        # board attachment can otherwise drop wildcard mask layers loaded
        # from older community footprints.
        for a,front_mask,back_mask in mask_layers:
            layers=a.GetLayerSet()
            for layer,present in [(pcb.F_Mask,front_mask),(pcb.B_Mask,back_mask)]:
                if present:layers.AddLayer(layer)
                else:layers.RemoveLayer(layer)
            a.SetLayerSet(layers)
    # Feasibility placement constrained to the P4 envelope and four inner inserts.
    # Full XIAO module courtyards stay clear; no parts are hidden under modules.
    fixed=[];pool=[];margin=.6
    for p,fp in loaded:
        if p['at']:
            fp.SetPosition(pt(50+p['at'][0],50+p['at'][1]))
            r=fp.GetBoundingBox(False,False)
            if p['ref'].startswith('H'):
                x1,y1=p['at'];d=FASTENER_KEEP_OUT
                fixed.append((x1-d/2,y1-d/2,d,d))
            else:fixed.append((r.GetX()/1e6-50-.3,r.GetY()/1e6-50-.3,r.GetWidth()/1e6+.6,r.GetHeight()/1e6+.6))
        else:
            r=fp.GetBoundingBox(False,False)
            pool.append((p['ref'],r.GetWidth()/1e6+margin,r.GetHeight()/1e6+margin))
    packed=pack(pool,fixed);placement=[]
    for p,fp in loaded:
        if p['at']:continue
        x,y,angle=packed[p['ref']]
        fp.SetOrientationDegrees(angle)
        r=fp.GetBoundingBox(False,False)
        fp.SetPosition(pt(50+x-r.GetX()/1e6+margin/2,50+y-r.GetY()/1e6+margin/2))
        fp.Reference().SetPosition(pt(50+x+r.GetWidth()/2e6,50+y-.15))
        placement.append({'reference':p['ref'],'x_mm':round(fp.GetPosition().x/1e6-50,3),'y_mm':round(fp.GetPosition().y/1e6-50,3),'rotation_deg':angle})
    for p,fp in loaded:
        if p['ref'] in ('J200','J300','J400','J500'):
            fp.Reference().SetLayer(pcb.F_SilkS);fp.Reference().SetPosition(fp.GetPosition());fp.Reference().SetTextSize(pt(1.0,1.0))
    height=HEIGHT; width=WIDTH
    (ROOT/'design/placement.json').write_text(json.dumps(placement,indent=2))
    for a,b in [((50,50),(50+width,50)),((50+width,50),(50+width,50+height)),((50+width,50+height),(50,50+height)),((50,50+height),(50,50))]:line(board,a,b,pcb.Edge_Cuts,.05)
    # Revision text lives on a user drawing layer while dense placement is reviewed.
    for label,x1,y1,size in [('KINO D4 CARRIER A0 - UNROUTED',52,50+height+3,1.3),('P4 envelope 117.01 x 69.41 / inner M2 inserts 61.9 x 54.8',52,50+height+6,1.0)]:
        t=pcb.PCB_TEXT(board);t.SetText(label);t.SetPosition(pt(x1,y1));t.SetTextSize(pt(size,size));t.SetTextThickness(pcb.FromMM(.15));t.SetLayer(pcb.Dwgs_User);t.SetHorizJustify(pcb.GR_TEXT_H_ALIGN_LEFT);board.Add(t)
    for x1,y1 in INSERT_CENTRES:
        circle=pcb.PCB_SHAPE(board);circle.SetShape(pcb.SHAPE_T_CIRCLE);circle.SetCenter(pt(50+x1,50+y1));circle.SetEnd(pt(50+x1+FASTENER_KEEP_OUT/2,50+y1));circle.SetWidth(pcb.FromMM(.1));circle.SetLayer(pcb.Dwgs_User);board.Add(circle)
    pcb.SaveBoard(str(ROOT/(NAME+'.kicad_pcb')),board)
    return {'width_mm':width,'height_mm':height,'footprints':len(loaded),'nets':len(nets),'tracks':0,'status':'UNROUTED_ENGINEERING_DRAFT'}

def outputs(summary,status_filename='BUILD_STATUS.json'):
    out=ROOT/'outputs';out.mkdir(exist_ok=True)
    (ROOT/'design/parts.json').write_text(json.dumps(PARTS,indent=2),encoding='utf-8')
    with (out/'BOM-DRAFT.csv').open('w',newline='',encoding='utf-8') as f:
        w=csv.writer(f);w.writerow(['Reference','Value','MPN_candidate','Footprint','DNP','Status','Design_note','Source'])
        for p in PARTS:w.writerow([p['ref'],p['value'],p['mpn'],p['footprint'],p['dnp'],'ENGINEERING_DRAFT',p['note'],p['source']])
    with (out/'PIN_NET_MATRIX.csv').open('w',newline='',encoding='utf-8') as f:
        w=csv.writer(f);w.writerow(['Reference','Pin','Pin_name','Net','Sheet'])
        for p in PARTS:
            for n,v in p['nets'].items():w.writerow([p['ref'],n,p['pins'][n]['name'],v or 'NC',p['sheet']])
    summary.update({'date':DATE,'components':len(PARTS),'sheets':len(SHEETS)+1,'fabrication_released':False,'erc_passed':False,'drc_passed':False})
    (out/status_filename).write_text(json.dumps(summary,indent=2)+'\n')
    pro={'meta':{'filename':NAME+'.kicad_pro','version':1},'board':{'design_settings':{'rules':{'min_clearance':0.2,'min_track_width':0.2,'min_via_diameter':0.6,'min_through_hole_diameter':0.3}}},'net_settings':{'classes':[{'name':'Default','clearance':0.2,'track_width':0.25,'via_diameter':0.6,'via_drill':0.3,'microvia_diameter':0.3,'microvia_drill':0.1,'diff_pair_width':0.2,'diff_pair_gap':0.25,'diff_pair_via_gap':0.25,'priority':2147483647}],'meta':{'version':4}},'schematic':{'drawing':{'default_line_thickness':6},'legacy_lib_dir':'','legacy_lib_list':[]}}
    if not (ROOT/(NAME+'.kicad_pro')).exists():(ROOT/(NAME+'.kicad_pro')).write_text(json.dumps(pro,indent=2))
    print(json.dumps(summary))

if __name__=='__main__':
    ROOT.mkdir(exist_ok=True)
    schematics();custom_footprints();outputs(pcb_design())

