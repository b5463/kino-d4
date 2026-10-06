"""Copper for the release-review parts placed by add_a02_release_parts.py (KiCad 10 python).

  R105   SYNC pad straight up into the existing SYNC_MASTER via south of TP101; GND pad to a new via.
  R1204  BOOST_ENABLE pad to a via on the In2 enable run (y 61.0); SYS_RAW pad up to C1205's SYS_RAW pad.
  D903   FN_N pad joins the J904 FN_N diagonal at 45 degrees; GND pad to the GND via west of J904.
Phases: rip, add.
"""
from handroute import run

ADD = [
    ('SYNC_MASTER', 'B', 0.2, [(15.0, 54.0), (15.0, 52.75)]),
    ('GND', 'V', None, [(13.35, 53.0)]), ('GND', 'B', 0.25, [(13.35, 54.0), (13.35, 53.0)]),
    ('BOOST_ENABLE', 'V', None, [(63.475, 61.2)]), ('BOOST_ENABLE', 'B', 0.2, [(63.475, 61.2), (63.475, 62.15)]),
    ('SYS_RAW', 'B', 0.25, [(65.125, 62.15), (65.125, 61.25), (65.775, 60.6)]),
    ('FN_N', 'B', 0.2, [(101.57, 8.9), (102.45, 8.02)]),
    ('GND', 'B', 0.25, [(99.47, 8.9), (98.62, 8.05), (98.62, 7.55)]),
]
run('release parts', [], ADD)
