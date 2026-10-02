"""Cross-check independently exported KiCad schematic, PCB and firmware pins.

Run with KiCad Python after regenerating NETLIST-DRAFT.xml and ERC/DRC reports.
These checks validate capture transfer and geometry, not circuit performance.
"""
import json
import hashlib
import re
import sys
from pathlib import Path
import xml.etree.ElementTree as ET
from collections import Counter
import pcbnew as pcb
from mechanical import WIDTH, HEIGHT, INSERT_CENTRES, FASTENER_KEEP_OUT, CAMERA_CENTRES, CAMERA_PITCH

ROOT=Path(__file__).resolve().parent.parent
REPO=ROOT.parents[2]
OUT=ROOT/'outputs'
tree=ET.parse(OUT/'NETLIST-DRAFT.xml').getroot()
a02='--a02' in sys.argv
routed='--routed' in sys.argv or a02
suffix='A02' if a02 else 'ROUTED'
boardname='KINO_D4_Carrier_A0_2.kicad_pcb' if a02 else ('KINO_D4_Carrier_A0_Routed.kicad_pcb' if routed else 'KINO_D4_Carrier_A0.kicad_pcb')
board=pcb.LoadBoard(str(ROOT/boardname))
fps={fp.GetReference():fp for fp in board.GetFootprints()}
schematic={}
nc=set()
for net in tree.findall('nets/net'):
    for node in net.findall('node'):
        ref,pin=node.attrib['ref'],node.attrib['pin']
        if ref.startswith('#'):continue
        key=(ref,pin)
        if net.attrib['name'].startswith('unconnected-'):nc.add(key)
        else:schematic[key]=net.attrib['name']
errors=[];checked=0
for ref,fp in fps.items():
    for pad in fp.Pads():
        num=pad.GetNumber()
        if num in ('','MP'):continue
        key=(ref,num);expected=schematic.get(key,'');actual=pad.GetNetname()
        if expected!=actual:errors.append(f'{ref}.{num}: schematic={expected!r}, PCB={actual!r}')
        checked+=1
for (ref,pin),net in schematic.items():
    if ref not in fps or pin not in {p.GetNumber() for p in fps[ref].Pads()}:
        errors.append(f'Schematic node {ref}.{pin} missing on PCB')

# Read current normative firmware macros, independently from circuit.py.
header=(REPO/'firmware/p4/main/board_d4v1.h').read_text(encoding='utf-8')
defines=dict(re.findall(r'^#define\s+(BOARD_\w+)\s+(\d+)\s*$',header,re.M))
header_pads={p.GetNumber():p.GetNetname() for p in fps['J100'].Pads()}
for i in range(1,5):
    for direction in ('TX','RX'):
        key=f'BOARD_CAM{i}_{direction}_JP1'
        assert header_pads[defines[key]]==f'P4_{direction}{i}',key
for key,net in [('BOARD_SYNC_OUT_JP1','SYNC_MASTER'),('BOARD_CAM_PWR_EN_JP1','CAM_GLOBAL_EN'),('BOARD_BTN_SHUTTER_JP1','SHUTTER_N')]:
    assert header_pads[defines[key]]==net,key
assert header_pads['15']=='','GPIO35 boot strap must be unconnected'
for pin in ('1','3','18'):
    assert header_pads[pin] not in ('MB_3V3','SYS_5V','P4_5V'),'sense-only supply pin'

for i in range(1,5):
    fp=fps[f'J{100+i*100}'];pads={p.GetNumber():p for p in fp.Pads()}
    assert abs((pads['14'].GetPosition().x-pads['1'].GetPosition().x)/1e6-15.24)<1e-5
    assert abs((pads['2'].GetPosition().y-pads['1'].GetPosition().y)/1e6-2.54)<1e-5
    assert pads['12'].GetNetname()==f'CAM{i}_3V3'
    assert pads['13'].GetNetname()=='GND'
    assert pads['14'].GetNetname()==f'CAM{i}_5V'
    if routed:
        x,y=CAMERA_CENTRES[i-1]
        assert abs(fp.GetPosition().x/1e6-50-x)<1e-5
        assert abs(fp.GetPosition().y/1e6-50-y)<1e-5
        assert fp.GetOrientationDegrees()==0 and fp.GetLayer()==pcb.F_Cu

if routed:
    # Read the enclosure source rather than assuming our constants match it.
    cad=(REPO/'hardware/cad/KINO_FIELD_BODY/generate-field-body.mjs').read_text(encoding='utf-8')
    pitch=float(re.search(r'cameraPitch:\s*([\d.]+)',cad).group(1))
    assert pitch==CAMERA_PITCH
    centres=[fps[f'J{200+i*100}'].GetPosition().x/1e6 for i in range(4)]
    assert all(abs(centres[i+1]-centres[i]-pitch)<1e-6 for i in range(3))

for i,(x,y) in enumerate(INSERT_CENTRES,1):
    pos=fps[f'H{i}'].GetPosition()
    assert abs(pos.x/1e6-50-x)<1e-5 and abs(pos.y/1e6-50-y)<1e-5
    hole=next(iter(fps[f'H{i}'].Pads()))
    assert abs(hole.GetDrillSize().x/1e6-2.2)<1e-5
    # No other physical footprint courtyard may occupy the fastener square.
    for ref,fp in fps.items():
        if ref.startswith('H'):continue
        r=fp.GetBoundingBox(False,False)
        d=FASTENER_KEEP_OUT/2
        assert r.GetRight()/1e6<=50+x-d or r.GetX()/1e6>=50+x+d or r.GetBottom()/1e6<=50+y-d or r.GetY()/1e6>=50+y+d,(ref,f'H{i}')
box=board.GetBoardEdgesBoundingBox()
# Edge line stroke adds 0.05 mm to each overall bounding dimension.
assert abs(box.GetWidth()/1e6-WIDTH-.05)<1e-4
assert abs(box.GetHeight()/1e6-HEIGHT-.05)<1e-4
assert not errors,'\n'.join(errors)
erc=json.loads((OUT/'ERC-DRAFT.json').read_text())
erc_count=sum(len(s['violations']) for s in erc['sheets'])
drc=json.loads((OUT/(f'DRC-{suffix}.json' if routed else 'DRC-DRAFT.json')).read_text())
report={
    'board':boardname,'board_sha256':hashlib.sha256((ROOT/boardname).read_bytes()).hexdigest(),
    'netlist_sha256':hashlib.sha256((OUT/'NETLIST-DRAFT.xml').read_bytes()).hexdigest(),
    'schematic_to_pcb_match':True,'physical_pads_compared':checked,
    'firmware_header_map_match':True,'xiao_socket_geometry_match':True,
    'p4_insert_geometry_match':True,'p4_envelope_mm':[WIDTH,HEIGHT],
    'erc_violations':erc_count,
    'drc_violations_by_type':dict(Counter(v['type'] for v in drc['violations'])),
    'unconnected_items':len(drc['unconnected_items']),
    'manufacturing_ready':False,'physical_fit_verified':False,
    'note':'Geometry, connectivity and data-transfer checks only. Power integrity, battery and stack qualification remain open.'
}
if routed:
    report.update({'camera_pitch_mm':CAMERA_PITCH,'outer_camera_span_mm':3*CAMERA_PITCH,
        'front_footprints':sum(f.GetLayer()==pcb.F_Cu for f in fps.values()),
        'rear_footprints':sum(f.GetLayer()==pcb.B_Cu for f in fps.values()),
        'track_segments':sum(not isinstance(t,pcb.PCB_VIA) for t in board.GetTracks()),
        'vias':sum(isinstance(t,pcb.PCB_VIA) for t in board.GetTracks())})
(OUT/(f'VERIFICATION-{suffix}.json' if routed else 'VERIFICATION.json')).write_text(json.dumps(report,indent=2)+'\n')
status=json.loads((OUT/('A02-CAPTURE-STATUS.json' if a02 else 'BUILD_STATUS.json')).read_text())
status.update({'erc_passed':erc_count==0,'drc_passed':not drc['violations'] and not drc['unconnected_items'],
               'physical_fit_verified':False,'schematic_to_pcb_match':True,
               'mounting_pattern_mm':[61.9,54.8],'mounting_hole_diameter_mm':2.2})
status.update({'unconnected_items':len(drc['unconnected_items']),'drc_violation_count':len(drc['violations']),
               'board_sha256':report['board_sha256']})
if routed:status.update({'status':'TWO_FACE_ROUTING_REVIEW','board':boardname,'tracks':report['track_segments'],'vias':report['vias'],'front_footprints':report['front_footprints'],'rear_footprints':report['rear_footprints']})
(OUT/('A02-STATUS.json' if a02 else 'ROUTING_STATUS.json' if routed else 'BUILD_STATUS.json')).write_text(json.dumps(status,indent=2)+'\n')
print(json.dumps(report,indent=2))
