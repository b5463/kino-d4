"""Short hand routes the grid router cannot finish: boxed-in pads and gaps in otherwise routed nets (KiCad 10 python).

Each fix names what it removes and what it draws; every drawn item is locked. Checked against
foreign copper with 0.15 mm clearance before it was written down (the copper it removes aside).
  USB_CC2       U1000 pins 4/5 had no way out: one of the two USB_VBUS vias below them sat in the
                only gap. That via moves 0.8 mm east (with a 0.6 mm F and 1.0 mm B link back to its
                partner, so the VBUS feed keeps two vias), and CC2 runs straight down from pin 5
                to its via at (109.35, 58.60).
  CHG_REGN      the U1100.5 stub stopped 1.2 mm short of the run to its via (95.05, 56.42); the run
                also had a 0.02 mm skew. The F loop from the via at (97.50, 59.70) round R1107 to
                R1110 is replaced by a 45-degree In2 run to the via at (99.65, 62.62), which already
                ties R1110.2 in: it boxed in R1107.1.
  CHG_TS        R1107.1 (thermistor bias) was not connected: out east, a via, and back on B to
                the CHG_TS run at (98.10, 60.75).
  POWER_KILL_N  U1300.2 (back) sits under U802 and C803 (front): the pin leaves west on B, down
                the gap beside C1300, to a via between the parts and up on F between R1300 and
                Q1300 onto the R1300-Q1300 run. Two GND stitching vias in that gap make way for
                one at (31.15, 57.75); the stub east of the pin goes.
  PACK_FUSED    the gauge sense line from RS700.1 to its via left the pad at an angle (11 degrees):
                now straight, then 45 degrees.
Phases: rip, add (separate processes).
"""
from handroute import run

# (net, layer F/B/I2, width, points) tracks; (net, 'V', None, [(x, y)]) vias
ADD = [
    ('USB_VBUS', 'V', None, [(111.0, 57.6)]),
    ('USB_VBUS', 'F', 0.6, [(110.2, 57.6), (111.0, 57.6)]),
    ('USB_VBUS', 'B', 1.0, [(110.2, 57.6), (111.0, 57.6)]),
    ('USB_CC2', 'F', 0.2, [(109.5, 56.36), (109.5, 58.45), (109.35, 58.6)]),
    ('CHG_REGN', 'B', 0.2, [(92.45, 55.2), (92.45, 56.42), (95.05, 56.42)]),
    ('CHG_REGN', 'I2', 0.2, [(97.5, 59.7), (97.5, 60.47), (99.65, 62.62)]),
    ('CHG_TS', 'F', 0.2, [(101.35, 61.025), (101.95, 61.025), (102.3, 61.375)]),
    ('CHG_TS', 'V', None, [(102.3, 61.375)]),
    ('CHG_TS', 'B', 0.2, [(102.3, 61.375), (101.725, 61.95), (99.3, 61.95), (98.1, 60.75)]),
    ('POWER_KILL_N', 'B', 0.2, [(30.862, 56.325), (29.9, 56.325), (29.9, 57.4), (30.35, 57.85)]),
    ('POWER_KILL_N', 'V', None, [(30.35, 57.85)]),
    ('POWER_KILL_N', 'F', 0.2, [(30.35, 57.85), (29.775, 58.425), (29.775, 60.55)]),
    ('GND', 'V', None, [(31.15, 57.75)]),
    ('PACK_FUSED', 'F', 0.2, [(98.95, 61.06), (99.91, 61.06), (100.15, 61.3)]),
]
# (net, layer or 'V', a, b): tracks by both ends, vias by position (b None)
RIP = [
    ('USB_VBUS', 'V', (109.4, 57.6), None),
    ('USB_VBUS', 'F', (110.2, 57.6), (109.4, 57.6)),
    ('CHG_REGN', 'B', (92.45, 56.4), (95.05, 56.42)),
    ('CHG_REGN', 'F', (97.5, 59.7), (99.35, 59.7)), ('CHG_REGN', 'F', (99.35, 59.7), (99.85, 60.2)),
    ('CHG_REGN', 'F', (99.85, 60.2), (101.9, 60.2)), ('CHG_REGN', 'F', (101.9, 60.2), (102.3, 60.6)),
    ('CHG_REGN', 'F', (102.3, 60.6), (102.3, 61.45)), ('CHG_REGN', 'F', (102.3, 61.45), (101.12, 62.62)),
    ('CHG_REGN', 'F', (101.12, 62.62), (100.85, 62.62)),
    ('POWER_KILL_N', 'B', (31.6, 56.33), (30.86, 56.33)),
    ('GND', 'V', (29.89, 58.05), None), ('GND', 'V', (30.86, 57.97), None),
    ('PACK_FUSED', 'F', (98.95, 61.06), (100.15, 61.3)),
]
run('local fixes', RIP, ADD)
