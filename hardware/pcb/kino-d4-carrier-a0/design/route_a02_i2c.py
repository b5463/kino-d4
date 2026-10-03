"""I2C bus links between the west cluster, the RTC, the IMU and the power side (KiCad 10 python). ODD JOBS 87/88.

  west   the SCL B run under J601 (y 49.80) drops at x 34.75 to In2 and runs straight down the gap
         between POWER_INT_N and SOFT_KILL (in place of a GND stitching via) onto the U801 / J102 run.
  U800   SCL leaves the IMU's pin 13 north between its SDA and 3.3 V lines to a via just outside L1200's
         switch-node keepout (in place of a GND stitching via), then
         In2 north-west and straight west under the free middle of the board to the bundle's SCL via
         at (38.00, 48.30).
  east   the power side sits behind the In2 SYS_5V / SYS_RAW loop round the boost stage and the main
         switches. The one In2 gap through it, between the P4_5V_ISO strap and the SYS_5V riser at
         x 49.6-51.3, carries the pair south (SCL teed off the y 48.30 run, SDA from a via on its B run
         under J601-U800) to the free strip along the bottom edge: SCL y 67.85, SDA y 68.45, south of
         the H4 keepout and J1100. Under J1100 SCL tees north into the charger's gap run
         (route_a02_u1100.py); SDA, the outer lane, crosses SCL on B between two vias. The lanes end
         at the gauge's escapes (route_a02_u701.py).
Phases: rip, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('GND', 'V', (35.5, 51.95), None), ('GND', 'V', (59.08, 53.0), None),
]
ADD = [
    ('I2C_SCL', 'B', W, [(34.75, 49.8), (34.75, 51.45)]), ('I2C_SCL', 'V', None, [(34.75, 51.45)]),
    ('I2C_SCL', 'I2', W, [(34.75, 51.45), (34.75, 51.95), (35.55, 52.75), (35.55, 62.0)]),
    ('I2C_SCL', 'F', W, [(58.5, 54.09), (58.5, 52.65), (58.75, 52.4)]), ('I2C_SCL', 'V', None, [(58.75, 52.4)]),
    ('I2C_SCL', 'I2', W, [(58.75, 52.4), (54.65, 48.3), (38.0, 48.3)]),
    ('I2C_SCL', 'I2', W, [(50.95, 48.3), (50.95, 67.25), (51.55, 67.85), (105.75, 67.85)]),
    ('I2C_SDA', 'V', None, [(50.35, 51.75)]),
    ('I2C_SDA', 'I2', W, [(50.35, 51.75), (50.35, 67.85), (50.95, 68.45), (105.75, 68.45)]),
    ('I2C_SDA', 'V', None, [(87.85, 68.45)]), ('I2C_SDA', 'B', W, [(87.85, 68.45), (87.85, 67.25)]),
    ('I2C_SDA', 'V', None, [(87.85, 67.25)]),
]
run('i2c', RIP, ADD)
