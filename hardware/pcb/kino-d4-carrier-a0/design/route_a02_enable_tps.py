"""Stubs from the camera enable lines to their new test pads TP600-TP602 (KiCad 10 python).

CAM2_EN and CAM3_EN branch east off their front runs; CAM4_EN reaches its pad from the spare via at
the end of its In2 lane. Placement: add_a02_enable_tps.py. Phases: rip, add.
"""
from handroute import run

W = 0.2
ADD = [
    ('CAM2_EN', 'F', W, [(55.25, 11.8), (56.45, 11.8)]),
    ('CAM3_EN', 'F', W, [(63.2, 12.0), (64.4, 12.0)]),
    ('CAM4_EN', 'F', W, [(87.7, 13.45), (87.75, 13.5), (88.35, 13.5)]),
]
run('enable tps', [], ADD)
