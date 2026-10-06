"""Haptic driver U900 (front) SDA down to the PD controller U1000 (KiCad 10 python). ODD JOBS 87/88.

U900's SDA (pin 3) sat between HAPTIC_EN's via (from pin 5) and SCL's via (from pin 2), 1.0 mm apart
east of the package; MOTOR_N and HAPTIC_REG fill In2 to the west. HAPTIC_EN's via moves 0.25 mm north
(its F stub turns 45 degrees into it, the B run shifts with it) and SCL's 0.25 mm south, which leaves
room for SDA's via straight east of pin 3. SDA then runs In2 east of SCL's vias and straight down the
east side of the PD power stage (In2 is free there), hops onto F over SCL's In2 run at y 47.20 (the
hop via sits between that run and the PD_COMMON_SOURCE back run), and drops on In2 into U1000's SDA via.
Phases: rip, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('HAPTIC_EN', 'F', (111.4, 21.0), (110.15, 21.0)), ('HAPTIC_EN', 'F', (111.4, 21.5), (111.4, 21.0)),
    ('HAPTIC_EN', 'V', (111.4, 21.5), None), ('HAPTIC_EN', 'B', (109.4, 23.5), (111.4, 21.5)),
    ('HAPTIC_EN', 'B', (109.4, 26.45), (109.4, 23.5)),
    ('I2C_SCL', 'F', (111.45, 22.5), (110.15, 22.5)), ('I2C_SCL', 'V', (111.45, 22.5), None),
    ('I2C_SCL', 'B', (111.45, 26.45), (111.45, 22.5)),
]
ADD = [
    ('HAPTIC_EN', 'F', W, [(110.15, 21.0), (111.15, 21.0), (111.4, 21.25)]), ('HAPTIC_EN', 'V', None, [(111.4, 21.25)]),
    ('HAPTIC_EN', 'B', W, [(111.4, 21.25), (109.4, 23.25), (109.4, 26.45)]),
    ('I2C_SCL', 'F', W, [(110.15, 22.5), (111.2, 22.5), (111.45, 22.75)]), ('I2C_SCL', 'V', None, [(111.45, 22.75)]),
    ('I2C_SCL', 'B', W, [(111.45, 22.75), (111.45, 26.45)]),
    ('I2C_SDA', 'F', W, [(110.15, 22.0), (111.45, 22.0)]), ('I2C_SDA', 'V', None, [(111.45, 22.0)]),
    ('I2C_SDA', 'I2', W, [(111.45, 22.0), (112.1, 22.0), (112.9, 22.8), (112.9, 46.4)]),
    ('I2C_SDA', 'V', None, [(112.9, 46.4)]), ('I2C_SDA', 'F', W, [(112.9, 46.4), (112.9, 51.0)]),
    ('I2C_SDA', 'V', None, [(112.9, 51.0)]),
    ('I2C_SDA', 'I2', W, [(112.9, 51.0), (112.9, 53.95), (112.0, 54.85)]),
]
run('u900 sda', RIP, ADD)
