"""Remote filter capacitor C904 out of H1's fastener square (KiCad 10 python). verify.py: fastener keep-out.

C904 (REMOTE_FILTER to GND, back) sat beside R903 with its courtyard 0.33 mm inside the 7 mm square
kept clear round the P4 insert at H1. It turns vertical directly below R904, its filter pad
straight under R904 pin 1, its GND pad dropping to a via below it.
Phases: rip, place, add.
"""
from handroute import run

W = 0.2
PLACE = {'C904': ((14.675, 15.25), 270, 'B')}
ADD = [
    ('REMOTE_FILTER', 'B', W, [(14.675, 12.9), (14.675, 14.475)]),
    ('GND', 'B', 0.25, [(14.675, 16.025), (14.675, 16.9)]), ('GND', 'V', None, [(14.675, 16.9)]),
]
run('c904', [], ADD, place=PLACE)
