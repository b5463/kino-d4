"""Dev carrier D1 legend: cassette-deck style, stroke font, nothing under 0.8 mm.

Front (SIDE A, the face the XIAOs stand on): title band, ODD JOBS mark, channel index
strips under the sockets, link and control labels, P4 header pin 1, the NC pin.
Back (SIDE B, the assembled face): product identity, channel labels, named test pads,
the S/N box and the JLC order-number anchor. Re-running replaces the legend.
Run with KiCad 10's bundled python.exe after route.py.
"""
import json
from pathlib import Path
import pcbnew as pcb
from placement import CAMERA_X, WIDTH, HEIGHT

ROOT = Path(__file__).resolve().parent.parent
A0 = ROOT.parent / 'kino-d4-carrier-a0'
BOARD = ROOT / 'KINO_D4_Dev_Carrier_D1.kicad_pcb'
OFF = 50.0
GROUP = 'D1 legend'
LEFT, CENTER, RIGHT = pcb.GR_TEXT_H_ALIGN_LEFT, pcb.GR_TEXT_H_ALIGN_CENTER, pcb.GR_TEXT_H_ALIGN_RIGHT
TITLE, DATE = 'DEV CARRIER D1', '2026-11'


def pt(x, y): return pcb.VECTOR2I(round((OFF + x) * 1e6), round((OFF + y) * 1e6))


def spaced(s): return ' '.join(s).replace('   ', '   ')   # cassette-label tracking: one space between letters


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

    def rect(self, x1, y1, x2, y2, w=0.15, layer=pcb.F_SilkS):
        for a, c in (((x1, y1), (x2, y1)), ((x2, y1), (x2, y2)), ((x2, y2), (x1, y2)), ((x1, y2), (x1, y1))):
            self.line(a, c, w, layer)

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

    def bracket(self, x, y, dx, dy, leg=6.0, t=0.35, layer=pcb.F_SilkS):
        """Corner bracket with its elbow at (x, y), legs running dx, dy (+1 or -1)."""
        self.poly([(x, y), (x + dx * leg, y), (x + dx * leg, y + dy * t), (x + dx * t, y + dy * t),
                   (x + dx * t, y + dy * leg), (x, y + dy * leg)], layer)

    def hatch(self, x1, y1, x2, y2, pitch=1.3, w=0.3, layer=pcb.F_SilkS):
        """45-degree stripes clipped to the box; the stripe block of a tape label."""
        h = y2 - y1
        s = x1 - h + pitch
        while s < x2:
            ax, ay, bx, by = s, y2, s + h, y1
            if ax < x1: ay = y2 - (x1 - ax); ax = x1
            if bx > x2: by = y1 + (bx - x2); bx = x2
            if bx - ax > 0.4:
                self.line((ax, ay), (bx, by), w, layer)
            s += pitch

    def hub(self, x, y, layer=pcb.F_SilkS):
        """Cassette hub: ring, six teeth, centre ring. Gaps of 0.3 mm keep every piece a separate item."""
        import math
        self.circle(x, y, 3.2, 0.25, layer); self.circle(x, y, 1.0, 0.25, layer)
        for k in range(6):
            a = math.radians(k * 60)
            self.line((x + 1.4 * math.cos(a), y + 1.4 * math.sin(a)), (x + 2.75 * math.cos(a), y + 2.75 * math.sin(a)), 0.45, layer)

    def meter(self, x0, y, span, divisions, labels, layer=pcb.F_SilkS):
        """A level scale: major ticks with labels, four minor ticks between, a rule under them."""
        self.line((x0, y + 2.3), (x0 + span, y + 2.3), 0.2, layer)
        step = span / divisions
        for i in range(divisions + 1):
            x = x0 + i * step
            self.line((x, y), (x, y + 1.9), 0.3, layer)
            self.text(labels[i], x, y + 3.6, 0.9, layer)
            if i < divisions:
                for j in range(1, 5):
                    xm = x + j * step / 5
                    self.line((xm, y + 1.0), (xm, y + 1.9), 0.15, layer)

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


def front(L):
    F = pcb.F_SilkS
    # Corner brackets, the panel frame.
    for x, y, dx, dy in ((1.3, 1.3, 1, 1), (WIDTH - 1.3, 1.3, -1, 1), (1.3, HEIGHT - 1.3, 1, -1), (WIDTH - 1.3, HEIGHT - 1.3, -1, -1)):
        L.bracket(x, y, dx, dy)
    # Title band: stripe block, name, model, side; the mark above the right end.
    L.line((3, 11.6), (WIDTH - 3, 11.6)); L.line((3, 16.4), (WIDTH - 3, 16.4))
    L.hatch(3.6, 12.2, 11.4, 15.8)
    L.text(spaced('KINO D4'), 13.0, 14.0, 2.2, F, LEFT, bold=True)
    L.text(spaced(TITLE), 44.0, 14.0, 1.3, F, LEFT)
    L.text(spaced('SIDE A'), WIDTH - 4.0, 14.0, 1.2, F, RIGHT)
    L.mark(104.5, 2.4, 9.0, F)
    # The 5 V bus meter along the top strip: the budget the board is drawn for.
    L.text(spaced('5V BUS'), 24.0, 6.2, 1.0, F, LEFT)
    L.meter(35.5, 3.6, 34.5, 3, ('0', '1', '2', '3'))
    L.text('A', 72.4, 7.2, 1.0, F, LEFT)
    # Cassette window in the clear column right of CAM 4.
    L.rect(102.6, 17.6, 114.9, 47.4, 0.25)
    L.hub(108.75, 25.0); L.hub(108.75, 40.0)
    L.text(spaced('4CH'), 108.75, 32.5, 1.3, F, CENTER, bold=True)
    # Channel strips: CAM n above each socket with its LINK header; counter rule and index bar below.
    for n, cx in enumerate(CAMERA_X, 1):
        L.text(spaced(f'CAM {n}'), cx - 8.8, 20.8, 1.1, F, LEFT, bold=True)
        L.text('LINK', cx + 7.4, 20.8, 0.9, F, LEFT)
        L.line((cx - 8.5, 46.3), (cx + 8.5, 46.3), 0.15)
        for k in (-4, -3, -2, 2, 3, 4):   # the index digit takes the middle
            L.line((cx + 2.0 * k, 46.6), (cx + 2.0 * k, 47.1), 0.15)
        L.line((cx - 8.5, 48.2), (cx - 2.2, 48.2), 1.2); L.line((cx + 2.2, 48.2), (cx + 8.5, 48.2), 1.2)
        L.text(str(n), cx, 48.2, 1.8, F, CENTER, bold=True)
    # Spec panel, bottom left, above the H3 fastener allowance.
    L.line((3.0, 50.9), (31.0, 50.9), 0.2)
    for i, (a, b) in enumerate((('HOST', 'P4 JP1 x26'), ('NODES', '4x XIAO S3'), ('UART', '921600 8N1'))):
        L.text(a, 3.6, 52.6 + 1.9 * i, 0.9, F, LEFT); L.text(b, 9.4, 52.6 + 1.9 * i, 0.9, F, LEFT)
    for i, (a, b) in enumerate((('SYNC', 'GPIO32'), ('PWR', 'GPIO31 EN'), ('IN', 'USB-C 5V'))):
        L.text(a, 20.0, 52.6 + 1.9 * i, 0.9, F, LEFT); L.text(b, 24.6, 52.6 + 1.9 * i, 0.9, F, LEFT)
    # Stripe block beside the input.
    L.hatch(87.5, 53.2, 99.5, 56.6)
    # Controls row.
    L.text(spaced('SHUTTER'), 38.25, 50.4, 1.0, F)
    L.text(spaced('REMOTE'), 48.4, 53.2, 1.0, F)
    for i, s in enumerate(('SW', 'GND')):
        L.text(s, 49.0 + 2.54 * i, 60.4, 0.9, F, CENTER, 90)
    L.text(spaced('C6 SERVICE'), 65.5, 53.2, 1.0, F)
    for i, s in enumerate(('GND', '3V3', 'RX', 'TX', 'IO9', 'EN')):
        L.text(s, 56.5 + 2.54 * i, 60.4, 0.9, F, CENTER, 90)
    # P4 ribbon: pin 1, the header name, the boot-strap pin that stays open.
    L.text('1', 11.3, 18.0, 0.9, F)
    L.text(spaced('P4 JP1'), 11.6, 27.2, 1.1, F, CENTER, 90)
    L.text('NC', 11.3, 35.78, 0.8, F)
    # Power.
    L.text(spaced('5V IN'), 108.5, 55.0, 1.3, F, CENTER, bold=True)
    L.text('USB-C  3A', 108.5, 57.4, 0.9, F)


def back(L):
    B = pcb.B_SilkS
    for x, y, dx, dy in ((WIDTH - 1.3, 1.3, -1, 1), (WIDTH - 1.3, HEIGHT - 1.3, -1, -1), (1.3, HEIGHT - 1.3, 1, -1)):
        L.bracket(x, y, dx, dy, layer=B)
    L.hatch(103.0, 3.5, 113.5, 9.5, layer=B)
    L.line((19, 11.6), (WIDTH - 3, 11.6), layer=B); L.line((19, 16.4), (WIDTH - 3, 16.4), layer=B)
    L.text(spaced('ODD JOBS'), 20.0, 14.0, 1.2, B, LEFT)
    L.text(spaced('KINO D4'), 37.0, 14.0, 1.4, B, LEFT, bold=True)
    L.text(spaced(TITLE), 55.0, 14.0, 1.1, B, LEFT)
    L.text(DATE, 89.5, 14.0, 1.1, B, LEFT)
    L.text(spaced('SIDE B'), WIDTH - 4.0, 14.0, 1.2, B, RIGHT)
    L.rect(88.0, 3.5, 101.0, 9.5, layer=B); L.text('S/N', 89.0, 4.5, 0.8, B, LEFT)
    L.text('JLCJLCJLCJLC', 50.0, 6.5, 1.0, B)
    for n, cx in enumerate(CAMERA_X, 1):
        L.text(spaced(f'CAM {n}'), cx, 24.3, 1.0, B, CENTER, bold=True)
        for i, s in enumerate(('TX', 'RX', 'SY', '3V3', '5V')):
            L.text(s, cx - 6.0 + 3.0 * i, 49.3, 0.8, B)
    L.text('QWIIC', 29.5, 64.6, 0.9, B)


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
