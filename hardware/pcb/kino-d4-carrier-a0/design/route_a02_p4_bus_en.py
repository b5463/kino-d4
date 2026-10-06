"""P4 bus enable: U100's EN pin and the R100/R101 divider onto the camera-buffer chain (KiCad 10 python).

P4_BUS_EN (divider R100/R101 off the P4 3V3 sense line) drives U100's EN (pin 5) and the four camera
buffers U200-U500, whose chain ends in a front loop round CAM1_3V3's via south of U200. U100 sits on
the back boxed in by the I2C lines and the divider by MB_3V3 and the fuse, so the net takes In2,
which is free south of SYNC_MASTER's In2 run:
  chain    drops off the bottom of the front loop, past a GND via, to a via 42.9 down.
  U100.5   leaves east between I2C_SCL and I2C_SDA on the back into a via beside R103; In2 runs
           there from the chain via, north-east to south-west.
  divider  In2 goes on from U100's via between the MB_3V3 and GND vias, south-west past the
           AUX_3V3 vias, to a via just below R100 pin 2.
I2C_SDA's front run east of its via moves 0.2 mm north for U100's via. A dangling SYS_5V via goes.
Phases: rip, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('I2C_SDA', 'F', (22.4, 47.67), (23.33, 46.75)), ('I2C_SDA', 'F', (23.33, 46.75), (26.85, 46.75)),
    ('I2C_SDA', 'F', (26.85, 46.75), (27.25, 47.15)),
    ('SYS_5V', 'V', (18.54, 50.27), None),
]
ADD = [
    ('I2C_SDA', 'F', W, [(22.4, 47.67), (22.4, 47.0), (22.85, 46.55), (26.65, 46.55), (27.25, 47.15)]),
    ('P4_BUS_EN', 'F', W, [(30.9, 38.7), (30.9, 40.9), (31.75, 41.75), (31.75, 42.9)]),
    ('P4_BUS_EN', 'V', None, [(31.75, 42.9)]),
    ('P4_BUS_EN', 'I2', W, [(31.75, 42.9), (27.9, 42.9), (23.5, 47.3)]),
    ('P4_BUS_EN', 'V', None, [(23.5, 47.3)]),
    ('P4_BUS_EN', 'B', W, [(21.11, 47.03), (23.23, 47.03), (23.5, 47.3)]),
    ('P4_BUS_EN', 'I2', W, [(23.5, 47.3), (23.5, 48.4), (22.9, 49.0), (21.9, 49.0), (21.35, 49.55), (21.35, 50.8),
                             (19.5, 52.65), (18.6, 53.55), (16.78, 53.55), (16.5, 53.83)]),
    ('P4_BUS_EN', 'V', None, [(16.5, 53.83)]),
    ('P4_BUS_EN', 'B', W, [(16.5, 52.83), (16.5, 53.83)]),
]
run('p4 bus en', RIP, ADD)
