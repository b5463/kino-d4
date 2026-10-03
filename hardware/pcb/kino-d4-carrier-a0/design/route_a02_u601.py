"""U601 (SN74LVC08, back, top edge) re-wired so all of its pins can leave (KiCad 10 python). ODD JOBS 87/88.

Before: MB_3V3 ran under the package along the inside of the right pin column (decoupler C602 at
the top, VCC pin 14 at the bottom), and CAM_GLOBAL_EN tied its four inputs (pins 1, 4, 9, 12) with
a loop round the outside of each column: pins 2-3 and 10-11 were walled in, and CAM1_EN, CAM3_EN,
CAM3_REQ and CAM4_EN had no way out.
Now:
  C602         beside pin 14 on the existing MB_3V3 run south-east of the package (pad 1 on the run);
               the MB_3V3 trunk from the west reaches that run on In2 (via at the old C602 corner,
               along y 2.5, down x 73.51) instead of under the package.
  GLOBAL_EN    one tie under the package from pin 4 to pins 9 and 12 (inner pad ends) and pin 1;
               the feed from J100 comes later (route_a02_*), through the package, not round it.
  CAM3_REQ     pin 10 from its inner end to a via under the package, F west at y 4.6 (between the
               REQ lines above U601 and the CAM3_EN run) to a via at (52.60, 4.60), In2 onto the
               existing CAM3_REQ In2 piece at (47.10, 10.45).
  CAM4_EN      pin 11 east and 45 degrees down to the lane C via at (76.15, 13.45).
  CAM1_EN      pin 3 west, down to a via, F across the CAM3_5V_ISO B run (y 12.55) to the lane C
               via at (62.45, 13.45).
  CAM3_EN      pin 8 east to a via, F west along y 3.4, In2 down x 63.2 to a via above the camera
               lanes, F across them (In2 carries the Kelvin corridor and lanes A-C there), In2 again
               down x 61.6 (the one In2 column left between the SYS_5V riser and camera 3's fan,
               west of camera 3's Kelvin vias), a via in the F corridor between the RX3 and TX3 drops
               and B to R405.1 / U401.3.
Two GND stitching vias in the way are dropped (gnd_stitch.py re-stitches). Phases: rip, place, add.
"""
from handroute import run

W = 0.2
RIP = [
    ('CAM_GLOBAL_EN', 'B', (64.89, 6.5), (68.7, 6.5)), ('CAM_GLOBAL_EN', 'V', (68.7, 6.5), None),
    ('CAM_GLOBAL_EN', 'F', (68.7, 6.5), (71.15, 6.5)), ('CAM_GLOBAL_EN', 'F', (71.15, 6.5), (71.8, 7.15)),
    ('CAM_GLOBAL_EN', 'V', (71.8, 7.15), None), ('CAM_GLOBAL_EN', 'B*', (70.61, 7.15), (71.8, 7.15)),
    ('CAM_GLOBAL_EN', 'B', (71.4, 5.2), (70.61, 5.2)), ('CAM_GLOBAL_EN', 'B', (71.8, 5.6), (71.4, 5.2)),
    ('CAM_GLOBAL_EN', 'B', (71.8, 7.15), (71.8, 5.6)),
    ('CAM_GLOBAL_EN', 'B', (64.89, 6.5), (64.1, 6.5)), ('CAM_GLOBAL_EN', 'B', (64.1, 6.5), (63.7, 6.9)),
    ('CAM_GLOBAL_EN', 'B', (63.7, 6.9), (63.7, 8.05)), ('CAM_GLOBAL_EN', 'B', (63.7, 8.05), (64.1, 8.45)),
    ('CAM_GLOBAL_EN', 'B', (64.1, 8.45), (64.89, 8.45)),
    ('MB_3V3', 'B', (66.97, 2.5), (69.35, 4.88)), ('MB_3V3', 'B', (69.35, 4.88), (69.35, 8.05)),
    ('MB_3V3', 'B', (69.35, 8.05), (69.75, 8.45)), ('MB_3V3', 'B', (69.75, 8.45), (70.61, 8.45)),
    ('GND', 'V', (64.18, 3.84), None), ('GND', 'V', (69.53, 2.5), None),
]
PLACE = {'C602': ((71.65, 10.265), 180, 'B')}
ADD = [
    ('MB_3V3', 'B', 0.3, [(66.97, 2.5), (67.6, 2.5)]), ('MB_3V3', 'V', None, [(67.6, 2.5)]),
    ('MB_3V3', 'I2', 0.3, [(67.6, 2.5), (73.51, 2.5), (73.51, 9.85)]), ('MB_3V3', 'V', None, [(73.51, 9.85)]),
    ('MB_3V3', 'B', 0.3, [(73.51, 9.85), (72.76, 10.6)]),
    ('CAM_GLOBAL_EN', 'B', W, [(64.89, 6.5), (67.25, 6.5)]),
    ('CAM_GLOBAL_EN', 'B', W, [(67.25, 6.5), (67.9, 7.15), (70.61, 7.15)]),
    ('CAM_GLOBAL_EN', 'B', W, [(67.25, 6.5), (68.55, 5.2), (70.61, 5.2)]),
    ('CAM_GLOBAL_EN', 'B', W, [(64.89, 8.45), (66.6, 8.45), (67.9, 7.15)]),
    ('CAM3_REQ', 'B', W, [(70.61, 5.85), (69.0, 5.85)]), ('CAM3_REQ', 'V', None, [(69.0, 5.85)]),
    ('CAM3_REQ', 'F', W, [(69.0, 5.85), (67.75, 4.6), (52.6, 4.6)]), ('CAM3_REQ', 'V', None, [(52.6, 4.6)]),
    ('CAM3_REQ', 'I2', W, [(52.6, 4.6), (52.6, 8.95), (51.1, 10.45), (47.1, 10.45)]),
    ('CAM4_EN', 'B', W, [(70.61, 6.5), (73.0, 6.5), (76.15, 9.65), (76.15, 13.45)]),
    ('CAM1_EN', 'B', W, [(64.89, 7.15), (63.85, 7.15), (62.45, 8.55), (62.45, 9.9)]),
    ('CAM1_EN', 'V', None, [(62.45, 9.9)]), ('CAM1_EN', 'F', W, [(62.45, 9.9), (62.45, 13.45)]),
    ('CAM3_EN', 'B', W, [(70.61, 4.55), (71.6, 4.55), (71.9, 4.25)]), ('CAM3_EN', 'V', None, [(71.9, 4.25)]),
    ('CAM3_EN', 'F', W, [(71.9, 4.25), (71.05, 3.4), (63.2, 3.4)]), ('CAM3_EN', 'V', None, [(63.2, 3.4)]),
    ('CAM3_EN', 'I2', W, [(63.2, 3.4), (63.2, 10.45)]), ('CAM3_EN', 'V', None, [(63.2, 10.45)]),
    ('CAM3_EN', 'F', W, [(63.2, 10.45), (63.2, 14.05)]), ('CAM3_EN', 'V', None, [(63.2, 14.05)]),
    ('CAM3_EN', 'I2', W, [(63.2, 14.05), (61.6, 15.65), (61.6, 20.75), (62.7, 21.85), (63.85, 21.85), (64.6, 22.6)]),
    ('CAM3_EN', 'V', None, [(64.6, 22.6)]),
    ('CAM3_EN', 'B', W, [(64.6, 22.6), (65.08, 22.12), (65.75, 22.12)]),
]
run('u601', RIP, ADD, place=PLACE)
