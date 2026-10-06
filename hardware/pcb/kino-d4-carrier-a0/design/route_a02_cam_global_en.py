"""Camera global enable: P4 header pin 10 across the top of the board to the enable gates U601 (KiCad 10 python).

CAM_GLOBAL_EN joins J100 pin 10 (and its pull-down R104) to the four gate inputs of U601 (back,
top middle), 60 mm east; every surface lane between them is taken. It runs on In2 straight off the
header's plated pin: north between the two pin columns, east along y 10.95 just south of H1's keepout, up to y 6.9
under the J101 row, through the gap in U600's west via column, round U600's north side along y 3.6
and over CAM3_EN's via, into a via at the north end of U601 that lands on the gates' back link.
Phases: rip, add.
"""
from handroute import run

W = 0.2
ADD = [
    ('CAM_GLOBAL_EN', 'I2', W, [(6.0, 28.16), (7.27, 26.89), (7.27, 11.65), (7.97, 10.95), (24.0, 10.95), (28.075, 6.875),
                                (41.0, 6.875), (42.5, 5.375), (42.5, 4.4), (43.3, 3.6), (61.4, 3.6), (62.6, 2.4),
                                (64.0, 2.4), (65.6, 4.0), (68.55, 4.0)]),
    ('CAM_GLOBAL_EN', 'V', None, [(68.55, 4.0)]),
    ('CAM_GLOBAL_EN', 'B', W, [(68.55, 4.0), (68.55, 5.2)]),
]
run('cam global en', [], ADD)
