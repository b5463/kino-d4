"""Vias out of and away from SMD pads (KiCad 10 python). ODD JOBS 82; release review M-2 follow-up.

Vias are tented with no pad mask expansion, so a hole inside a pad, or within about 0.1 mm of one,
lets solder wick into it. A sweep of hole-to-pad distances (not just via centres, as
fix_a02_via_in_pad.py did) found:
  CAM1_EN      the via of the J600 front leg overlapped U201 pin 3 by 0.04 mm. In2 lanes CAM1_D2_STRAP
               (x 22.96) and CAM1_D3 (x 24.23) pinned it there; D2 now jogs to x 22.7 for 1.8 mm, the
               via sits at (23.3, 23.65), its hole 0.25 mm clear of the pad, with a back stub to pin 3
               and the front leg on a new 45-degree run.
  C901.2       a GND via sat inside the pad. HAPTIC_EN's back lane moves 0.1 mm east (x 109.5) and
               the via dogbones out east of the pad.
  CHG_PMID     the via at (91.9, 51.65) was 0.05 mm from C1110.1 and 0.11 mm from C1107.1, wedged
               between C1110's GND pad and the In2 CHG_SW1 node. It goes; its twin 1 mm away at
               (91.2, 52.35) still ties C1107 to the back, now by one straight front run.
  CHG_BTST1    the via moves 0.14 mm back along its own diagonal, 0.18 mm clear of C1102.1.
  U701         the via ending the pin 3 GND tie inside the exposed pad duplicated the pad's own five
               thermal vias; the tie now ends on the pad.
  CAM3_5V_ISO  a via in the middle of the back track carried only a dead 0.57 mm In2 stub (left from the
               Kelvin via move). Both go.
The U700 exposed-pad via and the U701/U1201 footprint thermal vias stay (fab note: tent or plug from
the far side). Hole edges 0.075-0.1 mm from same-net pads at R203/R303/R403.2, U300.1, U1300.5 stay.
Phases: rip, add.
"""
from handroute import run

RIP = [
    ('CAM1_EN', 'V', (23.59, 23.6), None), ('CAM1_EN', 'F', (23.59, 23.6), (25.85, 25.86)),
    ('CAM1_EN', 'F', (25.85, 25.86), (25.85, 26.6)), ('CAM1_D2_STRAP', 'I2', (22.96, 18.0), (22.96, 28.2)),
    ('CHG_PMID', 'V', (91.9, 51.65), None), ('CHG_PMID', 'F', (91.2, 52.35), (91.9, 51.65)),
    ('CHG_PMID', 'F', (91.9, 51.65), (92.72, 50.9)),
    ('CHG_BTST1', 'V', (93.05, 54.95), None), ('CHG_BTST1', 'B', (92.7, 54.6), (93.05, 54.95)),
    ('CHG_BTST1', 'F', (93.05, 54.95), (93.53, 54.95)), ('CHG_BTST1', 'F', (93.53, 54.95), (93.75, 54.72)),
    ('GND', 'V', (107.9, 24.97), None),
    ('HAPTIC_EN', 'B', (111.4, 21.25), (109.4, 23.25)), ('HAPTIC_EN', 'B', (109.4, 23.25), (109.4, 26.45)),
    ('HAPTIC_EN', 'V', (109.4, 26.45), None), ('HAPTIC_EN', 'F', (104.4, 26.45), (109.4, 26.45)),
    ('GND', 'V', (108.0, 65.45), None),
    ('CAM3_5V_ISO', 'V', (62.9, 22.85), None), ('CAM3_5V_ISO', 'I2', (62.9, 22.85), (63.13, 22.62)),
    ('CAM3_5V_ISO', 'I2', (63.13, 22.62), (63.13, 22.38)),
]
ADD = [
    ('CAM1_D2_STRAP', 'I2', 0.2, [(22.96, 18.0), (22.96, 22.6), (22.7, 22.86), (22.7, 24.44), (22.96, 24.7), (22.96, 28.2)]),
    ('CAM1_EN', 'V', None, [(23.3, 23.65)]), ('CAM1_EN', 'B', 0.2, [(23.3, 23.65), (24.0, 23.65)]),
    ('CAM1_EN', 'F', 0.2, [(23.3, 23.65), (25.85, 26.2), (25.85, 26.6)]),
    ('CHG_PMID', 'F', 0.8, [(91.2, 52.35), (92.65, 50.9)]),
    ('CHG_BTST1', 'V', None, [(92.95, 54.85)]), ('CHG_BTST1', 'B', 0.2, [(92.7, 54.6), (92.95, 54.85)]),
    ('CHG_BTST1', 'F', 0.25, [(92.95, 54.85), (93.75, 54.85)]),
    ('HAPTIC_EN', 'B', 0.2, [(111.4, 21.25), (109.5, 23.15), (109.5, 26.45)]), ('HAPTIC_EN', 'V', None, [(109.5, 26.45)]),
    ('HAPTIC_EN', 'F', 0.2, [(104.4, 26.45), (109.5, 26.45)]),
    ('GND', 'V', None, [(108.9, 24.975)]), ('GND', 'B', 0.25, [(108.0, 24.975), (108.9, 24.975)]),
]
run('via webs', RIP, ADD)
