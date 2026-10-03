"""P4 connector J100 (back): the P4 3V3 test point beside its pin (KiCad 10 python).

TP100 (probe land on P4_3V3_TEST, J100 pin 3) sat 25 mm away; the line had no way through the P4
bus fan-out east of the header. It moves onto the front just east of pin 1, its silk ring clear of
pin 1's mask opening (the shrouded header's courtyard covers the back there; the fixture probes the
front, like J600), joined to pin 3 by a short front run. Two GND stitching vias beside the header go.
Phases: rip, place, add.
"""
from handroute import run

W = 0.2
RIP = [('GND', 'V', (10.51, 19.01), None), ('GND', 'V', (9.71, 19.61), None)]
PLACE = {'TP100': ((10.8, 17.9), 0, 'F')}
ADD = [('P4_3V3_TEST', 'F', W, [(8.54, 20.54), (9.8, 20.54), (10.8, 19.54), (10.8, 17.9)])]
run('j100', RIP, ADD, place=PLACE)
