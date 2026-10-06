"""U600 pin 21 (GND) to the plane (KiCad 10 python).

The expander's west GND pin sat on a sliver of back pour between the I2C_SCL and COVER_N escapes
with no via. A short back stub runs west to a via between them (clear of FN_N's In2 drop).
Phases: rip, add.
"""
from handroute import run

ADD = [('GND', 'B', 0.25, [(42.14, 3.625), (40.5, 3.625)]), ('GND', 'V', None, [(40.5, 3.625)])]
run('gnd u600', [], ADD)
