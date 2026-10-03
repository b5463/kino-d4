"""GAUGE_1V8 via away from J1000's mounting peg (KiCad 10 python). Release manufacturing review.

The via at (105.95, 63.45) was 0.385 mm hole edge to hole edge from J1000's 0.65 mm non-plated peg at
(106.11, 62.605), under the 0.45-0.5 mm hole-to-hole minimum of the fab. It moves to (106.05, 63.6):
0.52 mm from the peg, 0.15 mm ring-to-pad from C702.1 (same net). Phases: rip, add.
"""
from handroute import run

RIP = [('GAUGE_1V8', 'V', (105.95, 63.45), None), ('GAUGE_1V8', 'B', (105.5, 63.45), (105.95, 63.45)),
       ('GAUGE_1V8', 'F', (105.95, 63.45), (106.3, 63.8)), ('GAUGE_1V8', 'F', (106.3, 63.8), (106.7, 63.8))]
ADD = [('GAUGE_1V8', 'V', None, [(106.05, 63.6)]),
       ('GAUGE_1V8', 'B', 0.25, [(105.5, 63.45), (105.65, 63.6), (106.05, 63.6)]),
       ('GAUGE_1V8', 'F', 0.2, [(106.05, 63.6), (106.25, 63.8), (106.7, 63.8)])]
run('peg via', RIP, ADD)
