"""Copper of the remote dry-contact chain beside J903 (KiCad 10 python). See place_a02_remote.py.

Back: J903.1 straight to the clamp D900, on to R903; R903, C904 and R904 share the filter node, which
rises through a via beside D900 to the front and enters U901 pin 2 from the east. Front: U901 pin 4
(REMOTE_ACTIVE) out west to R905, then one vertical and one 45-degree leg to Q900's gate, passing
between U901 pin 5 and its decoupling cap C905 (straight below pin 5). A GND stitching via that sat
on the J903-D900 line moves 1.4 mm north-west. Run 'rip' before place_a02_remote.py place (it
clears the router's first attempt), 'add' after.
"""
from handroute import run

W = 0.2
RIP = [('GND', 'V', (8.62, 8.95), None)]
RIP_NETS = [(n, (0.0, 0.0, 20.0, 16.0)) for n in ('REMOTE_CONTACT', 'REMOTE_FILTER', 'REMOTE_ACTIVE')]
ADD = [
    ('GND', 'V', None, [(8.4, 7.6)]),
    ('REMOTE_CONTACT', 'B', W, [(7.625, 8.95), (11.3, 8.95), (11.3, 11.025), (11.525, 11.25)]),
    ('REMOTE_FILTER', 'B', W, [(13.175, 11.25), (14.675, 11.25), (14.675, 12.9)]),
    ('REMOTE_FILTER', 'B', W, [(13.9, 11.25), (13.9, 10.0)]),
    ('REMOTE_FILTER', 'V', None, [(13.9, 10.0)]),
    ('REMOTE_FILTER', 'F', W, [(13.9, 10.0), (14.6, 9.3), (14.6, 6.5), (13.138, 6.5)]),
    ('REMOTE_ACTIVE', 'F', W, [(10.862, 5.55), (9.875, 5.55), (9.875, 8.813), (7.138, 11.55)]),
    ('REMOTE_ACTIVE', 'F', W, [(9.775, 5.55), (9.125, 4.9)]),
    ('MB_3V3', 'F', 0.25, [(10.862, 7.45), (10.862, 9.025)]),
]
run('remote', RIP, ADD, RIP_NETS)
