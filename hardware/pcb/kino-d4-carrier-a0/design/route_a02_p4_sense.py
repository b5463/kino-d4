"""P4 3V3 sense line: J100 pin 1 round the west edge to its divider R100 (KiCad 10 python).

P4_3V3_SENSE leaves the P4 header (J100, back) at pin 1 and must reach R100 33 mm south. The direct
lanes are fenced by the CAM1_5V and C6_3V3_TEST front runs, the P4 bus fan-out on In2 and the
CAM1_EN and SHUTTER_N back runs, so the line goes north out of the pin column, jogs past
SHUTTER_N's via, runs down the west edge on the back 1 mm in and comes east along y 50.5 into
R100 pin 1. A GND stitching via on that last run goes.
Phases: rip, add.
"""
from handroute import run

W = 0.2
RIP = [('GND', 'V', (16.0, 50.0), None)]
ADD = [('P4_3V3_SENSE', 'B', W, [(8.54, 18.0), (8.54, 10.7), (8.04, 10.2), (5.95, 10.2), (5.7, 9.95), (1.6, 9.95),
                                  (1.0, 10.55), (1.0, 50.0), (1.5, 50.5), (15.83, 50.5), (16.5, 51.17)])]
run('p4 sense', RIP, ADD)
