"""Boost controller U1200 (back) EN pin out of its pocket (KiCad 10 python). ODD JOBS 87/88.

U1200's EN (pin 6, BOOST_ENABLE) sat in a pocket closed on the back by BOOST_5V and SYS_RAW. On F
the MB_3V3 spur to C801 ran over it, and on In2 the SYS_RAW riser to pin 7's via ran under it. The
MB_3V3 spur moves 0.6 mm north (the trunk turns straight down onto its southern branch). The riser
swings west under the package and reaches pin 7's via from the west. EN leaves pin 6 east on B to a
via in the pocket; the run on to Q1202 is in route_a02_boost.py.
Phases: rip, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('SYS_RAW', 'I2', (63.2, 47.2), (63.2, 56.3)),
    ('MB_3V3', 'F', (63.6, 55.3), (61.86, 55.3)), ('MB_3V3', 'F', (61.86, 55.3), (61.39, 55.78)),
    ('MB_3V3', 'F', (63.6, 55.3), (65.4, 53.5)), ('MB_3V3', 'F', (65.35, 55.3), (63.6, 55.3)),
    ('MB_3V3', 'F', (65.65, 55.6), (65.35, 55.3)),
]
ADD = [
    ('MB_3V3', 'F', 0.3, [(65.4, 53.5), (65.4, 55.35), (65.65, 55.6)]),
    ('MB_3V3', 'F', 0.3, [(65.4, 53.5), (64.2, 54.7), (62.47, 54.7), (61.39, 55.78)]),
    ('SYS_RAW', 'I2', 0.6, [(63.2, 47.2), (63.2, 53.7), (62.2, 54.7), (62.2, 55.4), (63.1, 56.3), (63.2, 56.3)]),
    ('BOOST_ENABLE', 'B', W, [(62.425, 55.375), (63.275, 55.375), (63.4, 55.5)]),
    ('BOOST_ENABLE', 'V', None, [(63.4, 55.5)]),
]
run('u1200 en', RIP, ADD)
