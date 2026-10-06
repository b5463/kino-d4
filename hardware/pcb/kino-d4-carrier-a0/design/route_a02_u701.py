"""Gauge corner: U701 (BQ27Z561-class, back) pins 1-2 out to the west, U1000 pin 8 out (KiCad 10 python). ODD JOBS 87/88.

U701's SDA and SCL (pins 1-2, west column) were fenced by GAUGE_1V8, which ran from pin 5 down the
west side of the package to C702 below it, and by the USB-C shield pins beyond.
  GAUGE_1V8  C702 moves into the gap between J1000's two west shield pins, its 1.8 V pad on pin 5's
             axis: pin 5 runs straight into it on B, and a via above it carries GAUGE_1V8 onto the
             existing F run east to R702. The B run down the west side, its via and the F spur go.
  I2C_SCL    pin 2 west to a via clear of pin 3, In2 straight down to the SCL bus lane (y 67.85).
  I2C_SDA    pin 1 west and straight down on B to a via on the SDA bus lane (y 68.45), crossing the
             SCL lane on B.
  U1000      (PD controller, front) SDA (pin 8) sat between PD_DISCH (pin 9) and SCL (pin 7), both
             leaving east. PD_DISCH's via moves 1.1 mm north-east of its pin (In2 follows), so SDA
             leaves east to its own via inside SCL's F loop.
  east edge  the gauge and the PD controller join along the free east edge: SDA on F along the bottom
             edge and up beside the USB-C shield, then B to U1000's new via (the grid router's path);
             SCL on In2, the bus lane carried on and up the edge to U1000's SCL via at (111.75, 47.20).
Phases: rip, place, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('GAUGE_1V8', 'B', (106.6, 64.65), (106.2, 64.65)), ('GAUGE_1V8', 'B', (106.2, 64.65), (106.0, 64.85)),
    ('GAUGE_1V8', 'B', (106.0, 64.85), (106.0, 67.9)), ('GAUGE_1V8', 'B', (106.0, 67.9), (106.4, 68.3)),
    ('GAUGE_1V8', 'B', (106.4, 68.3), (106.72, 68.3)), ('GAUGE_1V8', 'B', (106.3, 66.85), (106.0, 66.85)),
    ('GAUGE_1V8', 'V', (106.3, 66.85), None), ('GAUGE_1V8', 'F', (106.3, 64.2), (106.3, 66.85)),
    ('GAUGE_1V8', 'F', (106.7, 63.8), (106.3, 64.2)),
    ('PD_DISCH', 'F', (111.4, 54.65), (110.71, 54.65)), ('PD_DISCH', 'F', (111.75, 55.0), (111.4, 54.65)),
    ('PD_DISCH', 'V', (111.75, 55.0), None), ('PD_DISCH', 'I2', (107.55, 55.0), (111.75, 55.0)),
]
PLACE = {'C702': ((104.425, 64.27), 180, 'B')}
ADD = [
    ('GAUGE_1V8', 'B', 0.25, [(106.6, 64.65), (106.2, 64.65), (105.82, 64.27), (105.2, 64.27)]),
    ('GAUGE_1V8', 'B', 0.25, [(105.2, 64.27), (105.2, 63.75), (105.5, 63.45), (105.95, 63.45)]),
    ('GAUGE_1V8', 'V', None, [(105.95, 63.45)]),
    ('GAUGE_1V8', 'F', W, [(105.95, 63.45), (106.3, 63.8), (106.7, 63.8)]),
    ('I2C_SCL', 'B', W, [(106.6, 65.85), (106.2, 65.85), (105.75, 65.4)]), ('I2C_SCL', 'V', None, [(105.75, 65.4)]),
    ('I2C_SCL', 'I2', W, [(105.75, 65.4), (105.75, 67.85)]),
    ('I2C_SDA', 'B', W, [(106.6, 66.25), (106.05, 66.25), (106.05, 68.15), (105.75, 68.45)]),
    ('I2C_SDA', 'V', None, [(105.75, 68.45)]),
    ('PD_DISCH', 'F', W, [(110.71, 54.65), (111.1, 54.65), (111.75, 54.0), (111.75, 53.9)]),
    ('PD_DISCH', 'V', None, [(111.75, 53.9)]),
    ('PD_DISCH', 'I2', W, [(111.75, 53.9), (110.65, 55.0), (107.55, 55.0)]),
    ('I2C_SDA', 'F', W, [(110.71, 55.15), (111.7, 55.15), (112.0, 54.85)]), ('I2C_SDA', 'V', None, [(112.0, 54.85)]),
    ('I2C_SDA', 'F', W, [(105.75, 68.45), (114.7, 68.45), (114.7, 59.7)]), ('I2C_SDA', 'V', None, [(114.7, 59.7)]),
    ('I2C_SDA', 'B', W, [(114.7, 59.7), (114.7, 58.45), (112.0, 55.75), (112.0, 54.85)]),
    ('I2C_SCL', 'I2', W, [(105.75, 67.85), (114.7, 67.85), (115.3, 67.25), (115.3, 47.8), (114.7, 47.2), (111.75, 47.2)]),
]
run('u701', RIP, ADD, place=PLACE)
