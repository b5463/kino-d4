"""Vias out of SMD pads where there is room (KiCad 10 python). ODD JOBS 82.

  C1300.2  gnd_stitch.py had put the only GND via of this pad's pour fragment inside the pad; the
           stitcher now keeps vias out of pads, so the pad gets a 0.3 mm stub south-east to its own
           via between the SYS_5V via and POWER_KILL_N.
  C1106.1  the CHG_VBUS via that hands the 1.2 mm back run to the In2 sense lane sat in the
           capacitor pad; it moves 0.85 mm north-west, still inside the 1.2 mm run, and the In2
           lane jogs to it.
  TP602.1  the CAM4_EN via at the end of the In2 lane sat inside the probe land; it moves 0.75 mm
           west and a front stub runs into the land.
Left in pads, for the fab note (plugged and capped): the U700 and U701 exposed-pad thermal vias, and
C901.2's GND via, which has no clear site (COVER_RAW on In2 west, HAPTIC_EN on the back east).
Phases: rip, add.
"""
from handroute import run

RIP = [
    ('CHG_VBUS', 'V', (93.7, 53.8), None), ('CHG_VBUS', 'I2', (93.7, 53.8), (93.7, 54.6)),
    ('CAM4_EN', 'V', (87.7, 13.45), None), ('CAM4_EN', 'I2', (76.15, 13.45), (87.7, 13.45)),
    ('CAM4_EN', 'F', (87.7, 13.45), (87.75, 13.5)), ('CAM4_EN', 'F', (87.75, 13.5), (88.35, 13.5)),
]
ADD = [
    ('GND', 'B', 0.3, [(28.75, 56.775), (28.75, 57.25), (29.2, 57.7)]), ('GND', 'V', None, [(29.2, 57.7)]),
    ('CHG_VBUS', 'V', None, [(93.5, 53.0)]), ('CHG_VBUS', 'I2', 0.2, [(93.5, 53.0), (93.7, 53.2), (93.7, 54.6)]),
    ('CAM4_EN', 'I2', 0.2, [(76.15, 13.45), (86.95, 13.45)]), ('CAM4_EN', 'V', None, [(86.95, 13.45)]),
    ('CAM4_EN', 'F', 0.2, [(86.95, 13.45), (88.35, 13.45)]),
]
run('via in pad', RIP, ADD)
