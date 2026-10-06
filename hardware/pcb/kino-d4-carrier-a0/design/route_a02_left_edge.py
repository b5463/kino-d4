"""C6 service lines and SHUTTER_N along the left and top edges (KiCad 10 python). ODD JOBS 87/88.

The four C6 service lines leave J100's outer pin column (pins 20, 22, 24, 26) west on F, climb the
strip between J100 and the board edge (x 3.35 / 2.75 / 2.15 / 1.55, outside C6_3V3_TEST at x 4.25 and
1.45 mm or more from the edge), turn east along the top edge (y 3.05 / 2.45 / 1.85 / 1.25, nested so
none crosses another) and drop into J101 pins 3-6 from above. 0.6 mm pitch, 45-degree corners.
SHUTTER_N: from Q900's drain (front, top-left corner, see place_a02_remote.py) through a via to B,
down the same strip at x 2.0 and between J100 pins 20 and 22 into pin 21. J902 (the local shutter
jack) already hangs off pin 21 on F.
Phases: rip (nothing to remove), add.
"""
from handroute import run

W = 0.2
ADD = [
    ('C6_RX_SERVICE', 'F', W, [(6.0, 40.86), (3.35, 40.86), (3.35, 3.65), (3.95, 3.05), (28.33, 3.05), (28.83, 3.55), (28.83, 5.0)]),
    ('C6_TX_SERVICE', 'F', W, [(6.0, 43.4), (2.75, 43.4), (2.75, 3.05), (3.35, 2.45), (30.87, 2.45), (31.37, 2.95), (31.37, 5.0)]),
    ('C6_BOOT_SERVICE', 'F', W, [(6.0, 45.94), (2.15, 45.94), (2.15, 2.45), (2.75, 1.85), (33.41, 1.85), (33.91, 2.35), (33.91, 5.0)]),
    ('C6_EN_SERVICE', 'F', W, [(6.0, 48.48), (1.55, 48.48), (1.55, 1.85), (2.15, 1.25), (35.95, 1.25), (36.45, 1.75), (36.45, 5.0)]),
    ('SHUTTER_N', 'F', W, [(5.263, 10.6), (4.0, 10.6)]),
    ('SHUTTER_N', 'V', None, [(4.0, 10.6)]),
    ('SHUTTER_N', 'B', W, [(4.0, 10.6), (2.0, 12.6), (2.0, 40.86), (3.27, 42.13), (7.27, 42.13), (8.54, 43.4)]),
]
run('left edge', [], ADD)
