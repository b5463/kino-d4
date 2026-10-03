"""Power-button corner: U1300 (LTC2955, back) escapes, power LED moved, charge LED dropped (KiCad 10 python).

U1300's PB (pin 5) and EN (pin 7, BOOST_ENABLE) had no way out. Both LEDs sat on the front right
over the east pin column, so no via fitted there, and INT's back loop, the timer capacitor and its
In2 detour filled the rest. Three things change:
  charge LED   STAT (U1100 pin 1) has no layout path out of the charger's power copper, so the
               amber LED D1301, its resistor R1304, the STAT pull-up R1109 and TP1100 leave the
               design (circuit.py; firmware reads the charge state over I2C). Their copper and the
               MB_3V3 tail to R1109 go.
  power LED    R1303 and D1300 move onto the end of the MB_3V3 front run below U1300 (R1303 off the
               back), clear of the pin column.
  U1300        C1301 (timer) moves beside pin 3 on the back and its In2 detour goes. INT (pin 8)
               keeps a back loop, now east of two new vias. PB and EN each drop through one and run
               straight down the front between Q1300 and R1301 to the bottom edge. PB goes west on F
               to a via under J1300 pin 1. EN goes east on In2 under the P4_5V_ISO strap to the I2C
               column, and back past it, under TP1202, into Q1202 pin 1 (U1200 is next).
  J102 SCL     its via moves 0.9 mm west, off the two front runs, and its In2 link follows.
Two GND stitching vias in the way go. Phases: rip, place, add.
"""
from handroute import run

W = 0.2
RIP = [
    # charge LED and STAT parts
    ('CHARGE_LED_A', 'F', (34.79, 55.5), (33.95, 56.34)), ('CHARGE_LED_A', 'F', (33.45, 62.3), (32.12, 62.3)),
    ('CHARGE_LED_A', 'F', (34.55, 62.6), (33.75, 62.6)), ('CHARGE_LED_A', 'F', (34.95, 59.45), (34.95, 62.2)),
    ('CHARGE_LED_A', 'F', (34.95, 62.2), (34.55, 62.6)), ('CHARGE_LED_A', 'F', (33.95, 58.45), (34.95, 59.45)),
    ('CHARGE_LED_A', 'F', (32.12, 62.3), (31.17, 63.25)), ('CHARGE_LED_A', 'F', (33.75, 62.6), (33.45, 62.3)),
    ('CHARGE_LED_A', 'F', (33.95, 56.34), (33.95, 58.45)), ('CHARGE_LED_A', 'F', (35.09, 55.2), (34.79, 55.5)),
    ('MB_3V3', 'F', (35.55, 62.85), (35.15, 63.25)), ('MB_3V3', 'F', (35.15, 63.25), (32.83, 63.25)),
    ('MB_3V3', 'B', (101.05, 44.05), (101.05, 46.5)), ('MB_3V3', 'V', (101.05, 46.5), None),
    ('MB_3V3', 'F', (101.05, 46.5), (101.05, 47.38)), ('MB_3V3', 'B', (96.3, 44.05), (101.05, 44.05)),
    # power LED
    ('POWER_LED_A', 'F', (34.79, 56.8), (34.79, 57.5)), ('POWER_LED_A', 'F', (36.15, 55.95), (35.64, 55.95)),
    ('POWER_LED_A', 'F', (35.64, 55.95), (34.79, 56.8)), ('POWER_LED_A', 'V', (36.15, 55.95), None),
    ('POWER_LED_A', 'B', (35.75, 53.0), (36.15, 53.4)), ('POWER_LED_A', 'B', (36.15, 53.4), (36.15, 55.95)),
    ('POWER_LED_A', 'B', (32.83, 53.0), (35.75, 53.0)),
    ('MB_3V3', 'B', (32.65, 52.0), (32.17, 52.0)), ('MB_3V3', 'B', (32.17, 52.0), (31.17, 53.0)),
    ('MB_3V3', 'V', (32.65, 52.0), None), ('MB_3V3', 'F', (32.65, 54.2), (32.65, 52.0)),
    # timer capacitor detour
    ('POWER_TMR', 'V', (30.85, 54.25), None), ('POWER_TMR', 'I2', (31.55, 54.95), (30.85, 54.25)),
    ('POWER_TMR', 'I2', (33.95, 54.95), (31.55, 54.95)), ('POWER_TMR', 'I2', (34.95, 53.95), (33.95, 54.95)),
    ('POWER_TMR', 'V', (34.95, 53.95), None), ('POWER_TMR', 'B', (34.95, 53.95), (35.25, 54.25)),
    ('POWER_TMR', 'B', (35.25, 54.25), (35.25, 55.22)),
    # INT loop, SYS_RAW stub
    ('POWER_INT_N', 'B', (33.14, 56.97), (34.1, 56.97)), ('POWER_INT_N', 'B', (34.1, 56.97), (34.5, 56.58)),
    ('POWER_INT_N', 'B', (34.5, 56.58), (34.5, 55.15)), ('POWER_INT_N', 'B', (34.5, 55.15), (33.3, 53.95)),
    ('SYS_RAW', 'B', (33.9, 55.67), (33.14, 55.67)),
    # J102 SCL via and its In2 link; stitching vias
    ('I2C_SCL', 'B', (34.12, 63.95), (34.12, 62.0)), ('I2C_SCL', 'V', (34.12, 62.0), None),
    ('I2C_SCL', 'I2', (34.12, 62.0), (36.0, 62.0)), ('I2C_SCL', 'I2', (36.0, 62.0), (38.4, 59.6)),
    ('I2C_SCL', 'I2', (38.4, 59.6), (38.4, 57.45)), ('I2C_SCL', 'I2', (35.55, 52.75), (35.55, 62.0)),
    ('GND', 'V', (34.2, 59.6), None), ('GND', 'V', (34.34, 61.2), None),
]
PLACE = {'R1303': ((35.55, 63.675), 270, 'F'), 'D1300': ((35.55, 66.75), 90, 'F'),
         'C1301': ((30.4, 53.15), 180, 'B')}
PAD_NETS = {('U1100', '1'): ''}
REMOVE = ('D1301', 'R1304', 'R1109', 'TP1100')
ADD = [
    ('MB_3V3', 'B', 0.3, [(96.3, 44.05), (100.95, 44.05)]),
    ('MB_3V3', 'F', 0.3, [(32.65, 54.2), (32.65, 53.2)]),
    ('POWER_LED_A', 'F', W, [(35.55, 64.5), (35.55, 65.9625)]),
    ('POWER_TMR', 'B', W, [(30.85, 54.25), (31.175, 53.925), (31.175, 53.15)]),
    ('POWER_INT_N', 'B', W, [(33.14, 56.975), (34.8, 56.975), (35.2, 56.575), (35.2, 54.65), (34.5, 53.95), (33.3, 53.95)]),
    ('POWER_PB_N', 'B', W, [(33.14, 55.025), (34.05, 55.025)]), ('POWER_PB_N', 'V', None, [(34.05, 55.025)]),
    ('POWER_PB_N', 'F', W, [(34.05, 55.025), (34.05, 65.8), (33.35, 66.5), (26.625, 66.5)]),
    ('POWER_PB_N', 'V', None, [(26.625, 66.5)]), ('POWER_PB_N', 'B', W, [(26.625, 66.5), (26.625, 64.95)]),
    ('BOOST_ENABLE', 'B', W, [(33.14, 56.325), (34.6, 56.325)]), ('BOOST_ENABLE', 'V', None, [(34.6, 56.325)]),
    ('BOOST_ENABLE', 'F', W, [(34.6, 56.325), (34.6, 66.6)]), ('BOOST_ENABLE', 'V', None, [(34.6, 66.6)]),
    ('BOOST_ENABLE', 'I2', W, [(34.6, 66.6), (49.0, 66.6)]), ('BOOST_ENABLE', 'V', None, [(49.0, 66.6)]),
    ('BOOST_ENABLE', 'B', W, [(49.0, 66.6), (49.85, 67.45), (55.3, 67.45), (55.55, 67.2), (56.31, 67.2)]),
    ('I2C_SCL', 'B', W, [(34.125, 63.95), (34.125, 63.225), (33.2, 62.3)]), ('I2C_SCL', 'V', None, [(33.2, 62.3)]),
    ('I2C_SCL', 'I2', W, [(33.2, 62.3), (36.15, 62.3), (38.4, 60.05), (38.4, 57.45)]),
    ('I2C_SCL', 'I2', W, [(35.55, 52.75), (35.55, 62.3)]),
]
run('pb corner', RIP, ADD, place=PLACE, pad_nets=PAD_NETS, remove=REMOVE)
