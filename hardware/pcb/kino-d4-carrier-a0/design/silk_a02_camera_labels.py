"""The four "CAMn GPIO" labels at one offset from their breakout headers (KiCad 10 python). ODD JOBS 43, 91, 94.

place_a02_labels.py puts each connector label at the first clear spot round its own connector, so
the four camera breakout labels ended up on different sides of J201-J501 (two of them between two
headers). The headers are identical and sit on the same 22 mm pitch, so one offset is searched that
is clear for all four: above, below, left or right of the header courtyard (0.4, 1.0 or 1.6 mm gap),
sliding along that side in 0.5 mm steps by the same amount for every header. A spot is clear when its
box keeps 0.15 mm from back pads, through-holes and mask openings and from back part graphics, 0.6 mm
from other back silkscreen labels, and 0.5 mm inside the board. Component references are not
obstacles: assembly_labels.py places them afterwards. Run before assembly_labels.py.
"""
import pcbnew as pcb
from rework import TARGET

HEADERS = {'CAM1 GPIO': 'J201', 'CAM2 GPIO': 'J301', 'CAM3 GPIO': 'J401', 'CAM4 GPIO': 'J501'}
b = pcb.LoadBoard(str(TARGET))
fs = {f.GetReference(): f for f in b.GetFootprints()}
mm = lambda v: pcb.ToMM(v) - 50
texts = {d.GetText(): d for d in b.GetDrawings() if isinstance(d, pcb.PCB_TEXT)}
pads = [p.GetBoundingBox() for f in b.GetFootprints() for p in f.Pads() if p.IsOnLayer(pcb.B_Cu) or p.IsOnLayer(pcb.B_Mask)]
graphics = [g.GetBoundingBox() for f in b.GetFootprints() if f.IsFlipped() for g in f.GraphicalItems() if g.GetLayer() == pcb.B_SilkS]
others = [d.GetBoundingBox() for d in b.GetDrawings() if isinstance(d, pcb.PCB_TEXT) and d.GetLayer() == pcb.B_SilkS
          and d.GetText() not in HEADERS]
outline = b.GetBoardEdgesBoundingBox(); outline.Inflate(-pcb.FromMM(0.5))
def court(f):
    c = f.GetCourtyard(pcb.B_CrtYd); return c.BBox()

def spot(d, c, side, gap, k, size):
    d.SetTextSize(pcb.VECTOR2I(pcb.FromMM(size), pcb.FromMM(size))); d.SetTextThickness(pcb.FromMM(.15 if size == 1.0 else .12))
    d.SetTextAngleDegrees(0); h = d.GetBoundingBox().GetHeight(); step = pcb.FromMM(.5) * k
    cx, cy = c.GetCenter().x, c.GetCenter().y
    ang, (x, y) = {'above': (0, (cx + step, c.GetTop() - gap - h // 2)), 'below': (0, (cx + step, c.GetBottom() + gap + h // 2)),
                   'left': (270, (c.GetLeft() - gap - h // 2, cy + step)), 'right': (270, (c.GetRight() + gap + h // 2, cy + step))}[side]
    d.SetTextAngleDegrees(ang); d.SetPosition(pcb.VECTOR2I(int(x), int(y)))
    bb = d.GetBoundingBox(); bb.Inflate(pcb.FromMM(.15)); wide = d.GetBoundingBox(); wide.Inflate(pcb.FromMM(.6))
    return outline.Contains(bb) and not any(bb.Intersects(o) for o in pads + graphics) and not any(wide.Intersects(o) for o in others)

labels = [(texts[t], court(fs[r])) for t, r in HEADERS.items()]
for d, _ in labels: d.SetLayer(pcb.B_SilkS); d.SetMirrored(True); d.SetKeepUpright(False)
found = None
for size in (1.0, 0.8):
    for side in ('above', 'below', 'left', 'right'):
        for gap in (pcb.FromMM(.4), pcb.FromMM(1.0), pcb.FromMM(1.6)):
            for k in [0] + [s * i for i in range(1, 13) for s in (1, -1)]:
                if all(spot(d, c, side, gap, k, size) for d, c in labels):   # 22 mm apart: they cannot touch each other
                    found = (size, side, pcb.ToMM(gap), k * .5); break
            if found: break
        if found: break
    if found: break
assert found, 'no common offset clear for all four camera GPIO labels'
pcb.SaveBoard(str(TARGET), b)
print('camera GPIO labels: %.1f mm text, %s the header, gap %.1f mm, slide %.1f mm' % found, flush=True)
for d, _ in labels: print(' ', d.GetText(), (round(mm(d.GetPosition().x), 2), round(mm(d.GetPosition().y), 2)), d.GetTextAngleDegrees(), flush=True)
import os; os._exit(0)
