"""TCA9517 sides swapped: the local bus on the A side (KiCad 10 python). Release review, logic datasheets.

The TCA9517 B side drives a buffered low of 0.45 / 0.52 / 0.60 V (min / typ / max, TI SCPS242D 7.5; the TCA9517A fitted, SCPS245, is alike).
With the local bus on B, the P4's lows reached the STUSB4500 (VIL 0.35 V), BQ25798 (0.4 V), DRV2605L
(0.5 V) and BQ27441 (0.6 V) above their guaranteed low level. The A side drives a hard low (0.1-0.2 V
at 6 mA), so the local bus moves to SCLA/SDAA (pins 2/3) and the P4 bus to SCLB/SDAB (pins 7/6),
where the P4 (VIL 0.25 x VDD = 0.825 V) reads the buffered low with margin. VCCA and VCCB are both
MB_3V3; EN keeps its pull-up to VCCB.
Copper: the four lines around U100 are redrawn (grid_router.py, then fixed here). The P4 lines reach
pins 6/7 through vias between the pad rows and In2 runs west to J100's lines; the local SDA reaches
pin 3 from its R102 pull-up and joins the east branch through In2 north of the part; the local SCL
comes over on In2 north of C100 and down the inside of the west pad row to pin 2.
Phases: rip, place, add.
"""
from handroute import run

BOX = (13.6, 44.2, 24.6, 50.6)        # unlocked copper of these nets inside it is redrawn
RIP_NETS = [(n, BOX) for n in ('P4_SCL', 'P4_SDA', 'I2C_SCL', 'I2C_SDA')]
RIP = [
    ('I2C_SDA', 'F', (22.4, 47.67), (22.4, 47.0)), ('I2C_SDA', 'F', (22.4, 47.0), (22.85, 46.55)),
    ('I2C_SDA', 'B', (13.23, 49.0), (14.17, 49.95)), ('I2C_SCL', 'B', (24.4, 46.3), (24.8, 46.7)),
    ('P4_SCL', 'F', (8.54, 48.48), (14.27, 48.48)),
]
PAD_NETS = {('U100', '2'): 'I2C_SCL', ('U100', '3'): 'I2C_SDA', ('U100', '6'): 'P4_SDA', ('U100', '7'): 'P4_SCL'}
W = 0.2
ADD = [
    # P4 bus to the B side (pins 6/7): vias between the pad rows, In2 west to J100's lines
    ('P4_SDA', 'B', W, [(21.1125, 47.675), (19.25, 47.675)]), ('P4_SDA', 'V', None, [(19.25, 47.675)]),
    ('P4_SDA', 'I2', W, [(19.25, 47.675), (18.325, 46.75), (15.15, 46.75)]), ('P4_SDA', 'V', None, [(15.15, 46.75)]),
    ('P4_SDA', 'F', W, [(15.15, 46.75), (14.15, 46.75), (13.85, 46.45), (13.85, 45.94)]),
    ('P4_SCL', 'F', W, [(8.54, 48.48), (14.25, 48.48), (14.25, 49.95), (16.3, 49.95)]), ('P4_SCL', 'V', None, [(16.3, 49.95)]),
    ('P4_SCL', 'I2', W, [(16.3, 49.95), (17.925, 48.325), (19.75, 48.325)]), ('P4_SCL', 'V', None, [(19.75, 48.325)]),
    ('P4_SCL', 'B', W, [(19.75, 48.325), (21.1125, 48.325)]),
    # local bus to the A side (pins 2/3): SDA from its R102 pull-up, SCL down the inside of the west pad row
    ('I2C_SDA', 'B', W, [(13.23, 49.0), (13.23, 48.15), (13.705, 47.675), (16.8875, 47.675)]),
    ('I2C_SDA', 'F', W, [(22.9, 46.55), (22.9, 46.05)]), ('I2C_SDA', 'V', None, [(22.9, 46.05)]),
    ('I2C_SDA', 'B', W, [(22.9, 46.05), (19.5, 46.05)]), ('I2C_SDA', 'V', None, [(19.5, 46.05)]),
    ('I2C_SDA', 'I2', W, [(19.5, 46.05), (18.55, 45.1), (14.65, 45.1), (13.3, 46.45), (13.3, 46.75)]), ('I2C_SDA', 'V', None, [(13.3, 46.75)]),
    ('I2C_SDA', 'B', W, [(13.3, 46.75), (13.75, 47.2), (13.75, 47.675)]),
    ('I2C_SCL', 'B', W, [(24.8, 46.7), (24.45, 46.7), (24.45, 45.5)]), ('I2C_SCL', 'V', None, [(24.45, 45.5)]),
    ('I2C_SCL', 'I2', W, [(24.45, 45.5), (23.05, 44.1), (17.85, 44.1), (17.5, 44.45), (17.2, 44.45)]), ('I2C_SCL', 'V', None, [(17.2, 44.45)]),
    ('I2C_SCL', 'B', W, [(17.2, 44.45), (17.2, 45.45), (18.1, 46.35), (18.1, 48.325), (16.8875, 48.325)]),
]
run('u100 swap', RIP, ADD, rip_nets=RIP_NETS, pad_nets=PAD_NETS)
