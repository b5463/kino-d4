"""PD controller U1000 (front) top row: PD_SINK_EN_N to its gate resistor (KiCad 10 python). ODD JOBS 87/88.

PD_SINK_EN_N (pin 16) was capped by PD_VBUS_SENSE running east along the top row from pin 18, with
C1000 above that; its gate resistor R1004 sat 7 mm away boxed in by PD_GATE, USB_VBUS and the
CHG_VBUS back run, with no room for a via beside it.
  R1004          moves straight above pin 16 (1k, PD_SINK_EN_N to PD_GATE): pin 16 runs straight into
                 it. Its PD_GATE pad drops to In2 through a via beside it and joins the existing
                 PD_GATE via above Q1000 (whose back link reaches the FET gate). PD_GATE's F loop round
                 the old place goes.
  PD_VBUS_SENSE  leaves pin 18 north and loops round R1004 onto its old diagonal to R1001.
  C1000          (1u on USB_VBUS) moves onto the USB_VBUS run 6 mm north, pad 1 on the run, pad 2 on
                 the F pour; its old feed and a GND stitching via inside the loop go.
Phases: rip, place, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('USB_VBUS', 'F', (109.7, 50.3), (107.25, 47.85)), ('USB_VBUS', 'F', (107.25, 47.85), (106.15, 47.85)),
    ('PD_VBUS_SENSE', 'F', (107.5, 51.95), (107.5, 52.44)), ('PD_VBUS_SENSE', 'F', (107.9, 51.55), (107.5, 51.95)),
    ('PD_VBUS_SENSE', 'F', (111.38, 51.55), (107.9, 51.55)),
    ('GND', 'V', (108.75, 48.33), None),
    ('PD_GATE', 'F', (105.0, 43.92), (104.05, 44.88)), ('PD_GATE', 'F', (104.05, 44.88), (104.05, 47.3)),
]
PLACE = {'C1000': ((107.6, 43.9), 0, 'F'), 'R1004': ((108.5, 50.2), 270, 'F')}
ADD = [
    ('USB_VBUS', 'F', 0.5, [(106.15, 43.9), (106.65, 43.9)]),
    ('PD_SINK_EN_N', 'F', W, [(108.5, 52.44), (108.5, 51.025)]),
    ('PD_VBUS_SENSE', 'F', W, [(107.5, 52.44), (107.5, 49.0), (107.9, 48.6), (109.6, 48.6), (110.3, 49.3),
                                (110.3, 51.0), (110.85, 51.55), (111.38, 51.55)]),
    ('PD_GATE', 'F', W, [(108.5, 49.375), (109.55, 49.375)]), ('PD_GATE', 'V', None, [(109.55, 49.375)]),
    ('PD_GATE', 'I2', W, [(109.55, 49.375), (107.475, 47.3), (105.25, 47.3)]),
]
run('u1000 top', RIP, ADD, place=PLACE)
