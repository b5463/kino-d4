"""Dev carrier D1 legend: plain bench-board labelling, Arial bold, nothing under 1.0 mm.

One identity line, the maker's mark, and a name at every pin a hand or a probe goes to.
Front (SIDE A): the face the XIAOs stand on. Back (SIDE B): the assembled face.
Re-running replaces the legend. Run with KiCad 10's bundled python.exe after route.py.
"""
import json
from pathlib import Path
import pcbnew as pcb
from placement import CAMERA_X, CAMERA_Y, WIDTH

ROOT = Path(__file__).resolve().parent.parent
A0 = ROOT.parent / 'kino-d4-carrier-a0'
BOARD = ROOT / 'KINO_D4_Dev_Carrier_D1.kicad_pcb'
OFF = 50.0
GROUP = 'D1 legend'
LEFT, CENTER, RIGHT = pcb.GR_TEXT_H_ALIGN_LEFT, pcb.GR_TEXT_H_ALIGN_CENTER, pcb.GR_TEXT_H_ALIGN_RIGHT
MODEL, REV, DATE = 'DEV CARRIER', 'D1', '2026-11'
PN = 'KINO-D4-DC-D1'
MARGIN, END = 3.6, WIDTH - 3.0   # the left and right margins every aligned block shares
H1, H2, BODY = 3.2, 1.8, 1.0     # the type scale: board name and side; section names; everything else
BASE = 64.6                      # the one baseline of the bottom row's labels


def pt(x, y): return pcb.VECTOR2I(round((OFF + x) * 1e6), round((OFF + y) * 1e6))


class Legend:
    def __init__(self, board):
        self.b = board
        self.items = []

    def text(self, s, x, y, size=1.0, layer=pcb.F_SilkS, justify=CENTER, angle=0, thick=None, bold=False, baseline=False, tag=False):
        t = pcb.PCB_TEXT(self.b)
        t.SetText(s)
        t.SetPosition(pt(x, y))
        t.SetTextSize(pcb.VECTOR2I(pcb.FromMM(size), pcb.FromMM(size)))
        t.SetTextThickness(pcb.FromMM(thick or (0.2 if bold else 0.15)))
        t.SetLayer(layer)
        if layer == pcb.B_SilkS and justify != CENTER:   # mirrored text runs the other way in board coordinates
            justify = RIGHT if justify == LEFT else LEFT
        t.SetHorizJustify(justify)
        if baseline:   # y is the bottom of the capitals, so texts of different sizes share a baseline
            t.SetVertJustify(pcb.GR_TEXT_V_ALIGN_BOTTOM)
        if tag:   # reversed out of a solid block: the top of the hierarchy only. KiCad pads the
            t.SetIsKnockout(True)   # block from the text thickness, which the outline face ignores otherwise.
            t.SetTextThickness(pcb.FromMM(0.4 if size < 2 else 0.6))
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

    def box(self, x1, y1, x2, y2, w=0.15, layer=pcb.F_SilkS):
        for a, c in (((x1, y1), (x2, y1)), ((x2, y1), (x2, y2)), ((x2, y2), (x1, y2)), ((x1, y2), (x1, y1))):
            self.line(a, c, w, layer)

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


def identity(L, layer, side, end=END, side_end=END):
    """One line with a rule under it: product, model, revision, date, part number, side. Laid out in
    reading coordinates u (left to right as the face is viewed); on the back u maps to WIDTH - u so
    it reads in the same order from either face. The back line stops before the ribbon header column."""
    back = layer == pcb.B_SilkS
    m = (lambda u: WIDTH - u) if back else (lambda u: u)
    jl, jr = (RIGHT, LEFT) if back else (LEFT, RIGHT)
    # The side marker, large, at the top right: the first thing to find with the board in hand.
    L.text(side, m(side_end), 9.4, H1, layer, jr, bold=True, baseline=True, tag=True)
    y = 15.0   # one baseline for every size; the rule 1.1 mm under it
    # Left group, the product, by importance: name, revision, model. Arial Bold caps run about
    # 0.85 em; gaps are 3 mm. Right group, the record, right-aligned against the margin.
    L.text('KINO D4', m(MARGIN), y, H1, layer, jl, bold=True, baseline=True, tag=True)
    for u, s in ((26.4, MODEL), (46.0, 'REV ' + REV), (58.4, 'PROTOTYPE')):   # one size for the whole group
        L.text(s, m(u), y, H2, layer, jl, bold=True, baseline=True, tag=s == 'PROTOTYPE')
    L.text(DATE, m(end), y, BODY, layer, jr, baseline=True)
    L.text(PN, m(end - 9.0), y, BODY, layer, jr, baseline=True)


def front(L):
    F = pcb.F_SilkS
    # Top strip: the maker's mark in the left corner, the subtitle between the inserts.
    L.mark(MARGIN, 1.2, 9.0, F)   # foot at 8.5: the same 3 mm to the KINO D4 tag as between the words
    # Right of the H1 insert: the subtitle and the two facts the bench needs about the nodes.
    for i, s in enumerate(('4x XIAO ESP32-S3 SENSE  ON  ESP32-P4 JP1', 'LINK: PULL THE SHUNT BEFORE NODE USB',
                           'CAM 5V: 1.2A LIMIT PER NODE, SHARED ENABLE')):
        L.text(s, 22.5, 3.8 + 2.6 * i, BODY, F, LEFT)
    identity(L, F, 'SIDE A')
    # P4 ribbon header (on the back; the pins come through): designator, name, pin 1, the open boot-strap pin.
    L.text('1', 11.4, 18.0, 1.0, F)
    L.text('J100  P4 JP1', 11.7, 28.5, 1.0, F, CENTER, 90)
    L.text('NC', 11.4, 35.78, 1.0, F)
    # Each node: name and designator, link header with its designator, pin 1, the module name and the
    # socket pins named inside the rows (seen when the module is out).
    for n, cx in enumerate(CAMERA_X, 1):
        b = 200 + 100 * (n - 1)
        L.text(f'CAM {n}', cx - 9.0, 19.5, H2, F, LEFT, bold=True, tag=True)   # on the link header's centre line
        L.text(f'J{b}', cx - 9.0, 22.8, 1.0, F, LEFT)
        L.text('LINK', cx + 11.0, 17.0, 1.0, F)   # the header sits in the gap between sockets; JPn00 is in the README
        L.text('XIAO ESP32-S3', cx, 25.3, 1.0, F)
        for dx, dy, s in XIAO_PINS:
            L.text(s, cx + dx - 1.7 * (1 if dx > 0 else -1), CAMERA_Y + dy, 1.0, F, RIGHT if dx > 0 else LEFT)
        L.pin1(cx - 9.3, CAMERA_Y - 7.62)
    # The column right of CAM 4: the power-module connector, fused USB out to the SW6106, the 5 V rail back in.
    L.text('J1001  POWER', 109.25, 18.4, 1.0, F)
    for i, s in enumerate(('VBUS', 'GND', 'RAIL')):   # one name per contact pair, beside the housing
        L.text(s, 114.2, 24.25 + 5.0 * i, 1.0, F, CENTER, 90)   # right of the housing, clear of JP500
    # GPIO map, bottom left, next to the header the GPIOs come from: two aligned columns.
    for i, (a, b) in enumerate((('CAM EN', 'GPIO31'), ('SYNC', 'GPIO32'), ('SHUTTER', 'GPIO28'))):
        L.text(a, MARGIN, 51.2 + 2.0 * i, 1.0, F, LEFT)
        L.text(b, 13.0, 51.2 + 2.0 * i, 1.0, F, LEFT)
    # Controls: the shutter, the remote contact, the C6 service header, each with its designator,
    # all on the bottom row's one baseline.
    L.text('SW100  SHUTTER', 32.0, BASE, 1.0, F)
    for i, s in enumerate(('SW', 'GND')):
        L.text(s, 47.0 + 2.54 * i, 62.0, 1.0, F, CENTER, 90)
    L.text('J103  REMOTE', 48.3, BASE, 1.0, F)
    for i, s in enumerate(('GND', '3V3', 'RX', 'TX', 'IO9', 'EN')):
        L.text(s, 58.5 + 2.54 * i, 62.0, 1.0, F, CENTER, 90)
    L.text('J101  C6 SERVICE', 64.85, BASE, 1.0, F)
    # Power: the input over the USB-C against the right margin, the status LEDs by name.
    L.text('5V IN', END, 55.0, H2, F, RIGHT, bold=True, baseline=True, tag=True)
    L.text('J1000  USB-C  3A MAX', END, 57.6, 1.0, F, RIGHT, baseline=True)
    for x, s in ((87.0, 'PWR'), (93.0, 'CAM'), (99.0, 'FLT')):
        L.circle(x, 66.6, 0.75, 0.2); L.text(s, x, BASE, 1.0, F)
    # Scope-probe ground loops.
    for x, y in ((25.5, 59.0), (88.5, 57.4), (113.5, 43.4)):
        L.text('GND', x, y, 1.0, F)


def back(L):
    B = pcb.B_SilkS
    identity(L, B, 'SIDE B', WIDTH - 19.0, WIDTH - 23.0)   # clear of the ribbon header and the H1 insert
    L.box(88.0, 3.4, 101.0, 9.6, 0.15, B); L.text('S/N', 89.0, 4.6, 1.0, B, LEFT)
    L.text('JLCJLCJLCJLC', 70.0, 6.4, 1.0, B)
    L.text('ODD JOBS  CERN-OHL-S-2.0', 40.0, 6.4, 1.0, B, LEFT)
    L.text('github.com/b5463/kino-d4', 40.0, 8.9, 1.0, B, LEFT)
    # The ideal diode to the P4 5 V pins, beside the ribbon header (whose outline carries its own pin 1 chamfer).
    L.text('U1001  RAIL > P4 5V', 20.5, 17.6, 1.0, B)
    for n, cx in enumerate(CAMERA_X, 1):
        L.text(f'CAM {n}', cx, 23.8, H2, B, CENTER, bold=True)
        for i, s in enumerate(('TX', 'RX', 'SY', '3V3', '5V', '5VJ')):   # 5VJ: jumper side of the measure link
            L.text(s, cx - 6.0 + 3.0 * i, 49.3, 1.0, B)
    for y, s in ((33.5, 'EN'), (46.0, '3V3'), (49.0, '5V'), (52.0, 'SY'), (55.0, 'SH')):   # the J100 shroud ends at x 11.8
        L.text(s, 14.8, y, 1.0, B, RIGHT)
    L.text('GND', 4.0, 60.2, 1.0, B)
    L.text('J102  QWIIC', 14.5, 67.0, 1.0, B, LEFT)
    L.text('PU DNP', 12.8, 57.6, 1.0, B)   # the Qwiic pull-up pads under it
    L.text('GND', 101.0, 62.2, 1.0, B)
    L.text('FAULT', 96.0, 62.2, 1.0, B)
    L.text('F1000', 113.5, 48.5, 1.0, B)
    L.text('D1003  TVS', 104.0, 25.2, 1.0, B)
    L.text('JP1001', 107.3, 47.0, 1.0, B, RIGHT)   # USB > rail bridge, closed as shipped
    for x, s in ((87.0, 'PWR'), (93.0, 'CAM'), (99.0, 'FLT')):
        L.text(s, x, 65.2, 1.0, B)


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
    typeface()
    print({'legend_items': len(L.items)})


# Outline font for every legend text; the swig API has no font setter, so the saved file is patched.
# Arial has a static bold face that every KiCad install resolves (Bahnschrift's weights are
# named instances of a variable font, which KiCad cannot address: it falls back silently).
# Every text is bold: at 1.0 mm the regular weight's strokes fall under the 0.15 mm silk minimum.
FACE = 'Arial'


def typeface():
    """Give every silk gr_text the outline face, bold."""
    import re
    src = BOARD.read_text(encoding='utf-8')

    def patch(m):
        block = m.group(0)
        if '(face ' in block or '.SilkS' not in block:
            return block
        block = block.replace('(font\n', f'(font\n\t\t\t\t(face "{FACE}")\n', 1)
        return re.sub(r'(\(thickness [\d.]+\))', r'\1\n\t\t\t\t(bold yes)', block, count=1)

    out = re.sub(r'\(gr_text .*?\n\t\)\n', patch, src, flags=re.S)
    BOARD.write_text(out, encoding='utf-8')


if __name__ == '__main__':
    main()
