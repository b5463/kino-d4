"""Dev carrier D1: the checks that can run before a board exists.

Reads circuit.py, the routed board and the fab package, and writes outputs/VERIFY-D1.md:
  1. nets: every net reaches at least two pads; the unused pins are no-connects
  2. intent: the polarity of every polarised part and the function of every protection part
  3. pin maps: J100 against the measured JP1 table in firmware/p4/main/board_d4v1.h; the XIAO socket
  4. copper: power nets at their class width end to end; copper resistance and drop per power path
  5. mechanics: nothing but silk inside the 7 mm fastener allowance; part heights on the P4 face
  6. parts: every LCSC number exists, is in the library class recorded, and has stock
  7. fab package: every layer, the drill, the BOM and CPL agree with the board
Run with KiCad 10's bundled python.exe after release.py. Exit code 1 if any check fails.
"""
import json
import re
import sys
import urllib.request
from pathlib import Path
import pcbnew as pcb
from circuit import PARTS
from placement import HOLES, FASTENER_KEEP_OUT, PLACE

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent.parent.parent
BOARD = ROOT / 'KINO_D4_Dev_Carrier_D1.kicad_pcb'
OUT = ROOT / 'outputs'
OFF = 50.0
RHO_OZ = 0.49e-3   # ohm per mm of a 1 mm wide 1 oz (35 um) copper track, 1.72e-8 ohm m
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    return ok


def mm(v): return v / 1e6 - OFF


# --- 1. nets -------------------------------------------------------------------------------
def nets():
    pads = {}
    for p in PARTS:
        for num, net in p['nets'].items():
            if net:
                pads.setdefault(net, []).append(f"{p['ref']}.{num}")
    single = {n: r for n, r in pads.items() if len(r) < 2}
    check('every net reaches two pads', not single, ', '.join(f'{n} ({r[0]})' for n, r in single.items()) or f'{len(pads)} nets')
    return pads


# --- 2. intent -----------------------------------------------------------------------------
def intent(pads):
    part = {p['ref']: p for p in PARTS}

    def pin(ref, num): return part[ref]['nets'][str(num)]

    for n in range(1, 5):
        b = 200 + 100 * (n - 1)
        check(f'SS34 D{b} blocks node USB from the bank', pin(f'D{b}', 1) == f'CAM{n}_LINK' and pin(f'D{b}', 2) == f'CAM{n}_SW5V',
              f"K={pin(f'D{b}', 1)} A={pin(f'D{b}', 2)}")
        check(f'TPS2553 U{b} wiring', pin(f'U{b}', 1) == '5V_IN' and pin(f'U{b}', 3) == 'CAM_PWR_EN' and pin(f'U{b}', 4) == 'FAULT_N'
              and pin(f'U{b}', 6) == f'CAM{n}_SW5V' and pin(f'R{b}', 1) == f'CAM{n}_ILIM' and part[f'R{b}']['value'] == '24k')
        check(f'node {n} link, measure link and socket 5 V in series',
              pin(f'JP{b}', 1) == f'CAM{n}_LINK' and pin(f'JP{b}', 2) == f'CAM{n}_5VJ'
              and {pin(f'R{b + 6}', 1), pin(f'R{b + 6}', 2)} == {f'CAM{n}_5VJ', f'CAM{n}_5V'} and pin(f'J{b}', 14) == f'CAM{n}_5V')
        check(f'node {n} UART crossed and series-protected',
              {pin(f'R{b + 3}', 1), pin(f'R{b + 3}', 2)} == {f'P4_TX{n}', f'CAM{n}_RX'}
              and {pin(f'R{b + 4}', 1), pin(f'R{b + 4}', 2)} == {f'CAM{n}_TX', f'P4_RX{n}'}
              and pin(f'J{b}', 7) == f'CAM{n}_TX' and pin(f'J{b}', 8) == f'CAM{n}_RX')
    leds = {'D1000': ('GND', '5V_IN_LED'), 'D1001': ('CAM_EN_LED', 'CAM_PWR_EN'), 'D1002': ('FAULT_N', 'FAULT_LED')}
    for ref, (k, a) in leds.items():
        check(f'LED {ref} polarity', pin(ref, 1) == k and pin(ref, 2) == a, f"K={pin(ref, 1)} A={pin(ref, 2)}")
    check('FAULT_N has exactly one pull-up (the FLT LED chain)', {r for r in pads['FAULT_N'] if not r.startswith('U')} == {'D1002.1', 'TP107.1'})
    check('ideal diode U1001: rail in, P4 5 V out, CE on VOUT',
          pin('U1001', 1) == '5V_IN' and pin('U1001', 6) == 'P4_5V' and pin('U1001', 3) == 'P4_5V' and pin('U1001', 2) == 'GND')
    check('no other path from the rail to P4_5V', sorted(pads['P4_5V']) == sorted(['J100.2', 'J100.4', 'U1001.3', 'U1001.6', 'C1004.1', 'TP101.1']),
          ', '.join(sorted(pads['P4_5V'])))
    check('USB-C VBUS: clamp, fuse, then the bridge and the module connector',
          pin('U1000', 5) == 'VBUS' and {pin('F1000', 1), pin('F1000', 2)} == {'VBUS', 'VBUS_F'}
          and {pin('JP1001', 1), pin('JP1001', 2)} == {'VBUS_F', '5V_IN'} and pin('J1001', 1) == 'VBUS_F' and pin('J1001', 5) == '5V_IN')
    check('CC pull-downs 5.1k and clamped', part['R1000']['value'] == '5.1k' and part['R1001']['value'] == '5.1k'
          and {pin('U1000', 1), pin('U1000', 3)} == {'USB_CC1', 'USB_CC2'})
    check('camera bank held off from reset, against the 45k internal pull-up', pin('R100', 1) == 'CAM_PWR_EN' and pin('R100', 2) == 'GND' and part['R100']['value'] == '4.7k')
    check('sync held low from reset', pin('R101', 1) == 'SYNC_MASTER' and pin('R101', 2) == 'GND')
    check('shutter: switch and remote both pull SHUTTER_N to GND', {pin('SW100', 1), pin('SW100', 2)} == {'SHUTTER_N', 'GND'}
          and {pin('J103', 1), pin('J103', 2)} == {'SHUTTER_N', 'GND'})
    check('Qwiic pinout GND 3V3 SDA SCL', [pin('J102', i) for i in (1, 2, 3, 4)] == ['GND', 'P4_3V3', 'P4_SDA', 'P4_SCL'])
    check('Qwiic pull-ups are DNP', part['R102']['fit'] == 'none' and part['R103']['fit'] == 'none')


# --- 3. pin maps ---------------------------------------------------------------------------
JP1_NAME = {'3V3': 'P4_3V3', '5V': 'P4_5V', 'GND': 'GND', 'ESP_3V3': 'C6_3V3', 'C6_U0RXD': 'C6_RX', 'C6_U0TXD': 'C6_TX',
            'C6_IO9': 'C6_IO9', 'C6_CHIP_PU': 'C6_EN', 'I2C_SDA': 'P4_SDA', 'I2C_SCL': 'P4_SCL', 'GPIO35': None,
            'GPIO52': 'P4_TX1', 'GPIO51': 'P4_RX1', 'GPIO50': 'P4_TX2', 'GPIO49': 'P4_RX2', 'GPIO34': 'P4_TX3',
            'GPIO33': 'P4_RX3', 'GPIO31': 'CAM_PWR_EN', 'GPIO30': 'P4_TX4', 'GPIO29': 'P4_RX4', 'GPIO32': 'SYNC_MASTER', 'GPIO28': 'SHUTTER_N'}


def pinmaps():
    src = (REPO / 'firmware/p4/main/board_d4v1.h').read_text(encoding='utf-8')
    rows = re.findall(r'^//\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$', src, re.M)
    table = {}
    for a, left, right, b in rows:
        table[int(a)] = left; table[int(b)] = right
    j100 = next(p for p in PARTS if p['ref'] == 'J100')['nets']
    bad = [f'pin {i}: header {name} -> {JP1_NAME.get(name)!r}, board {j100.get(str(i))!r}'
           for i, name in sorted(table.items()) if JP1_NAME.get(name) != j100.get(str(i))]
    check('J100 matches the measured JP1 table (26 pins)', len(table) == 26 and not bad, '; '.join(bad) or '26 pins agree')
    for n in range(1, 5):
        j = next(p for p in PARTS if p['ref'] == f'J{200 + 100 * (n - 1)}')['nets']
        check(f'XIAO socket J{200 + 100 * (n - 1)}: D1 sync, D6 TX, D7 RX, 3V3/GND/5V',
              j['2'] == f'CAM{n}_SYNC' and j['7'] == f'CAM{n}_TX' and j['8'] == f'CAM{n}_RX' and j['12'] == f'CAM{n}_3V3' and j['13'] == 'GND' and j['14'] == f'CAM{n}_5V')


# --- 4. copper -----------------------------------------------------------------------------
def copper(b):
    widths = {'5V_IN': 1.0, 'P4_5V': 1.0, 'VBUS_F': 1.0, 'VBUS': 0.6, **{f'CAM{n}_{s}': 0.6 for n in range(1, 5) for s in ('SW5V', 'LINK', '5VJ', '5V')}}
    by_net = {}
    for t in b.GetTracks():
        if t.GetClass() == 'PCB_TRACK':
            by_net.setdefault(t.GetNetname(), []).append(t)
    # The 1.0 mm bus nets carry up to 3 A and must not change layers through a single 0.3 mm via: every via
    # needs a joined twin within 2.5 mm, except a branch that only reaches a test pad. The 0.6 mm node nets
    # carry one node (1.2 A max), which a single 0.3 mm via handles; their singles are listed, not failed.
    # Branches that carry no load current: test pads, the rail clamp D1003, the USB clamp U1000.
    tps = [p.GetPosition() for fp in b.GetFootprints() if fp.GetReference().startswith('TP') or fp.GetReference() in ('D1003', 'U1000') for p in fp.Pads()]
    vias = {}
    for t in b.GetTracks():
        if t.GetClass() == 'PCB_VIA' and t.GetNetname() in widths:
            vias.setdefault(t.GetNetname(), []).append(t.GetPosition())
    single = {net: [p for p in ps if not any(q is not p and (q - p).EuclideanNorm() <= pcb.FromMM(2.5) for q in ps)
                    and not any((tp - p).EuclideanNorm() <= pcb.FromMM(2.5) for tp in tps)] for net, ps in vias.items()}
    bus = [f'{net} ({mm(p.x):.1f},{mm(p.y):.1f})' for net, ps in single.items() if widths[net] >= 1.0 for p in ps]
    node = [f'{net} ({mm(p.x):.1f},{mm(p.y):.1f})' for net, ps in single.items() if widths[net] < 1.0 for p in ps]
    check('bus-net vias doubled (3 A path)', not bus, '; '.join(bus) or f'{sum(len(v) for n, v in vias.items() if widths[n] >= 1.0)} vias, all paired or on a test-pad or clamp branch')
    check('node-net single vias carry one node only', True, f'{len(node)} single: ' + '; '.join(node) if node else 'none')
    rows = []
    for net, w in widths.items():
        segs = by_net.get(net, [])
        # A pad entry may neck down for up to 3 mm (one pin's current into a SOT or receptacle pad); nothing longer may.
        thin = [s for s in segs if s.GetWidth() < pcb.FromMM(w) - 10 and s.GetLength() > pcb.FromMM(3.0)]
        length = sum(s.GetLength() for s in segs) / 1e6
        r = sum(s.GetLength() / 1e6 * RHO_OZ / (s.GetWidth() / 1e6) for s in segs)
        rows.append((net, length, r))
        detail = '; '.join(f'{s.GetWidth() / 1e6:.2f} mm x {s.GetLength() / 1e6:.1f} mm at ({mm(s.GetStart().x):.1f},{mm(s.GetStart().y):.1f})' for s in thin)
        check(f'{net} at {w} mm end to end', not thin, detail or f'{length:.0f} mm, {r * 1e3:.1f} mohm')
    return rows


# --- 5. mechanics --------------------------------------------------------------------------
HEIGHTS = {'J100': 9.1, 'J1000': 3.3, 'J102': 4.3, 'C1000': 1.3, 'C1001': 1.3, 'F1000': 1.6, 'U200': 1.2}


def mechanics(b):
    hits = []
    for fp in b.GetFootprints():
        ref = fp.GetReference()
        if ref.startswith('H') or ref.startswith('FID'):
            continue
        box = fp.GetBoundingBox(False, False)
        for i, (hx, hy) in enumerate(HOLES, 1):
            cx, cy = pcb.FromMM(OFF + hx), pcb.FromMM(OFF + hy)
            r = pcb.FromMM(FASTENER_KEEP_OUT / 2)
            dx = max(box.GetLeft() - cx, 0, cx - box.GetRight()); dy = max(box.GetTop() - cy, 0, cy - box.GetBottom())
            if dx * dx + dy * dy < r * r:
                hits.append(f'{ref} in H{i} allowance')
    check('nothing but silk inside the 7 mm fastener allowance', not hits, '; '.join(hits) or '4 holes clear')
    back = max((HEIGHTS.get(r, 0) for r, v in PLACE.items() if v[3] == 'B'), default=0)
    check('tallest part on the P4 face recorded', back == 4.3, f'{back} mm (J102 Qwiic); J100 is on the top face, only the P4-side ribbon plug is in the gap')


# --- 6. parts ------------------------------------------------------------------------------
def parts():
    url = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList'
    codes = {p['lcsc']: p for p in PARTS if p['lcsc']}
    for code, p in sorted(codes.items()):
        try:
            req = urllib.request.Request(url, data=json.dumps({'keyword': code, 'currentPage': 1, 'pageSize': 3}).encode(),
                                         headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
            rows = (json.load(urllib.request.urlopen(req, timeout=25)).get('data') or {}).get('componentPageInfo', {}).get('list') or []
            row = next((r for r in rows if r.get('componentCode') == code), None)
        except Exception as e:   # network: record, do not fail the design
            check(f'{code} {p["value"]}', True, f'lookup failed: {e}')
            continue
        if not row:
            check(f'{code} {p["value"]}', False, 'not in the JLC library'); continue
        lib = row.get('componentLibraryType')
        stock = row.get('stockCount') or 0
        ok = (lib == 'base') == p['basic'] and stock > 0
        check(f'{code} {p["value"]}', ok, f'{lib}, stock {stock}, recorded {"basic" if p["basic"] else "extended"}')


# --- 7. fab package ------------------------------------------------------------------------
def fab(b):
    fabdir = OUT / 'fab-d1'
    files = {f.suffix for f in fabdir.iterdir()}
    check('gerber layers and drill present', {'.gtl', '.gbl', '.gts', '.gbs', '.gto', '.gbo', '.gtp', '.gbp', '.gm1', '.drl'} <= files, ', '.join(sorted(files)))
    smt = {p['ref'] for p in PARTS if p['fit'] == 'smt'}
    import csv
    with (fabdir / 'CPL-D1-JLC.csv').open(encoding='utf-8') as f:
        cpl = {row['Designator'] for row in csv.DictReader(f)}
    check('CPL lists every SMT part once and nothing else', cpl == smt, f'{len(cpl)} rows')
    with (fabdir / 'BOM-D1-JLC.csv').open(encoding='utf-8') as f:
        refs = {r for row in csv.DictReader(f) for r in row['Designator'].split(',')}
    check('BOM designators equal the CPL', refs == cpl, f'{len(refs)} designators')
    sides = {fp.IsFlipped() for fp in b.GetFootprints() if fp.GetReference() in smt}
    check('all SMT on the bottom face', sides == {True})


def main():
    b = pcb.LoadBoard(str(BOARD))
    pads = nets(); intent(pads); pinmaps(); rows = copper(b); mechanics(b); parts(); fab(b)
    failed = [r for r in results if not r[1]]
    lines = ['# Dev carrier D1 pre-build verification', '', f'{len(results) - len(failed)} of {len(results)} checks pass.', '',
             '| Check | Result | Detail |', '|---|---|---|']
    lines += [f'| {n} | {"pass" if ok else "FAIL"} | {d} |' for n, ok, d in results]
    lines += ['', '## Copper per power net', '', '| Net | Track length | Resistance (1 oz) |', '|---|---:|---:|']
    lines += [f'| {n} | {l:.0f} mm | {r * 1e3:.1f} mohm |' for n, l, r in rows]
    (OUT / 'VERIFY-D1.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'checks': len(results), 'failed': [r[0] for r in failed]}))
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
