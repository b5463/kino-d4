"""J600 pogo test legs (KiCad 10 python). ODD JOBS 87/88.

CAM1_EN's leg (J600.8, F up the middle of camera 1's socket at x 25.85) ended at a via east of U201
that reached nothing: U201's EN pin is boxed in on B by the CAM1_SHUNT_OUT run. It now meets the EN
node at a via between camera 1's fan lanes (x 23.60, In2 lanes at 22.96 / 24.23), just south of the
P4 bus band, with one 45-degree F leg. Phases: rip, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('CAM1_EN', 'V', (28.65, 26.2), None),
    ('CAM1_EN', 'F', (28.65, 26.2), (26.25, 26.2)), ('CAM1_EN', 'F', (26.25, 26.2), (25.85, 26.6)),
]
ADD = [
    ('CAM1_EN', 'V', None, [(23.595, 23.6)]),
    ('CAM1_EN', 'F', W, [(23.595, 23.6), (25.85, 25.855), (25.85, 26.6)]),
]
run('test legs', RIP, ADD)
