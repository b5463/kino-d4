"""RTC corner: U801 (RV-3028, front) pins 2-4 out to the west (KiCad 10 python). ODD JOBS 87/88.

U801's RTC_INT_N, SCL and SDA all leave its west pin column. Its pull-up R800 sat level with pin 3
(SCL), with RTC_INT_N wrapped round it and an MB_3V3 via for R800 between the two parts, so SCL had
no exit.
  RTC_INT_N  R800 moves 0.83 mm north so its RTC_INT_N pad lines up with pin 2: RTC_INT_N runs
             straight in from pin 2 and from the bundle's via at (39.00, 56.05).
  MB_3V3     R800's MB_3V3 pad is the only feed of the MB_3V3 pull-ups round U1300 and U100; it
             reaches the back through a new via between R800 and U801, then B along y 56.10 to
             C802's via (the old via path and its B run go).
  I2C_SCL    pin 3 straight west below R800 to a via at (38.40, 57.45), clear of the SYS_5V B runs,
             then In2 south-west (south of SOFT_KILL's via, north of the P4_5V_ISO band) to a via on
             J102 pin 4's axis, in place of a GND stitching via. The rest of the bus: route_a02_i2c.py.
Phases: rip, place, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('RTC_INT_N', 'F', (40.35, 57.38), (39.0, 57.38)), ('RTC_INT_N', 'F', (39.0, 57.38), (39.0, 56.05)),
    ('RTC_INT_N', 'F', (40.35, 57.38), (41.17, 57.38)), ('RTC_INT_N', 'F', (41.17, 57.38), (42.0, 56.55)),
    ('RTC_INT_N', 'F', (42.0, 56.55), (42.35, 56.55)),
    ('MB_3V3', 'F', (40.35, 55.72), (40.95, 55.72)), ('MB_3V3', 'F', (40.95, 55.72), (41.35, 56.12)),
    ('MB_3V3', 'F', (41.35, 56.12), (41.35, 56.3)), ('MB_3V3', 'V', (41.35, 56.3), None),
    ('MB_3V3', 'B', (41.35, 56.3), (41.55, 56.1)), ('MB_3V3', 'B', (41.55, 56.1), (42.2, 56.1)),
    ('MB_3V3', 'B', (46.65, 56.1), (42.2, 56.1)), ('MB_3V3', 'F', (40.35, 55.72), (37.72, 53.1)),
    ('GND', 'V', (34.12, 62.0), None),
]
PLACE = {'R800': ((40.35, 55.725), 90, 'F')}
ADD = [
    ('RTC_INT_N', 'F', W, [(42.35, 56.55), (40.35, 56.55)]),
    ('RTC_INT_N', 'F', W, [(39.0, 56.05), (39.5, 56.55), (40.35, 56.55)]),
    ('MB_3V3', 'F', 0.3, [(37.72, 53.1), (39.52, 54.9), (40.35, 54.9)]),
    ('MB_3V3', 'F', 0.25, [(40.35, 54.9), (40.35, 55.5), (40.7, 55.85), (41.25, 55.85)]),
    ('MB_3V3', 'V', None, [(41.25, 55.85)]),
    ('MB_3V3', 'B', 0.3, [(41.25, 55.85), (41.5, 56.1), (46.35, 56.1)]),
    ('MB_3V3', 'B', 0.3, [(46.65, 56.1), (46.35, 56.1)]),
    ('I2C_SCL', 'F', W, [(42.35, 57.45), (38.4, 57.45)]), ('I2C_SCL', 'V', None, [(38.4, 57.45)]),
    ('I2C_SCL', 'B', W, [(34.12, 63.95), (34.12, 62.0)]), ('I2C_SCL', 'V', None, [(34.12, 62.0)]),
    ('I2C_SCL', 'I2', W, [(34.12, 62.0), (36.0, 62.0), (38.4, 59.6), (38.4, 57.45)]),
]
run('u801', RIP, ADD, place=PLACE)
