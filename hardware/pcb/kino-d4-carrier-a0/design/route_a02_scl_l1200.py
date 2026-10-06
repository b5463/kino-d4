"""I2C_SCL out from under the L1200 corner (KiCad 10 python). Release review: switch-node exposure.

The switching inductors sit on the back, so In2 (0.2 mm above B.Cu) is the layer exposed to them; the
front keepouts are shielded by the In1 plane. Under L1200 In2 carries only the boost power feed
(SYS_RAW, SYS_5V), except the I2C_SCL diagonal from the via at (58.75, 52.4), which cut 1.8 mm across
the body's south-west corner. It now runs west below the body first and turns down-left at x 56.6,
passing 0.69 mm from the GND via at (54.17, 49.0), and joins the y 48.3 run at x 52.5.
Phases: rip, add.
"""
from handroute import run

RIP = [('I2C_SCL', 'I2', (58.75, 52.4), (54.65, 48.3)), ('I2C_SCL', 'I2', (54.65, 48.3), (38.0, 48.3))]
ADD = [('I2C_SCL', 'I2', 0.2, [(58.75, 52.4), (56.6, 52.4), (52.5, 48.3), (38.0, 48.3)])]
run('scl l1200', RIP, ADD)
