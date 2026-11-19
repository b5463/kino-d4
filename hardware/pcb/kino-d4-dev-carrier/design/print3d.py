"""Dev carrier D1 as one printable STL for a clearance check: the board body from KiCad (outline
and holes) and every component as a plain box at its datasheet envelope. No pins, no mated
plugs, no detailed connector models, no XIAO modules: what a PLA print can hold and what a
clearance check needs. The J100 socket is a box on the P4 face, 8.5 mm, so the stack height
drops in.

  kicad-cli pcb export stl --board-only -o outputs/D1-3d-base.stl KINO_D4_Dev_Carrier_D1.kicad_pcb
  python design/print3d.py            -> outputs/D1-print.stl
  python design/print3d.py slab       -> outputs/D1-slab.stl: the outline with the USB window, the four M2 holes
                                         (2.6 mm), the J100 2x13 socket and the eight 1x07 socket rows as 1.7 mm
                                         holes (real socket strips push in; FDM holes print small);
                                         nothing else, for the JP1 datum and the XIAO fit before the quote.
  python design/print3d.py fit        -> outputs/D1-fit.stl: the slab plus the cable-side connectors
  python design/print3d.py pouch      -> outputs/D1-pouch.stl: the 505573 pouch dummy, for the battery placement
  python design/print3d.py plates     -> outputs/D1-plate.stl and .3mf: the flat fit plate (outline, USB window, M2 and
                                         socket holes) with the ODD JOBS symbol pocketed, drawn larger by the filament's
                                         shrink (`plates petg`); gauge -> the header gauge, see below
  python design/print3d.py assembly petg -> outputs/D1-assembly-petg.stl: the board as ordered (1.6 mm, the window and
                                         holes) with every component box on both faces, the four XIAO Sense modules on
                                         their sockets (21.0 x 17.8 x 15.0, hardware/BOM.csv) and the J100 socket as an
                                         8.5 mm block with 26 through-holes, so the print pushes onto the P4's header
                                         like the real board. Print it P4 face down with supports under the board.

STL frame (checked against the exported board body): x = board x + 50, y = -(board y + 50),
board body from z 0 (P4 face) up to its top face (about 1.5 mm, read from the file). Front
parts stand on the top face, back parts hang below z 0. Sizes are datasheet envelopes
(w along the footprint's x, l along its y, h).
"""
import math
import struct
from pathlib import Path
from circuit import PARTS
from placement import PLACE, HEIGHT, EDGE, CORNER_R

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
    'KINO_DEV:PinSocket_2x13_P2.54mm_Vertical_Pad1.5': (5.08, 33.02, 8.5, -1.27, 15.24),   # pin 2 at -x in the footprint
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


XIAO = (17.8, 21.0, 15.0)   # the XIAO ESP32-S3 Sense with its camera board, seated: x across the rows, y along them, height above the socket (hardware/BOM.csv)


def build(top, refs=None, exclude=(), modules=False):
    """Every part as its envelope, or only the refs listed; `modules` seats a XIAO on each socket pair."""
    for p in PARTS:
        fp = p['footprint']
        if fp.startswith(SKIP) or (refs is not None and p['ref'] not in refs) or p['ref'] in exclude:
            continue
        x, y, deg, side = PLACE[p['ref']]
        if fp == 'KINO_DEV:XIAO_Socket_15.24mm':   # two 1x07 socket strips, 8.5 mm; the module on them if asked
            for dx in (-7.62, 7.62):
                body(x + dx, y, 2.54, 17.78, top, top + 8.5)
            if modules:
                body(x, y, XIAO[0], XIAO[1], top + 8.5, top + 8.5 + XIAO[2])
            continue
        if fp not in ENVELOPE:
            print('no envelope for', p['ref'], fp)
            continue
        w, l, h, ox, oy = ENVELOPE[fp]
        dx, dy = rot(ox, oy, deg)
        if side == 'B':
            dy = -dy   # a flipped footprint: KiCad rotates, then mirrors about the x axis (checked on J100, J1000, J102 pads)
        if deg % 180:
            w, l = l, w
        if side == 'F':
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


SOCKETS = {'J100', 'J200', 'J300', 'J400', 'J500'}


def slab_base(out, keep=SOCKETS):
    """A board copy holding only the outline (with the USB window), the M2 holes (opened to PRINT_M2) and
    the J100 and XIAO socket rows (drills opened to PRINT_PIN so a PLA print takes a real 2.54 mm socket
    strip: FDM holes come out 0.3-0.4 mm under), exported by kicad-cli as the slab body."""
    import os
    import shutil
    import subprocess
    import tempfile
    import pcbnew as pcb
    b = pcb.LoadBoard(str(ROOT / 'KINO_D4_Dev_Carrier_D1.kicad_pcb'))
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
            d = PRINT_PIN if ref in keep else PRINT_M2
            for pad in fp.Pads():
                pad.SetDrillSize(pcb.VECTOR2I(pcb.FromMM(d), pcb.FromMM(d)))
                pad.SetSize(pcb.F_Cu, pcb.VECTOR2I(pcb.FromMM(d + .6), pcb.FromMM(d + .6)))
                pad.SetSize(pcb.B_Cu, pcb.VECTOR2I(pcb.FromMM(d + .6), pcb.FromMM(d + .6)))
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


# Print hole sizes, mm: FDM holes come out 0.3-0.4 mm under the model. 0.64 mm square pins want about
# 1.3 mm printed; an M2 screw wants 2.2 mm.
PRINT_PIN, PRINT_M2 = 1.7, 2.6
# The cable side of the board, for the fit print: every connector a lead plugs into, and the LINK
# headers that sit beside the XIAO USB plugs. J100 is in the slab as holes.
CABLE_REFS = {'J1001', 'J103', 'J101', 'JP200', 'JP300', 'JP400', 'JP500'}

# The battery, from docs/HARDWARE.md (a size-code figure, to be measured): 505573 pouch 5 x 55 x 73 mm
# with a PH2.0 lead on a short edge. It connects to the P4, so no power-module dummy; the bench spacers exist.
POUCH = (73.0, 55.0, 5.0)

# The plates' mark: the ODD JOBS symbol (the carrier brand file silk.py also draws), a vector outline
# pocketed into the top face. The plate itself is built here from the outline, the USB window and the
# hole circles (an even-odd polygon set, extruded with an exact trapezoid sweep), because a pocket cannot
# be added to kicad-cli's exported body.
MARK = ROOT.parent / 'kino-d4-carrier-a0/brand/odd-jobs-symbol.json'
PLATE_T, POCKET = 1.5, 0.6         # plate thickness; the mark's depth (three 0.2 mm layers)
MARK_W, MARK_AT = 12.0, (2.5, 2.5)   # width and the top-left corner, board frame
BLUE = '#0A2989FF'                 # Bambu Basic Blue, for the 3MF's material colour (an STL has no colour)
GAUGE_WINDOW = (90.0, 14.0, 112.0, 58.0)   # the gauge plate's window over the P4 header and USB-C ports, board frame (round numbers: the ticks count from its top-left corner)
TICK_W, TICK_GAP = 0.5, 0.3         # tick pocket width; the plate left between the window edge and the tick
SHRINK = {'pla': 1.003, 'petg': 1.005}   # the filament cools this much smaller; the plates are drawn larger about their centre so the printed
                                         # holes land on the P4's pitch. The first plate (PETG, drawn 1.000) mated on the header; the column of
                                         # holes 22 mm from it fitted and the column 84 mm from it sat ~0.4 mm toward the header, which 0.5 % is.
                                         # `plates petg` / `plates pla`, default pla. Caliper a print's M2 pitch (61.9 x 54.8) to confirm.
MATERIAL = 'pla'


def ring_area(r):
    return sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r))) / 2


def inside(p, r):
    x, y = p; c = False
    for i in range(len(r)):
        (x1, y1), (x2, y2) = r[i], r[(i + 1) % len(r)]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            c = not c
    return c


def extrude(rings, z0, z1):
    """Triangles (binary STL records) for an even-odd polygon set in STL x y, from z0 to z1. Manifold:
    the walls are split at every vertex level and the cap strips share every point on their common
    levels, so each edge belongs to exactly two triangles."""
    out = []
    rings = [[(round(x, 4), round(y, 4)) for x, y in r] for r in rings]   # snap: mirrored circle vertices must share a level exactly
    oriented = []
    for r in rings:   # a ring with an even number of rings around it is a boundary, CCW outward
        depth = sum(inside(r[0], o) for o in rings if o is not r)
        if (ring_area(r) > 0) != (depth % 2 == 0):
            r = r[::-1]
        oriented.append(r)
    edges = [(r[i], r[(i + 1) % len(r)]) for r in oriented for i in range(len(r))]
    levels = sorted({p[1] for r in rings for p in r})

    def tx(e, y):   # one formula everywhere, so shared points are bit-identical; an endpoint is itself, not a rounding of it
        (x1, y1), (x2, y2) = e
        return x1 if y == y1 else x2 if y == y2 else x1 + (y - y1) * (x2 - x1) / (y2 - y1)
    at = {y: set() for y in levels}   # every boundary point on each level
    for e in edges:
        (x1, y1), (x2, y2) = e
        if y1 == y2:
            at[y1].update((x1, x2))
        else:
            for y in levels:
                if min(y1, y2) <= y <= max(y1, y2):
                    at[y].add(tx(e, y))
    for e in edges:   # walls, split at the levels they cross (and horizontal ones at the points on their level)
        (x1, y1), (x2, y2) = e
        if y1 == y2:
            xs = sorted((x for x in at[y1] if min(x1, x2) <= x <= max(x1, x2)), reverse=x2 < x1)
            pts = [(x, y1) for x in xs]
        else:
            ys = sorted((y for y in levels if min(y1, y2) <= y <= max(y1, y2)), reverse=y2 < y1)
            pts = [(tx(e, y), y) for y in ys]
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            out.append(tri((ax, ay, z0), (bx, by, z0), (bx, by, z1)))
            out.append(tri((ax, ay, z0), (bx, by, z1), (ax, ay, z1)))
    for ya, yb in zip(levels, levels[1:]):   # caps: the crossings at the strip's middle pair up even-odd
        ym = (ya + yb) / 2
        xs = sorted((tx(e, ym), e) for e in edges if min(e[0][1], e[1][1]) < ym < max(e[0][1], e[1][1]))
        for (_, e0), (_, e1) in zip(xs[0::2], xs[1::2]):
            a0, a1, b0, b1 = tx(e0, ya), tx(e1, ya), tx(e0, yb), tx(e1, yb)
            L = sorted(x for x in at[ya] if a0 <= x <= a1)   # the low chain and the high chain, left to right
            H = sorted(x for x in at[yb] if b0 <= x <= b1)
            i = j = 0
            while i < len(L) - 1 or j < len(H) - 1:   # zip the two chains, advancing the one whose next point is left
                if j == len(H) - 1 or (i < len(L) - 1 and L[i + 1] <= H[j + 1]):
                    p, q, s = (L[i], ya), (L[i + 1], ya), (H[j], yb); i += 1
                else:
                    p, q, s = (L[i], ya), (H[j + 1], yb), (H[j], yb); j += 1
                out.append(tri((*p, z1), (*q, z1), (*s, z1)))
                out.append(tri((*p, z0), (*s, z0), (*q, z0)))
    return out


def plate_holes(keep):
    """Board frame (x, y, printed drill) of every hole the plate keeps: the M2 inserts and the socket pads."""
    import pcbnew as pcb
    b = pcb.LoadBoard(str(ROOT / 'KINO_D4_Dev_Carrier_D1.kicad_pcb'))
    holes = []
    for fp in b.GetFootprints():
        ref = fp.GetReference()
        if ref in keep or ref.startswith('H'):
            for pad in fp.Pads():
                p = pad.GetPosition()
                holes.append((p.x / 1e6 - OFF, p.y / 1e6 - OFF, PRINT_PIN if ref in keep else PRINT_M2))
    return holes


stl = lambda x, y: (OFF + x, -(OFF + y))
rect = lambda x1, y1, x2, y2: [stl(x1, y1), stl(x2, y1), stl(x2, y2), stl(x1, y2)]


def outline(n=8):
    """The board outline in STL coordinates: EDGE with CORNER_R at every corner."""
    x1, y1, x2, y2 = EDGE
    r = CORNER_R
    pts = []
    for cx, cy, a0 in ((x2 - r, y1 + r, -90), (x2 - r, y2 - r, 0), (x1 + r, y2 - r, 90), (x1 + r, y1 + r, 180)):
        pts += [stl(cx + r * math.cos(math.radians(a0 + 90 * i / n)), cy + r * math.sin(math.radians(a0 + 90 * i / n))) for i in range(n + 1)]
    return pts


def plate_tris(holes, window=None, pockets=(), mark=True):
    """The plate body: outline with the window and the holes, the mark (and any extra pockets) POCKET deep into the top."""
    import json
    circle = lambda x, y, d, n=48: [stl(x + d / 2 * math.cos(2 * math.pi * i / n), y + d / 2 * math.sin(2 * math.pi * i / n)) for i in range(n)]
    from placement import USB_WINDOW
    rings = [outline(), rect(*(window or USB_WINDOW))] + [circle(x, y, d) for x, y, d in holes]
    cx, cy = stl((EDGE[0] + EDGE[2]) / 2, (EDGE[1] + EDGE[3]) / 2)
    s = SHRINK[MATERIAL]
    grow = lambda r: [(cx + (x - cx) * s, cy + (y - cy) * s) for x, y in r]   # shrink compensation, about the plate's centre
    rings = [grow(r) for r in rings]
    if not mark and not pockets:   # the flat plate: one shell, nothing on it
        return b''.join(extrude(rings, 0.0, PLATE_T))
    m = json.loads(MARK.read_text(encoding='utf-8'))
    s = MARK_W / (m['pixel_bounds'][2] - 1)
    top = [grow(r) for r in ([[stl(MARK_AT[0] + a * s, MARK_AT[1] + c * s) for a, c in m['points']]] if mark else []) + list(pockets)]
    # Two shells sharing the pocket floor: the full plate under it, the top layer with the pockets cut out.
    return b''.join(extrude(rings, 0.0, PLATE_T - POCKET + 0.05) + extrude(rings + top, PLATE_T - POCKET, PLATE_T))


def ticks():
    """Millimetre ticks pocketed outside the gauge window: along its top edge for x, down its left edge for y.
    1 mm long, 2 mm at every 5, 3 mm at every 10, counted from the board frame's origin."""
    x1, y1, x2, y2 = GAUGE_WINDOW
    L = lambda v: 3.0 if v % 10 == 0 else 2.0 if v % 5 == 0 else 1.0
    out = []
    for x in range(int(x1), int(x2) + 1):   # above the top edge
        out.append(rect(x - TICK_W / 2, y1 - TICK_GAP - L(x), x + TICK_W / 2, y1 - TICK_GAP))
    for y in range(int(y1), int(y2) + 1):   # left of the left edge
        out.append(rect(x1 - TICK_GAP - L(y), y - TICK_W / 2, x1 - TICK_GAP, y + TICK_W / 2))
    return out


def slab():
    base = ROOT / 'outputs/D1-3d-slab-base.stl'
    slab_base(base)
    top = read_base(base)
    write(ROOT / 'outputs/D1-slab.stl', b'KINO D4 dev carrier D1 slab: outline, USB window, M2 holes, J100 and XIAO socket holes')


def fit():
    """The slab plus the cable side: J1001 power, J103 shutter, J101 C6 service and the
    four LINK headers, so every lead can be plugged and dressed around the XIAOs."""
    base = ROOT / 'outputs/D1-3d-slab-base.stl'
    slab_base(base)
    top = read_base(base)
    build(top, CABLE_REFS)
    write(ROOT / 'outputs/D1-fit.stl', b'KINO D4 dev carrier D1 fit: slab with the cable-side connectors')


PLATES = (('', SOCKETS, 'outline, USB window, M2 holes, J100 and XIAO socket holes, the mark pocketed'),)
GAUGE = (('-gauge', set(), 'outline, M2 holes, a window over the P4 header with mm ticks from (90, 14)'),)


def gauge():
    """The header gauge: screwed to the four inserts, its window shows JP1 and the USB-C ports against mm ticks.
    Read pin 1's column and row off the ticks; the difference to P4_JP1 is the correction."""
    plates(GAUGE, 'D1-gauge', GAUGE_WINDOW, ticks())


def flat():
    """The flat check plate: the outline, the USB window, the four M2 holes and every socket hole, nothing else
    on either face; drawn larger by the filament's shrink (`flat petg`). For the last fit check before ordering."""
    plates((('', SOCKETS, 'outline, USB window, M2 holes, J100 and XIAO socket holes, nothing else'),), 'D1-flat', mark=False)


def plates(which=PLATES, stem='D1-plate', window=None, pockets=(), mark=True):
    """The fit plate: the slab with the ODD JOBS symbol pocketed into its top face. Flat, no supports;
    the 3MF carries it in blue. PLATES can hold more than one (name suffix, kept refs, note); they go
    side by side on one bed."""
    import json
    import subprocess
    import tempfile
    x1, y1, x2, y2 = EDGE
    tris = {}
    PLATES = which
    for n, (name, keep, what) in enumerate(PLATES, 1):
        holes = Path(tempfile.mkdtemp(prefix='d1-plate-')) / 'holes.json'   # pcbnew loads one board per process
        subprocess.run([sys.executable, __file__, '_holes', str(holes), *sorted(keep)], check=True, capture_output=True)
        data = plate_tris(json.loads(holes.read_text()), window, pockets, mark)
        out = ROOT / f'outputs/{stem}{name}.stl'
        out.write_bytes(f'KINO D4 dev carrier D1 plate: {what}'.encode()[:80].ljust(80, b' ') + struct.pack('<I', len(data) // 50) + data)
        print({'plate': name, 'holes': len(json.loads(holes.read_text())), 'triangles': len(data) // 50, 'out': str(out), 'bytes': out.stat().st_size})
        tris[name] = data
    pitch = y2 - y1 + 10.0   # the plates stacked along the bed's y, 10 mm apart
    objs, items = [], []
    for i, (name, _, _) in enumerate(PLATES):
        t = tris[name]
        verts, idx, faces = [], {}, []
        for k in range(len(t) // 50):
            fc = []
            for v in range(3):
                p = struct.unpack_from('<3f', t, 50 * k + 12 + 12 * v)
                p = (round(p[0] - OFF - x1, 4), round(p[1] + OFF + y2, 4), round(p[2], 4))   # plate corner at the origin
                if p not in idx:
                    idx[p] = len(verts); verts.append(p)
                fc.append(idx[p])
            faces.append(fc)
        objs.append(f'  <object id="{i + 1}" name="D1-plate{name}" type="model" pid="10" pindex="0"><mesh><vertices>'
                    + ''.join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in verts)
                    + '</vertices><triangles>' + ''.join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in faces)
                    + '</triangles></mesh></object>\n')
        items.append(f'  <item objectid="{i + 1}" transform="1 0 0 0 1 0 0 0 1 0 {i * pitch:.3f} 0"/>\n')
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n'
             '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
             ' <metadata name="Title">KINO D4 dev carrier D1 fit plates</metadata>\n <resources>\n'
             f'  <basematerials id="10"><base name="Bambu {MATERIAL.upper()} Basic Blue" displaycolor="{BLUE}"/></basematerials>\n' + ''.join(objs)
             + ' </resources>\n <build>\n' + ''.join(items) + ' </build>\n</model>\n')
    import zipfile
    out = ROOT / f'outputs/{stem}.3mf'
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n'
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n')
        z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n')
        z.writestr('3D/3dmodel.model', model)
    print({'out': str(out), 'plates': [n for n, _, _ in PLATES], 'material': MATERIAL, 'drawn_x': SHRINK[MATERIAL], 'pitch_y': pitch, 'bytes': out.stat().st_size})


PCB_T = 1.6                 # the board as ordered
SOCKET_W, SOCKET_PIN = 5.8, 1.5   # the J100 block: 0.36 mm wider a side than the 5.08 socket so a 0.4 mm nozzle gets two walls
                                  # outside the 1.5 mm pin holes (0.64 mm square pins, 0.9 across the corners; FDM holes print ~0.3 under)
LAP = 0.05                  # a solid overlaps what it stands on by this, so the slicer unions the shells
PIN = 1.0                   # a printed header pin: 0.64 mm square really; 1.0 is two perimeters
MARK_DEPTH = 0.4            # the silk mark pocketed into the front face

# --- part models for the assembly: lists of (rings, z0, z1) in the footprint frame (x right, y down, z away
# from the board), each an even-odd polygon set extruded between z0 and z1. Sizes from the footprints'
# F.Fab outlines and the vendor envelopes; cavities only where a 0.4 mm nozzle keeps two walls.

def R(x1, y1, x2, y2):
    return [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]


def C(x, y, d, n=24):
    return [(x + d / 2 * math.cos(2 * math.pi * i / n), y + d / 2 * math.sin(2 * math.pi * i / n)) for i in range(n)]


def RR(x1, y1, x2, y2, r, n=6):
    """A rounded rectangle, r at every corner."""
    pts = []
    for cx, cy, a0 in ((x2 - r, y1 + r, -90), (x2 - r, y2 - r, 0), (x1 + r, y2 - r, 90), (x1 + r, y1 + r, 180)):
        pts += [(cx + r * math.cos(math.radians(a0 + 90 * i / n)), cy + r * math.sin(math.radians(a0 + 90 * i / n))) for i in range(n + 1)]
    return pts


def notch(x1, y1, x2, y2, nx1, nx2, ny, face='+y'):
    """The rectangle with a slot cut in from its +y face (from y = ny to y2) or its -y face (y1 to ny), between nx1 and nx2."""
    if face == '-y':
        return [(x1, y1), (nx1, y1), (nx1, ny), (nx2, ny), (nx2, y1), (x2, y1), (x2, y2), (x1, y2)]
    return [(x1, y1), (x2, y1), (x2, y2), (nx2, y2), (nx2, ny), (nx1, ny), (nx1, y2), (x1, y2)]


def ramp(ring, z0, z1, step=0.2):
    """A staircase of `step` layers from z0 to z1, each layer the polygon ring(t) at its top, t from 0 to 1:
    an overhang printed without support when the ring grows no faster than the layers rise (45 degrees)."""
    n = max(1, round((z1 - z0) / step))
    return [([ring((i + 1) / n)], z0 + (z1 - z0) * i / n - LAP, z0 + (z1 - z0) * (i + 1) / n) for i in range(n)]


def xiao_station(n_strip=7):
    """Two 1x07 socket strips with their pin holes, and the XIAO ESP32-S3 Sense seated on them: the module PCB,
    its USB-C (opening over the pin-1 end), the Sense board, the microSD slot at the USB end, the OV3660 head
    and lens barrel 6.95 mm toward the other end. Heights: the Sense board's top face 7.6 above the XIAO's back
    face and the lens front 15.0 (both measured, KINO_FIELD_BODY).
    The air in the real stack is filled so the print stands without support: a block between the strips up to
    the PCB, 45-degree ramps under the PCB ends and under the USB-C lip, and a block from the PCB to the Sense
    board (the ESP32-S3 can and the board-to-board stand-off are inside it, as they are under the real Sense
    board). A support tower under these failed: its PLA foot does not bond to the PETG board."""
    s = []
    for sx in (-7.62, 7.62):
        s.append(([R(sx - 1.27, -8.89, sx + 1.27, 8.89)], 0, 5.6))
        s.append(([R(sx - 1.27, -8.89, sx + 1.27, 8.89)] + [C(sx, -7.62 + 2.54 * i, 1.0) for i in range(n_strip)], 5.5, 8.5))
    z = 8.5
    s.append(([R(-6.35 - LAP, -8.89, 6.35 + LAP, 8.89)], 0, z))                      # between the strips, up to the PCB
    s += ramp(lambda t: RR(-8.9, -(8.89 + 1.61 * t), 8.9, 8.89 + 1.61 * t, 2.4), z - 1.6, z)   # under the PCB's ends
    s.append(([RR(-8.9, -10.5, 8.9, 10.5, 2.4)], z - LAP, z + 1.2))                   # the XIAO PCB
    s += ramp(lambda t: R(-4.47, -10.5 - 1.3 * t, 4.47, -10.5), z, z + 1.2)          # under the USB-C's lip past the PCB end
    s.append(([R(-4.47, -11.8, 4.47, -4.45)], z + 1.2 - LAP, z + 2.0))                              # USB-C: floor
    s.append(([notch(-4.47, -11.8, 4.47, -4.45, -3.3, 3.3, -7.0, '-y')], z + 2.0 - LAP, z + 3.6))   # ... the opening, over the module end
    s.append(([R(-4.47, -11.8, 4.47, -4.45)], z + 3.6 - LAP, z + 4.4))              # ... lid
    s.append(([RR(-8.9, -10.5, 8.9, 10.5, 2.4)], z + 1.2 - LAP, z + 6.6))           # PCB to Sense board, solid
    s.append(([RR(-8.9, -10.5, 8.9, 10.5, 2.4)], z + 6.6 - LAP, z + 7.6))           # the Sense board
    s.append(([R(-6.0, -10.0, 6.0, 1.0)], z + 7.6 - LAP, z + 9.1))                  # microSD slot, USB end
    s.append(([R(-4.25, 6.95 - 4.25, 4.25, 6.95 + 4.25)], z + 7.6 - LAP, z + 12.0))  # the camera head
    s.append(([C(0, 6.95, 5.6, 32)], z + 12.0 - LAP, z + 14.2))                      # the lens barrel
    s.append(([C(0, 6.95, 5.6, 32), C(0, 6.95, 2.4, 24)], z + 14.2 - LAP, z + 15.0))  # ... with the aperture
    return s


XIAO_HOLE, XIAO_FLOOR = 1.1, 1.5   # the printed socket: 1.1 mm drawn prints about 0.8, a press fit on the 0.64 mm pin
                                   # (0.9 across the corners); 1.5 mm floor under 7 mm of hole for a 6 mm pin


def xiao_sockets(n_strip=7):
    """Two 1x07 socket bodies, 8.5 mm, printed as the female header: blind holes from the top the real
    XIAO's pins press into, so the real module plugs in at the real height."""
    s = []
    for sx in (-7.62, 7.62):
        s.append(([R(sx - 1.27, -8.89, sx + 1.27, 8.89)], 0, XIAO_FLOOR + LAP))
        s.append(([R(sx - 1.27, -8.89, sx + 1.27, 8.89)] + [C(sx, -7.62 + 2.54 * i, XIAO_HOLE) for i in range(n_strip)], XIAO_FLOOR, 8.5))
    return s


def pin_header(n):
    """Pin 1 at the origin, the row along +y; 2.5 mm body, 6 mm of pin above it."""
    L = (n - 1) * 2.54
    s = [([R(-1.27, -1.27, 1.27, L + 1.27)], 0, 2.5)]
    s += [([R(-PIN / 2, 2.54 * i - PIN / 2, PIN / 2, 2.54 * i + PIN / 2)], 2.5 - LAP, 8.5) for i in range(n)]
    return s


def pin_socket_2x13():
    """The J100 block, pin 1 at the origin, pin 2 at -x, rows down +y; through-holes for the P4's header pins."""
    cx, cy, L = -1.27, 15.24, 33.02
    pins = [C(-2.54 * c, 2.54 * r, SOCKET_PIN, 32) for r in range(13) for c in range(2)]
    return [([R(cx - SOCKET_W / 2, cy - L / 2, cx + SOCKET_W / 2, cy + L / 2)] + pins, 0, 8.5)]


def xh_vertical(n):
    """JST XH B*B-XH-A: pin 1 at the origin, pins along +x; the housing open at the top with the pins inside."""
    x2 = (n - 1) * 2.5 + 2.45
    s = [([R(-2.45, -2.35, x2, 3.4)], 0, 1.2)]
    s.append(([R(-2.45, -2.35, x2, 3.4), R(-2.45 + 0.8, -2.35 + 0.8, x2 - 0.8, 3.4 - 0.8)], 1.2 - LAP, 7.0))
    s += [([R(2.5 * i - PIN / 2, -PIN / 2, 2.5 * i + PIN / 2, PIN / 2)], 1.2 - LAP, 6.0) for i in range(n)]
    return s


def sh_horizontal():
    """JST SH SM04B-SRSS-TB: 6.0 x 4.25 x 2.9, the cable enters at the +y face."""
    return [([R(-3, -1.675, 3, 2.575)], 0, 0.6),
            ([notch(-3, -1.675, 3, 2.575, -2.3, 2.3, 0.3)], 0.6 - LAP, 2.3),
            ([R(-3, -1.675, 3, 2.575)], 2.3 - LAP, 2.9)]


def usb_c():
    """GCT USB4105: 8.94 x 7.35 x 3.26 shell, the plug enters at the +y face."""
    return [([R(-4.47, -3.675, 4.47, 3.675)], 0, 0.5),
            ([notch(-4.47, -3.675, 4.47, 3.675, -3.5, 3.5, -2.0)], 0.5 - LAP, 2.76),
            ([R(-4.47, -3.675, 4.47, 3.675)], 2.76 - LAP, 3.26)]


def smd(w, l, h, ox=0, oy=0):
    return [([R(ox - w / 2, oy - l / 2, ox + w / 2, oy + l / 2)], 0, h)]


MODELS = {
    'KINO_DEV:XIAO_Socket_15.24mm': xiao_sockets,   # xiao_station draws the whole module instead, for a render
    'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical': lambda: pin_header(2),
    'Connector_PinHeader_2.54mm:PinHeader_1x06_P2.54mm_Vertical': lambda: pin_header(6),
    'KINO_DEV:PinSocket_2x13_P2.54mm_Vertical_Pad1.5': pin_socket_2x13,
    'Connector_JST:JST_XH_B2B-XH-A_1x02_P2.50mm_Vertical': lambda: xh_vertical(2),
    'Connector_JST:JST_XH_B6B-XH-A_1x06_P2.50mm_Vertical': lambda: xh_vertical(6),
    'Connector_JST:JST_SH_SM04B-SRSS-TB_1x04-1MP_P1.00mm_Horizontal': sh_horizontal,
    'KINO_DEV:USB_C_GCT_USB4105_KINO_GND0.05': usb_c,
}


def footprint_ring(ref, ring):
    """A ring in a footprint's frame, in STL coordinates: rotated, and mirrored about x on the back."""
    x, y, deg, side = PLACE[ref]
    q = []
    for px, py in ring:
        dx, dy = rot(px, py, deg)
        if side == 'B':
            dy = -dy
        q.append(stl(x + dx, y + dy))
    return q


def place_model(ref, fp, top):
    """A part's model in STL coordinates: the footprint frame rotated, mirrored about x on the back, and the
    z range set on the face it sits on (the first solid of each model stands on the board, so it overlaps it)."""
    side = PLACE[ref][3]
    solids = MODELS[fp]() if fp in MODELS else smd(*ENVELOPE[fp]) if fp in ENVELOPE else None
    if solids is None:
        print('no model for', ref, fp)
        return []
    out = []
    for rings, z0, z1 in solids:
        if z0 == 0:
            z0 = -LAP
        pts = [footprint_ring(ref, r) for r in rings]
        if side == 'F':
            out += extrude(pts, top + z0, top + z1)
        else:
            out += extrude(pts, -z1, -z0)
    return out


POCKET_GAP = 0.1   # the J100 block's locating pocket in the back face, this much wider a side than the block


def write_scaled(data, path, header, centre):
    """Write triangles drawn larger by the filament's shrink in x and y about `centre`; z is layer-true."""
    data = b''.join(data)
    s = SHRINK[MATERIAL]
    ox, oy = centre
    out = bytearray()
    for i in range(len(data) // 50):
        vs = []
        for k in range(3):
            x, y, z = struct.unpack_from('<3f', data, 50 * i + 12 + 12 * k)
            vs.append((ox + (x - ox) * s, oy + (y - oy) * s, z))
        out += tri(*vs)
    path.write_bytes(header.encode()[:80].ljust(80, b' ') + struct.pack('<I', len(out) // 50) + bytes(out))
    print({'out': str(path), 'material': MATERIAL, 'drawn_x': s, 'triangles': len(out) // 50, 'bytes': path.stat().st_size})


def assembly():
    """The assembled carrier, 1:1, for the stack check, as two prints that need no support:
    D1-assembly: the board with its holes, window and the silk mark pocketed, and every front-side part as a
      recognisable model (connectors with their openings and pins, the four XIAO Sense modules with camera
      and lens). The back face is flat, for the bed: the back-side parts are left off (small parts printed
      face-down onto a support interface tear off), except a 0.4 mm pocket where the J100 block glues on.
    D1-socket: the J100 block the P4's header pins enter, printed on its own, holes up; its glued end
      fills the pocket.
    Both drawn larger by the filament's shrink."""
    import json
    import subprocess
    import tempfile
    holes = Path(tempfile.mkdtemp(prefix='d1-asm-')) / 'holes.json'
    subprocess.run([sys.executable, __file__, '_holes', str(holes), 'J100'], check=True, capture_output=True)
    holes = [(x, y, SOCKET_PIN if d == PRINT_PIN else d) for x, y, d in json.loads(holes.read_text())]
    from placement import USB_WINDOW, MARGIN
    circle = lambda x, y, d, n=32: [stl(x + d / 2 * math.cos(2 * math.pi * i / n), y + d / 2 * math.sin(2 * math.pi * i / n)) for i in range(n)]
    board = [outline(), rect(*USB_WINDOW)]
    mounts = [circle(x, y, d) for x, y, d in holes if d != SOCKET_PIN]
    pins = [circle(x, y, d) for x, y, d in holes if d == SOCKET_PIN]
    cx, cy, L = -1.27, 15.24, 33.02
    g = POCKET_GAP
    pocket = footprint_ring('J100', R(cx - SOCKET_W / 2 - g, cy - L / 2 - g, cx + SOCKET_W / 2 + g, cy + L / 2 + g))
    m = json.loads(MARK.read_text(encoding='utf-8'))
    sc = 9.0 / (m['pixel_bounds'][2] - 1)   # the silk mark: 9 mm wide at (MARGIN, 1.2) on the front, silk.py
    mark = [stl(MARGIN + a * sc, 1.2 + c * sc) for a, c in m['points']]
    data = (extrude(board + mounts + [pocket], 0.0, MARK_DEPTH + LAP)                       # back layer: the pocket, the pin holes inside it open
            + extrude(board + mounts + pins, MARK_DEPTH, PCB_T - MARK_DEPTH + LAP)
            + extrude(board + mounts + pins + [mark], PCB_T - MARK_DEPTH, PCB_T))
    n_parts = 0
    for p in PARTS:
        if p['footprint'].startswith(SKIP) or PLACE[p['ref']][3] == 'B':
            continue
        data += place_model(p['ref'], p['footprint'], PCB_T)
        n_parts += 1
    centre = stl((EDGE[0] + EDGE[2]) / 2, (EDGE[1] + EDGE[3]) / 2)
    write_scaled(data, ROOT / f'outputs/D1-assembly-{MATERIAL}.stl',
                 f'KINO D4 dev carrier D1 assembly ({MATERIAL}, drawn x{SHRINK[MATERIAL]}): board, front parts, XIAO modules; J100 pocket', centre)
    print({'front_parts': n_parts, 'back_parts': 'left off; J100 block in D1-socket'})
    # the J100 block alone, on the bed holes-up; the extra MARK_DEPTH is the end that sits in the pocket
    [(rings, z0, z1)] = pin_socket_2x13()
    block = extrude([[(px, -py) for px, py in r] for r in rings], 0.0, z1 + MARK_DEPTH)
    write_scaled(block, ROOT / f'outputs/D1-socket-{MATERIAL}.stl',
                 f'KINO D4 dev carrier D1 J100 block ({MATERIAL}, drawn x{SHRINK[MATERIAL]}): glue into the pocket on the back', (cx, -cy))


def pouch():
    """The pouch dummy alone, from z 0, with its lead tab on one short edge."""
    global BASE_TRIS, BASE_N
    BASE_TRIS, BASE_N = b'', 0
    pw, pl, ph = POUCH
    body(pw / 2, HEIGHT + 12.0 + pl / 2, pw, pl, 0, ph)   # below the board's frame, so the files can be loaded together
    body(pw + 4.0, HEIGHT + 12.0 + pl / 2, 8.0, 6.0, 0, 3.0)   # PH2.0 lead exit; mark the real edge when measured
    write(ROOT / 'outputs/D1-pouch.stl', b'KINO D4 dev carrier D1: 505573 pouch dummy 73 x 55 x 5 with lead tab')


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
    x1, y1, _, y2 = EDGE
    assert abs(lo[0] - OFF - x1) < 1 and abs(hi[1] + OFF + y1) < 1 and abs(lo[1] + OFF + y2) < 1 and abs(lo[2]) < .1 and 1.4 < hi[2] < 1.7, 'unexpected frame'
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
    if sys.argv[1:2] == ['_holes']:   # one plate's holes, for plates(): kicad's python loads one board per process
        import json; Path(sys.argv[2]).write_text(json.dumps(plate_holes(set(sys.argv[3:])))); sys.exit(0)
    if sys.argv[2:3] and sys.argv[2] in SHRINK:
        MATERIAL = sys.argv[2]
    {'slab': slab, 'fit': fit, 'pouch': pouch, 'plates': plates, 'gauge': gauge, 'flat': flat, 'assembly': assembly}.get(sys.argv[1] if sys.argv[1:] else '', main)()
