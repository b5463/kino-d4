"""Gauge east side: U701 (back) BIN pull-down and GPOUT pull-up beside the package (KiCad 10 python). ODD JOBS 87/88.

R701 (BIN 10k to GND) sat 50 mm away at the top of the board and BIN (pin 10) had no way out: pin 8's
PACK_FUSED via sits above it and GPOUT (pin 12) ran north-east across its exit to R702.
  GAUGE_GPOUT  R702 (GPOUT 10k to GAUGE_1V8) moves to the bottom edge east of the USB-C shield; GPOUT
               leaves pin 12 south-east, under the shield pin, into its west pad. GAUGE_1V8 reaches its
               east pad straight down the board edge from the existing back run.
  GAUGE_BIN    takes GPOUT's old corridor, east between the shield pins, into R701, which moves to
               R702's old place; R701's GND pad ties straight into the adjacent shield pin (In2 and F
               are taken there, so no via).
Phases: rip, place, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('GAUGE_GPOUT', 'B', (110.4, 66.25), (111.05, 66.25)), ('GAUGE_GPOUT', 'B', (111.05, 66.25), (112.35, 64.95)),
    ('GAUGE_GPOUT', 'B', (112.35, 64.95), (114.38, 64.95)), ('GAUGE_GPOUT', 'B', (114.38, 64.95), (115.05, 65.62)),
]
PLACE = {'R701': ((114.7, 65.775), 270, 'B'), 'R702': ((115.2, 68.25), 0, 'B')}
ADD = [
    ('GAUGE_BIN', 'B', W, [(110.4, 65.45), (111.35, 65.45), (111.85, 64.95), (114.7, 64.95)]),
    ('GND', 'B', 0.3, [(114.7, 66.6), (113.32, 66.6)]),
    ('GAUGE_GPOUT', 'B', W, [(110.4, 66.25), (110.95, 66.25), (112.95, 68.25), (114.375, 68.25)]),
    ('GAUGE_1V8', 'B', W, [(115.05, 63.97), (115.45, 63.97), (116.025, 64.545), (116.025, 68.25)]),
]
run('gauge', RIP, ADD, place=PLACE)
