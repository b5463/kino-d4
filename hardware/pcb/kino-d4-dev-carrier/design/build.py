"""Generate the dev carrier D1 schematic and placed (unrouted) board from circuit.py.

Run with KiCad 10's bundled python.exe. route.py routes it; release.py writes the fab package.
The schematic writer follows kino-d4-carrier-a0/design/build.py: one symbol per part, global labels.
"""
import json
import shutil
from pathlib import Path
from uuid import uuid5, NAMESPACE_URL
import pcbnew as pcb
from circuit import PARTS, SHEETS
from placement import PLACE, WIDTH, HEIGHT, HOLES, FASTENER_KEEP_OUT

ROOT = Path(__file__).resolve().parent.parent
A0 = ROOT.parent / 'kino-d4-carrier-a0'
NAME = 'KINO_D4_Dev_Carrier_D1'
REV, DATE = 'DEV CARRIER D1', '2026-11'
STOCK = Path('C:/Program Files/KiCad/10.0/share/kicad/footprints')
ROOT_ID = str(uuid5(NAMESPACE_URL, NAME))
SUPPLIES = {'GND': 'J1000 USB-C ground / J100 P4 ground', 'VBUS': 'J1000 USB-C VBUS',
            '5V_IN': 'J1001 RAIL from the SW6106, or VBUS over JP1001',
            'P4_3V3': 'J100 pins 1/3, P4 3.3 V', 'C6_3V3': 'J100 pin 18, C6 supply',
            **{f'CAM{n}_3V3': f'J{100 + 100 * n} XIAO onboard regulator' for n in range(1, 5)}}
OFF = 50.0   # drawing offset, as A0


def uid(s): return str(uuid5(NAMESPACE_URL, NAME + '/' + s))
def q(s): return json.dumps(str(s), ensure_ascii=False)
def pt(x, y): return pcb.VECTOR2I(round(x * 1e6), round(y * 1e6))


def geometry(p):
    pinlist = list(p['pins'])
    if len(pinlist) == 2:
        return {pinlist[0]: (-7.62, 0, 0), pinlist[1]: (7.62, 0, 180)}, 7.62
    if len(pinlist) == 1: return {pinlist[0]: (-7.62, 0, 0)}, 5.08
    rows = -(-len(pinlist) // 2)
    h = max(5.08, (rows + 1) * 1.27)
    return {num: (17.78 if i >= rows else -17.78, h - 2.54 - (i % rows) * 2.54, 180 if i >= rows else 0)
            for i, num in enumerate(pinlist)}, h


def libsym(p, full=True):
    loc, h = geometry(p)
    name = ('KINO_DEV:' if full else '') + p['ref']
    two = len(p['pins']) == 2 and abs(loc[next(iter(loc))][0]) < 10
    body = ('(rectangle (start -5.08 1.27) (end 5.08 -1.27) (stroke (width 0.25) (type default)) (fill (type background)))' if two
            else f'(rectangle (start -15.24 {h}) (end 15.24 {-h}) (stroke (width 0.25) (type default)) (fill (type background)))')
    pins = ''.join(f'(pin {p["pins"][n]["type"]} line (at {x} {y} {a}) (length 2.54) (name {q(p["pins"][n]["name"])} '
                   f'(effects (font (size 0.9 0.9)))) (number {q(n)} (effects (font (size 0.9 0.9)))))' for n, (x, y, a) in loc.items())
    return f'''(symbol {q(name)} (pin_names (offset 0.508)) (in_bom {'yes' if p['fit'] != 'none' else 'no'}) (on_board yes)
      (property "Reference" {q(p['ref'].rstrip('0123456789'))} (at 0 {h + 3.81} 0) (effects (font (size 1.27 1.27))))
      (property "Value" {q(p['value'])} (at 0 {h + 1.27} 0) (effects (font (size 1.0 1.0))))
      (property "Footprint" {q(p['footprint'])} (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Datasheet" {q(p['source'])} (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol {q(p['ref'] + '_0_1')} {body}) (symbol {q(p['ref'] + '_1_1')} {pins}))'''


def supply_symbol(full=True):
    name = 'KINO_DEV:SUPPLY_DRIVE' if full else 'SUPPLY_DRIVE'
    return f'''(symbol {q(name)} (power) (pin_numbers hide) (pin_names (offset 0) hide) (in_bom no) (on_board no)
    (property "Reference" "#FLG" (at 0 0 0) (effects (font (size 1 1)) (hide yes)))
    (property "Value" "SUPPLY_DRIVE" (at 0 5.08 0) (effects (font (size 1 1)) (hide yes)))
    (symbol "SUPPLY_DRIVE_0_1" (polyline (pts (xy 0 0) (xy 0 2.54) (xy -1.27 3.81) (xy 0 5.08) (xy 1.27 3.81) (xy 0 2.54)) (stroke (width 0.15) (type default)) (fill (type none))))
    (symbol "SUPPLY_DRIVE_1_1" (pin power_out line (at 0 0 90) (length 0) (name "SUPPLY" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1)))))))'''


def text(s, x, y, size=1.27):
    return f'(text {q(s)} (at {x} {y} 0) (effects (font (size {size} {size})) (justify left top)) (uuid {q(uid(f"{x}{y}{s}"))}))'


def header(id, title):
    return f'''(kicad_sch (version 20250114) (generator "eeschema") (generator_version "10.0")
    (uuid {q(id)}) (paper "A3")
    (title_block (title {q(title)}) (date {q(DATE)}) (rev "D1") (company "KINO / ODD JOBS") (comment 1 "Dev carrier, issue #250"))'''


def schematics():
    symbols = []
    for page, (key, info) in enumerate(SHEETS.items(), 2):
        parts = [p for p in PARTS if p['sheet'] == key]
        sid = uid(key)
        body = [header(sid, info['title']), '(lib_symbols ' + ''.join(libsym(p) for p in parts) + ')',
                text(info['title'], 15, 12, 2.5), text(info['note'], 15, 20, 1.05)]
        y = 40.64
        for start in range(0, len(parts), 4):
            batch = parts[start:start + 4]
            maxh = max(geometry(p)[1] for p in batch)
            cy = y + maxh
            for col, p in enumerate(batch):
                x = 50.8 + col * 96.52
                loc, h = geometry(p)
                ref = p['ref']
                body.append(f'''(symbol (lib_id {q('KINO_DEV:' + ref)}) (at {x} {cy} 0) (unit 1)
                  (in_bom {'yes' if p['fit'] != 'none' else 'no'}) (on_board yes) (dnp no) (uuid {q(uid(ref))})
                  (property "Reference" {q(ref)} (at {x} {cy - h - 5} 0) (effects (font (size 1.27 1.27))))
                  (property "Value" {q(p['value'])} (at {x} {cy - h - 2.5} 0) (effects (font (size 1.0 1.0))))
                  (property "Footprint" {q(p['footprint'])} (at {x} {cy} 0) (effects (font (size 1 1)) (hide yes)))
                  (property "Datasheet" {q(p['source'])} (at {x} {cy} 0) (effects (font (size 1 1)) (hide yes)))
                  (property "LCSC" {q(p['lcsc'])} (at {x} {cy} 0) (effects (font (size 1 1)) (hide yes)))
                  (property "Design note" {q(p['note'])} (at {x} {cy} 0) (effects (font (size 1 1)) (hide yes)))
                  {''.join(f'(pin {q(n)} (uuid {q(uid(ref + "/" + n))}))' for n in p['pins'])}
                  (instances (project {q(NAME)} (path {q('/' + ROOT_ID + '/' + sid)} (reference {q(ref)}) (unit 1)))))''')
                for num, (px, py, angle) in loc.items():
                    a, b = x + px, cy - py
                    net = p['nets'][num]
                    if net is None:
                        body.append(f'(no_connect (at {a} {b}) (uuid {q(uid(ref + num + "nc"))}))')
                        continue
                    end = a + (-5.08 if px < 0 else 5.08)
                    rot = 0 if px < 0 else 180
                    body.append(f'(wire (pts (xy {a} {b}) (xy {end} {b})) (stroke (width 0) (type default)) (uuid {q(uid(ref + num + "wire"))}))')
                    body.append(f'''(global_label {q(net)} (shape bidirectional) (at {end} {b} {rot})
                    (effects (font (size 0.9 0.9)) (justify {'right' if px < 0 else 'left'})) (uuid {q(uid(ref + num + 'label'))})
                    (property "Intersheetrefs" "${{INTERSHEET_REFS}}" (at {end} {b} {rot}) (effects (font (size 0.8 0.8)) (hide yes))))''')
            y = round(cy + maxh + 15.24, 6)
        assert y < 290, (key, y)
        body.append('(embedded_fonts no))')
        (ROOT / (key + '.kicad_sch')).write_text('\n'.join(body), encoding='utf-8')
        symbols.extend(libsym(p, False) for p in parts)
    root = [header(ROOT_ID, 'KINO D4 - dev carrier D1'), '(lib_symbols ' + supply_symbol() + ')',
            text('KINO D4 / ' + REV, 20, 15, 3),
            text('Low-cost bench carrier: four XIAO sockets on the P4 JP1 ribbon, USB-C 5 V, one camera bank switch. See README.md.', 20, 25, 1.4)]
    for i, (key, info) in enumerate(SHEETS.items()):
        x, y = 25 + (i % 3) * 130, 45 + (i // 3) * 50
        root.append(f'''(sheet (at {x} {y}) (size 110 30) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
        (stroke (width 0.25) (type solid)) (fill (color 0 0 0 0)) (uuid {q(uid(key))})
        (property "Sheetname" {q(info['title'])} (at {x} {y - 1} 0) (effects (font (size 1.2 1.2)) (justify left bottom)))
        (property "Sheetfile" {q(key + '.kicad_sch')} (at {x} {y + 31} 0) (effects (font (size 1 1)) (justify left top)))
        (instances (project {q(NAME)} (path {q('/' + ROOT_ID)} (page {q(i + 2)})))))''')
    for i, (net, source) in enumerate(SUPPLIES.items()):
        x, y = 30.48 + (i % 5) * 76.2, 160.02 + (i // 5) * 17.78
        ref = f'#FLG{i + 1:03d}'
        root.append(f'''(symbol (lib_id "KINO_DEV:SUPPLY_DRIVE") (at {x} {y} 0) (unit 1) (in_bom no) (on_board no) (dnp no) (uuid {q(uid(ref))})
        (property "Reference" {q(ref)} (at {x} {y} 0) (effects (font (size 1 1)) (hide yes)))
        (property "Value" "SUPPLY_DRIVE" (at {x} {y} 0) (effects (font (size 1 1)) (hide yes)))
        (property "Source declaration" {q(source)} (at {x} {y} 0) (effects (font (size 1 1)) (hide yes)))
        (pin "1" (uuid {q(uid(ref + 'pin'))}))
        (instances (project {q(NAME)} (path {q('/' + ROOT_ID)} (reference {q(ref)}) (unit 1)))))
        (global_label {q(net)} (shape bidirectional) (at {x} {y} 180) (effects (font (size 1 1)) (justify left)) (uuid {q(uid(ref + 'label'))}))''')
    symbols.append(supply_symbol(False))
    root.append('(embedded_fonts no))')
    (ROOT / (NAME + '.kicad_sch')).write_text('\n'.join(root), encoding='utf-8')
    (ROOT / 'KINO_DEV.kicad_sym').write_text('(kicad_symbol_lib (version 20250114) (generator "kicad_symbol_editor")\n'
                                             + '\n'.join(symbols) + '\n)', encoding='utf-8')
    (ROOT / 'sym-lib-table').write_text('(sym_lib_table (version 7) (lib (name "KINO_DEV") (type "KiCad") '
                                        '(uri "${KIPRJMOD}/KINO_DEV.kicad_sym") (options "") (descr "Dev carrier pin tables")))\n')


def footprints():
    dest = ROOT / 'KINO_DEV.pretty'
    dest.mkdir(exist_ok=True)
    for name in ('XIAO_Socket_15.24mm', 'USB_C_GCT_USB4105_KINO_GND0.05'):
        shutil.copyfile(A0 / 'KINO_A0.pretty' / (name + '.kicad_mod'), dest / (name + '.kicad_mod'))
    (ROOT / 'fp-lib-table').write_text('(fp_lib_table (version 7) (lib (name "KINO_DEV") (type "KiCad") '
                                       '(uri "${KIPRJMOD}/KINO_DEV.pretty") (options "") (descr "A0.2 socket and USB-C lands")))\n')


def project():
    # A0.2's project is the template: its design rules (JLC 2-layer: 0.15 mm track and gap,
    # 0.3 mm drill, 0.2 mm hole clearance) and severities carry over unchanged.
    pro = json.loads((A0 / 'KINO_D4_Carrier_A0_2.kicad_pro').read_text(encoding='utf-8'))
    pro['meta']['filename'] = NAME + '.kicad_pro'
    pro['board']['design_settings']['drc_exclusions'] = []
    pro['board']['layer_presets'] = []
    ns = pro['net_settings']
    default = next(c for c in ns['classes'] if c['name'] == 'Default')
    cls = lambda name, width: dict(default, name=name, track_width=width)
    ns['classes'] = [default, cls('CameraPower', 0.6), cls('MainPower', 1.0)]
    power = ['VBUS_F', 'VBUS_M', '5V_IN', 'P4_5V', 'GND']
    camera = ['VBUS'] + [f'CAM{n}_{s}' for n in range(1, 5) for s in ('SW5V', 'LINK', '5VJ', '5V')]
    ns['netclass_patterns'] = ([{'netclass': 'MainPower', 'pattern': n} for n in power]
                               + [{'netclass': 'CameraPower', 'pattern': n} for n in camera])
    ns['netclass_assignments'] = {}
    pro['schematic']['top_level_sheets'] = [{'filename': NAME + '.kicad_sch', 'name': NAME, 'uuid': ROOT_ID}]
    pro['sheets'] = []
    (ROOT / (NAME + '.kicad_pro')).write_text(json.dumps(pro, indent=2) + '\n', encoding='utf-8')


def seg(board, a, b, layer, w=.05):
    s = pcb.PCB_SHAPE(board); s.SetShape(pcb.SHAPE_T_SEGMENT); s.SetStart(pt(*a)); s.SetEnd(pt(*b))
    s.SetWidth(round(w * 1e6)); s.SetLayer(layer); board.Add(s)


def board():
    brd = pcb.BOARD()
    brd.SetCopperLayerCount(2)
    ds = brd.GetDesignSettings()
    ds.SetBoardThickness(pcb.FromMM(1.6))
    # kicad-cli takes these from the board file's setup, not the project: the same values as the project.
    ds.m_MinClearance, ds.m_TrackMinWidth, ds.m_ViasMinSize = pcb.FromMM(.15), pcb.FromMM(.15), pcb.FromMM(.6)
    ds.m_MinThroughDrill, ds.m_HoleClearance, ds.m_HoleToHoleMin = pcb.FromMM(.2), pcb.FromMM(.2), pcb.FromMM(.25)
    ds.m_CopperEdgeClearance, ds.m_SilkClearance, ds.m_ViasMinAnnularWidth = pcb.FromMM(.5), pcb.FromMM(.15), pcb.FromMM(.1)
    nets = {}
    for name in sorted({n for p in PARTS for n in p['nets'].values() if n}):
        nets[name] = pcb.NETINFO_ITEM(brd, name); brd.Add(nets[name])
    missing = {p['ref'] for p in PARTS} - set(PLACE)
    assert not missing, ('unplaced', sorted(missing))
    for p in PARTS:
        lib, name = p['footprint'].split(':', 1)
        path = ROOT / 'KINO_DEV.pretty' if lib == 'KINO_DEV' else STOCK / (lib + '.pretty')
        fp = pcb.FootprintLoad(str(path), name)
        assert fp, p['footprint']
        fp.SetReference(p['ref']); fp.SetValue(p['value']); fp.SetFPID(pcb.LIB_ID(lib, name))
        fp.SetPath(pcb.KIID_PATH('/' + ROOT_ID + '/' + uid(p['sheet']) + '/' + uid(p['ref'])))
        fp.Value().SetVisible(False)
        if p['fit'] == 'none':
            fp.SetAttributes(fp.GetAttributes() | pcb.FP_EXCLUDE_FROM_BOM | pcb.FP_EXCLUDE_FROM_POS_FILES)
        pads = {a.GetNumber() for a in fp.Pads() if a.GetNumber() not in ('', 'MP')}
        assert pads == set(p['nets']), (p['ref'], pads ^ set(p['nets']))
        for a in fp.Pads():
            if p['nets'].get(a.GetNumber()): a.SetNet(nets[p['nets'][a.GetNumber()]])
        masks = [(a, a.IsOnLayer(pcb.F_Mask), a.IsOnLayer(pcb.B_Mask)) for a in fp.Pads()
                 if a.GetAttribute() in (pcb.PAD_ATTRIB_PTH, pcb.PAD_ATTRIB_NPTH)]
        brd.Add(fp)
        for a, fm, bm in masks:   # KiCad 10 can drop wildcard mask layers on attach (A0 note)
            ls = a.GetLayerSet()
            for layer, on in ((pcb.F_Mask, fm), (pcb.B_Mask, bm)):
                ls.AddLayer(layer) if on else ls.RemoveLayer(layer)
            a.SetLayerSet(ls)
        x, y, rot, side = PLACE[p['ref']]
        fp.SetPosition(pt(OFF + x, OFF + y))
        if side == 'B':
            fp.Flip(fp.GetPosition(), pcb.FLIP_DIRECTION_LEFT_RIGHT)
        # The recorded angle is the stored one. KiCad stores a back-side part as its
        # y-mirror plus 180 degrees, so a connector that opens toward +y on the front
        # is recorded as 180 on the back (A0.2 J100 is 180 B).
        fp.SetOrientationDegrees(rot)
        ref = fp.Reference()
        ref.SetTextSize(pt(.8, .8)); ref.SetTextThickness(pcb.FromMM(.12))
        ref.SetLayer(pcb.B_Fab if side == 'B' else pcb.F_Fab)
    for i, (x, y) in enumerate(HOLES, 1):
        fp = pcb.FootprintLoad(str(STOCK / 'MountingHole.pretty'), 'MountingHole_2.2mm_M2')
        fp.SetReference(f'H{i}'); fp.SetValue('M2'); fp.Value().SetVisible(False); fp.Reference().SetLayer(pcb.F_Fab)
        fp.SetAttributes(fp.GetAttributes() | pcb.FP_EXCLUDE_FROM_BOM | pcb.FP_EXCLUDE_FROM_POS_FILES | pcb.FP_BOARD_ONLY)
        fp.SetPosition(pt(OFF + x, OFF + y)); brd.Add(fp)
    corners = [(OFF, OFF), (OFF + WIDTH, OFF), (OFF + WIDTH, OFF + HEIGHT), (OFF, OFF + HEIGHT)]
    for a, b in zip(corners, corners[1:] + corners[:1]):
        seg(brd, a, b, pcb.Edge_Cuts)
    for x, y in HOLES:   # M2 fastener allowance, review layer only
        c = pcb.PCB_SHAPE(brd); c.SetShape(pcb.SHAPE_T_CIRCLE); c.SetCenter(pt(OFF + x, OFF + y))
        c.SetEnd(pt(OFF + x + FASTENER_KEEP_OUT / 2, OFF + y)); c.SetWidth(pcb.FromMM(.1)); c.SetLayer(pcb.Dwgs_User); brd.Add(c)
    out = ROOT / (NAME + '.kicad_pcb')
    pcb.SaveBoard(str(out), brd)
    return {'footprints': len(PARTS) + len(HOLES), 'nets': len(nets)}


if __name__ == '__main__':
    (ROOT / 'design').mkdir(exist_ok=True)
    schematics(); footprints(); project()
    print(json.dumps(board()))
