"""PAC1954 U700 to the middle of the camera shunt row, on the front (KiCad 10 python). ODD JOBS 152.

U700 measures the four camera currents through RS200-RS500 (20 mOhm). At the far right its eight
Kelvin lines (73 mm for camera 1) had no free path along the camera row. It moves to the front
between the camera 2 and 3 GPIO headers, centre (58.75, 15.5), 90 degrees, north of the SYS_5V
trunk: the shortest Kelvin runs on the board (12 mm for cameras 2 and 3), and on the front the
mirrored pin order puts camera 1 and 2 pins to the west, camera 3 and 4 pins to the east. The
QFN is 1 mm tall: the XIAOs stay the tallest parts on the front.
  C700 (100 nF) south of it, its MB_3V3 pad under pin 2; R700 (0 ohm, PAC_ADDR to GND for
  address 0x10) south-east, beside C700; C701 (1 uF) on the back under pin 16, where the edges of
  the package have no room left beside the camera 2 and 3 Kelvin pairs. Courtyards touch, no more:
  the trunk 0.15 mm south of the caps' pads sets the depth.
  The stock pin 1 triangle (pointing up at pin 1 from the south) would lie on C700's pad 1. U700
  uses the project footprint KINO_A0:VQFN-16-1EP_3x3mm_P0.5mm_EP1.1x1.1mm_Pin1Corner instead
  (fp_a02_pac1954.py, captured in circuit.py): the same land, the triangle in the free corner south-west
  of the package, pointing north-east at pin 1, clear of the pin 16 via, C700's pad 2 and C700's silk
  (ODD JOBS 93/94). 'place' sets the footprint ID and draws the triangle, so the board matches it.
Cleared for it ('rip'): copper attached to the four parts' pads (unlocked; re-routed), the CAM3_REQ
diagonal and via at (56.80, 14.05), the CAM2_EN B run at x 59.45, the IMU_INT diagonal ending at
(56.80, 16.00).
Phases: rip, place (separate processes).
"""
import sys
import pcbnew as pcb
from rework import TARGET
from routing import pt

PHASE = sys.argv[1] if len(sys.argv) > 1 else ''
assert PHASE in ('rip', 'place'), 'run: rip, place'
b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())
fs = {f.GetReference(): f for f in b.GetFootprints()}
mm = lambda v: pcb.ToMM(v) - 50
near = lambda p, x, y, e=0.03: abs(mm(p.x) - x) < e and abs(mm(p.y) - y) < e
PARTS = {'U700': ((58.75, 15.5), 90, 'F'), 'C700': ((57.725, 18.42), 180, 'F'), 'C701': ((58.07, 17.25), 0, 'B'), 'R700': ((60.9, 18.42), 0, 'F')}

if PHASE == 'rip':
    pads = [p for r in PARTS for p in fs[r].Pads()]
    doomed = []
    for t in tracks:
        n = t.GetNetname()
        if isinstance(t, pcb.PCB_VIA):
            if (n == 'CAM3_REQ' and near(t.GetPosition(), 56.8, 14.05)): doomed.append(t)
            continue
        if t.IsLocked(): continue
        ends = (t.GetStart(), t.GetEnd())
        on_pad = any(p.GetNetCode() == t.GetNetCode() and p.HitTest(e) for p in pads for e in ends)
        cam2_en = n == 'CAM2_EN' and t.GetLayer() == pcb.B_Cu and any(near(e, 59.45, 10.15) or near(e, 59.45, 17.95) for e in ends)
        req = n == 'CAM3_REQ' and t.GetLayer() == pcb.F_Cu and any(near(e, 56.8, 14.05) for e in ends)
        imu = n == 'IMU_INT' and t.GetLayer() == pcb.F_Cu and any(near(e, 56.8, 16.0) for e in ends)
        if on_pad or cam2_en or req or imu: doomed.append(t)
    names = sorted({t.GetNetname() for t in doomed}); k = len(doomed)
    for t in doomed: b.Remove(t)                 # last: Remove() invalidates the other proxies
    pcb.SaveBoard(str(TARGET), b)
    print(f'u700 rip: {k} items on {names}', flush=True)
    import os; os._exit(0)

log = []
PARTS = {r: v for r, v in PARTS.items() if r in fs}     # R700 left the capture (route_a02_u700_i2c.py)
FLIP = pcb.FLIP_DIRECTION_TOP_BOTTOM if hasattr(pcb, 'FLIP_DIRECTION_TOP_BOTTOM') else False
for ref, ((x, y), rot, side) in PARTS.items():
    f = fs[ref]
    if f.IsFlipped() != (side == 'B'): f.Flip(f.GetPosition(), FLIP)
    f.SetPosition(pt(50 + x, 50 + y)); f.SetOrientationDegrees(rot)
    log.append(f'{ref} {side} ({x}, {y}) {rot}')
f = fs['U700']                                   # pin 1 marker: the footprint's one silk polygon
tri = [g for g in f.GraphicalItems() if g.GetLayer() == pcb.F_SilkS and g.GetShape() == pcb.SHAPE_T_POLY]
assert len(tri) == 1
ps = pcb.SHAPE_POLY_SET(); ps.NewOutline()
for x, y in ((57.45, 17.32), (57.35, 17.77), (57.0, 17.42)): ps.Append(pcb.FromMM(50 + x), pcb.FromMM(50 + y))
tri[0].SetPolyShape(ps); f.SetFPID(pcb.LIB_ID('KINO_A0', 'VQFN-16-1EP_3x3mm_P0.5mm_EP1.1x1.1mm_Pin1Corner'))
log.append('U700 on KINO_A0:...Pin1Corner, pin 1 marker at the south-west corner')
pin = lambda r, n: next(p for p in fs[r].Pads() if p.GetNumber() == n).GetPosition()
log.append('pins ' + ', '.join(f'{n}:({mm(pin("U700", n).x):.2f},{mm(pin("U700", n).y):.2f})' for n in ('2', '9', '12', '13', '8', '6')))
log.append('C700 ' + ', '.join(f'{p.GetNumber()} {p.GetNetname()} ({mm(p.GetPosition().x):.2f},{mm(p.GetPosition().y):.2f})' for p in fs['C700'].Pads()))
log.append('C701 ' + ', '.join(f'{p.GetNumber()} {p.GetNetname()} ({mm(p.GetPosition().x):.2f},{mm(p.GetPosition().y):.2f})' for p in fs['C701'].Pads()))
if 'R700' in fs: log.append('R700 ' + ', '.join(f'{p.GetNumber()} {p.GetNetname()} ({mm(p.GetPosition().x):.2f},{mm(p.GetPosition().y):.2f})' for p in fs['R700'].Pads()))
pcb.SaveBoard(str(TARGET), b)
print('u700 place:', '; '.join(log), flush=True)
import os; os._exit(0)
