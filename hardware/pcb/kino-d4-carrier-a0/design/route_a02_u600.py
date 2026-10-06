"""U600 port 1 in layout order and its south-bound lines down the camera 1/2 channel (KiCad 10 python).

U600 (TCA9539, back, top edge) carries eight interchangeable GPIOs on its west pin column, pins 13-20.
In the old order the lines going north / east (FN_N, COVER_N, HAPTIC_EN) and those going south sat
interleaved, so every south-bound line crossed a north-bound one beside the package. circuit.py now
assigns pins 20-18 to COVER_N, FN_N, HAPTIC_EN and pins 17-13 to the south-bound POWER_INT_N,
CHARGE_STAT_N, SOFT_KILL, RTC_INT_N, IMU_INT, in the west-to-east order they take at the bottom of
the board ('place' sets the board's pad nets to match; firmware reads the map from circuit.py).
  north     COVER_N and FN_N keep their edge lanes (route_a02_top_lanes.py), now from pins 20 and 18.
  channel   the five south-bound lines and I2C_SCL as one bundle between the camera 1 and 2 sockets:
            B stubs to vias west of U600, F west and down (0.65 mm rows, 45-degree turns, no line
            crossing another), vias at y 15.3 / 15.95 below the camera lanes, In2 straight down the
            channel at x 34.5 / 35.1 / 36.2 / 36.8 / 37.4 / 38.0 (the gap at 35.65 is I2C_SDA's B
            run) to vias above the SYNC bus at y 39.7 / 40.35. SCL leaves pin 22 west on B and drops
            on B at x 38.0 east of the F rows. The final links below the SYNC bus are short and go
            to the router.
  cleared   POWER_INT_N's old route (F and In2 round the channel), the CAM1_3V3 via (moves 1.9 mm
            north-west onto its own F diagonal, B link added), the P4_BUS_EN via (moves east of the
            bundle; its F run crosses the In2 bundle), a GND stitching via.
Phases: rip, place, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('COVER_N', 'B', (42.14, 8.83), (39.3, 8.83)), ('COVER_N', 'V', (39.3, 8.83), None),
    ('COVER_N', 'I2', (39.3, 8.83), (37.6, 7.13)), ('COVER_N', 'I2', (37.6, 7.13), (37.6, 0.85)),
    ('FN_N', 'B', (42.14, 6.88), (39.9, 6.88)), ('FN_N', 'V', (39.9, 6.88), None),
    ('FN_N', 'I2', (39.9, 6.88), (39.9, 1.5)),
    ('POWER_INT_N', 'B', (40.75, 8.17), (42.14, 8.17)), ('POWER_INT_N', 'V', (40.75, 8.17), None),
    ('POWER_INT_N', 'F', (38.9, 10.02), (40.75, 8.17)), ('POWER_INT_N', 'F', (38.9, 18.45), (38.9, 10.02)),
    ('POWER_INT_N', 'V', (38.9, 18.45), None), ('POWER_INT_N', 'I2', (38.9, 18.45), (38.9, 22.45)),
    ('POWER_INT_N', 'I2', (38.9, 22.45), (37.7, 23.65)), ('POWER_INT_N', 'V', (37.7, 23.65), None),
    ('POWER_INT_N', 'F', (37.35, 24.0), (37.7, 23.65)), ('POWER_INT_N', 'F', (37.35, 42.6), (37.35, 24.0)),
    ('POWER_INT_N', 'F', (38.1, 43.35), (37.35, 42.6)), ('POWER_INT_N', 'V', (38.1, 43.35), None),
    ('POWER_INT_N', 'I2', (33.9, 47.55), (38.1, 43.35)),
    ('CAM1_3V3', 'V', (34.95, 18.55), None), ('CAM1_3V3', 'F', (34.95, 18.55), (33.15, 16.75)),
    ('GND', 'V', (38.45, 24.52), None),
    ('P4_BUS_EN', 'V', (36.25, 35.95), None), ('P4_BUS_EN', 'B', (41.25, 35.95), (36.25, 35.95)),
    ('P4_BUS_EN', 'F', (36.25, 35.95), (31.95, 35.95)),
]
PAD_NETS = {('U600', '13'): 'IMU_INT', ('U600', '14'): 'RTC_INT_N', ('U600', '15'): 'SOFT_KILL',
            ('U600', '16'): 'CHARGE_STAT_N', ('U600', '17'): 'POWER_INT_N', ('U600', '18'): 'FN_N',
            ('U600', '19'): 'HAPTIC_EN', ('U600', '20'): 'COVER_N'}
# (net, pin y, via near U600, F lane x, top via y, bottom via y)
BUNDLE = [
    ('POWER_INT_N', 6.23, 40.3, 34.5, 15.3, 39.7),
    ('CHARGE_STAT_N', 6.88, 39.7, 35.1, 15.95, 40.35),
    ('SOFT_KILL', 7.52, 40.3, 36.2, 15.3, 39.7),
    ('RTC_INT_N', 8.17, 39.7, 36.8, 15.95, 40.35),
    ('IMU_INT', 8.83, 40.3, 37.4, 15.3, 39.7),
]
ADD = [
    ('COVER_N', 'B', W, [(42.14, 4.27), (38.6, 4.27)]), ('COVER_N', 'V', None, [(38.6, 4.27)]),
    ('COVER_N', 'I2', W, [(38.6, 4.27), (37.6, 3.27), (37.6, 0.85)]),
    ('FN_N', 'B', W, [(42.14, 5.58), (39.9, 5.58)]), ('FN_N', 'V', None, [(39.9, 5.58)]),
    ('FN_N', 'I2', W, [(39.9, 5.58), (39.9, 1.5)]),
    ('CAM1_3V3', 'V', None, [(33.6, 17.2)]),
    ('CAM1_3V3', 'F', 0.25, [(33.6, 17.2), (33.15, 16.75)]), ('CAM1_3V3', 'B', 0.25, [(33.6, 17.2), (34.95, 18.55)]),
    ('P4_BUS_EN', 'B', W, [(41.25, 35.95), (38.6, 35.95)]), ('P4_BUS_EN', 'V', None, [(38.6, 35.95)]),
    ('P4_BUS_EN', 'F', W, [(38.6, 35.95), (31.95, 35.95)]),
    ('I2C_SCL', 'B', W, [(42.14, 2.98), (38.4, 2.98), (38.0, 3.38), (38.0, 15.95)]),
    ('I2C_SCL', 'V', None, [(38.0, 15.95)]), ('I2C_SCL', 'I2', W, [(38.0, 15.95), (38.0, 40.35)]),
    ('I2C_SCL', 'V', None, [(38.0, 40.35)]),
]
for net, y, vx, lx, ty, by in BUNDLE:
    ADD += [
        (net, 'B', W, [(42.14, y), (vx, y)]), (net, 'V', None, [(vx, y)]),
        (net, 'F', W, [(vx, y), (lx + 0.6, y), (lx, y + 0.6), (lx, ty)]), (net, 'V', None, [(lx, ty)]),
        (net, 'I2', W, [(lx, ty), (lx, by)]), (net, 'V', None, [(lx, by)]),
    ]
run('u600', RIP, ADD, pad_nets=PAD_NETS)
