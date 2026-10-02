"""Functional connector labels follow their connectors to the back (KiCad 10 python). ODD JOBS 42/43/94.

The cable connectors and pin headers moved to the back (place_a02_backside.py, place_a02_j100.py);
their labels were still on the front silkscreen. Each label moves to B.SilkS, mirrored, beside its
connector: the first of below / above / left / right of the connector's courtyard (0.4, 1.0 or
1.6 mm gap; 1.0 mm text, 0.8 mm only where 1.0 mm cannot fit) sliding along each side in 0.5 mm steps, whose box is clear of back-side pads, through-holes and
mask openings and of other back silkscreen, and inside the board by 0.5 mm. Labels of front parts (CAMx PWR links,
P4 PWR LINK, POGO / SENSE, CAM x sockets, - NTC +, USB, maker mark) stay on the front.
"""
import pcbnew as pcb
from rework import TARGET
from routing import pt

LABELS = {'REMOTE': 'J903', 'SHUTTER': 'J902', 'POWER': 'J1300', 'C6 SERVICE': 'J101', '3V3 I2C': 'J102',
          'RTC BACKUP': 'J800', 'FUNCTION': 'J904', 'MOTOR': 'J900', 'COVER': 'J901', 'FLASH': 'J601',
          'CAM1 GPIO': 'J201', 'CAM2 GPIO': 'J301', 'CAM3 GPIO': 'J401', 'CAM4 GPIO': 'J501'}
GAP = pcb.FromMM(0.4)

b = pcb.LoadBoard(str(TARGET))
fs = {f.GetReference(): f for f in b.GetFootprints()}
mm = lambda v: pcb.ToMM(v) - 50
def cy(f):
    c = f.GetCourtyard(pcb.B_CrtYd if f.IsFlipped() else pcb.F_CrtYd)
    return c.BBox() if c.OutlineCount() else f.GetBoundingBox(False, False)
pads = [p.GetBoundingBox() for f in b.GetFootprints() for p in f.Pads() if p.IsOnLayer(pcb.B_Cu) or p.IsOnLayer(pcb.B_Mask)]
outline = b.GetBoardEdgesBoundingBox(); outline.Inflate(-pcb.FromMM(0.5))
texts = {d.GetText(): d for d in b.GetDrawings() if isinstance(d, pcb.PCB_TEXT)}
placed, log = [], []
fsilk = [g.GetBoundingBox() for f in b.GetFootprints() if f.IsFlipped() for g in f.GraphicalItems() if g.GetLayer() == pcb.B_SilkS]
def other_silk(me):
    out = [d.GetBoundingBox() for d in b.GetDrawings() if isinstance(d, pcb.PCB_TEXT) and d.GetLayer() == pcb.B_SilkS and d.GetText() != me.GetText()]   # SWIG proxies are never identical; compare by text
    # component references are not obstacles: assembly_labels.py re-places them around these labels (ODD JOBS 176)
    return out + placed + fsilk
for text, ref in LABELS.items():
    d = texts.get(text); f = fs[ref]
    if d is None or not f.IsFlipped(): log.append(f'{text}: skipped'); continue
    d.SetLayer(pcb.B_SilkS); d.SetMirrored(True); d.SetTextAngleDegrees(0)
    c = cy(f); cx, cyy = c.GetCenter().x, c.GetCenter().y
    w, h = d.GetBoundingBox().GetWidth(), d.GetBoundingBox().GetHeight()
    step = pcb.FromMM(0.5)
    done = False
    for size in (1.0, 0.8):                                         # 0.8 mm only where 1.0 mm cannot fit
        d.SetTextSize(pcb.VECTOR2I(pcb.FromMM(size), pcb.FromMM(size))); d.SetTextThickness(pcb.FromMM(0.15 if size == 1.0 else 0.12))
        d.SetTextAngleDegrees(0); h = d.GetBoundingBox().GetHeight()
        for gap in (GAP, pcb.FromMM(1.0), pcb.FromMM(1.6)):
            cands = []
            for k in [0] + [s_ * i for i in range(1, 11) for s_ in (1, -1)]:   # slide along each side
                cands += [(0, (cx + k * step, c.GetBottom() + gap + h // 2)), (0, (cx + k * step, c.GetTop() - gap - h // 2)),
                          (90, (c.GetLeft() - gap - h // 2, cyy + k * step)), (90, (c.GetRight() + gap + h // 2, cyy + k * step))]
            for ang, (x, y) in cands:
                d.SetTextAngleDegrees(ang); d.SetPosition(pcb.VECTOR2I(int(x), int(y)))
                bb = d.GetBoundingBox(); bb.Inflate(pcb.FromMM(0.15))
                if not outline.Contains(bb): continue
                if any(bb.Intersects(o) for o in pads + other_silk(d)): continue
                done = True; break
            if done: break
        if done: break
    if not done:
        d.SetTextSize(pcb.VECTOR2I(pcb.FromMM(1.0), pcb.FromMM(1.0))); d.SetTextThickness(pcb.FromMM(0.15))
        d.SetTextAngleDegrees(0); d.SetPosition(pcb.VECTOR2I(int(cx), int(c.GetBottom() + GAP + h // 2)))
    placed.append(d.GetBoundingBox())
    log.append(f'{text} -> ({mm(d.GetPosition().x):.2f}, {mm(d.GetPosition().y):.2f}) {pcb.ToMM(d.GetTextHeight()):.1f} mm{"" if done else " (check by hand)"}')
pcb.SaveBoard(str(TARGET), b)
print('labels:', '; '.join(log), flush=True)
import os; os._exit(0)
