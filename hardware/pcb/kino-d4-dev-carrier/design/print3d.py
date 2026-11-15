"""Dev carrier D1 as one printable STL for a clearance check: the board body from KiCad (outline
and holes) and every component as a plain box at its datasheet envelope. No pins, no mated
plugs, no detailed connector models, no XIAO modules: what a PLA print can hold and what a
clearance check needs. The J100 shroud is hollow, with its key notch, so a real IDC socket
drops in.

  kicad-cli pcb export stl --board-only -o outputs/D1-3d-base.stl KINO_D4_Dev_Carrier_D1.kicad_pcb
  python design/print3d.py            -> outputs/D1-print.stl
  python design/print3d.py slab       -> outputs/D1-slab.stl: the outline, the four M2 holes, the J100 shroud
                                         and the eight 1x07 socket rows as 1.2 mm holes (real socket strips push in);
                                         nothing else, for the ribbon fold and the XIAO fit before the quote.
  python design/print3d.py fit        -> outputs/D1-fit.stl: the slab plus the cable-side connectors
  python design/print3d.py parts      -> outputs/D1-fit-parts.stl: spacer posts, pouch and power-module dummies

STL frame (checked against the exported board body): x = board x + 50, y = -(board y + 50),
board body from z 0 (P4 face) up to its top face (about 1.5 mm, read from the file). Front
parts stand on the top face, back parts hang below z 0. Sizes are datasheet envelopes
(w along the footprint's x, l along its y, h).
"""
import math
import struct
from pathlib import Path
from circuit import PARTS
from placement import PLACE, HEIGHT

ROOT = Path(__file__).resolve().parent.parent
BASE, OUT = ROOT / 'outputs/D1-3d-base.stl', ROOT / 'outputs/D1-print.stl'
OFF = 50.0

# footprint -> (w, l, h, centre offset x, centre offset y) in the footprint frame, mm.
ENVELOPE = {
    'Resistor_SMD:R_0603_1608Metric': (1.6, 0.8, 0.45, 0, 0),
    'Capacitor_SMD:C_0603_1608Metric': (1.6, 0.8, 0.8, 0, 0),
    'Capacitor_SMD:C_0805_2012Metric': (2.0, 1.25, 1.25, 0, 0),
    'LED_SMD:LED_0603_1608Metric': (1.6, 0.8, 0.6, 0, 0),
    'LED_SMD:LED_0805_2012Metric': (2.0, 1.25, 1.1, 0, 0),
    'Diode_SMD:D_SMA': (4.3, 2.6, 2.3, 0, 0),
    'Package_TO_SOT_SMD:SOT-23-6': (2.9, 1.6, 1.15, 0, 0),
    'Package_TO_SOT_SMD:SOT-23': (2.9, 1.3, 1.1, 0, 0),
    'Package_TO_SOT_SMD:SOT-363_SC-70-6': (2.0, 1.25, 1.0, 0, 0),
    'Fuse:Fuse_1812_4532Metric': (4.5, 3.2, 1.6, 0, 0),
    'KINO_DEV:USB_C_GCT_USB4105_KINO_GND0.05': (8.94, 7.35, 3.26, 0, 0),
    'Connector_JST:JST_SH_SM04B-SRSS-TB_1x04-1MP_P1.00mm_Horizontal': (6.0, 4.3, 2.9, 0, 0),
    'Connector_IDC:IDC-Header_2x13_P2.54mm_Vertical': (8.9, 38.6, 9.1, 1.27, 15.24),   # Wurth 61202621621 shroud
    'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical': (2.54, 5.08, 2.5, 0, 1.27),   # body only
    'Connector_PinHeader_2.54mm:PinHeader_1x06_P2.54mm_Vertical': (2.54, 15.24, 2.5, 0, 6.35),
    'Connector_JST:JST_XH_B2B-XH-A_1x02_P2.50mm_Vertical': (7.4, 5.75, 7.0, 1.25, 0.5),
    'Connector_JST:JST_XH_B6B-XH-A_1x06_P2.50mm_Vertical': (17.5, 5.75, 7.0, 6.25, 0.5),
}
SKIP = ('TestPoint', 'Fiducial:', 'Jumper:')   # flat features and the wire loops: nothing to print
BODIES = []   # (x1, y1, x2, y2, z1, z2) in board mm


def rot(x, y, deg):
    """KiCad footprint rotation in the y-down board frame."""
    c, s = round(math.cos(math.radians(deg))), round(math.sin(math.radians(deg)))
    return x * c + y * s, -x * s + y * c


def body(cx, cy, w, l, z1, z2):
    BODIES.append((cx - w / 2, cy - l / 2, cx + w / 2, cy + l / 2, z1, z2))


def shroud(cx, cy, w, l, h, z0, inner=(6.4, 33.8), floor=1.5, key=4.0):
    """A box header as a hollow: four walls on a floor, the key notch open in the -x wall at
    mid-length, so a real IDC socket drops in for the clearance check."""
    iw, il = inner
    sx, sy = (w - iw) / 2, (l - il) / 2
    BODIES.append((cx - w / 2, cy - l / 2, cx + w / 2, cy + l / 2, z0, z0 + floor))
    for y1, y2 in ((cy - l / 2, cy - l / 2 + sy), (cy + l / 2 - sy, cy + l / 2)):   # end walls
        BODIES.append((cx - w / 2, y1, cx + w / 2, y2, z0, z0 + h))
    BODIES.append((cx + w / 2 - sx, cy - l / 2, cx + w / 2, cy + l / 2, z0, z0 + h))   # +x wall
    for y1, y2 in ((cy - l / 2, cy - key / 2), (cy + key / 2, cy + l / 2)):          # -x wall, key notch between
        BODIES.append((cx - w / 2, y1, cx - w / 2 + sx, y2, z0, z0 + h))


def build(top, refs=None):
    """Every part as its envelope, or only the refs listed."""
    for p in PARTS:
        fp = p['footprint']
        if fp.startswith(SKIP) or (refs is not None and p['ref'] not in refs):
            continue
        x, y, deg, side = PLACE[p['ref']]
        if fp == 'KINO_DEV:XIAO_Socket_15.24mm':   # two 1x07 socket strips, 8.5 mm; the module itself is not printed
            for dx in (-7.62, 7.62):
                body(x + dx, y, 2.54, 17.78, top, top + 8.5)
            continue
        if fp not in ENVELOPE:
            print('no envelope for', p['ref'], fp)
            continue
        w, l, h, ox, oy = ENVELOPE[fp]
        if side == 'B':
            ox = -ox   # the flip mirrors the footprint frame in x
        dx, dy = rot(ox, oy, deg)
        if deg % 180:
            w, l = l, w
        if fp.startswith('Connector_IDC:'):
            shroud(x + dx, y + dy, w, l, h, top if side == 'F' else -h)
        elif side == 'F':
            body(x + dx, y + dy, w, l, top, top + h)
        else:
            body(x + dx, y + dy, w, l, -h, 0)


def tri(a, b, c):
    return struct.pack('<12fH', 0, 0, 0, *a, *b, *c, 0)


def box(x1, y1, x2, y2, z1, z2):
    X1, X2 = OFF + x1, OFF + x2
    Y1, Y2 = -(OFF + y2), -(OFF + y1)   # board y down -> STL y up
    p = [(X1, Y1, z1), (X2, Y1, z1), (X2, Y2, z1), (X1, Y2, z1), (X1, Y1, z2), (X2, Y1, z2), (X2, Y2, z2), (X1, Y2, z2)]
    faces = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    return b''.join(tri(p[i], p[j], p[k]) for i, j, k in faces)


def slab_base(out):
    """A board copy holding only the outline, the M2 holes, J100 and the XIAO sockets (drills opened
    to 1.2 mm so a PLA print takes a real 2.54 mm socket strip), exported by kicad-cli as the slab body."""
    import os
    import shutil
    import subprocess
    import tempfile
    import pcbnew as pcb
    b = pcb.LoadBoard(str(ROOT / 'KINO_D4_Dev_Carrier_D1.kicad_pcb'))
    keep = {'J100', 'J200', 'J300', 'J400', 'J500'}
    # Collect everything first: the track list cannot be read once items have been removed (swig).
    tracks, zones, drawings, footprints = list(b.GetTracks()), list(b.Zones()), list(b.GetDrawings()), list(b.GetFootprints())
    for t in tracks:
        b.Remove(t)
    for z in zones:
        b.Remove(z)
    for d in drawings:
        if d.GetLayer() != pcb.Edge_Cuts:
            b.Remove(d)
    for fp in footprints:
        ref = fp.GetReference()
        if ref in keep or ref.startswith('H'):
            if ref != 'J100' and ref in keep:
                for pad in fp.Pads():
                    pad.SetDrillSize(pcb.VECTOR2I(pcb.FromMM(1.2), pcb.FromMM(1.2)))
                    pad.SetSize(pcb.F_Cu, pcb.VECTOR2I(pcb.FromMM(1.8), pcb.FromMM(1.8)))
                    pad.SetSize(pcb.B_Cu, pcb.VECTOR2I(pcb.FromMM(1.8), pcb.FromMM(1.8)))
            continue
        b.Remove(fp)
    tmp = Path(tempfile.mkdtemp(prefix='d1-slab-'))
    board = tmp / 'slab.kicad_pcb'
    pcb.SaveBoard(str(board), b)
    cli = shutil.which('kicad-cli') or os.path.join(os.path.dirname(pcb.__file__), '..', '..', 'kicad-cli.exe')
    if not Path(cli).exists():
        cli = r'C:\Program Files\KiCad\10.0\bin\kicad-cli.exe'
    subprocess.run([cli, 'pcb', 'export', 'stl', '--force', '--board-only', '-o', str(out), str(board)], check=True, capture_output=True)
    shutil.rmtree(tmp, ignore_errors=True)


# The cable side of the board, for the fit print: every connector a lead plugs into, and the LINK
# headers that sit beside the XIAO USB plugs.
CABLE_REFS = {'J100', 'J1001', 'J103', 'J101', 'JP200', 'JP300', 'JP400', 'JP500'}

# Bench stack and battery, from docs/HARDWARE.md and the A0 mechanical record (seller and size-code
# figures, to be measured): 505573 pouch 5 x 55 x 73 mm with a PH2.0 lead on a short edge; SW6106
# module 28 x 28 x 11.4 mm; carrier-to-P4 spacers 15-20 mm on the four M2 inserts.
POUCH = (73.0, 55.0, 5.0)
POWER_MODULE = (28.0, 28.0, 11.4)
SPACER_HEIGHTS = (15.0, 17.5, 20.0)
SPACER_OD, SPACER_BORE = 6.0, 2.4   # square post, M2 clearance bore


def slab():
    base = ROOT / 'outputs/D1-3d-slab-base.stl'
    slab_base(base)
    top = read_base(base)
    build(top, {'J100'})
    write(ROOT / 'outputs/D1-slab.stl', b'KINO D4 dev carrier D1 slab: outline, M2 holes, J100 shroud, socket holes')


def fit():
    """The slab plus the cable side: J100 shroud, J1001 power, J103 shutter, J101 C6 service and the
    four LINK headers, so every lead can be plugged and dressed around the XIAOs."""
    base = ROOT / 'outputs/D1-3d-slab-base.stl'
    slab_base(base)
    top = read_base(base)
    build(top, CABLE_REFS)
    write(ROOT / 'outputs/D1-fit.stl', b'KINO D4 dev carrier D1 fit: slab with the cable-side connectors')


def post(cx, cy, h):
    """A square spacer post with a through bore, four walls."""
    o, i = SPACER_OD / 2, SPACER_BORE / 2
    BODIES.append((cx - o, cy - o, cx + o, cy - i, 0, h))
    BODIES.append((cx - o, cy + i, cx + o, cy + o, 0, h))
    BODIES.append((cx - o, cy - i, cx - i, cy + i, 0, h))
    BODIES.append((cx + i, cy - i, cx + o, cy + i, 0, h))


def parts():
    """Loose bench parts on one bed, all from z 0: twelve spacer posts (four of each height), the
    pouch dummy with its lead tab, the power-module dummy. Split to objects in the slicer."""
    global BASE_TRIS, BASE_N
    BASE_TRIS, BASE_N = b'', 0
    y0 = HEIGHT + 12.0   # below the board's frame, so the two files can be loaded together
    for col, h in enumerate(SPACER_HEIGHTS):
        for row in range(4):
            post(4.0 + col * 10.0, y0 + 4.0 + row * 10.0, h)
    pw, pl, ph = POUCH
    px = 40.0
    body(px + pw / 2, y0 + pl / 2, pw, pl, 0, ph)
    body(px + pw + 4.0, y0 + pl / 2, 8.0, 6.0, 0, 3.0)   # PH2.0 lead exit, short edge; mark the real one when measured
    mw, ml, mh = POWER_MODULE
    body(px + pw + 16.0 + mw / 2, y0 + ml / 2, mw, ml, 0, mh)
    write(ROOT / 'outputs/D1-fit-parts.stl', b'KINO D4 dev carrier D1 fit parts: spacers 15/17.5/20, 505573 pouch, SW6106 module dummies')


def read_base(path):
    """Load the kicad-cli board STL into BASE_TRIS and return its top face z."""
    global BASE_TRIS, BASE_N
    data = path.read_bytes()
    if data[:5] == b'solid' and b'facet' in data[:2000]:   # ASCII STL: rebuild the binary triangle list
        import re
        verts = [tuple(map(float, m)) for m in re.findall(rb'vertex\s+(\S+)\s+(\S+)\s+(\S+)', data)]
        BASE_TRIS = b''.join(tri(verts[i], verts[i + 1], verts[i + 2]) for i in range(0, len(verts) - 2, 3))
        BASE_N = len(verts) // 3
    else:
        BASE_N = struct.unpack_from('<I', data, 80)[0]
        BASE_TRIS = data[84:84 + 50 * BASE_N]
    lo, hi = [1e9] * 3, [-1e9] * 3
    for i in range(BASE_N):
        for v in range(3):
            x, y, z = struct.unpack_from('<3f', BASE_TRIS, 50 * i + 12 + 12 * v)
            lo = [min(lo[0], x), min(lo[1], y), min(lo[2], z)]; hi = [max(hi[0], x), max(hi[1], y), max(hi[2], z)]
    print('board bbox x', round(lo[0], 1), round(hi[0], 1), 'y', round(lo[1], 1), round(hi[1], 1), 'z', round(lo[2], 2), round(hi[2], 2))
    assert abs(lo[0] - OFF) < 1 and abs(hi[1] + OFF) < 1 and abs(lo[1] + OFF + HEIGHT) < 1 and abs(lo[2]) < .1 and 1.4 < hi[2] < 1.7, 'unexpected frame'
    return hi[2]


def write(out, header):
    out.write_bytes(header[:80].ljust(80, b' ') + struct.pack('<I', BASE_N + len(BODIES) * 12) + BASE_TRIS + b''.join(box(*b) for b in BODIES))
    print({'board_triangles': BASE_N, 'bodies': len(BODIES), 'out': str(out), 'bytes': out.stat().st_size})


def main():
    top = read_base(BASE)
    build(top)   # front parts stand on the board body's top face as exported
    write(OUT, b'KINO D4 dev carrier D1 clearance print: board and component envelopes')


if __name__ == '__main__':
    import sys
    {'slab': slab, 'fit': fit, 'parts': parts}.get(sys.argv[1] if sys.argv[1:] else '', main)()
