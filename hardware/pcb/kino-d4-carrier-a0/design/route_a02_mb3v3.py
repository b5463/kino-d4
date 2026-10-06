"""MB_3V3 links for parts that moved (KiCad 10 python). ODD JOBS 87/88.

  remote chain  R904 (filter pull-up, back) and U901 / C905 (front) beside J903 had no 3.3 V: a via
                beside R904 (south-west of the C6_3V3_TEST F diagonal, so the F leg need not cross
                it), In2 east to the MB_3V3 via at (22.40, 14.05) on the camera 1 feed, F west into
                C905 pad 1 (C905 sits straight below U901 pin 5).
0.25 mm. Phases: rip (nothing to remove), add.
"""
from handroute import run

W = 0.25
ADD = [
    ('MB_3V3', 'B', W, [(16.325, 12.9), (16.725, 12.9), (17.2, 12.425), (17.2, 12.0)]),
    ('MB_3V3', 'V', None, [(17.2, 12.0)]),
    ('MB_3V3', 'I2', W, [(17.2, 12.0), (17.2, 13.3), (21.65, 13.3), (22.1, 13.75)]),
    ('MB_3V3', 'F', W, [(17.2, 12.0), (16.45, 12.75), (13.55, 12.75), (11.8, 11.0), (11.8, 9.6), (11.225, 9.025), (10.862, 9.025)]),
]
run('mb3v3', [], ADD)
