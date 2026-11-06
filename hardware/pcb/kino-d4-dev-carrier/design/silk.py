"""Dev carrier D1 legend: plain bench-board labelling, stroke font, nothing under 0.8 mm.

A rule-lined identity bar, a rectangle around each functional block with its name, every pin
named where a probe or a cable lands, the limits and the one procedure that matters. Nothing
decorative: each item is a pin, a limit, a procedure or an identity field.
Front (SIDE A): the face the XIAOs stand on. Back (SIDE B): the assembled face.
Re-running replaces the legend. Run with KiCad 10's bundled python.exe after route.py.
"""
import json
from pathlib import Path
import pcbnew as pcb
from placement import CAMERA_X, CAMERA_Y, WIDTH, HEIGHT

ROOT = Path(__file__).resolve().parent.parent
A0 = ROOT.parent / 'kino-d4-carrier-a0'
BOARD = ROOT / 'KINO_D4_Dev_Carrier_D1.kicad_pcb'
OFF = 50.0
GROUP = 'D1 legend'
LEFT, CENTER, RIGHT = pcb.GR_TEXT_H_ALIGN_LEFT, pcb.GR_TEXT_H_ALIGN_CENTER, pcb.GR_TEXT_H_ALIGN_RIGHT
MODEL, REV, DATE = 'DEV CARRIER', 'D1', '2026-11'
PN = 'KINO-D4-DC-D1'


def pt(x, y): return pcb.VECTOR2I(round((OFF + x) * 1e6), round((OFF + y) * 1e6))


class Legend:
    def __init__(self, board):
        self.b = board
        self.items = []

    def text(self, s, x, y, size=1.0, layer=pcb.F_SilkS, justify=CENTER, angle=0, thick=None, bold=False):
        t = pcb.PCB_TEXT(self.b)
        t.SetText(s)
        t.SetPosition(pt(x, y))
        t.SetTextSize(pcb.VECTOR2I(pcb.FromMM(size), pcb.FromMM(size)))
        t.SetTextThickness(pcb.FromMM(thick or (0.2 if bold else 0.15)))
        t.SetLayer(layer)
        if layer == pcb.B_SilkS and justify != CENTER:   # mirrored text runs the other way in board coordinates
            justify = RIGHT if justify == LEFT else LEFT
        t.SetHorizJustify(justify)
        t.SetTextAngleDegrees(angle)
        t.SetMirrored(layer == pcb.B_SilkS)
        self.b.Add(t); self.items.append(t)

    def line(self, a, c, w=0.15, layer=pcb.F_SilkS):
        s = pcb.PCB_SHAPE(self.b)
        s.SetShape(pcb.SHAPE_T_SEGMENT); s.SetStart(pt(*a)); s.SetEnd(pt(*c))
        s.SetWidth(pcb.FromMM(w)); s.SetLayer(layer)
        self.b.Add(s); self.items.append(s)

    def poly(self, points, layer=pcb.F_SilkS):
        p = pcb.SHAPE_POLY_SET(); p.NewOutline()
        for x, y in points:
            p.Append(pt(x, y))
        s = pcb.PCB_SHAPE(self.b)
        s.SetShape(pcb.SHAPE_T_POLY); s.SetPolyShape(p); s.SetFilled(True); s.SetWidth(0); s.SetLayer(layer)
        self.b.Add(s); self.items.append(s)

    def circle(self, x, y, r, w=0.2, layer=pcb.F_SilkS):
        s = pcb.PCB_SHAPE(self.b)
        s.SetShape(pcb.SHAPE_T_CIRCLE); s.SetCenter(pt(x, y)); s.SetEnd(pt(x + r, y))
        s.SetWidth(pcb.FromMM(w)); s.SetLayer(layer)
        self.b.Add(s); self.items.append(s)

    def box(self, x1, y1, x2, y2, w=0.15, layer=pcb.F_SilkS, gap=(), gap_edge='top'):
        """Rectangle as four lines; `gap` lists (x_from, x_to) openings in the top or bottom edge for a title."""
        edges = {'top': [(x1, x2)], 'bottom': [(x1, x2)]}
        for a, b in gap:
            edges[gap_edge] = [seg for s in edges[gap_edge]
                               for seg in ((s[0], min(s[1], a)), (max(s[0], b), s[1])) if seg[1] - seg[0] > 0.3]
        for a, b in edges['top']:
            self.line((a, y1), (b, y1), w, layer)
        for a, b in edges['bottom']:
            self.line((a, y2), (b, y2), w, layer)
        self.line((x1, y1), (x1, y2), w, layer); self.line((x2, y1), (x2, y2), w, layer)

    def pin1(self, x, y, layer=pcb.F_SilkS, size=0.6):
        """Filled triangle pointing at pin 1 from the left."""
        self.poly([(x - size, y - size * 0.6), (x, y), (x - size, y + size * 0.6)], layer)

    def mark(self, x, y, w=9.0, layer=pcb.F_SilkS):
        """ODD JOBS maker's mark (standard 96), traced outline from the carrier brand file."""
        data = json.loads((A0 / 'brand/odd-jobs-symbol.json').read_text(encoding='utf-8'))
        scale = w / (data['pixel_bounds'][2] - 1)
        poly = pcb.SHAPE_POLY_SET(); poly.NewOutline()
        for a, c in data['points']:
            px = x + (w - a * scale if layer == pcb.B_SilkS else a * scale)
            poly.Append(pt(px, y + c * scale))
        s = pcb.PCB_SHAPE(self.b)
        s.SetShape(pcb.SHAPE_T_POLY); s.SetPolyShape(poly); s.SetFilled(True); s.SetWidth(0); s.SetLayer(layer)
        self.b.Add(s); self.items.append(s)
        return (data['pixel_bounds'][3] - 1) * scale


# XIAO socket pins that carry a signal: (pad x offset, pad y offset, name). Pin 1 is the top-left pin.
XIAO_PINS = ((-7.62, -5.08, 'SYNC'), (-7.62, 7.62, 'TX'), (7.62, 7.62, 'RX'),
             (7.62, -2.54, '3V3'), (7.62, -5.08, 'GND'), (7.62, -7.62, '5V'))
JP1_KEY = (('01', '3V3'), ('02', '5V'), ('10', 'CAM EN'), ('15', 'NC'),
           ('19', 'SYNC'), ('21', 'SHUTTER'), ('23', 'SDA'), ('25', 'SCL'))
SPEC = (('HOST', 'ESP32-P4  JP1 x26'), ('NODES', '4x XIAO ESP32-S3'), ('UART', '921600 8N1'),
        ('SYNC', 'GPIO32'), ('CAM EN', 'GPIO31'), ('IN', 'USB-C 5V 3A'))


def identity(L, layer, side, end=WIDTH - 3.0):
    """The identity bar under the top strip: product, model, revision, date, part number, side, one rule below.
    Laid out in reading coordinates u (left to right as the face is viewed); on the back u maps to
    WIDTH - u so the bar reads in the same order from either face. The back bar stops before the
    ribbon header column (end = WIDTH - 19) and drops the part number."""
    back = layer == pcb.B_SilkS
    m = (lambda u: WIDTH - u) if back else (lambda u: u)
    jl, jr = (RIGHT, LEFT) if back else (LEFT, RIGHT)
    ym = 13.6
    L.line((m(3.0), 11.4), (m(end), 11.4), 0.15, layer)
    L.line((m(3.0), 16.0), (m(end), 16.0), 0.3, layer)
    L.text('KINO D4', m(3.6), ym, 2.0, layer, jl, bold=True)
    L.text(MODEL, m(19.0), ym, 1.2, layer, jl)
    L.text('REV ' + REV, m(35.0), ym, 1.2, layer, jl, bold=True)
    L.text(DATE, m(47.0), ym, 1.0, layer, jl)
    if not back:
        L.text(PN, m(60.0), ym, 1.0, layer, jl)
    L.text(side, m(end - 0.6), ym, 1.2, layer, jr)


def front(L):
    F = pcb.F_SilkS
    identity(L, F, 'SIDE A')
    # Top strip: the spec strip between the inserts, the maker's mark at the right.
    for i, (a, b) in enumerate(SPEC):
        col, row = divmod(i, 3)
        x = 24.0 + col * 28.0
        L.text(a, x, 4.0 + row * 2.0, 0.85, F, LEFT, bold=True)
        L.text(b, x + 7.4, 4.0 + row * 2.0, 0.85, F, LEFT)
    L.text('ODD JOBS', 99.8, 6.4, 1.0, F, RIGHT)
    L.mark(104.5, 2.4, 9.0, F)
    # P4 ribbon header (on the back; the pins come through): name, pin 1, the open boot-strap pin.
    L.text('1', 11.4, 18.0, 0.9, F)
    L.text('P4 JP1', 11.7, 27.5, 1.0, F, CENTER, 90)
    L.text('NC', 11.4, 35.78, 0.8, F)
    # One box per node: the name in the top edge, the link header, the limit, the socket pin names
    # inside the rows (visible exactly when the module is out), pin 1, the module name.
    for n, cx in enumerate(CAMERA_X, 1):
        x1, x2 = cx - 10.7, cx + 10.7
        L.box(x1, 17.2, x2, 46.4, 0.15, F, gap=[(x1 + 1.0, x1 + 7.2)])
        L.text(f'CAM {n}', x1 + 1.5, 17.2, 1.0, F, LEFT, bold=True)
        L.text('LINK', cx + 3.81, 22.4, 0.8, F)
        L.text('ILIM 1.2A', cx - 7.3, 22.4, 0.8, F, LEFT)
        for dx, dy, s in XIAO_PINS:
            L.text(s, cx + dx - 1.7 * (1 if dx > 0 else -1), CAMERA_Y + dy, 0.8, F, RIGHT if dx > 0 else LEFT)
        L.pin1(cx - 9.3, CAMERA_Y - 7.62)
        L.text('XIAO ESP32-S3', cx, 44.6, 0.8, F)
    # The one procedure, in the column right of CAM 4.
    for i, s in enumerate(('NODE USB:', 'PULL LINK', 'SHUNT FIRST')):
        L.text(s, 108.8, 19.6 + 1.8 * i, 0.8, F)
    # Controls: the shutter, the remote contact, the C6 service header.
    L.box(28.0, 49.4, 73.0, 67.0, 0.15, F, gap=[(29.0, 43.0)])
    L.text('CONTROL  GPIO28', 29.5, 49.4, 0.9, F, LEFT, bold=True)
    L.text('SHUTTER', 35.0, 63.4, 0.8, F)
    for i, s in enumerate(('SW', 'GND')):
        L.text(s, 49.0 + 2.54 * i, 61.0, 0.8, F, CENTER, 90)
    L.text('REMOTE', 50.3, 64.6, 0.8, F)
    for i, s in enumerate(('GND', '3V3', 'RX', 'TX', 'IO9', 'EN')):
        L.text(s, 56.5 + 2.54 * i, 61.0, 0.8, F, CENTER, 90)
    L.text('C6 SERVICE', 62.85, 64.6, 0.8, F)
    L.line((45.5, 52.4), (45.5, 64.8), 0.15)
    # JP1 key, bottom left: the pins a probe goes to first.
    L.text('JP1 KEY', 3.6, 51.0, 0.9, F, LEFT, bold=True)
    for i, (p, s) in enumerate(JP1_KEY):
        col, row = divmod(i, 4)
        x = 3.6 + col * 11.2
        L.text(p, x, 53.4 + row * 1.6, 0.8, F, LEFT, bold=True)
        L.text(s, x + 2.8, 53.4 + row * 1.6, 0.8, F, LEFT)
    # Power: the input rating, the status LEDs by name.
    L.box(86.0, 49.4, 114.6, 60.4, 0.15, F, gap=[(87.0, 93.0)])   # the USB-C lands start at y 61
    L.text('POWER', 87.5, 49.4, 0.9, F, LEFT, bold=True)
    L.text('5V IN', 108.5, 54.8, 1.3, F, CENTER, bold=True)
    L.text('USB-C 3A MAX', 108.5, 57.2, 0.8, F)
    L.text('STATUS', 96.0, 62.6, 0.8, F, CENTER, bold=True)
    for x, s in ((92.0, 'PWR'), (96.0, 'CAM'), (100.0, 'FLT')):
        L.circle(x, 66.6, 0.75, 0.2); L.text(s, x, 64.6, 0.8, F)


def back(L):
    B = pcb.B_SilkS
    identity(L, B, 'SIDE B', WIDTH - 19.0)
    # Top strip: S/N box, the JLC order anchor, the licence line.
    L.box(88.0, 3.4, 101.0, 9.6, 0.15, B); L.text('S/N', 89.0, 4.6, 0.8, B, LEFT)
    L.text('JLCJLCJLCJLC', 50.0, 6.4, 1.0, B)
    L.text('ODD JOBS  CERN-OHL-S-2.0', 24.0, 6.4, 0.85, B, LEFT)
    # The 5 V link bridge beside the ribbon header (the header outline carries its own pin 1 chamfer).
    L.text('5V LINK', 16.0, 17.1, 0.8, B)
    # Nodes: name, every test pad named.
    for n, cx in enumerate(CAMERA_X, 1):
        L.text(f'CAM {n}', cx, 23.9, 1.0, B, CENTER, bold=True)
        for i, s in enumerate(('TX', 'RX', 'SY', '3V3', '5V')):
            L.text(s, cx - 6.0 + 3.0 * i, 49.3, 0.8, B)
    # P4 test pads down the header column, the Qwiic port, the status LEDs.
    for y, s in ((33.5, 'EN'), (46.0, '3V3'), (49.0, '5V'), (52.0, 'SY'), (55.0, 'SH')):   # the J100 shroud ends at x 11.8
        L.text(s, 14.8, y, 0.8, B, RIGHT)
    L.text('GND', 4.0, 60.2, 0.8, B)
    L.text('QWIIC', 29.0, 62.6, 0.9, B)
    L.text('GND', 101.0, 62.2, 0.8, B)
    for x, s in ((92.0, 'PWR'), (96.0, 'CAM'), (100.0, 'FLT')):
        L.text(s, x, 65.2, 0.8, B)


def main():
    b = pcb.LoadBoard(str(BOARD))
    for g in list(b.Groups()):
        if g.GetName() == GROUP:
            for item in list(g.GetItems()):
                g.RemoveItem(item); b.Remove(item)
            b.Remove(g)
    L = Legend(b)
    front(L); back(L)
    g = pcb.PCB_GROUP(b); g.SetName(GROUP); b.Add(g)
    for item in L.items:
        g.AddItem(item)
    pcb.SaveBoard(str(BOARD), b)
    print({'legend_items': len(L.items)})


if __name__ == '__main__':
    main()
