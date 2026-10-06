"""South ends of the camera 1/2 channel bundle (route_a02_u600.py) and the RTC interrupt (KiCad 10 python).

  POWER_INT_N  from its bundle via F down beside J200 to a via, In2 onto its existing In2 run at
               (33.90, 47.55) towards U1300 and R1302.
  I2C_SCL      from its bundle via F down to a via clear of SDA's F turn, B onto the SCL run at
               (37.35, 50.20) to J601 / U100 / J600 / U802.
  RTC_INT_N    R800 (pull-up) and U801 pin 2 were 2 mm apart with an MB_3V3 via between them: the via
               moves 0.65 mm north (its F and B legs follow) and RTC_INT_N joins the two pads with one
               45-degree F leg. The link from the bundle is the router's.
Phases: rip, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('MB_3V3', 'V', (41.35, 56.95), None), ('MB_3V3', 'F', (41.35, 56.12), (41.35, 56.95)),
    ('MB_3V3', 'B', (42.2, 56.1), (41.35, 56.95)),
]
ADD = [
    ('POWER_INT_N', 'F', W, [(34.5, 39.7), (34.5, 45.6)]), ('POWER_INT_N', 'V', None, [(34.5, 45.6)]),
    ('POWER_INT_N', 'I2', W, [(34.5, 45.6), (34.5, 46.95), (33.9, 47.55)]),
    ('I2C_SCL', 'F', W, [(38.0, 40.35), (38.0, 48.3)]), ('I2C_SCL', 'V', None, [(38.0, 48.3)]),
    ('I2C_SCL', 'B', W, [(38.0, 48.3), (37.35, 48.95), (37.35, 50.2)]),
    ('MB_3V3', 'F', 0.3, [(41.35, 56.12), (41.35, 56.3)]), ('MB_3V3', 'V', None, [(41.35, 56.3)]),
    ('MB_3V3', 'B', 0.3, [(41.35, 56.3), (41.55, 56.1), (42.2, 56.1)]),
    ('RTC_INT_N', 'F', W, [(40.35, 57.375), (41.17, 57.375), (41.995, 56.55), (42.35, 56.55)]),
]
run('bundle ends', RIP, ADD)
