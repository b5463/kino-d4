"""MOTOR_P out of the haptic driver U900 (front) to J900 (KiCad 10 python). ODD JOBS 87/88.

U900's pin 7 (MOTOR_P) was walled in: an F loop tied its MB_3V3 pins 6 and 10 round the outside of
pins 7-9, and pin 8's GND stub (route_a02_u900_gnd.py) ran under the package between pin 7 and the
GND via. Now:
  MB_3V3   the loop goes; pins 6 and 10 keep their own F exits (north to R906 / the via at
           (105.95, 20.20), south to the via at (106.25, 24.05)) and those two vias are joined on In2.
  GND      pin 8 takes the F GND pour west of the package, which the loop had kept out; pin 4 keeps
           its stub to the GND via at (107.20, 20.60).
  MOTOR_P  pin 7 inwards to a via under the package, In2 north beside MOTOR_N (a pair, 0.4 mm and
           more apart) and east under J900 to a via, B into J900 pin 1 from below.
Phases: rip, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('MB_3V3', 'F', (105.85, 21.0), (105.0, 21.0)), ('MB_3V3', 'F', (105.0, 21.0), (104.6, 21.4)),
    ('MB_3V3', 'F', (104.6, 21.4), (104.6, 22.6)), ('MB_3V3', 'F', (104.6, 22.6), (105.0, 23.0)),
    ('MB_3V3', 'F', (105.0, 23.0), (105.85, 23.0)),
    ('GND', 'F', (105.85, 22.0), (106.8, 22.0)), ('GND', 'F', (106.8, 22.0), (107.2, 21.6)),
    ('GND', 'F', (107.2, 21.6), (107.2, 20.6)),
]
ADD = [
    ('MB_3V3', 'I2', 0.3, [(105.95, 20.2), (105.95, 23.75), (106.25, 24.05)]),
    ('MOTOR_P', 'F', W, [(105.85, 21.5), (107.1, 21.5), (107.3, 21.7)]), ('MOTOR_P', 'V', None, [(107.3, 21.7)]),
    ('MOTOR_P', 'I2', W, [(107.3, 21.7), (106.6, 21.0), (106.6, 9.7), (107.8, 8.5), (110.62, 8.5)]),
    ('MOTOR_P', 'V', None, [(110.62, 8.5)]), ('MOTOR_P', 'B', W, [(110.62, 8.5), (110.62, 9.95)]),
]
run('u900', RIP, ADD)
