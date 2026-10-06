"""J1300, J102 and J800 in one row along the bottom edge of the back (KiCad 10 python).

The three JST GH sockets (POWER, 3V3 I2C, RTC BACKUP) stood at y 63.0, 62.0 and 64.0. They now share
J1300's row, y 63.0: J102 moves 1.0 mm down and J800 1.0 mm up (J1300 cannot move: R1302 and a SYS_RAW
via sit just above it). J102's mounting tab would then cover its own I2C_SDA run and come 0.12 mm from
the I2C_SCL via, so:
  I2C_SDA  leaves pin 3 north and runs east at y 63.5, between the tab and the pads, then north at x 40.65
           to its via;
  I2C_SCL  via 0.1 mm east (33.3, 62.3), 0.22 mm clear of the tab;
  AUX_3V3  leaves pin 2 south and runs east at y 66.3, below the pads, then north at x 43.0 as before;
  RTC_BACKUP  shorter run from J800 pin 1 to its via.
The 'labels' phase sets the three function labels (POWER, 3V3 I2C, RTC BACKUP) in one row under the
sockets, each centred on its own socket.
Phases: rip, place, add, labels.
"""
import sys
from handroute import run

ROW_Y = 63.0
PLACE = {'J102': ((36.0, ROW_Y), 180, 'B'), 'J800': ((44.5, ROW_Y), 180, 'B')}
RIP = [
    ('AUX_3V3', 'B', (36.62, 63.95), (36.62, 64.85)), ('AUX_3V3', 'B', (36.62, 64.85), (37.03, 65.25)),
    ('AUX_3V3', 'B', (37.03, 65.25), (42.6, 65.25)), ('AUX_3V3', 'B', (42.6, 65.25), (43.0, 64.85)),
    ('AUX_3V3', 'B', (43.0, 64.85), (43.0, 59.85)),
    ('I2C_SCL', 'B', (34.12, 63.22), (33.2, 62.3)), ('I2C_SCL', 'B', (34.12, 63.95), (34.12, 63.22)),
    ('I2C_SCL', 'V', (33.2, 62.3), None), ('I2C_SCL', 'I2', (33.2, 62.3), (36.15, 62.3)),
    ('I2C_SDA', 'B', (35.38, 63.05), (35.78, 62.65)), ('I2C_SDA', 'B', (35.38, 63.95), (35.38, 63.05)),
    ('I2C_SDA', 'B', (35.78, 62.65), (40.25, 62.65)), ('I2C_SDA', 'B', (40.25, 62.65), (40.65, 62.25)),
    ('I2C_SDA', 'B', (40.65, 62.25), (40.65, 59.75)),
    ('RTC_BACKUP', 'B', (45.12, 65.95), (45.12, 59.8)),
]
W = 0.2
ADD = [
    ('AUX_3V3', 'B', W, [(36.625, 64.95), (36.625, 65.9), (37.025, 66.3), (42.6, 66.3), (43.0, 65.9), (43.0, 59.85)]),
    ('I2C_SCL', 'B', W, [(34.125, 64.95), (34.125, 63.125), (33.3, 62.3)]), ('I2C_SCL', 'V', None, [(33.3, 62.3)]),
    ('I2C_SCL', 'I2', W, [(33.3, 62.3), (36.15, 62.3)]),
    ('I2C_SDA', 'B', W, [(35.375, 64.95), (35.375, 63.9), (35.775, 63.5), (40.25, 63.5), (40.65, 63.1), (40.65, 59.75)]),
    ('RTC_BACKUP', 'B', W, [(45.125, 64.95), (45.125, 59.8)]),
]
LABELS = {'POWER': 26.0, '3V3 I2C': 36.0, 'RTC BACKUP': 44.5}     # text centre x; one row below the sockets
LABEL_Y = 67.6

if len(sys.argv) > 1 and sys.argv[1] == 'labels':
    import pcbnew as pcb
    from rework import TARGET
    b = pcb.LoadBoard(str(TARGET))
    texts = {d.GetText(): d for d in b.GetDrawings() if isinstance(d, pcb.PCB_TEXT) and d.GetLayer() == pcb.B_SilkS}
    for t, x in LABELS.items():
        d = texts[t]; d.SetTextAngleDegrees(0); d.SetHorizJustify(pcb.GR_TEXT_H_ALIGN_CENTER); d.SetVertJustify(pcb.GR_TEXT_V_ALIGN_CENTER)
        d.SetPosition(pcb.VECTOR2I(pcb.FromMM(50 + x), pcb.FromMM(50 + LABEL_Y)))
    pcb.SaveBoard(str(TARGET), b)
    print('labels in one row at y', LABEL_Y, flush=True)
    import os; os._exit(0)
run('connector row', RIP, ADD, place=PLACE)
