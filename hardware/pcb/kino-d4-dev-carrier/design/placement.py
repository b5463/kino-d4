"""Dev carrier D1 placement, board mm, origin at the upper-left corner seen from the front.

The coordinate frame is A0.2's (kino-d4-carrier-a0/MECHANICAL.md): origin at the upper-left corner of the
117.01 x 69.41 shell envelope in Guition's structure drawing, seen from the carrier's front, X right, Y down.
The board the bench has is the bare module (spec p.6: 114.40 x 66.80, the SKU without shell), which sits
INSET inside that envelope on every side; the carrier outline runs MARGIN outside the bare module. The insert
holes are A0.2's: 61.9 x 54.8 centres (caliper), H1 at (16.95, 6.0) from the bare module's corner
(PROVISIONAL: the pattern's offset along x is drawing-derived; the slab print checks it).
There is no ribbon: J100 is a 2x13 socket on the back that
mates the P4's JP1 header directly, so the carrier stacks on the P4 at the header's height.
Front: XIAO sockets and the parts a hand reaches (links, shutter, C6 header).
Back (P4 side): J100, every SMD part, test pads. One assembly side.
"""
WIDTH, HEIGHT = 117.01, 69.41   # the frame: the shell envelope of the structure drawing (silk mirrors about its centre)
MODULE = (114.40, 66.80)        # the bare P4 module, spec p.6
INSET = 1.305                   # the module inside the shell envelope, centred: (117.01 - 114.40) / 2 = (69.41 - 66.80) / 2
P4 = (INSET, INSET, INSET + MODULE[0], INSET + MODULE[1])   # the bare module's edges in this frame
MARGIN = 2.0                    # the carrier edge outside the bare module, every side
EDGE = (P4[0] - MARGIN, P4[1] - MARGIN, P4[2] + MARGIN, P4[3] + MARGIN)   # board outline, x1 y1 x2 y2: 118.40 x 70.80 (-0.695..117.705, -0.695..70.105)
CORNER_R = 3.0                  # the outline's corner radius; the inserts sit 7 mm in, well clear of it
# P4 JP1 pin 1 (3V3, the odd column toward the P4's USB ports), in this frame.
# Read off the structure drawing's back view (structure.pdf: the only vendor drawing that shows the
# header and the ports; it draws them to scale, 5.99 px/mm from the 117.01 x 69.41 envelope, but does
# not dimension them; the same scale puts the inserts within 0.1 mm of HOLES). Header body drawn
# 33.3 x 5.2 mm, centre (102.65, 34.705): centred on the board's short axis. J100's pad pattern is
# centred 1.27 right and 15.24 down from pin 1. The plate print on the real P4 confirms the pattern.
# That back view is drawn as seen THROUGH the board, not from behind it: the assembly print, which can
# only mount with the modules outward, had the USB window off the ports, and the flat plate had lined up
# only when set on upside down. So every feature read from the drawing is mirrored about the short-axis
# centre line y = 34.705 (the inserts and the header pattern are symmetric about it; the ports are not).
# The ports below are the mirrored positions. Which end of JP1 holds pin 1 the mirror left open (the
# header pattern cannot tell; the only other candidate was the 180-degree turn, pin 1 at (103.92, 49.945)).
# Settled by meter on 2026-11-20: 3.3 V on this pin, 5 V beside it in the same row. Pin 1 is as filed:
# the column nearer the USB-C ports, the end away from the lone third port.
P4_JP1 = (101.38, 19.465)
# The P4's two vertical USB-C receptacles (openings face the carrier), same drawing, mirrored: 8.9 x 3.2 mm
# openings, long axis along y, 10.94 mm apart. A third 8.3 x 3.3 mm port is drawn at (95.2, 49.4),
# outside the window; nothing plugs through the carrier there. The window lets the USB plugs through.
P4_USB = ((95.14, 26.69), (95.14, 37.63))
USB_WINDOW = (91.6, 20.4, 98.7, 43.9)   # cutout x1 y1 x2 y2: plug overmold 6.5 x 12 each, 0.3 mm a side; 0.6 to CAM 4's pads.
# The 1.33 mm between the window's copper clearance (0.5) and J100's odd-column pads is the socket's left
# escape lane: two 0.25 mm tracks a layer at the 0.15 clearance. At 99.0 it took one, and the UART nets
# from the socket's middle rows did not all route.
HOLES = [(18.255, 7.305), (80.155, 7.305), (18.255, 62.105), (80.155, 62.105)]   # M2, 2.2 mm NPTH; 6.0 from the module's top and bottom edges, 16.95 from its left
FASTENER_KEEP_OUT = 7.0
CAMERA_X = [16.5, 38.5, 60.5, 82.5]   # 22 mm pitch, 9 mm left of A0.2's so CAM 4's right row clears the USB window
CAMERA_Y = 34.705

# ref: (x, y, rotation_deg, side)
PLACE = {
    # J100: the 2x13 socket on the P4 face, pin 1 on the JP1 datum. KiCad's socket footprint puts pin 2 at
    # -2.54 x and the rows at +y; the back-side flip plus the stored 180 (see build.py) leaves pin 2 at +2.54 x
    # and the rows running down, seen from the front: the P4's header as its back shows it. verify.py checks.
    'J100': (P4_JP1[0], P4_JP1[1], 180, 'B'),
    # The P4-side parts sit at the socket, where their nets are, but off the lane between the socket's
    # even row and J1001's pins: that lane is where the socket's middle pins escape, and a column of parts
    # in it left six nets unrouted, and parts in the bands above and below the window (the corridors from
    # the socket to the cameras) left three. The 5 V ideal diode with its two capacitors and the 3V3
    # capacitor in the top strip left of the S/N box, 12 mm from pins 1 to 4; the two pull-downs extend
    # CAM 1's row of signal resistors to the left edge, on nets that run the whole board anyway.
    'C1003': (92.5, 7.5, 90, 'B'), 'U1001': (95.0, 7.5, 0, 'B'), 'C1004': (97.5, 7.5, 90, 'B'),
    'C100': (100.3, 7.5, 90, 'B'),
    'R100': (3.0, 46.5, 90, 'B'),
    'R101': (7.5, 46.5, 90, 'B'),
    'J1000': (109.0, 65.9, 180, 'B'),    # receptacle opens over the bottom edge (EDGE[3] - 4.2), as A0.2
    'R1000': (104.0, 57.5, 90, 'B'),
    'R1001': (114.2, 52.5, 90, 'B'),
    'U1000': (114.2, 57.0, 270, 'B'),  # USBLC6 beside the receptacle's CC pads, VBUS pad toward the bridge
    'JP1001': (109.0, 47.0, 0, 'B'),   # USB > rail bridge, above the fuse
    'U1002': (93.0, 55.5, 0, 'B'), 'Q1000': (98.5, 55.5, 0, 'B'), 'C1005': (89.2, 55.5, 90, 'B'),
'C1006': (97.0, 59.3, 0, 'B'), 'C1007': (102.0, 55.5, 90, 'B'),   # anode and cathode capacitors at the FET   # VBUS ideal diode toward J1001, between the CAM4 pads and the LED row
    # Rail clamp above J1001's pins, under the identity line. Turned 180 with the net swap of 2026-11-19 so the
    # cathode pad sits where the 5V_IN copper already ended: the routed session imports unchanged.
    'D1003': (113.5, 19.0, 180, 'B'),
    'J1001': (110.5, 23.0, 270, 'F'),   # JST XH 6-way to the SW6106 module, right of the J100 socket, pins 1..6 down from y 23
    'C1000': (106.5, 56.5, 90, 'B'),
    'C1001': (111.5, 56.5, 90, 'B'),
    'C1002': (109.0, 56.5, 90, 'B'),
    # Status LEDs at the bottom edge, left of the USB-C, so they show through the spacer gap with the carrier on the P4.
    'D1000': (87.0, 67.7, 0, 'B'), 'D1001': (93.0, 67.7, 0, 'B'), 'D1002': (99.0, 67.7, 0, 'B'),
    'R1002': (87.0, 64.2, 0, 'B'), 'R1003': (93.0, 64.2, 0, 'B'), 'R1004': (99.0, 64.2, 0, 'B'),   # each LED's resistor beside it
    'F1000': (109.0, 51.5, 0, 'B'),   # input polyfuse between the USB-C VBUS pads and the 5V_IN caps
    'TP107': (91.5, 60.0, 0, 'B'),    # FAULT_N
    'R102': (12.0, 60.0, 90, 'B'), 'R103': (13.6, 60.0, 90, 'B'),   # Qwiic pull-ups, DNP, above J102
    'FID1': (4.0, 4.0, 0, 'B'), 'FID2': (73.0, 67.5, 0, 'B'), 'FID3': (116.0, 7.0, 0, 'B'),   # spread over the board, clear of the USB-C corner's copper
    'GL1': (25.5, 56.5, 0, 'F'), 'GL2': (81.5, 56.0, 0, 'F'), 'GL3': (96.5, 62.5, 0, 'F'),   # scope grounds, clear of the TP rows; GL3 between the FAULT and GND pads under the probe column
    'J102': (9.0, 65.7, 180, 'B'),     # Qwiic in the lower-left corner, cable leaves over the bottom edge
    'J103': (38.0, 57.0, 0, 'F'),     # JST XH 2-way for the shutter lead, pins along +x; one axis with J101
    'J101': (52.0, 57.0, 90, 'F'),
    'TP105': (101.0, 60.0, 0, 'B'),
    # Top-face pads. 3V3 and 5V in the top strip beside the socket's pins 1 to 4, where those nets are:
    # with them in the column below, the 1.0 mm P4_5V ran the length of the socket's right escape lane.
    # SYNC EN SHUT GND FLT RAIL as one column under J1001, named to its left; at x 108 the column itself
    # sat in that lane (x 104.8 to 109.5 on the front), at 112 it is clear. (A 0.7 mm move of this column
    # reshuffled the whole route and left three nets unrouted: the router is at its margin here.)
    'TP110': (105.5, 11.5, 0, 'F'), 'TP111': (112.0, 11.5, 0, 'F'),
    **{f'TP{112 + i}': (112.0, 43.0 + 2.54 * i, 0, 'F') for i in range(6)},
}

for n, cx in enumerate(CAMERA_X, 1):
    b = 200 + 100 * (n - 1)
    PLACE.update({
        f'J{b}': (cx, CAMERA_Y, 0, 'F'),
        # One row, each left of its module's USB-C plug (plug cx +- 6.2; header at cx - 11), so the band
        # above the USB window stays open for the J100 signals escaping toward the cameras.
        f'JP{b}': (cx - 11.0, 19.5, 0, 'F'),
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
