"""Dev carrier D1 as one printable STL for a clearance check.

Base: kicad-cli's STL of the board body with the connector, socket and switch models
(component filter J*, JP*, SW*: no bare pins, loops or passives). Added here, as boxes, the
bodies the footprints do not carry: the two 1x7 socket strips per node, the XIAO ESP32-S3
Sense module with its camera board and lens, the mated 26-way IDC plug on J100 with a
ribbon stub over the left edge, and the JST XH housing if its model is missing.

  kicad-cli pcb export stl --no-dnp --component-filter "J*,JP*,SW*" --subst-models -o outputs/D1-3d-base.stl BOARD
  python design/print3d.py            -> outputs/D1-print.stl

STEP/STL frame: x = board x, y = -board y, z up on the front face, in mm, with the drawing
offset (50, 50) that build.py uses. Checked against the exported board body's bounding box.
"""
import struct
from pathlib import Path
from placement import CAMERA_X, CAMERA_Y, PLACE, WIDTH, HEIGHT

ROOT = Path(__file__).resolve().parent.parent
BASE, OUT = ROOT / 'outputs/D1-3d-base.stl', ROOT / 'outputs/D1-print.stl'
OFF = 50.0

# Bodies in board mm: (x1, y1, x2, y2, z_bottom, z_top), z from the front face (negative = P4 face).
SOCKET_H, XIAO = 8.5, (21.0, 17.5)   # Wurth 61300711821 socket height; XIAO ESP32-S3 outline
BODIES = []
for cx in CAMERA_X:
    for dx in (-7.62, 7.62):   # the two 1x7 socket strips
        BODIES.append((cx + dx - 1.27, CAMERA_Y - 8.89, cx + dx + 1.27, CAMERA_Y + 8.89, 0, SOCKET_H))
    x1, y1 = cx - XIAO[0] / 2 * 17.5 / 21.0, CAMERA_Y - XIAO[0] / 2   # module: 17.5 wide (x), 21 long (y)
    x1, x2 = cx - XIAO[1] / 2, cx + XIAO[1] / 2
    y1, y2 = CAMERA_Y - XIAO[0] / 2, CAMERA_Y + XIAO[0] / 2
    BODIES.append((x1, y1, x2, y2, SOCKET_H, SOCKET_H + 1.0))                  # module PCB
    BODIES.append((x1 + 1, y1 + 1, x2 - 1, y2 - 1, SOCKET_H + 1.0, SOCKET_H + 4.0))   # shield and parts
    BODIES.append((cx - 4.5, y1 - 1.3, cx + 4.5, y1 + 6.0, SOCKET_H + 1.0, SOCKET_H + 4.3))   # USB-C receptacle, over the top edge
    BODIES.append((x1, y1 + 2, x2, y2, SOCKET_H + 4.0, SOCKET_H + 5.2))        # Sense expansion board
    BODIES.append((cx - 4.0, CAMERA_Y - 1.0, cx + 4.0, CAMERA_Y + 7.0, SOCKET_H + 5.2, SOCKET_H + 10.0))   # camera module and lens
# Mated IDC plug on J100 (pin 1 at PLACE['J100'], rows along +y, columns at x and x+2.54), ribbon stub over the left edge.
jx, jy = PLACE['J100'][0], PLACE['J100'][1]
cxj, cyj = jx + 1.27, jy + 6 * 2.54
BODIES.append((cxj - 4.5, cyj - 19.3, cxj + 4.5, cyj + 19.3, 0, 9.1))        # shroud (the model has it; harmless twice)
BODIES.append((cxj - 4.3, cyj - 17.0, cxj + 4.3, cyj + 17.0, 9.1, 15.5))     # IDC socket body and strain relief
BODIES.append((-12.0, cyj - 16.5, cxj - 4.3, cyj + 16.5, 12.0, 13.0))        # ribbon leaving over the left edge
# JST XH 6-way housing at J1001 (pins along -y from pin 1 at rotation 270): 17.5 x 5.75 x 7 mm.
px, py = PLACE['J1001'][0], PLACE['J1001'][1]
BODIES.append((px - 2.9, py - 2.45, px + 2.9, py + 12.5 + 2.45, 0, 7.0))


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
        body = b''.join(tri(verts[i], verts[i + 1], verts[i + 2]) for i in range(0, len(verts) - 2, 3))
        n = len(verts) // 3
    else:
        n = struct.unpack_from('<I', data, 80)[0]
        body = data[84:84 + 50 * n]
    # Bounding box of the base, to confirm the frame.
    lo, hi = [1e9] * 3, [-1e9] * 3
    for i in range(n):
        for v in range(3):
            x, y, z = struct.unpack_from('<3f', body, 50 * i + 12 + 12 * v)
            lo = [min(lo[0], x), min(lo[1], y), min(lo[2], z)]; hi = [max(hi[0], x), max(hi[1], y), max(hi[2], z)]
    print('base bbox x', round(lo[0], 1), round(hi[0], 1), 'y', round(lo[1], 1), round(hi[1], 1), 'z', round(lo[2], 1), round(hi[2], 1))
    assert abs((hi[0] - lo[0]) - WIDTH) < 20 and abs(lo[0] - OFF) < 1, 'unexpected x frame'
    assert abs(hi[1] + OFF) < 1 and abs(lo[1] + OFF + HEIGHT) < 1, 'unexpected y frame (expected y = -board y)'
    extra = b''.join(box(*b) for b in BODIES)
    header = b'KINO D4 dev carrier D1, board with connector and module bodies for a clearance print'.ljust(80, b' ')
    OUT.write_bytes(header + struct.pack('<I', n + len(BODIES) * 12) + body + extra)
    print({'base_triangles': n, 'bodies': len(BODIES), 'out': str(OUT), 'bytes': OUT.stat().st_size})


if __name__ == '__main__':
    main()
