"""USB PD input release fixes (KiCad 10 python). Release review C-1 and the TP1001 leftover.

C-1 itself is a value change in circuit.py (D1001 SMF12A -> SMF22A, R1004 1k -> 10k: the board then
survives the STUSB4500 factory NVM, which takes a 20 V contract); sync_a02_values.py writes the new
values to the board. This script removes TP1001: PD_9V_OK_N (U1000 pin 20) is open drain with no
pull-up, so the pad could never show the state; TP1000 (VBUS) and the PD registers over I2C give the
same information. Its 12 mm of copper and two vias go, and U1000 pin 20 is left unconnected.
Phases: rip, place, add.
"""
from handroute import run

RIP = [
    ('PD_9V_OK_N', 'F', (106.2, 52.5), (105.9, 52.8)), ('PD_9V_OK_N', 'F', (105.9, 52.8), (105.9, 53.25)),
    ('PD_9V_OK_N', 'F', (105.9, 53.25), (106.3, 53.65)), ('PD_9V_OK_N', 'F', (106.3, 53.65), (106.79, 53.65)),
    ('PD_9V_OK_N', 'V', (106.2, 52.5), None), ('PD_9V_OK_N', 'V', (102.3, 47.1), None),
    ('PD_9V_OK_N', 'I2', (102.3, 47.1), (102.3, 48.6)), ('PD_9V_OK_N', 'I2', (102.3, 48.6), (106.2, 52.5)),
    ('PD_9V_OK_N', 'B', (99.5, 46.0), (100.6, 47.1)), ('PD_9V_OK_N', 'B', (100.6, 47.1), (102.3, 47.1)),
]
run('usb pd release', RIP, [], pad_nets={('U1000', '20'): ''}, remove=('TP1001',))
