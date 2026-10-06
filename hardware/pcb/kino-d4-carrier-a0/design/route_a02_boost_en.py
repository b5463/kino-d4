"""Boost enable: U1200's EN out of the boost pocket to the power-path FET driver Q1202 (KiCad 10 python).

BOOST_ENABLE (U1300 pin 7) already reaches Q1202 pin 1; U1200's EN (pin 6, back) only had a via
beside the pin, boxed in on both surfaces by the boost's own copper (BOOST_5V, MB_3V3, SYS_RAW,
C1209). On In2 the via is open to the east: the line runs east, down past the BAT_PROTECTED and
BOOST_5V vias, round the end of SYS_RAW's In2 run, and west along the gap above the SYS_5V bar to
a via between the C1202/C1203 caps and Q1200. The front takes it south between MAIN_COMMON and
Q1200's drain pads to a via north-east of Q1202, and the back runs it west into pin 1.
Two GND stitching vias on the way go.
Phases: rip, add.
"""
from handroute import run

W = 0.2
RIP = [('GND', 'V', (59.5, 61.72), None), ('GND', 'V', (64.22, 61.25), None)]
ADD = [
    ('BOOST_ENABLE', 'I2', W, [(63.4, 55.5), (64.9, 55.5), (65.6, 56.2), (65.6, 57.5), (67.5, 59.4), (67.5, 60.6),
                               (67.1, 61.0), (60.2, 61.0)]),
    ('BOOST_ENABLE', 'V', None, [(60.2, 61.0)]),
    ('BOOST_ENABLE', 'F', W, [(60.2, 61.0), (59.4, 61.8), (59.4, 67.2)]),
    ('BOOST_ENABLE', 'V', None, [(59.4, 67.2)]),
    ('BOOST_ENABLE', 'B', W, [(59.4, 67.2), (56.31, 67.2)]),
]
run('boost en', RIP, ADD)
