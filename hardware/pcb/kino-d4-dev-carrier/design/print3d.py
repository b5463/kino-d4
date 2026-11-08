"""Dev carrier D1 as one printable STL for a clearance check: the board body from KiCad (outline
and holes) and every component as a plain box at its datasheet envelope. No pins, no mated
plugs, no detailed connector models, no XIAO modules: what a PLA print can hold and what a
clearance check needs. The J100 shroud is hollow, with its key notch, so a real IDC socket
drops in.

  kicad-cli pcb export stl --board-only -o outputs/D1-3d-base.stl KINO_D4_Dev_Carrier_D1.kicad_pcb
  python design/print3d.py            -> outputs/D1-print.stl

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


def build(top):
    for p in PARTS:
        fp = p['footprint']
        if fp.startswith(SKIP):
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


def main():
    data = BASE.read_bytes()
    if data[:5] == b'solid' and b'facet' in data[:2000]:   # ASCII STL: rebuild the binary triangle list
        import re
        verts = [tuple(map(float, m)) for m in re.findall(rb'vertex\s+(\S+)\s+(\S+)\s+(\S+)', data)]
        base = b''.join(tri(verts[i], verts[i + 1], verts[i + 2]) for i in range(0, len(verts) - 2, 3))
        n = len(verts) // 3
    else:
        n = struct.unpack_from('<I', data, 80)[0]
        base = data[84:84 + 50 * n]
    lo, hi = [1e9] * 3, [-1e9] * 3
    for i in range(n):
        for v in range(3):
            x, y, z = struct.unpack_from('<3f', base, 50 * i + 12 + 12 * v)
            lo = [min(lo[0], x), min(lo[1], y), min(lo[2], z)]; hi = [max(hi[0], x), max(hi[1], y), max(hi[2], z)]
    print('board bbox x', round(lo[0], 1), round(hi[0], 1), 'y', round(lo[1], 1), round(hi[1], 1), 'z', round(lo[2], 2), round(hi[2], 2))
    assert abs(lo[0] - OFF) < 1 and abs(hi[1] + OFF) < 1 and abs(lo[1] + OFF + HEIGHT) < 1 and abs(lo[2]) < .1 and 1.4 < hi[2] < 1.7, 'unexpected frame'
    build(hi[2])   # front parts stand on the board body's top face as exported
    header = b'KINO D4 dev carrier D1 clearance print: board and component envelopes'[:80].ljust(80, b' ')
    OUT.write_bytes(header + struct.pack('<I', n + len(BODIES) * 12) + base + b''.join(box(*b) for b in BODIES))
    print({'board_triangles': n, 'bodies': len(BODIES), 'out': str(OUT), 'bytes': OUT.stat().st_size})


if __name__ == '__main__':
    main()
