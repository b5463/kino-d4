"""I2C into U700 (PAC1954, front, between cameras 2 and 3) (KiCad 10 python). ODD JOBS 87/88.

U700's SCL (pin 4, south side) and SDA (pin 5, east side) had no way out: SCL was fenced by C700's
MB_3V3 link to a via below the package and by C701 on the back; SDA by PAC_ADDR running from pin 6
to the strap R700 below. Beyond them sit camera 3's Kelvin lines and the CAM3_5V_ISO B run.
  ADDRSEL  R700 (0 ohm, ADDRSEL to GND for address 0x10) leaves the capture: U700 is the only
           PAC1954 on the bus, so pin 6 ties straight to the exposed GND pad (circuit.py).
  MB_3V3   the trunk reaches pin 16's via directly on B; C701 turns 180 degrees and moves 1.2 mm
           west (its GND pad on C700's GND via); C700 pad 1 reaches the back through a via east of
           SCL's, clear of the SYS_5V riser below.
  SCL      pin 4 straight down to a via, In2 along the one free corridor north of camera 2's header
           (y 14.05, between lane C and the header pads) to the SCL bundle via at (38.00, 15.95).
  SDA      pin 5 east to a via, In2 down the one free column between the SYS_5V riser and camera 3's
           socket (x 60.85, then 60.65 past a CAM3_SYNC via) to a via above the SYNC bus, clear of J400; the link to
           U800 is next.
Also dropped: R603's GND via on the SCL corridor (R603.2 is on the B pour). Phases: rip, place, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('PAC_ADDR', 'F', (60.21, 15.75), (60.85, 15.75)), ('PAC_ADDR', 'F', (60.85, 15.75), (60.85, 17.65)),
    ('PAC_ADDR', 'F', (60.85, 17.65), (60.08, 18.42)),
    ('GND', 'F', (61.72, 18.42), (62.39, 17.75)), ('GND', 'V', (62.39, 17.75), None),
    ('MB_3V3', 'F', (60.1, 17.35), (59.8, 17.65)), ('MB_3V3', 'F', (59.8, 17.65), (59.35, 17.65)),
    ('MB_3V3', 'F', (59.35, 17.65), (59.35, 18.42)), ('MB_3V3', 'F', (59.35, 18.42), (58.5, 18.42)),
    ('MB_3V3', 'V', (60.1, 17.35), None), ('MB_3V3', 'B', (59.3, 18.15), (60.1, 17.35)),
    ('MB_3V3', 'B', (57.3, 18.15), (59.3, 18.15)), ('MB_3V3', 'B', (60.1, 17.35), (60.1, 15.8)),
    ('MB_3V3', 'B', (60.1, 15.8), (56.0, 11.7)),
    ('GND', 'B', (58.85, 17.25), (58.85, 15.6)), ('GND', 'B', (58.85, 15.6), (58.75, 15.5)),
    ('GND', 'V', (56.0, 14.33), None),
]
PLACE = {'C701': ((56.8, 17.6), 180, 'B')}
PAD_NETS = {('U700', '6'): 'GND'}
ADD = [
    ('GND', 'F', W, [(60.21, 15.75), (59.3, 15.75)]),
    ('GND', 'B', 0.25, [(56.025, 17.6), (56.025, 18.345), (56.1, 18.42)]),
    ('MB_3V3', 'B', 0.3, [(56.0, 11.7), (57.29, 12.99), (57.29, 16.8)]),
    ('MB_3V3', 'B', W, [(57.3, 18.15), (58.55, 18.15)]),
    ('MB_3V3', 'F', 0.25, [(58.5, 18.42), (59.95, 18.42), (60.3, 18.07), (60.3, 17.65)]),
    ('MB_3V3', 'V', None, [(60.3, 17.65)]),
    ('MB_3V3', 'B', 0.25, [(60.3, 17.65), (60.3, 18.4), (58.8, 18.4), (58.55, 18.15)]),
    ('I2C_SCL', 'F', W, [(59.5, 16.96), (59.5, 17.75)]), ('I2C_SCL', 'V', None, [(59.5, 17.75)]),
    ('I2C_SCL', 'I2', W, [(59.5, 17.75), (59.5, 14.85), (58.7, 14.05), (39.9, 14.05), (38.0, 15.95)]),
    ('I2C_SDA', 'F', W, [(60.21, 16.25), (60.45, 16.25), (60.85, 16.65), (60.85, 16.85)]),
    ('I2C_SDA', 'V', None, [(60.85, 16.85)]),
    ('I2C_SDA', 'I2', W, [(60.85, 16.85), (60.85, 25.4), (60.65, 25.6), (60.65, 39.85), (60.3, 40.2)]),
    ('I2C_SDA', 'V', None, [(60.3, 40.2)]),
]
run('u700 i2c', RIP, ADD, place=PLACE, pad_nets=PAD_NETS, remove=('R700',))
