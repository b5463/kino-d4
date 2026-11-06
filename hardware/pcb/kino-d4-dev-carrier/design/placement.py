"""Dev carrier D1 placement, board mm, origin at the upper-left corner seen from the front.

Outline, insert holes, camera centres and J100 are A0.2's (kino-d4-carrier-a0/MECHANICAL.md),
so the dev carrier mounts on the same P4 inserts and takes the same ribbon.
Front: XIAO sockets and the parts a hand reaches (links, shutter, C6 header).
Back (P4 side): J100, every SMD part, test pads. One assembly side.
"""
WIDTH = 117.01
HEIGHT = 69.41
HOLES = [(18.255, 7.305), (80.155, 7.305), (18.255, 62.105), (80.155, 62.105)]   # M2, 2.2 mm NPTH
FASTENER_KEEP_OUT = 7.0
CAMERA_X = [25.505, 47.505, 69.505, 91.505]
CAMERA_Y = 34.705

# ref: (x, y, rotation_deg, side)
PLACE = {
    'J100': (8.54, 18.0, 180, 'B'),
    'C100': (16.0, 19.5, 90, 'B'),
    'R100': (16.0, 26.0, 90, 'B'),
    'R101': (16.0, 41.5, 90, 'B'),
    'JP1000': (16.0, 14.0, 90, 'B'),
    'J1000': (109.0, 65.21, 180, 'B'),   # receptacle opens over the bottom edge, as A0.2
    'R1000': (104.0, 57.5, 90, 'B'),
    'R1001': (114.0, 57.5, 90, 'B'),
    'C1000': (106.5, 56.5, 90, 'B'),
    'C1001': (111.5, 56.5, 90, 'B'),
    'C1002': (109.0, 56.5, 90, 'B'),
    # Status LEDs at the bottom edge, left of the USB-C, so they show through the spacer gap with the carrier on the P4.
    'D1000': (92.0, 67.0, 0, 'B'), 'D1001': (96.0, 67.0, 0, 'B'), 'D1002': (100.0, 67.0, 0, 'B'),
    'R1002': (111.0, 52.0, 0, 'B'), 'R1003': (94.0, 63.5, 0, 'B'), 'R1004': (99.0, 63.5, 0, 'B'),
    'J102': (36.0, 64.6, 180, 'B'),    # cable leaves over the bottom edge
    'SW100': (35.0, 56.0, 0, 'F'),
    'J103': (49.0, 56.0, 90, 'F'),
    'J101': (56.5, 56.0, 90, 'F'),
    'TP100': (16.0, 46.0, 0, 'B'), 'TP101': (16.0, 49.0, 0, 'B'), 'TP102': (16.0, 52.0, 0, 'B'),
    'TP103': (16.0, 33.5, 0, 'B'), 'TP104': (16.0, 55.0, 0, 'B'),
    'TP105': (101.0, 60.0, 0, 'B'), 'TP106': (4.0, 58.0, 0, 'B'),
}

for n, cx in enumerate(CAMERA_X, 1):
    b = 200 + 100 * (n - 1)
    PLACE.update({
        f'J{b}': (cx, CAMERA_Y, 0, 'F'),
        f'JP{b}': (cx + 5.08, 19.5, 270, 'F'),
        f'U{b}': (cx, 27.5, 0, 'B'),
        f'C{b}': (cx - 3.6, 27.5, 90, 'B'),
        f'R{b}': (cx + 3.6, 27.5, 90, 'B'),
        f'D{b}': (cx, 32.2, 0, 'B'),
        f'C{b + 1}': (cx - 3.4, 36.6, 90, 'B'),
        f'C{b + 2}': (cx - 1.2, 36.6, 90, 'B'),
        f'R{b + 3}': (cx + 4.5, 46.5, 90, 'B'),
        f'R{b + 4}': (cx - 4.5, 46.5, 90, 'B'),
        f'R{b + 5}': (cx, 46.5, 90, 'B'),
        f'TP{b}': (cx - 6.0, 51.0, 0, 'B'),
        f'TP{b + 1}': (cx - 3.0, 51.0, 0, 'B'),
        f'TP{b + 2}': (cx, 51.0, 0, 'B'),
        f'TP{b + 3}': (cx + 3.0, 51.0, 0, 'B'),
        f'TP{b + 4}': (cx + 6.0, 51.0, 0, 'B'),
    })
