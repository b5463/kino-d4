"""P4_RX4 back in its bus slot, the J100 bus taps trimmed, camera 3's 3V3 and FAULT_N re-homed (KiCad 10 python).

route_a02.py lays the P4 UART bus on F at y 24.2 - 1.2 i - 0.6 k (camera i+1, k 0 = RX, 1 = TX);
camera 4's RX lane, y 20.6, between TX4 (20.0) and TX3 (21.2), had been ripped and the later router
passes filled the slot: a CAM1_EN run, a CAM3_3V3 and a CAM3_FAULT_N crossing and the B-to-In2 vias
of POWER_INT_N, CAM2_5V and CAM2_5V_ISO. The F band y 19.05-24.3 (SYS_5V trunk plus bus) can only be
crossed on B or In2, so every crossing now spans it in one piece:
  P4_RX4        F y 20.6 from x 15.5 to the camera 4 drop at x 85.51 (the route_a02.py geometry) and on
                to R502.2. West end: a via clear of the TX3 tap, In2 down west of the RX2 tap, a via
                beside J100 and B between J100 pins 13 and 15 into pin 14.
  POWER_INT_N   one In2 run from the via at (38.90, 18.45) to the via at (37.70, 23.65).
  CAM2_5V_ISO   In2 from the via at (40.95, 18.45) straight on to its In2 run (0.5 mm).
  CAM2_5V       In2 from the via at (54.05, 18.45) to the via at (55.12, 22.85) (0.5 mm).
  CAM3_3V3      as camera 1's: B from J400.12 up beside the socket (x 78.95, across the band), a via,
                F into the header row gap and along it to J401.2.
  CAM3_FAULT_N  from its lane via down the header column gap at x 70.80, along the row gap beside
                CAM3_3V3, out to a via at (76.80, 15.34), B across the band, an F hop over the CAM3_5V
                B run at y 21.6 and B to R404.1. The row gap (0.84 mm between pads) holds both lines
                at 0.15 mm: 0.15 mm to the pads, 0.24 mm between them.
Also: the bus lines ran past their J100 tap points (dead stubs of 1.4 mm on TX3, 7.8 mm on TX1,
10.5 mm and a via on RX2) and the RX2 tap doubled back (a 135-degree turn): each line now ends at its
tap. Removed for re-routing: CAM1_EN's slot run and its B ends (the via at (28.65, 26.20) to J600.8
stays), CAM4_EN's local copper at the camera 4 drop, CAM4_SYNC's B run across the RX4 via.
Phases: rip, add (separate processes).
"""
from handroute import run

RIP = [
    ('CAM1_EN', 'F', (18.2, 20.6), (31.65, 20.6)), ('CAM1_EN', 'V', (18.2, 20.6), None), ('CAM1_EN', 'V', (31.65, 20.6), None),
    ('CAM1_EN', 'B', (18.2, 18.7), (18.2, 20.6)), ('CAM1_EN', 'B', (31.65, 20.6), (31.65, 25.85)),
    ('CAM1_EN', 'B', (31.65, 25.85), (31.3, 26.2)), ('CAM1_EN', 'B', (31.3, 26.2), (28.65, 26.2)),
    ('POWER_INT_N', 'B', (37.7, 23.65), (38.55, 22.8)), ('POWER_INT_N', 'B', (38.55, 22.8), (38.55, 20.6)),
    ('POWER_INT_N', 'V', (38.55, 20.6), None), ('POWER_INT_N', 'I2', (38.55, 20.6), (38.9, 20.25)),
    ('POWER_INT_N', 'I2', (38.9, 20.25), (38.9, 18.45)),
    ('CAM2_5V_ISO', 'B', (40.95, 18.45), (40.95, 20.6)), ('CAM2_5V_ISO', 'V', (40.95, 20.6), None),
    ('CAM2_5V', 'B', (54.05, 18.45), (54.05, 20.3)), ('CAM2_5V', 'B', (54.05, 20.3), (53.75, 20.6)),
    ('CAM2_5V', 'V', (53.75, 20.6), None), ('CAM2_5V', 'I2', (53.75, 20.6), (53.75, 21.47)),
    ('CAM2_5V', 'I2', (53.75, 21.47), (55.12, 22.85)),
    ('CAM3_3V3', 'F', (77.12, 32.17), (71.75, 26.79)), ('CAM3_3V3', 'F', (71.75, 26.79), (71.75, 22.45)),
    ('CAM3_3V3', 'F', (71.75, 22.45), (69.9, 20.6)), ('CAM3_3V3', 'F', (69.9, 20.6), (64.8, 20.6)),
    ('CAM3_3V3', 'V', (64.8, 20.6), None), ('CAM3_3V3', 'B', (64.8, 20.6), (64.8, 18.38)),
    ('CAM3_3V3', 'B', (64.8, 18.38), (64.42, 18.0)),
    ('CAM3_FAULT_N', 'F', (70.8, 13.95), (70.8, 16.35)), ('CAM3_FAULT_N', 'F', (70.8, 16.35), (71.2, 16.75)),
    ('CAM3_FAULT_N', 'F', (71.2, 16.75), (76.8, 16.75)), ('CAM3_FAULT_N', 'V', (76.8, 16.75), None),
    ('CAM3_FAULT_N', 'B', (76.8, 16.75), (76.8, 20.6)), ('CAM3_FAULT_N', 'V', (76.8, 20.6), None),
    ('CAM3_FAULT_N', 'F', (76.8, 20.6), (75.2, 20.6)), ('CAM3_FAULT_N', 'V', (75.2, 20.6), None),
    ('CAM3_FAULT_N', 'B', (73.67, 22.12), (75.2, 20.6)), ('CAM3_FAULT_N', 'B', (73.25, 22.12), (73.67, 22.12)),
    ('CAM3_FAULT_N', 'B', (73.25, 22.12), (73.25, 21.75)),
    ('CAM4_EN', 'V', (85.7, 20.85), None), ('CAM4_EN', 'I2', (85.7, 20.85), (84.0, 19.15)),
    ('CAM4_EN', 'I2', (84.0, 19.15), (84.0, 14.85)), ('CAM4_EN', 'I2', (84.0, 14.85), (85.4, 13.45)),
    ('CAM4_EN', 'B', (85.7, 20.85), (85.7, 21.72)), ('CAM4_EN', 'B', (85.7, 21.72), (86.1, 22.12)),
    ('CAM4_EN', 'B', (86.1, 22.12), (87.75, 22.12)),
    ('P4_TX3', 'F', (13.25, 21.2), (64.61, 21.2)), ('P4_TX1', 'F', (11.5, 23.6), (20.61, 23.6)),
    ('P4_RX2', 'F', (10.7, 23.0), (40.7, 23.0)), ('P4_RX2', 'V', (10.7, 23.0), None),
    ('P4_RX2', 'F', (21.4, 23.0), (21.4, 23.4)), ('P4_RX2', 'F', (21.4, 23.4), (21.1, 23.1)),
]
RIP_NETS = [('CAM4_SYNC', (83.5, 29.0, 97.5, 35.5))]
ADD = [
    ('P4_TX3', 'F', 0.2, [(14.6, 21.2), (64.61, 21.2)]),
    ('P4_TX1', 'F', 0.2, [(19.25, 23.6), (20.61, 23.6)]),
    ('P4_RX2', 'F', 0.2, [(21.2, 23.0), (40.7, 23.0)]), ('P4_RX2', 'F', 0.2, [(21.2, 23.0), (21.1, 23.1)]),
    ('P4_RX4', 'F', 0.2, [(15.5, 20.6), (84.71, 20.6), (85.51, 21.4), (85.51, 33.67), (86.21, 34.37)]),
    ('P4_RX4', 'V', None, [(86.21, 34.37)]), ('P4_RX4', 'B', 0.2, [(86.21, 34.37), (86.21, 35.42)]),
    ('P4_RX4', 'V', None, [(15.5, 20.6)]),
    ('P4_RX4', 'I2', 0.2, [(15.5, 20.6), (15.5, 22.0), (12.6, 24.9), (12.6, 32.41), (10.5, 34.51)]),
    ('P4_RX4', 'V', None, [(10.5, 34.51)]), ('P4_RX4', 'B', 0.2, [(10.5, 34.51), (7.27, 34.51), (6.0, 33.24)]),
    ('POWER_INT_N', 'I2', 0.2, [(38.9, 18.45), (38.9, 22.45), (37.7, 23.65)]),
    ('CAM2_5V_ISO', 'I2', 0.5, [(40.95, 18.45), (40.95, 20.6)]),
    ('CAM2_5V', 'I2', 0.5, [(54.05, 18.45), (54.05, 21.78), (55.12, 22.85)]),
    ('CAM3_3V3', 'B', 0.25, [(77.12, 32.17), (78.95, 30.34), (78.95, 18.55)]), ('CAM3_3V3', 'V', None, [(78.95, 18.55)]),
    ('CAM3_3V3', 'F', 0.25, [(78.95, 18.55), (77.325, 16.925)]),
    ('CAM3_3V3', 'F', 0.15, [(77.325, 16.925), (65.495, 16.925), (64.42, 18.0)]),
    ('CAM3_FAULT_N', 'F', 0.15, [(70.8, 13.95), (70.8, 16.335), (71.0, 16.535), (75.6, 16.535), (76.8, 15.335)]),
    ('CAM3_FAULT_N', 'V', None, [(76.8, 15.335)]), ('CAM3_FAULT_N', 'B', 0.2, [(76.8, 15.335), (76.8, 21.6)]),
    ('CAM3_FAULT_N', 'V', None, [(76.8, 21.6)]), ('CAM3_FAULT_N', 'F', 0.2, [(76.8, 21.6), (75.2, 21.6)]),
    ('CAM3_FAULT_N', 'V', None, [(75.2, 21.6)]),
    ('CAM3_FAULT_N', 'B', 0.2, [(75.2, 21.6), (74.68, 22.12), (73.25, 22.12)]),
]
run('p4 rx4', RIP, ADD, RIP_NETS)
