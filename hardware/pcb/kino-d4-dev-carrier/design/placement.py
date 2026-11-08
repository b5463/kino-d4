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
    # J100 on the top face: the ribbon leaves over the left edge and folds down to JP1 beneath, so only the
    # P4-side plug is in the gap. The fold rotates the far socket about the edge, which swaps the two columns:
    # pin 1 sits at JP1's even-column x (6.0), rows unchanged. Verify pin 1 against the ribbon before ordering.
    'J100': (6.0, 18.0, 0, 'F'),
    'C100': (16.0, 19.5, 90, 'B'),
    'R100': (16.0, 26.0, 90, 'B'),
    'R101': (16.0, 41.5, 90, 'B'),
    'U1001': (16.0, 14.0, 0, 'B'), 'C1003': (13.5, 14.0, 90, 'B'), 'C1004': (18.5, 14.0, 90, 'B'),   # ideal diode to the P4 5 V pins, beside the ribbon header
    'J1000': (109.0, 65.21, 180, 'B'),   # receptacle opens over the bottom edge, as A0.2
    'R1000': (104.0, 57.5, 90, 'B'),
    'R1001': (114.2, 52.5, 90, 'B'),
    'U1000': (114.2, 57.0, 270, 'B'),  # USBLC6 beside the receptacle's CC pads, VBUS pad toward the bridge
    'JP1001': (109.0, 47.0, 0, 'B'),   # USB > rail bridge, above the fuse
    'U1002': (93.0, 55.5, 0, 'B'), 'Q1000': (98.5, 55.5, 0, 'B'), 'C1005': (89.2, 55.5, 90, 'B'),
'C1006': (97.0, 59.3, 0, 'B'), 'C1007': (102.0, 55.5, 90, 'B'),   # anode and cathode capacitors at the FET   # VBUS ideal diode toward J1001, between the CAM4 pads and the LED row
    'D1003': (104.0, 29.0, 90, 'B'),    # rail clamp beside J1001
    'J1001': (109.25, 23.0, 270, 'F'),  # JST XH 6-way to the SW6106 module, in the column right of CAM 4, pins 1..6 down from y 23
    'C1000': (106.5, 56.5, 90, 'B'),
    'C1001': (111.5, 56.5, 90, 'B'),
    'C1002': (109.0, 56.5, 90, 'B'),
    # Status LEDs at the bottom edge, left of the USB-C, so they show through the spacer gap with the carrier on the P4.
    'D1000': (87.0, 67.0, 0, 'B'), 'D1001': (93.0, 67.0, 0, 'B'), 'D1002': (99.0, 67.0, 0, 'B'),
    'R1002': (87.0, 63.5, 0, 'B'), 'R1003': (93.0, 63.5, 0, 'B'), 'R1004': (99.0, 63.5, 0, 'B'),   # each LED's resistor beside it
    'F1000': (109.0, 51.5, 0, 'B'),   # input polyfuse between the USB-C VBUS pads and the 5V_IN caps
    'TP107': (91.5, 60.0, 0, 'B'),    # FAULT_N
    'R102': (12.0, 60.0, 90, 'B'), 'R103': (13.6, 60.0, 90, 'B'),   # Qwiic pull-ups, DNP, above J102
    'FID1': (4.0, 4.0, 0, 'B'), 'FID2': (84.0, 4.0, 0, 'B'), 'FID3': (113.0, 46.0, 0, 'B'),
    'GL1': (25.5, 56.5, 0, 'F'), 'GL2': (81.5, 56.0, 0, 'F'), 'GL3': (113.5, 41.0, 0, 'F'),   # scope grounds, clear of the TP rows
    'J102': (9.0, 65.0, 180, 'B'),     # Qwiic under the ribbon header, cable leaves over the bottom edge
    'J103': (38.0, 57.0, 0, 'F'),     # JST XH 2-way for the shutter lead, pins along +x; one axis with J101
    'J101': (52.0, 57.0, 90, 'F'),
    'TP100': (16.0, 46.0, 0, 'B'), 'TP101': (16.0, 49.0, 0, 'B'), 'TP102': (16.0, 52.0, 0, 'B'),
    'TP103': (16.0, 33.5, 0, 'B'), 'TP104': (16.0, 55.0, 0, 'B'),
    'TP105': (101.0, 60.0, 0, 'B'), 'TP106': (4.0, 58.0, 0, 'B'),
    # Top-face pads: 3V3 5V SYNC EN SHUT GND FLT RAIL, one row under the GPIO map and across to the shutter socket.
    **{f'TP{110 + i}': (x, 62.5, 0, 'F') for i, x in enumerate((3.5, 6.5, 9.5, 12.5, 24.0, 27.0, 30.0, 33.0))},
}

for n, cx in enumerate(CAMERA_X, 1):
    b = 200 + 100 * (n - 1)
    PLACE.update({
        f'J{b}': (cx, CAMERA_Y, 0, 'F'),
        f'JP{b}': (cx + 11.0, 19.5, 0, 'F'),   # in the gap between sockets, clear of the XIAO's USB-C plug (cx +- 6.2)
        f'U{b}': (cx, 27.5, 0, 'B'),
        f'C{b}': (cx - 3.6, 27.5, 90, 'B'),
        f'R{b}': (cx + 3.6, 27.5, 90, 'B'),
        f'U{b + 1}': (cx + 1.2, 32.0, 0, 'B'),   # ideal diode where the SS34 was
        f'C{b + 3}': (cx - 2.2, 32.0, 90, 'B'),
        # One row at 3 mm pitch, all upright: the 22 uF, the 100 nF and the current-measure link.
        f'C{b + 1}': (cx - 2.4, 36.6, 90, 'B'),
        f'C{b + 2}': (cx + 0.6, 36.6, 90, 'B'),
        f'R{b + 6}': (cx + 3.6, 36.6, 90, 'B'),
        f'R{b + 3}': (cx + 4.5, 46.5, 90, 'B'),
        f'R{b + 4}': (cx - 4.5, 46.5, 90, 'B'),
        f'R{b + 5}': (cx, 46.5, 90, 'B'),
        f'TP{b}': (cx - 6.0, 51.0, 0, 'B'),
        f'TP{b + 1}': (cx - 3.0, 51.0, 0, 'B'),
        f'TP{b + 2}': (cx, 51.0, 0, 'B'),
        f'TP{b + 3}': (cx + 3.0, 51.0, 0, 'B'),
        f'TP{b + 4}': (cx + 6.0, 51.0, 0, 'B'),
        f'TP{b + 5}': (cx + 9.0, 51.0, 0, 'B'),
    })
