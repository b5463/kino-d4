"""CAM2 fault line: the CAM2 load switch's FAULT (U301 pin 4, pull-up R304) to the expander U600 pin 9 (KiCad 10 python).

The camera-2 switch sits south of the J301 camera header and the front P4/SYS_5V bands; U600 sits
north of the In2 bands (SYS_5V, shunt outputs, fault and enable lines, I2C_SCL). In2 cannot pass
the header (a data line in every pin gap) or the bands, and the front cannot pass the bands either,
so the line keeps to the back except under U600:
  U600     pin 9 east into a via, In2 west under the expander between its vias, back to the back
           west of it.
  north    the back runs east along y 13.45 between CAM3_REQ and CAM2_EN (between R603's pads),
           down past U700's back between C701's pads, and west along y 19.15 under the header's
           lower row, over R304 and down into the existing pull-up link.
R603's GND pad, cut off from the pour by the new line, gets a back link down to C701's GND pad
and its via.
Clearance mapped from grid_router.py's GR_DEBUG masks. Phases: rip, add.
"""
from handroute import run

W = 0.2
ADD = [
    ('CAM2_FAULT_N', 'B', W, [(47.86, 6.875), (49.26, 6.875)]),
    ('CAM2_FAULT_N', 'V', None, [(49.26, 6.875)]),
    ('CAM2_FAULT_N', 'I2', W, [(49.26, 6.875), (49.86, 7.475), (49.86, 8.05), (49.45, 8.46), (47.25, 8.46), (46.9, 8.81),
                               (45.3, 8.81), (44.95, 8.46), (44.6, 8.46), (44.2, 8.86), (44.2, 10.26)]),
    ('CAM2_FAULT_N', 'V', None, [(44.2, 10.26)]),
    ('CAM2_FAULT_N', 'B', W, [(44.2, 10.26), (44.2, 10.96), (42.85, 12.31), (42.85, 13.05), (43.25, 13.45), (55.6, 13.45),
                              (56.4, 14.25), (56.4, 16.65), (56.75, 17.0), (56.75, 18.6), (56.2, 19.15), (51.3, 19.15),
                              (50.5, 19.95), (50.5, 22.12)]),
    ('GND', 'B', W, [(55.25, 14.325), (55.725, 14.325), (56.025, 14.625), (56.025, 17.6)]),
]
run('cam2 fault', [], ADD)
