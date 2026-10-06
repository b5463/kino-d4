"""CAM3_REQ pull-down R603 and U700's 1 uF C701 off the CAM2 fault line (KiCad 10 python).

CAM2_FAULT_N (route_a02_cam2_fault.py) had to pass between the pads of R603 and of C701, under
both bodies.
  R603  CAM3_REQ's pull-down only needs to sit somewhere on the net. It moves from the end of an
        8 mm back stub to U601 pin 10, the other end of CAM3_REQ: pin 10 runs east into it, its
        GND pad drops to a via. The stub and its via go (the In2 run through that via is
        continuous), and so does the back link that tied its GND pad to C701.
  C701  moves under U700's east half on the back: its MB_3V3 pad tees off the MB_3V3 trunk
        2.6 mm below the U700 supply via, its GND pad runs to the GND via beside it. C700
        (100 nF, front) stays the close decoupler. C701's old GND link goes.
Phases: rip, place, add.
"""
from handroute import run

RIP = [
    ('CAM3_REQ', 'B', (47.1, 10.45), (49.33, 12.67)), ('CAM3_REQ', 'B', (49.33, 12.67), (55.25, 12.67)),
    ('CAM3_REQ', 'V', (47.1, 10.45), None),
    ('GND', 'B', (55.25, 14.33), (55.72, 14.33)), ('GND', 'B', (55.72, 14.33), (56.03, 14.62)),
    ('GND', 'B', (56.03, 14.62), (56.03, 17.6)),
    ('GND', 'B', (56.03, 17.6), (56.03, 18.34)), ('GND', 'B', (56.03, 18.34), (56.1, 18.42)),
]
PLACE = {'R603': ((73.125, 5.525), 0, 'B'), 'C701': ((58.775, 14.2), 0, 'B')}
ADD = [
    ('CAM3_REQ', 'B', 0.2, [(70.61, 5.85), (71.6, 5.85), (71.925, 5.525), (72.3, 5.525)]),
    ('GND', 'B', 0.25, [(73.95, 5.525), (74.95, 5.525)]), ('GND', 'V', None, [(74.95, 5.525)]),
    ('MB_3V3', 'B', 0.3, [(57.29, 14.2), (58.0, 14.2)]),
    ('GND', 'B', 0.25, [(59.55, 14.2), (59.55, 14.7), (58.75, 15.5)]),
]
run('r603 c701', RIP, ADD, place=PLACE)
