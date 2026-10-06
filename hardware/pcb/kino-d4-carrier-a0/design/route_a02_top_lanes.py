"""Long expander lines along the top edge (KiCad 10 python). ODD JOBS 87/88.

U600's P1 port (west pin column) drives lines that end at the right edge. The top band on In2 is
crossed by the U601 verticals (CAM3_REQ x 52.6, CAM3_EN x 63.2, MB_3V3 x 73.51) from y 2.5 down,
so the long run takes a lane along the board edge above them, y 0.9 (0.8 mm copper to the edge,
clear of the MB_3V3 vias at y 1.65):
  FN_N   pin 16 west on B to a via, In2 up beside U600, east along y 0.9 to x 101.75, down x 102.75
         onto FN_N's B run between J904 pin 1 and R906 (via at (102.75, 9.50)).
  COVER_N pin 13 west on B to a via, In2 round the via cluster west of U600 to a via at the board
         corner of C601, then B along the top edge (y 0.85, under C601 and U600's top pins, clear of
         J904's pads) to x 104.2 and down; an MB_3V3 run at y 20.2 turns it to In2 at (104.2, 18.2)
         and onto COVER_N's via at (105.3, 24.05) beside C903 / R901.
Unattached GND stitching vias on the lanes at (41.43, 0.97) and (104.25, 19.03) go (gnd_stitch.py
re-stitches).
Phases: rip, add.
"""
from handroute import run

W = 0.2
RIP = [('GND', 'V', (41.43, 0.97), None), ('GND', 'V', (104.25, 19.03), None)]
ADD = [
    ('FN_N', 'B', W, [(42.14, 6.88), (39.9, 6.88)]), ('FN_N', 'V', None, [(39.9, 6.88)]),
    ('FN_N', 'I2', W, [(39.9, 6.88), (39.9, 1.5), (40.5, 0.9), (101.75, 0.9), (102.75, 1.9), (102.75, 9.5)]),
    ('FN_N', 'V', None, [(102.75, 9.5)]),
    ('COVER_N', 'B', W, [(42.14, 8.83), (39.3, 8.83)]), ('COVER_N', 'V', None, [(39.3, 8.83)]),
    ('COVER_N', 'I2', W, [(39.3, 8.83), (37.6, 7.13), (37.6, 0.85)]), ('COVER_N', 'V', None, [(37.6, 0.85)]),
    ('COVER_N', 'B', W, [(37.6, 0.85), (103.35, 0.85), (104.2, 1.7), (104.2, 18.2)]),
    ('COVER_N', 'V', None, [(104.2, 18.2)]),
    ('COVER_N', 'I2', W, [(104.2, 18.2), (104.2, 22.95), (105.3, 24.05)]),
]
run('top lanes', RIP, ADD)
