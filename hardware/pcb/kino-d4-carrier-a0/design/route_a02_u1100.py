"""Charger pocket: U1100 (BQ25798, back) pins 13-16 out to the south (KiCad 10 python). ODD JOBS 82/87/88.

U1100's CHARGE_CE_N, I2C_SCL and I2C_SDA (pins 13-15, bottom row) sat in a closed pocket: CHG_TS ran
from pin 16 diagonally under them on B, BAT_PROTECTED crossed beneath on a 2.4 mm In2 strap and a
1.6 mm F strap, and CHG_ILIM, R1105 and J1100 closed the sides.
  BAT_PROTECTED  the In2 strap and its three transfer vias go. The via column at x 84.60 now hands the
                 battery current to F, which runs 1.5 mm wide along y 59.45, below the new vias and
                 above CHG_REGN, onto the existing 1.6 mm F run to RS700.
  CHG_TS         straight down from pin 16 on B, between R1105's pads, then east along y 61.30 to the
                 existing junction at x 91.90.
  pins 13-15     each drops on B to its own via just below the row (no via in pad). On In2, SDA and
                 SCL run south-west and down the gap between J1100 pins 3 and 2 to the bus lanes
                 (route_a02_i2c.py). CHARGE_CE_N runs south-east and down the gap between J1100 pins 2
                 and 1 to R1110 (DNP, its CHG_REGN pad on the REGN B run) and R1102 (100k to GND),
                 which move from the far side of the charger to the back below the battery connector.
Phases: rip, place, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('BAT_PROTECTED', 'I2', (84.6, 56.3), (84.6, 57.7)), ('BAT_PROTECTED', 'I2', (84.6, 57.7), (85.3, 58.4)),
    ('BAT_PROTECTED', 'I2', (85.3, 58.4), (92.1, 58.4)), ('BAT_PROTECTED', 'F', (98.25, 58.4), (90.3, 58.4)),
    ('BAT_PROTECTED', 'V', (90.3, 58.4), None), ('BAT_PROTECTED', 'V', (91.2, 58.4), None),
    ('BAT_PROTECTED', 'V', (92.1, 58.4), None),
    ('CHG_TS', 'B', (88.15, 56.6), (88.15, 57.35)), ('CHG_TS', 'B', (88.15, 57.35), (91.95, 61.15)),
    ('CHG_REGN', 'F', (100.85, 62.62), (99.65, 62.62)),
]
PLACE = {'R1110': ((96.1, 65.625), 90, 'B'), 'R1102': ((98.45, 66.45), 0, 'B')}
ADD = [
    ('BAT_PROTECTED', 'F', 0.8, [(84.6, 56.3), (84.6, 57.7)]),
    ('BAT_PROTECTED', 'F', 1.2, [(84.6, 57.7), (84.6, 58.3)]),
    ('BAT_PROTECTED', 'F', 1.5, [(84.6, 58.3), (85.75, 59.45), (90.65, 59.45), (91.7, 58.4)]),
    ('BAT_PROTECTED', 'F', 1.6, [(91.7, 58.4), (98.25, 58.4)]),
    ('CHG_TS', 'B', W, [(88.15, 56.6), (88.15, 59.3), (88.4, 59.55), (88.4, 61.0), (88.7, 61.3), (91.9, 61.3)]),
    ('I2C_SDA', 'B', W, [(89.0, 56.9), (89.0, 57.55), (88.8, 57.75)]), ('I2C_SDA', 'V', None, [(88.8, 57.75)]),
    ('I2C_SDA', 'I2', W, [(88.8, 57.75), (87.85, 58.7), (87.85, 67.25)]),
    ('I2C_SCL', 'B', W, [(89.4, 56.9), (89.4, 58.25)]), ('I2C_SCL', 'V', None, [(89.4, 58.25)]),
    ('I2C_SCL', 'I2', W, [(89.4, 58.25), (88.4, 59.25), (88.4, 67.85)]),
    ('CHARGE_CE_N', 'B', W, [(89.8, 56.9), (89.8, 57.3), (90.25, 57.75)]), ('CHARGE_CE_N', 'V', None, [(90.25, 57.75)]),
    ('CHARGE_CE_N', 'I2', W, [(90.25, 57.75), (91.95, 59.45), (91.95, 66.2), (93.05, 67.3), (96.1, 67.3)]),
    ('CHARGE_CE_N', 'V', None, [(96.1, 67.3)]),
    ('CHARGE_CE_N', 'B', W, [(96.1, 67.3), (96.1, 66.45), (97.625, 66.45)]),
    ('GND', 'B', 0.3, [(99.275, 66.45), (100.05, 66.45)]), ('GND', 'V', None, [(100.05, 66.45)]),
]
run('u1100', RIP, ADD, place=PLACE)
