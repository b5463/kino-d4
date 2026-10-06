"""Charger STAT no longer goes to the expander (KiCad 10 python).

U600 P1.3 (pin 16) read the charger's STAT line; the line had no path out of the bottom of the
camera 1/2 channel bundle to the charger on the far side of the board (circuit.py: firmware reads
the charge state over I2C instead). Its bundle lane, the two vias and the stub from pin 16 go, and
pin 16 becomes no-connect. STAT keeps driving the amber charge LED (D1301) directly.
Phases: rip, place, add.
"""
from handroute import run

RIP = [
    ('CHARGE_STAT_N', 'B', (42.14, 6.88), (39.7, 6.88)), ('CHARGE_STAT_N', 'V', (39.7, 6.88), None),
    ('CHARGE_STAT_N', 'F', (39.7, 6.88), (35.7, 6.88)), ('CHARGE_STAT_N', 'F', (35.7, 6.88), (35.1, 7.48)),
    ('CHARGE_STAT_N', 'F', (35.1, 7.48), (35.1, 15.95)), ('CHARGE_STAT_N', 'V', (35.1, 15.95), None),
    ('CHARGE_STAT_N', 'I2', (35.1, 15.95), (35.1, 40.35)), ('CHARGE_STAT_N', 'V', (35.1, 40.35), None),
]
PAD_NETS = {('U600', '16'): ''}
run('stat', RIP, [], pad_nets=PAD_NETS)
