# KINO carrier body: a shell around the dev carrier D1 stack

Third body for the D4, and the first one that does not carry the electronics
itself. The dev carrier D1 ([`hardware/pcb/kino-d4-dev-carrier/`](../../pcb/kino-d4-dev-carrier/README.md),
issue #250) stacks on the P4's own inserts through 8 mm spacers, the four XIAOs
stand in sockets on it, and each camera module hangs off its XIAO on a short
soft ribbon. The carrier is the chassis. No screw into any board: the
carrier's edge lands on a ledge in the shell and the rear frame's foam
presses the glass from behind; nothing of the body touches the carrier's
holes or its screw heads. The body's own two joints are screwed: M2 brass
heat-set inserts and M2 screws hold the face (from inside the cavity, no
head on the front) and the rear frame (from the back, six heads where the
brand's concept draws its rear screws).
The shell captures each camera head in a pocket with pinch ribs, so the
picture does not shake on its ribbon. The face shell carries the form.
Issue #252; twenty-fifth cut (2026-11-21): the button proved on the bench
("works perfectly"), the filament pins retired for M2 inserts and screws
(the owner's kit), the walls 6.0 for the inserts, and the cover's detents
PETG spring arms in the cover clicking over fixed teeth, the rims the stops; two materials, black PETG and dark blue PLA, one per
part; the coupons in `coupons/` print before the body. Every
part has an ID (A01 to B02, C01 to C03 for what is not printed, T01 to
T07 for the coupons, P1 and P2 for the plates) in its file name and in the
register below; A01 to A03 and the coupons carry it engraved in a real
font on a face that is up or vertical in print, never the bed.

Not a variant of [`KINO_FIELD_BODY`](../KINO_FIELD_BODY/README.md) (loose XIAOs
on pads, a Dupont loom, a component bay, the P4 on posts behind foam) or of
[`KINO_RESIN_BODY`](../KINO_RESIN_BODY/README.md). Both stay as released. The
measured inputs and the mechanisms (camera capture, cover track, shutter pod)
are the field body's, restated here by hand on the carrier datum.

## The stack, which sets the depth

Z = 0 is the back face of the P4's PCB. The display is at negative Z, the
lenses at positive Z. The chain is re-added by a gate every build.

| Term | mm | Z after | Source |
|---|---:|---:|---|
| rear frame | 2.0 | -7.0 | chosen; 1.2 under the gasket groove; the thumb climbs it to the glass, so its window edge is chamfered |
| glass clearance | 0.4 | -5.0 | chosen; the frame never touches the glass; a foam gasket in the frame's groove takes the stack's tolerance and holds the module |
| P4 module, glass front to PCB back | 4.6 | 0.0 | DERIVED: the bench measured the P4 with its screen, the standoffs and the bare carrier at 17.5 glass front to carrier front (MEASURED, a gate); with the inserts and standoffs below as measured, 4.6 is what is left for the module. The official CAD's 13.8 included something not on the bench; the split is the bench's to confirm |
| P4 inserts | 3.3 | 3.3 | MEASURED |
| M2 spacers | 8.0 | 11.3 | the bench set; the J100 socket floats 0.3 mm off home |
| carrier PCB | 1.6 | 12.9 | |
| XIAO socket insulator | 8.5 | 21.4 | Wurth 61300711821 |
| XIAO male header insulator | 2.5 | 23.9 | **PROVISIONAL**: the headers soldered to the owner's XIAOs; the carrier's assembly print left this out |
| XIAO back face to the lens front | 15.0 | 38.9 | Seeed's assembled Sense stack |
| plate ahead of the lens | 1.0 | 39.9 | chosen; the shell's front; the bore and its 0.4 chamfer; five whole 0.2 layers |
| face | 5.2 | 45.1 | its own 1.0 floor under the track, the lips 3.2 (a 3.0 cover and 0.2 of play), the horizon 1.0; its edge a 1.2 mm 45 degree chamfer; nothing stands proud of it but the cover's 1.5 mm lip |
| **body** | **52.1** | | |

The module's PCB face is the Z datum for the camera, as in the field body: it
lands on the plate's inner face at Z 35.5 (the Sense board's top is at 31.5, so
the 3.5 mm module PCB has 0.4 mm of fold behind it), the head (8.5 mm on
paper; the first pocket coupon was loose, so the gauge T02 decides) sits in a
3.5 mm pocket with 0.3 mm pinch ribs on two walls pushing it onto the other two,
and the lens front is the pocket floor. If the real header insulator is not
2.5 mm, every Z above the socket moves by the difference and the plate must
move with it; `xiaoHeaderInsulator` in `params.mjs` is the one number to change.

Plan: the carrier's 118.40 x 70.80 outline plus 0.5 mm a side of cavity (the
owner's PETG shrinks 0.2 %, measured on T01 and set in the slicer, and a
54 mm wall bows; 0.3 wedged on paper) plus
6.0 mm walls (4.5 until the inserts: an M2 insert hole in a wall end needs
1.0 mm of wall each side, and a boss on the inner face would stand in the
carrier's path from the rear), 131.4 x 83.8 mm, R10 corners (the
carrier's near-square corner sits inside the wall, and R10 leaves 5.05 mm on
the diagonal, gated). The
lens row is 28.45 mm above the carrier's bottom edge (the heads sit 6.95 mm
below the socket centres, toward the pin-7 end), at X 17.2, 39.2, 61.2, 83.2
from the carrier's left edge. The block is 9 mm left of centre; the right side
carries the USB window and the shutter.

What the depth is made of, lens front to glass, and what the body adds:

| | mm |
|---|---:|
| electronics, lens front to glass | 43.5 |
| of which the P4 module | 4.6 |
| of which the P4-to-carrier layer (inserts and spacers; the battery lives in it) | 11.3 |
| of which the XIAO connectors (8.5 socket + 2.5 male header insulator) | 11.0 |
| of which the XIAO, Sense board and camera | 15.0 |
| body in front: plate ahead of the lens 1.0, face 5.2 | 6.2 |
| body behind: the rear frame 2.0 and its 0.4 off the glass | 2.4 |
| **in all** | **52.1** |

The body is 8.6 mm of the 52.1; the face's 5.2 is its own floor under the track, the lips for a 3.0 cover and the groove
and the groove it sits in. The one stack term that is a bench choice
is the XIAO connectors: the eight 1x07 sockets are hand-fit, so 4.3 mm
low-profile strips in place of the 8.5 mm Wurth part, and XIAOs soldered on
bare pins without the 2.5 mm insulator, would take up to 6.7 mm out of the
camera; `socketH` and `xiaoHeaderInsulator` are the two numbers. The J100
socket fixes the 11.3 mm layer.

## Thinner

The body is 7.6 mm of the depth and is at its floor: 2.0 of frame (1.2
under the gasket groove), 0.4 off the glass, 1.0 of plate ahead of the
lens (the bore and its chamfer), 4.2 of face (its own 1.0 track floor, so
the face and the cover are one tested subassembly in one material, 2.4 of
track lips and a 0.8 groove). The other 43.5 mm are the electronics, and three of those terms
are bench choices, each one number in `params.mjs`:

| Lever | Now | Thin | Saves | What it costs |
|---|---:|---:|---:|---|
| `socketH`, the XIAO female headers | 8.5 | 4.3 | 4.2 | low-profile 1x07 sockets on the carrier (hand-fit, so this is a BOM line) |
| `xiaoHeaderInsulator`, the soldered male header | 2.5 | 0.0 | 2.5 | XIAOs soldered with bare pins, or castellated straight to the carrier: no insulator under the board |
| `spacer`, the P4-to-carrier layer | 8.0 | 5.0 | 3.0 | a 3 mm cell in the bay (the bay is `cellT` + 0.5 foam + 10 % swell between the P4's 3.5 mm can and the carrier's 1.5 mm back parts); with no cell in the layer, 3.0 and 5.0 saved |

All three together: 41.4 mm, 9.7 thinner, with the same body files. The
body regenerates from the numbers; nothing else moves.

## The battery

In the layer between the P4 and the carrier, on the P4's own CN4 connector
(owner's placement, 2026-11-20). The P4's IP5306 charges it from the
carrier's USB-C: JP1 5 V sits on the IP5306's node per the vendor schematic,
and the carrier README's bench step 8 is the meter check. No SW6106 module,
no J1001 lead, no lead leaves the shell. The bay is a gated keep-out in the
model (`batteryBay`), carried in the stack dummy as the cell it is gated for:

| | mm |
|---|---:|
| plan, between the four spacers, 1 mm clear of each | 56.4 x 49.4 |
| height, carrier back-face parts (1.5) to the P4 module can (3.5, PROVISIONAL) | 6.3 |
| cell gated for | 5.0 thick plus 0.5 of foam |

A 505573 pouch (55 x 73) does not fit this plan in either orientation; the
cell has to be a 50 x 50 class, 5 to 6 mm thick. On battery the cameras run
only if the rail is tied to the P4's 5 V (U1001 keeps the rail off the P4 by
design): one wire from TP101 to the J1001 RAIL pins, and then the IP5306's
2.1 A boost carries the whole stack. Measure before trusting it.

## The stack, held without a screw

The P4's four inserts carry the carrier's standoffs, and the standoffs
carry the carrier's own four M2 screws; those four are the carrier's and
the body uses them for nothing. The owner's rule, restated after the first
coupons: no screw into a board, and the carrier's heads are no datum. (The
body's own joints, face to shell and frame to shell, are screwed: that is
the next section.) The stack is held three ways, none of them a screw:

- Forward, by the ledge: the cavity is 2.0 mm narrower on every side from
  the carrier's front face to the plate, so the carrier's edge lands on a
  step all round (1.5 mm of bearing with the carrier pushed 0.5 to one
  side). Nothing on the carrier's front face is within 4.3 mm of its edge
  (J1001 is the nearest), the P4 is 2.0 inside the carrier's outline, and
  behind the ledge the cavity is full width down to the glass, so the
  stack still slides in from the rear and stops on the step. No pillar,
  no pocket, nothing within 1 mm of the carrier's screw heads (a gate per
  hole). Turned round in its plane the stack does not go in: the heads
  meet the plate and the carrier's USB-C meets the top wall (a gate).
- Backward, by the rear frame through a gasket. The frame's inner face
  stands 0.4 mm behind the glass front (a gate: a rigid PETG frame never
  touches glass) and carries a 2 mm foam strip, 2 mm wide, in a 0.8 mm
  groove round the window, on the glass's margin: 1.8 mm outside the
  window past its chamfer, 0.5 mm inside the module's edge. The frame
  seats on the wall ends (the drawn V) and squeezes the foam to 1.2 mm
  (40 %; 25 to 55 % over +-0.3 mm of stack tolerance, a gate). The 114 x
  67 module hangs 26 mm past its standoffs in X; the foam carries that
  overhang, so a thumb on the glass loads foam and not the inserts,
  nothing rattles, and the window is sealed against dust. The foam pushes
  the glass, the glass the module, the standoffs the carrier, the carrier
  the ledge: about 16 N at 40 % on 644 mm^2 of PORON, twelve times the
  stack's weight (a gate; the foam's pressure and the stack's mass are
  provisional until both are on the bench).
- The frame itself, by six M2 x 4 screws from the rear into M2 heat-set
  inserts in the walls' rear ends (the joints section below). The frame
  seats hard on the wall ends, so the screws see the foam's 16 N and
  nothing else; six inserts at 50 N of pull-out each (provisional, the
  pull on T04) are eighteen times that (a gate). The bottom pair sits at X
  40 and 100 against the top pair's 30 and 90, so turned round the frame
  misses its inserts by 11.6 mm and goes on one way (a gate).
- In plan, by the carrier's outline in the cavity, 0.5 mm a side; the
  heads in their pockets hold the cameras to the shell whatever the
  carrier does inside that 0.5.

## The joints: inserts and screws

Two joints, twelve M2 brass heat-set inserts (C01: the owner's kit, OD
3.2, the 3 mm length everywhere) and twelve M2 pan-head screws (C03). The
insert hole is 3.0 mm (PROVISIONAL: 0.2 under the OD; the kit's own sheet
wins and T06 and T04 prove it), the insert's length plus 0.4 deep, with
a 0.3 countersink at the mouth so the flash the iron pushes up stays under
the surface and the joint seats flat. No filament pin anywhere: the twelve
pins before this held by friction alone, on paper.

- **The face, from inside.** Six stations in the plate's interior, where
  the plate's inner face is bare: (4, 36), (4, 50), (18, 60), (95, 60),
  (114, 50), (105, 4), inside the ledge (the first sits in the horizon
  band, where the face is 4.2: still 0.8 ahead of the insert, gated),
  clear of the camera module PCBs, the window, the horizon, the grip, the
  detent channels and the signature (gates: a 1.0 mm ring of face round every hole,
  a full ring of plate under every head). The insert sits in the face's
  back, 3.4 deep, 0.8 of face ahead of it (gated; the iron stops when the
  insert is flush). The screw, M2 x 6, comes from the cavity through a 2.4
  hole in the plate, its head in a 4.4 x 1.4 counterbore in the plate's
  inner face, flush under the stack (gated against the dummy): 3.0 of
  plate under the head, then the whole insert, 0.4 short of the hole's
  floor. Nothing shows on the front. The face goes on before the stack and
  comes off after it: the screws are reached through the open rear with
  the stack out.
- **The frame, from the back.** Six stations in the walls' rear ends, the
  axis 3.2 mm from the body's outline: 1.7 of wall outside the hole (1.2
  where the first groove crosses it), 1.3 inside toward the cavity, gated
  as a ring in material. The 4.5 wall left 0.75 a side, and a boss on the
  wall's inner face stood in the carrier's path from the rear (the sweep
  gate caught it), so the walls are 6.0 and the body grew 1.5 a side. The
  screw, M2 x 4, passes a 2.4 hole in the frame, its head in a 4.0 x 0.6
  counterbore in the rear face whose edge lands exactly on the frame's 1.2
  chamfer (gated): 1.4 of frame under the head, 2.6 into the 3 mm insert,
  0.8 short of the floor. Six heads stand 0.7 proud of the back, where the
  concept draws its rear screws. The side stations sit at Y 58, above the
  thumb pad and the symbol.

Setting the inserts: the face and the shell face-up on the bench, a
soldering iron with an M2 insert tip at 200 C for PLA (the face), 230 C
for PETG (the wall ends), the insert pushed in square until flush, the
flash under the countersink. T06 (the face's corner) and T04 (a wall end)
are the two practice pieces and the proof: an insert set in each, a screw
run in and out ten times, and the T04 insert pulled.

Foam: 2 mm thick PORON or silicone foam with adhesive on one side (not PE
or EVA: they take a set in a year and the clamp goes with it), 2 mm wide
(a stock 3M 4000-series tape width, or sheet cut with two blades 2 mm
apart), four strips, two of 101 mm and two of 60 mm, butted at the corners,
adhesive down, pressed flat into the groove before the frame goes on (`previews/KINO_CARRIER_REAR_FRAME_INNER.png`
shows the groove). That the glass's margin is flat to the
module's outline is read from OFFICIAL_CAD and is PROVISIONAL; the gasket's
outer edge stays 0.8 mm inside it.

## The parts, and the brand

ODD JOBS, as the brand's own camera concept draws it (`ODD JOBS/CAMERA 01`,
v18 and v6: a dark body with the layer texture on its walls, a colour
fascia, one button in the accent, quiet lowercase markings, "made for bad
ideas"), in the two production materials. Black PETG is structure and
everything that takes load or wear: the shell, the frame, the cover. Dark
blue PLA is what you look at and the one thing you press: the face and the
button. One material per part, never two: PLA on PETG does not bond (it is
the breakaway pair), so there is no filament change anywhere, and the
colour boundary is always a part boundary. The IDs are engraved in DejaVu Sans
Bold (`text-outline.py` draws the outlines at build time; python with
matplotlib is needed to generate), 5 mm tall on the big hidden faces,
3 mm on the rear and the coupons, 2.2 in the face's edge, 0.4 deep into a
face that is up in print and 0.3 into a vertical wall, never into the bed
(the first layer squashes a bed-face engraving and it cannot be read; the
owner saw it on the first coupons). The three B parts carry no mark: each
is the only part of its shape and colour and has no hidden face that is
not the bed.

| ID, file | What | Material | Print |
|---|---|---|---|
| A01, `print/A01-KINO_CARRIER_SHELL.stl` | front plate with the four pockets (0.5 mm corner reliefs) and 7.5 mm bores, all four walls to the display plane with R10 plan corners, 0.5 mm V-grooves at 2.4 mm pitch round the whole body, the deck included whole (one 1.5 mm smooth ring round the collar); nothing engraved outside; the horizon carried round the left wall only, open at both ends; the 2.0 mm ledge round the cavity at the carrier's front face (no pillar, nothing at the carrier's holes), the shutter pod from X 94 into the right wall at the deck's front (a closed round 14.6 bore through the deck with six 0.2 ribs, the step all round it, a 6.2 chamber open through the plate's corner, a flat floor with two leg channels narrowing into crush ribs for the switch's rear legs; the collar a 0.4 mm shadow line clipped by the front edge), the plain USB-C opening, six countersunk pin holes in the walls' front ends for the face and six plain ones in their rear ends for the frame, four strap tunnels inside the top and bottom walls' ends under 1.2 mm of wall; the bores, the front edge and the rear edge chamfered 0.4; A01 engraved 5 mm in the plate's inner face, up in print | black PETG | front plate on the bed (`previews/A01-KINO_CARRIER_SHELL_PRINT.png`; the ledge and the rear pin holes in `_SHELL_LEDGE.png`), 0.20 mm, no support (gated) |
| A03, `print/A03-KINO_CARRIER_REAR_FRAME.stl` | the 2.0 mm frame around the display, a 0.8 mm gasket groove in its inner face round the window (the P4 is held by 2 mm foam in it), its outer edge chamfered 1.2 toward the rear and 0.4 toward the shell (the joint is a drawn V on the groove rhythm), 95.6 x 58.2 window with a 1.0 mm chamfer toward the rear, a thumb pad with 1.0 x 0.6 grooves over the whole right border (X 109.5 to 121), the ODD JOBS symbol engraved 1 mm deep with a stepped edge on the left, six 1.8 mm pin holes through it countersunk at the inner face (the pins end 0.2 under the rear face: six dots where the brand's concept shows its rear screws), eight 3.0 x 2.8 strap slots, two at each corner; A03 engraved 3 mm in the rear face under the thumb pad | black PETG | rear face UP (`previews/A03-KINO_CARRIER_REAR_FRAME_PRINT.png`; the gasket groove on the bed), 0.10 mm |
| A02, `print/A02-KINO_CARRIER_FACE.stl` | the face: a 5.2 mm plate inset 0.3 mm from the shell's outline (a black reveal line round it), its front edge a 1.2 mm 45 degree chamfer, its back edge chamfered 0.4; the horizon, a 1.0 mm groove edge to edge at the bar's height with its lips chamfered 0.8 above and 0.4 below, its right end ramping at 45 degrees to 2.2 mm deep as the grip; the cover's window, 87 x 36.5 with R3.1 corners, cut down to the face's own 1.0 mm floor, its front edges chamfered 0.8 (bottom rim) and 0.4 (sides), a 1.6 x 1.0 rail down the tray at the middle of the four cells (the cover's guide), dovetail lips 1.0 on its two side walls the window's whole height but for a 14 mm loading gap a side between the stops; in each side wall a detent channel 0.75 deep with two teeth (a 1.0 land, 35 degree ramps); the window's rims are the cover's stops; four 7.5 mm cells through the floor with a 0.8 mm rim; six 3.0 mm insert holes in the back; the signature engraved 0.4 mm inside, mirrored; A02 engraved 2.2 mm in the bottom edge wall, inside the reveal | dark blue PLA | back down (`previews/A02-KINO_CARRIER_FACE_PRINT.png`, the back in `_FACE_BACK.png`, the edge in `_FACE_EDGE.png`), 0.20 mm, no support |
| B01, `print/B01-KINO_CARRIER_LENS_COVER.stl` | the sliding cover, 86.4 x 16.5 x 3 with R3 corners, its back edge chamfered 0.4, its two long edges bevelled 45 degrees 0.9, a 1.8 x 1.2 groove in its back at its centre for the rail, its edges chamfered 0.3 at the bed, a spring arm 1.45 wide at each end cut free by a 1.2 slit 14 up from the bottom edge, one bump 1.0 proud and 1.4 tall on each arm's flank 4.0 up, R0.9 below and R1.5 above, its foot the bed chamfer; "odd jobs" engraved 0.4 in its top; a 20 x 2.5 lip with a 0.8 mm root on its top edge, centred on the bar, 1.5 proud of the face; no mark | black PETG | back down (`previews/B01-KINO_CARRIER_LENS_COVER_PRINT.png`), 0.20 mm layers (every height in it is a whole layer), a 4 mm brim for the arms |
| B02, `print/B02-KINO_CARRIER_SHUTTER_BUTTON.stl` | the plunger: 14 mm cap with a 0.5 mm 45 degree edge and an 11 mm spherical dish 0.4 deep in its top inside a 1.0 flat rim (the finger finds the centre), 2.1 mm proud of the deck at the rim, running on six 0.2 mm ribs in the closed bore; the 17.6 mm flange chamfered at the bed, 0.5 a side in the chamber, 1.5 under the step all round, its front 0.3 short of the face; 6.0 tall; no mark. The shutter's one printed part: it goes in first and hangs in the bore; the switch slides under it into the crush ribs; the face only covers the mouth | dark blue PLA | flange down (`previews/B02-KINO_CARRIER_SHUTTER_BUTTON_PRINT.png`), 0.08 mm layers |
| B03, `print/B03-KINO_CARRIER_CARD_DOOR.stl` | the card door: 23.5 x 10.5 x 2.0, flush in its recess over the P4's microSD slot, the deck's V-grooves across its top; two 1.0 in-plane spring arms with 0.65 bumps that snap into the recess's groove; a nail under its front edge lifts it | black PETG | underside down (`previews/B03-KINO_CARRIER_CARD_DOOR_PRINT.png`), 0.12 mm |
| C01, twelve inserts | M2 brass heat-set inserts, OD 3.2, 3 mm long (the owner's kit). Six in the face's back, six in the walls' rear ends, in 3.0 mm holes 3.4 deep countersunk 0.3 at the mouth, set with an iron until flush | brass | not printed |
| C03, twelve screws | M2 pan head: six M2 x 6 for the face (from inside the cavity, heads flush in the plate's counterbores), six M2 x 4 for the frame (from the back, heads 0.7 proud in 4.0 counterbores) | steel | not printed |
| C02, foam | 2 mm PORON or silicone foam with adhesive, 2 mm wide: two strips of 101 mm and two of 60 mm in A03's groove; the clamp that holds the stack | foam | cut |

Where it comes from, and what each thing is for:

- **The horizon.** One line is cut across the face, edge to edge, at the
  bar's height, its ends open through the pillow round. The bar sits in it;
  the face is built around the line, and the lens row's position (fixed low
  and left by the stack) becomes a position on that line rather than a
  misalignment. The jury's one move.
- **The hand.** The right hand holds the right end (the on-device UI is laid
  out for it: `firmware/UI_DIRECTION.md`). The blue shutter is on the top deck
  at X 104 under the index finger; the grip is the horizon's right end cut
  2.2 mm deep, so the middle finger pulls against its wall; the thumb pad
  stands 1.5 mm off the rear frame's right border with three ridges, and the
  window's edge is chamfered so the thumb slides onto the glass's edge
  targets. The cover is a LEFT-hand action: its lip is at the top of the bar
  and the thumb pushes it down; its lip stands 1.5 mm proud, a sill you can
  see from across the room, as the XA's and the Minox's, and a glove or a
  dry thumb can lift it closed. The grip is 2.2 mm deep, its floor a 45
  degree ramp down from the groove floor over 1.4 mm (a vertical step
  rendered as a chipped notch), a wall for the middle finger (2 mm was a
  fingertip's edge), and the
  layer ribs run unbroken down the right wall under the two fingers that
  hold the camera: the horizon is carried round the left wall only, so the
  line ends where the hand begins. The strap is a cord through two slots in
  the frame's border at each corner into a tunnel inside the wall end: the
  shell's own wall between the slots is the bar it pulls on, so a drop
  loads the shell and not the frame's pins; inside the outline, out
  of the palm. The top pair hangs the camera upright on a neck cord, button
  up; the bottom pair is the wrist loop. A left-handed body is a mirror
  of four numbers, not one: `shutterX`, the grip end, `thumbPadX` and the
  horizon's wall side, plus the firmware's `body.hand`; one `hand` switch
  that drives all four is on the list, not in this cut.
- **The four-mark.** The cover closed is one dark bar in the line, the UI's
  landed bar, and it carries the brand; dropped, it slides down its window
  into the open stow zone and the four bores show in the line, the UI's
  four-mark. The window is open: the face's own blue floor shows through
  it under the bar, and the dropped cover sits in it in plain view.
- **Colour is the architecture.** Black PETG is everything structural and
  everything that wears: the shell, the frame, the cover. Dark blue PLA is
  what you look at and the one thing you press: the face and the button.
  One material per part; the cover is a black bar in a blue field, the
  button a blue dot in a black deck, and every colour boundary is a part
  boundary, so the assembler reads the colour as a bin.
- **One word outside, the rest inside.** The brand on the bar: "odd jobs"
  (traced from the logo by `brand/trace-wordmark.py`, 30 x 6.8 mm, strokes
  1.3) engraved 0.4 in the cover's top, reading as shadow (a raised mark
  in the face's colour would be PLA on PETG, which does not bond). The symbol on the back, engraved 1 mm with a 0.3 mm stepped
  edge so it reads as shadow. Nothing else on the outside: no model name on
  the deck (a 0.6 mm stroke in a vertical wall is one wobbling perimeter,
  and the deck carries the button and nothing else). The signature is
  inside, engraved 0.4 mm in the face's back where only the person who
  opens the camera reads it: the symbol, "odd jobs", and under them
  "kino D4", mirrored so they read right with the face turned over; the
  maker's mark in the joint, as a joiner signs the underside of the board.
  "made for bad ideas." is not on this body: at a size the brand would set
  it, its strokes are under one nozzle line.
- **The empty field is the point.** The face has one line and one bar; the
  rest of it is left alone on purpose (the owner's note, 2026-11-20: a
  Japanese or Chinese sense of work and of less). Every surface that is
  plain is plain because a mark there would be decoration; every mark that
  stays is a tool (the bar is the cover, the line is the grip and the
  cover's lane, the button is the button). The work is in the fits, which
  is where the care goes: the track, the inserts, the pockets, and the print
  plan below.
- **Ribs.** 0.5 mm V-grooves at 2.4 mm pitch round the whole body, the
  deck included whole (in print the deck is a wall like the others), one
  1.5 mm smooth ring round the shutter collar. They are ribs, not the layer
  lines: twelve 0.2 mm layers to a pitch, so every groove slices the same
  and the print's own lines fall inside them. The first groove's waist at
  Z -6.6 lands on a whole layer (the first shell groove, at -4.2, crosses
  the frame's insert holes with 1.2 mm of wall left outside them, a gate),
  and three pitches later the frame joint lands on the rhythm. 49 degree flanks, so
  the face-down print has no overhang.
- **Rounds in plan, chamfers in Z.** Every edge that runs across the
  layers is a 45 degree chamfer, never a round: the face's front edge
  (1.2), the frame's rear edge (1.2), the horizon's two lips (0.8 and
  0.4), the cells' rims (0.8), the cap's edge (0.5), and every bed edge
  (0.4). A chamfer steps one layer each and reads as the grooves do; a
  quarter round at 0.2 mm terraces (R3.5 stepped 1.17, 0.46 and 0.33 mm
  wide along the first edge a hand meets, R1.5 stepped 0.77 and 0.32, an
  R18 dome a 3.4 mm disc and rings under the finger). The rounds are in
  the plan, where the nozzle draws them perfectly: R10 corners, R3 on the
  bar, the 14 mm cap. The body is one thing; the reveal line
  and the smooth cap are gone.
- **Not a box.** R10 plan corners (the carrier's square corner inside the
  wall caps it near R10.6), the face framed by a 0.3 mm black reveal
  line, the cover's corners R3, every tab and ear gone from the outline. The shell's front edge is on the bed, so its
  softness is the face's; the rear frame's chamfer is 1.2, its pin holes
  1.35 mm from the edge.
### What the reviews and the awards taught

Nine review rounds (engineers, customers, design-award jurors, a print
foreman, a first-time builder) and a reading of the design awards' own
criteria shaped cuts four to seventeen. What survived is the body above;
each round, what it found and what was taken or refused is in ECN-0009,
and every cut's renders are on the making-of page (`docs/MAKING_OF.md`).
The rules that came out of it and govern this body: rounds in plan,
chamfers in Z; reduce controls, never grip; the slide must be visible;
nothing glued, nothing that needs a knife; every overhang in a named
place; one material per part; every part keyed and named.

### The face and the cover

The shell's front plate prints on the bed, so it can carry no relief; the
face does. It covers the front to 0.3 mm of the walls' outer edge, 5.2 mm
thick (4.2 until the 3.0 cover) with its front edge a 1.2 mm 45 degree chamfer (the frame's own size) and its back edge
chamfered 0.4 against the elephant foot. Into it, from the front: the
horizon, 1.0 mm deep across the full width (the window's chamfered rims
carry the line on), its upper lip
chamfered 0.8 and its lower 0.4 so the line catches light from every
angle, its right end ramping down at 45 degrees to 2.2 deep as the grip
(3.0 of plate left under it). Through it: the cover's
window, 87 x 36.5 mm with R3.1 corners, from the stow zone's bottom rim to
0.5 above the closed cover's top, cut down to the face's own 1.0 mm
floor, so the tray is a pocket in the face's colour (closed, a black bar
on a blue field, as the brand draws it) and the face with its cover is one
subassembly, slid and tested before it goes near the shell. The window's
two side walls (the short ones, along the travel) carry the dovetail lips,
0.9 wide and 1.1 deep (deeper than wide, so the underside is steeper
than 45 degrees in print; two lines of the nozzle), the window's whole height but for one 14 mm
loading gap a side (Y 14.1 to 28.2, between the stops), with 0.2 of play; 0.3 mm a side, because the walls do not
guide the cover. The guide is a rail:
1.6 wide and 1.0 tall on the tray's floor, the window's full height,
down the middle of the four cells (X 50.2, between cells 2 and 3), running in a
1.8 x 1.2 groove in the cover's back (0.1 a side, 0.2 over it, its two
edges chamfered 0.3 at the bed so an elephant foot cannot close it; the
groove is a channel in the bed face and prints as a bridge). The cover is
guided over its whole 16.5 on smooth vertical faces right under the
thumb, so a push off centre cannot yaw it; a bar 87 wide guided only on
its two 10.5 mm flanks jammed on its walls one time in two whenever the
thumb landed a few millimetres off centre (three prints, 2026-11-22 and
23). The rail is the one visible piece of mechanism on the front, so it
runs down the middle of the cells (it stood 1.5 right of the window's
centre as an orientation key and read as off-centre; the owner,
2026-11-24). The cover has no key: the thumb lip at its top edge and the
wordmark show which way up it goes. The cover is 3.0 thick: 2.0 "feels cheap", and with
its 0.4 back chamfer and a 1.5 right bevel it had a 0.1 mm flank on the
right (the first printed track, 2026-11-22: "goes a bit sideways and no
longer slides"); at 3.0 with 0.9 bevels the flanks are 2.1.

The stops and the detents (twenty-ninth cut, 2026-11-24). The stops are
the window's rims, and the cover reaches them: closed, its top edge lies
on the top rim; stowed, its bottom edge lies on the bottom rim (gates
move it 0.05 past each and find it in the rim). The springs are in the
cover, in PETG: an arm 1.45 wide at each end of the bar, cut free by a 1.2
slit from the bottom edge that ends in an R0.8 keyhole tangent to the
arm (the arm's root, 13.5 up, is a round and not a slit's end: every
click bends it there), flexing in X in the print plane. Each arm carries
one bump, 1.0 past the edge line, 4.0 above the bottom edge, its lower
side an R0.9 round and its upper side an R1.5 round in plan,
on the straight flank, 1.4 tall (seven 0.20 layers) with its top chamfered
45 degrees and its foot only the cover's 0.4 bed chamfer, so on the first
layer the bump is already 0.6 proud and solid with the arm (a 0.95 foot
chamfer that kept it inside the wall above a raised channel floor left a
0.05 sliver there, where P3's arms curled, 2026-11-27). The bump runs in
a channel in the side wall, 1.1 deep past the
wall's face (0.4 clear of the bump's tip), from 0.2 below the tray's floor
(0.8 of the 1.0 floor stays) up to the lip's underside at 2.0, its ceiling
falling 45 degrees into the wall
(no support), from the bottom rim, where grit the bump pushes leaves into
the tray's corner, to 4 mm past the closed bump's reach, a pocket for grit
out of its way. Two teeth per wall interrupt the channel: a 1.0 land at
the wall's own face and a ramp at each end. The bump presses 0.7 over a
land, and at each stop it rests on its tooth's far ramp still pressed, so
the ramp pushes the cover into the rim: closed, above the upper tooth,
pressed 0.25; stowed, below the lower one, pressed 0.35. Those presses
were 0.2 and 0.5 over a land on the fifth T07 (2026-11-27): the click
was right, but the cover held loose, and the owner bent the arms out by
hand to make it latch. A tenth of print error on the bump and a tenth on
the tooth had eaten the 0.2; the rest press is now above the error with
margin, the teeth taller for it, the arms softer so the click stays, and
a gate keeps the pair's press at a stop above 0.3 with 0.1 of error on
each part. The closed stop is the
firmer, because a pocket's lining drags the thumb lip toward open as the
camera comes out: the bump's tight R0.9 side climbs out of the closed
stop and its gentle R1.5 side climbs in. (A steeper ramp alone does not
do it: with one round bump the force's peak just moves to a lower
press.) The forces come from a model of the bump's real outline rolled
past the wall's profile, sliced from the face: each arm pushes its press
times its stiffness, and the cover feels that times the press's local
slope along the travel, with friction 0.3. About 3.8 N/mm at the bump,
1.7 % strain over a crest, about 5.6 N under the thumb to open from
closed, 4.1 N to close, 4.1 N to leave stowed and 5.1 N to stow; 1.6 N
into the top rim and 1.9 N into the bottom rim at rest, about 30 and 36 g
on a 5.4 g cover (gates). (The first version of this cut used full press
times full ramp slope, which never happen together, and said 5.1 N for
arms of 1.4 that the model puts at 3.4.) The click rests on the
stiffness of printed PETG, the number least known, so T08 (1.3 mm arms,
about 4.0 N) and T09 (1.6, about 7.5 N) print beside B01 on P3 and the
one that feels right sets `sliderArmT`. Between the clicks the cover touches nothing: a gate
sweeps it in 0.25 steps and finds a tooth under each bump only in the
first and last 3 mm of the travel, and nothing mid-travel with the cover
0.09 either way on the rail. Wear on a tooth takes press, not position:
the rim still stops the cover.
`previews/A02-KINO_CARRIER_FACE_DETENT.png` is the left wall and the
cover's end in plan, closed and stowed, and in section through the bump.

The thumb lip's top edge is chamfered 0.8 at 45 degrees, so a lining
dragged across the face rides over it instead of hooking it; 0.7 of
square face stays above the face's front for the thumb. Each lip run's
end at the loading gap has a 0.6 lead-in under it, so a cover riding its
0.2 of play slides under the lip and does not catch the end.

Printing with a 0.4 mm nozzle (gated, in lines of 0.45): the thinnest
arm (T08, 1.3) is 2.9 lines, the rail 3.6, a tooth's land 2.2 and a lip 2.0,
the thumb lip 3.8; the slit and the channel are gaps of 2.7 and 2.4
lines; the bump's tight side is an R0.9 round; the wordmark starts 0.8,
nearly two lines, past the firmest cover's slit (it sits 3.6 from the
bar's end and is 29.4 wide for that). The one fit a 0.4 nozzle's accuracy can
close is the rail in its groove, 0.1 a side: if T07 drags, the groove
goes to 1.9.

Real-world cases, each gated (the materials stay as they are: the face
and the button PLA now; later the shell ASA and the blue parts PETG):

- A pocket: the lip rides a lining, and the closed stop takes about 45 %
  more to leave than to enter.
- Print error and the rail's play: 0.1 of each a side moves a stop's
  press 0.2 on one side; the pair keeps at least 0.3 between them, the
  press over a crest stays inside the 1.2 slit at 2.2 % strain, and the
  flank stays 0.1 off the wall.
- Heat on the PLA face, and wear: the teeth carry about 28 MPa of
  standing contact at rest, the only standing load on the face. If a hot
  day or wear takes the rest press and 0.1 off each crest, the cover
  still clicks (about 4.4 N to open, 3.2 to close), the rims still stop
  it and the lips still hold it: it fails to a slightly looser hold, not
  to a cover that falls.
- Grit and lint: 0.4 behind the bump in the channel, the channel open to
  the tray's corner at the bottom and a pocket past the bump at the top;
  the rail's groove open at both ends.
- Fatigue: the arm's root is an R0.8 keyhole, 1.2 % strain a click.
- The face in PETG later: PETG on PETG grips harder (friction about
  0.5); the clicks rise to about 6.9 N to open and 4.4 to close with
  B01's arms and nothing self-locks (the steepest ramp plus friction 67
  degrees). Reprint P3 against the PETG face and choose the arms again.
- Not designed out: a hot car softens PLA as a material; the face may
  warp past 60 C whatever the geometry, and the track with it. The
  manual says not to leave it in the sun until the face is PETG.

What this replaced, and why: the twenty-eighth cut's springs were PLA
leaves in the face's walls whose bumps (R0.6, 0.25 of reach) rubbed the
cover's flanks over 16 of every 19 mm and seated centred in a V-notch.
The owner, after a day with the railed T07: the PLA wears, the slide
gets "looser and looser", rattles, "at the top it never fully closes"
even before the wear, and shaken hard at the bottom "the cover flies
off". Both rims stood 0.5 off the cover, so only the detent placed it,
and a detent centred in a notch has no force at its centre: the cover
hung anywhere in its play, low under gravity, and every 0.1 of wear on
the PLA bumps was 0.1 more of it. Stowed, the lips (broken for the
leaves) held 3.9 of the cover's 10.5 mm flank a side. The rigid posts
before the leaves were what the owner saw on the field body ("bumps are
not a stop"); the corner-arc bumps after them held nothing.

The thumb lip is centred on the bar (it was 11.6 off-axis, and an
off-axis push yaws a bar five times wider than it is tall) and 2.5 thick
on a 0.8 root (1.5 snapped under the shove a stuck cover needed). The window's bottom rim is the
stowed cover's stop and its top rim the closed cover's. Its front edges
are chamfered as the horizon's lips are, 0.8 on the bottom rim and 0.4 on
the sides, so the open stow zone reads as the second line of a cut tray
and the bar sits between two lit edges. The tray's floor is plain plate
in the face's colour. The four cells are 7.5 mm bores through the floor with a 0.8 mm rim,
over the shell's own bores.

The cover drops 19.5 mm to shoot; the travel is derived: the window's
top rim to its bottom rim, less the cover. 16.5 mm tall, it blankets the 7.5 mm cells by 4.5 a side when closed
and its top edge clears the field cone when stowed. Both are gates, as is
the closed cover blanketing every cell (the firmware's cover-closed test
needs all four dark). Closed, its front sits 0.2 below the groove floor. Its
lip, 20 mm wide and 2.5 thick with a 0.8 mm root, centred on the bar (33.4 to 53.4 off
its left end, the wordmark ending 0.4 before it) and 1.5 mm proud of the
face (a thumb needs 16; at 1.0 a glove could not lift it), is what the
thumb pushes down and lifts back. Dropped, the cover sits in the open
stow zone in plain view, the bar's top 0.2 below the face.

Loading: the face's own floor closes the track, so the cover goes in
from the front, at the loading position: its top edge level with the top
of the gap in the lips (its bottom edge at Y 11.4, between the stops),
wordmark up, the groove on the rail. There its rigid top and the stiff
upper part of each arm (above 6.0 from the bottom edge, where a 0.7 fold
would strain PETG past 2.5 %) stand over the gap, and so do its bumps:
press it in, the bevels fold the arms' lower ends 0.7 under the lips
below the gap (1.1 % strain at worst), the bumps drop into the channels
clear of the teeth. Then slide it to either stop. The gap is above the
stowed cover and under the closed cover's lower part, so at both stops
the cover's stiff part is under a lip: pried at its free end it rises at
most 0.47 closed and 0.28 stowed (gates). Out the same way, at the
loading position. (Gated geometry only: try it on T07 first.) To service it: the frame off, the stack out, the
six screws out from inside, face off, cover out. The face is held by six
M2 x 6 screws from inside the cavity into inserts in its back (the joints
section); there is no glue anywhere in the body. T06 (the face's corner
with one station) and T03 (the plate's corner with its counterbore) are
the joint's coupon pair. The horizon channel on the left wall still
exposes 1.5 mm of the face's back edge at its front end and 1.8 of the
frame's inner face at the rear: with the screws out, a nail lifts either
part there. No knife on the blue.

### The shutter

One printed part, the plunger B02, and the 6 x 6 tactile switch on its
two leads. No retainer, no fastener, no glue. The shell holds all of it;
the face is only a cover over the mouth (twenty-ninth cut, 2026-11-24).

How it got here. The first printed pod (2026-11-21) stopped 0.5 above the
switch, its retainer cup held nothing and its teardrops were for the
printer; the pinned floor plate after it could not be assembled; the
first front-entry chamber left 0.2 under its ceiling. Then the guide was
opened to the front and the face became its front wall, 0.4 off the cap.
That put the round 17.6 flange 1.4 into the face's back: with the face
on, the button was clamped (13.9 mm^3 of plunger inside the face from rest
to the bottom of the press; T05 was pressed without a face and no gate set
the two together). It also put the face's top 0.4 in front of the cap,
where a fingertip bottoms. A pocket in the face for the flange fixed the
clamp; the owner asked for the technical answer instead: take the face
out of the mechanism.

Now: a pod under the top wall from X 94 into the right wall (Z 19.3 to
the plate, 6.4 above the carrier, 1.9 clear of CAM 4's XIAO, 10.9 above
J1001), the cap's axis at X 105.5, Z 30.8, set so the flange's front stops
0.3 short of the face's back. From the deck down:

- the bore: closed and round, 14.6 across and 2.3 deep, with six 0.2 x 0.8
  ribs (one each side, two 60 degrees each side of its front and of its
  rear) so the 14 cap runs on six lines 0.1 off each over 1.9 of guide.
  In print (the front plate on the bed) its rear half is the overhang: a
  flat ceiling 0.4 behind it below its last millimetre, round only at the
  deck. 1.8 of deck stands between the bore and the face. A 0.4 collar
  round the cap, clipped by the deck's front edge;
- the step: the deck all round the bore, the 17.6 flange 1.5 under it at
  the sides, the rear and now the front: the plunger cannot leave through
  the deck nor walk toward the face;
- the chamber: 18.6 wide and 6.2 tall, closed at the rear, open at the
  front through the plate's top-right corner (the mouth), which the face's
  back covers and nothing else;
- the floor: flat, the switch sits on it under the cap, with two 2 mm leg
  channels through it from their rear ends out to the front. Over its
  last 0.8 each channel narrows, with a 45 degree lead-in, to the leg's
  thickness less 0.1: the rear legs press into PETG crush ribs and stop
  against the channels' ends with the switch 0.05 off the axis. That is
  the switch's hold fore and aft; the flange 0.3 above it holds it down.

The arithmetic is a gate: the floor + the switch's whole height (4.3, base
to actuator top) + 0.3 of free play = the flange's underside on the step;
the first 0.3 of press is free, the next 0.25 is the click; the press goes
into the floor, nothing is loaded in tension. If the bench's switch is not
4.3 tall, `shutterSwitchBody[2]` is the one number. The chamber's closed
end is an 18.6 mm bridge inside the pod.

The order is forced by the closed bore and proved by sweeps: 1. deck down,
the plunger rides in on the floor through the mouth, its cap 0.2 under the
step, and at the axis lifts into the bore until its flange hangs on the
step; 2. the switch rides in flat on the floor under the hanging flange
(0.3 under it), legs in the channels, until its rear legs are home in the
crush ribs; 3. the face. A switch already seated blocks the plunger's ride
(a gate): plunger first, switch second, face third. The chamber is set by
the switch (flange 1.6 + free 0.3 + switch 4.3 = 6.2), and the whole
plunger must fit in it to ride under the deck: flange + guide + proud +
0.2 = 6.2, so with the 4.3 switch the guide is 2.3 and the cap stands 2.1
proud (the owner kept the switch; a 6 x 6 x 7 one, same footprint, would
leave room for a taller cap and a deeper finger well).

The cap's top is dished: an 11 mm sphere cap 0.4 deep (`shutterCapDish`)
inside a 1.0 flat rim before the chamfer, so the finger finds the centre
without looking (the owner's ask, 2026-11-21). The dish prints as five
0.08 layers, up in print. A gate probes the rim in material and the
dish's centre empty.

The finger. A pad is soft: pressing the cap it wraps round the cap's edge
and can bottom on what is around before the switch clicks. A gate models
the press as a flat round punch (the cap) into an elastic half-space (the
pad, 0.1 MPa): at 2.6 N, the top of the usual tactile switch, the pad
sinks 1.86; it would reach the collar's recess at 2.39, the deck at 3.14
and the face's top, now 9.1 from the axis and 2.1 in front of the cap, at
3.31: 0.53 to spare, the collar the nearest. (With the face 0.4 in front of
the cap and the cap 2.0 proud it was 0.36, at the face.) The face's top in
front of the cap is flat and 0.3 below the deck: a finger sliding forward
meets no edge.

The feel: 0.3 of free travel, then the click within the next 0.25, then
the switch's own stop, pressing into the floor. The dish finds the
centre. `previews/KINO_CARRIER_SHUTTER_SECTION.png` is the section through
the axis: the closed bore, the flange short of the face, the cap at rest
and at the click. T10, the face's top-right corner, held over T05 with the
real switch and B02 in it, is the button as it will be in the body.

### The card door

The photographs live on the P4's own microSD card (the firmware's
`storage.c`, SD slot 0), and until this cut the body had no way to it:
the card came out with the rear frame, the foam and the stack.

Where the slot is. Guition's structure drawing of the board
(`JC4880P443C_I_W_Y`, its vector rear view, drawn as seen through the
board) shows an 11.9 mm slot mouth on the module's top edge. Scaled by
the four inserts' measured 61.9 x 54.8 pitch (the drawing agrees to 0.15 %)
and mirrored as the dev carrier found, it is at body X 64.4 to 76.4, its
mouth 0.9 inside the module's top edge (Y 67.9). The same mapping puts the
three ports within 0.1 of `placement.py` and SW3 15.5 right of the
top-right insert, as ECN-0004's bench note has it; the vendor's photograph
of the board's back shows the silver push-push socket on that edge, with
BOOT and RST further left. That is `OFFICIAL_CAD`, not `MEASURED`. The
drawing does not give the socket's height: the card's plane is taken at
0.4 to 1.4 in front of the P4's back face (a 1.8 socket on the component
side), its seated end 1.0 past the mouth and its spring 3.5
(`tfCardZ`, `tfCardProud`, `tfCardEject`, PROVISIONAL).

The card's seated end is 8.4 below the deck: no finger reaches it through
a card-sized slot. So the top wall over it has a 24 x 11 recess, 2.0 deep,
from Z -3 (2.0 of wall left to the frame's seat) to Z 8, and in its floor
a 21 x 8 opening through to the cavity, a fingertip wide: push the card
home until it clicks, and pinch it out with two nails once it springs up
(or tip it out). The opening is outside the cavity's outline, so the stack
still slides in from the rear; 7.6 clear of the nearest frame screw, 11.6
of the shutter's pod (gates). Its rear edges are 24 and 21 mm bridges in
print.

The door, B03, black PETG: 23.5 x 10.5 x 2.0, flush with the deck, the
deck's V-grooves carried across its top on the body's rhythm. Two in-plane
spring arms, 1.0 wide and 5.6 from their root to the bump, the lens
cover's arms again, end in bumps 0.65 past the door's edge that snap into
a 0.5 groove with 45 degree flanks along the recess's side walls; the
walls' top edges are chamfered so the bumps ride in. The gate measures
the arms' bend on a slice through the bumps, lifting the door in 0.02
steps: at most 0.30 (1.45 % strain), not the 0.40 the bump's reach would
suggest, because the groove's upper flank runs into the wall's top
chamfer and the bump never meets a flat face; about 6.5 N on a nail to
lift it out, at the 0.6 mm pit under its front edge in the nail notch. Closed, its underside is 2.9 over the card
even sprung out. `previews/KINO_CARRIER_CARD_DOOR_SECTION.png` is the
section through the card's path; T11 is the top wall round the door.

### Assembly

0. Before anything goes in: flash the P4 and the four nodes (the P4's USB
   ports are unreachable with the shell on), and fit the four M2 8 mm
   male-female standoffs into the P4's own brass inserts (it ships with
   them; add no heat-set inserts), and screw the carrier to the standoffs
   with its own four M2 x 4 pan heads: the carrier's screws, which the
   body never touches. Stack the P4, the cell on CN4 with its
   lead to J1001 RAIL (the carrier README's bring-up step 7 with an SW6106
   is superseded here), the carrier on the standoffs, the nodes in their
   sockets, outside the body.
1. A01 deck down in the hand, face off. The plunger first: B02 in
   through the mouth in the plate's top-right corner, flange down on the
   floor, cap toward the deck; slide it back until it is under the bore,
   then let it drop into the bore: the cap rises through the deck and the
   flange hangs on the step. Then the switch: in through the same mouth,
   actuator toward the plunger, its four legs in the two channels, its two
   leads trailing through the channels; push it back along the floor
   under the flange until the rear legs press into the crush ribs at the
   channels' ends and stop (a firm push, a felt stop). Turn A01 deck up;
   press the cap: it clicks. In this order only: a switch already in
   blocks the plunger's way to the bore. Plug the lead's JST XH housing
   into J103 on the carrier's front as the stack goes in (step 2): J103 is
   inside the cavity and unreachable once the stack is in. The plunger
   stays in the bore whichever way up the shell is held: the step holds
   it all round and the switch under it holds it up.
2. Slide the stack into the shell from the rear, carrier first, USB-C
   toward the bottom wall, until the carrier's edge meets the ledge all
   round (turned round it stops 3 mm short: the heads are on the plate).
   Nothing screws here: the frame clamps it in step 5.
3. B01 cover into A02's window from the front, stowed: wordmark toward the
   face's front, lip toward the horizon (the top), its groove on the rail.
   The lip at the top and the wordmark reading right show it the right
   way up. Slide it to both detents: that is
   the face subassembly's test, done before it goes near the shell. The
   lips hold it from falling out forward, so with the shell front-up on the
   bench and the face lowered back-down onto it the cover cannot drop.
4. Before the stack (step 2 waits for this): six C01 inserts set in A02's
   back and six in A01's rear wall ends (the joints section). A02 onto the
   shell's front, the shell's plate closing the track and the face's back
   closing the button's slot and mouth; the shell face-down on the bench,
   six M2 x 6 (C03) from inside the cavity through the plate's
   counterbores into the face's inserts, snug, not tight (0.8 of PLA
   ahead of each insert). Then the stack goes in. To service the cover or
   the button: frame off, stack out, the six screws out, face off, cover
   out; deck down, the plunger slides out of the mouth, then the switch
   lifts out of its pocket and follows.
5. Four C02 foam strips into A03's groove (two of 101 mm, two of 60 mm,
   adhesive down, butted at the corners, pressed flat). A03 onto the wall
   ends, thumb pad to the right (turned round its holes miss the inserts
   by 11.6 mm), six M2 x 4 (C03) from the back into the wall ends'
   inserts, run down in two passes until the V joint closes all round, the
   heads 0.7 proud. The seated frame squeezes the foam onto the glass's
   margin and the stack onto the ledge: that is what holds the whole
   stack, and the screws hold the frame. No screw into a board.
6. Power up. The carrier's three status LEDs are not visible with the frame
   on (three slots in the bottom wall did nothing for the body; the screen
   carries status); read them with the frame off. Close the cover: the
   firmware's cover-closed test must see all four cells dark. Drop it: all
   four live. Press the button: it fires.

A battery change is six screws out of the back, the frame off, the stack
out. Brass inserts do not wear with the cycle; a stripped screw is the
spare screw.

The carrier's USB-C comes out through a plain rounded opening in the bottom
wall at the right (the 45 degree gable that dodged the bridge was a house
drawn on the wall; the 13.4 mm bridge is inside the wall). The P4's own USB
ports are reached through the carrier's window only with the shell off.

Previews: `previews/KINO_CARRIER_FRONT.png`, `_OPEN`, `_FLAT`, `_LOW`,
`_REAR`, `_TOP` and `_SIDE` are the colour views from `render-parts.py`
(each part's STL in its material's colour, triangles split to 5 mm so the
painter's order holds); the `<ID>-*_PRINT.png` views are each part in print
orientation from `render-stl.py`, with `A02-KINO_CARRIER_FACE_BACK.png`,
`A02-KINO_CARRIER_FACE_EDGE.png` (the A02 mark in the bottom edge),
`A03-KINO_CARRIER_REAR_FRAME_INNER.png` (the gasket groove and the
countersinks), `A01-KINO_CARRIER_SHELL_LEDGE.png` (the ledge, the rear
pin holes and the open channel), `A01-KINO_CARRIER_SHELL_FRONT_HOLE.png`
(the shell with the face off: the slot and the mouth at the top-right)
and `T05-KINO_COUPON_DECK_INNER.png` (the pod coupon from the cavity side:
the pocket, the channels, the mouth). `KINO_CARRIER_EXPLODED.png` (labelled by ID) and `_EXPLODED_SIDE.png`
pull every part apart along the depth axis: A03, the electronics stack
(green) with its glass, A01 with B02, A02, B01; the inserts, the screws,
the foam strips and the switch are too small to show.
`KINO_CARRIER_CARD_DOOR_SECTION.png` is the section through the card's path, `B03-KINO_CARRIER_CARD_DOOR_PRINT.png` the door and `T11-KINO_COUPON_CARD_DOOR.png` its coupon; `KINO_CARRIER_SHUTTER_SECTION.png` is the section through the shutter's axis; `T10-KINO_COUPON_FACE_SHUTTER.png` and `_BACK.png` the face's shutter corner;
`P3-COUPON_PLATE_B01_T08_T09.png` is the three covers on their bed;
`A02-KINO_CARRIER_FACE_DETENT.png` is the left wall's teeth and channel
with the cover's arm and bump, in plan closed and stowed and in section; `T06-KINO_COUPON_FACE_CORNER.png` and `_BACK.png` are
the face's corner coupon with its insert hole. Every cut's renders are kept under
`docs/assets/making-of/carrier-body/` by `archive-previews.py`, for the
making-of page (`docs/MAKING_OF.md`).

## Gates

`node generate-carrier-body.mjs` writes `.candidate/` and runs 283 gates,
throwing on the first failure (`KINO_SOFT_GATES=1` collects them): the depth
chain re-added over the lens band, the lens front on the pocket floor, the
module PCB with the plate to land on, the battery bay tall enough for the cell
and clear of the spacers and the outline, each part one solid (the pins four,
the button two), the face on the shell and the electronics dummy clear of
every part with only the pinch ribs inside the nominal heads, every pocket
open with its ribs standing, the field cone (bore then cone, two probes) clear
of the shell, the face and the stowed cover at every station, the closed
cover blanketing every cell, the ledge standing round the whole cavity and
bearing on bare carrier edge inside the front-face keep-out, nothing of the
body within 1 mm of any carrier screw head, the stack refused turned round,
every frame insert hole open in the wall end with a 1.0 mm ring of wall
round it, every frame screw hole and counterbore open through the frame,
the counterbores inside the frame's chamfer, the frame's screw reaching
its insert and short of the floor, the walls carrying the holes without a
boss, the frame refused turned round, every face screw hole and
counterbore open through the plate with a full ring of plate under the
head and the head flush and clear of the stack, every face insert hole
open, blind with 0.8 of face ahead and a 1.0 mm ring of face round it,
the face's screw reaching its insert, the stations off the mouth and the
pod, the carrier's sweep
from the rear clear up to the ledge with the pod above it, the USB plug and
the frame window over the whole
active area with 3 mm of border, the cover on the top rim closed and on
the bottom rim stowed, its bumps resting pressed on the teeth's far ramps
at both stops, touching nothing between the clicks (a 0.25 mm sweep) nor
mid-travel with 0.09 of play either way, the bumps under the bevels and
the channels' ceilings, all four teeth standing and the channels open
between them, the arms' stiffness, strain, click and hold, the slits open
and clear of the wordmark, the lips along the cover at both stops and the
lips holding the cover at both stops, the cover pressing in at the loading position, T08 and T09 running as B01, the rail standing the window's full height, the groove open end to end, the rail in the groove at both stops and between, the rail down the middle of the four cells, the thumb lip on the cover's axis, the cover refused turned round, stowed on the window's rim, the
wordmark inside the cover's band, the shutter's closed bore open from the step up and closed toward the face by 1.8 of deck, the step holding the flange all round, the chamber open from its closed rear end out through the plate, the mouth covered by the face, the floor solid under the switch, the leg channels open to the front and their crush ribs gripping the rear legs with the switch stopped under the cap, six ribs in the bore, the order of operations swept (the plunger riding in under the deck and lifting into the bore, at rest 2.1 proud and dished, the switch riding in flat under the hanging flange, a seated switch blocking the plunger's ride), the actuator under the flange at rest by arithmetic, the plunger clear of the face through its whole press, a fingertip clicking before it bottoms round the cap, the pod joined to the wall and clear of CAM 4, the carrier's connectors, CAM 4's pocket and the face's stations, the stem positive
passing its bore, the strap tunnels open under their skin, the signature
inside the plate clear of the track and the stations, the deck bare, every
print's overhang inside its named bridges, holes and pockets (each print
lists the places a face may point down past 45 degrees, a bridge, a hole
or a pocket where a support could not stand or its scar would never show;
anything down-facing outside them fails, with its position; a chamfer
counts only past 45 degrees, so every chamfer here is exactly 45) and on a
250 x 210 bed, the horizon above the track's lips with plate under the
grip, the battery bay with 10 % of swell, the foam's clamp on the stack and
six inserts' hold against it, the horizon channel as both pry points and open
to the joint, the first groove leaving wall outside the insert holes, the corner coupon
carrying a face screw station and the ledge, the strap coupon a frame insert station, the face coupon its station and the left wall's lower tooth, the track coupon all four teeth, both rims and the cover's whole run,
every coupon labelled with its ID in material, the frame off the glass, the gasket
groove on the glass's margin, open, and its squeeze over the stack's
tolerance, and every coupon one piece on the bed.

`node promote.mjs` validates the candidates, copies the five parts into
`print/`, the five coupons into `coupons/` and the report into `reports/`,
sweeps stale files and validates again. There is no independent scan yet; promote says so every run.

## Print plan

The print technician's settings for the owner's PETG, written down so the
first print is not a guess. 0.4 mm nozzle; 0.20 mm layers on the shell, the face and the cover (the
cover's heights are whole 0.20 layers since the thirty-first cut: the bump
1.4, its chamfers 0.4 and 0.5 on the way in), 0.10 on the frame
(every one of its heights is then a whole layer), 0.08 on the
button. Orientations are in the parts table, each with its preview, and in
`release-set.mjs`; they agree.

| | |
|---|---|
| supports | off, on every part. No part needs any: every down-facing surface is a bridge of 4.5 mm or less, a blind hole or a groove at the bed (the gate lists them per print, and anything else fails with its position). Supports here do damage: trees in the pin holes and the strap tunnels block them, trees in the gasket groove and the collar's recess fill a 0.9 and a 0.4 mm fit. If the slicer insists, set its overhang threshold so the 45 degree chamfers, the 49 degree groove flanks and the track lips' 48 degree undersides never trigger (faces steeper than 40 degrees from the bed unsupported) and keep bridge detection on |
| elephant foot compensation | 0.2 mm (the chamfers are a second defence, not the first; it takes the detent bumps' first layer, which is why they are 1.0 tall) |
| seam | scarf, painted onto the bottom wall; the grooves hide a seam only where it is straight |
| bridges | fan 100 %, bridge speed 20 mm/s, thick bridges off: the strap tunnels, the USB opening's 13.4 mm top, the pod's flat bore ceilings, the frame's gasket groove |
| face | 40 % gyroid with six top layers (1.2 mm) and two 100 % modifier boxes, 128 x 24 x 3.2 over the horizon band (Y 18 to 42) and 100 x 42 x 3.2 round the window (X 0 to 100, Y 0 to 42) (100 % over 128 mm bowed at the corners and kept moving for weeks); top solid lines monotonic along X on the face, the horizon's floor and the cover's front, line width 0.42, flow +2 %; no ironing (it gums at the nozzle and the gloss goes uneven); no modelled texture on the front (nothing under one layer exists, and a 0.2 relief reads as a sticker) |
| frame | 0.10 mm layers throughout (20 layers: the groove 0.8, the chamfers 1.2, 1.0 and 0.4, the pad 1.5 and the 2.0 plate are all whole layers; at 0.12 none was); bed 75 C, a 2 mm ring lifts at the corners at 65 |
| cover | black PETG at 0.20 (the owner's choice, 2026-11-27; the cover's heights are whole layers at it), a 4 mm outer brim (the arms are 1.45 mm strips on the first layer and curled without one); minimum layer time 10 s with the fan at 100 % (after Z 2.8 only the 20 x 1.5 lip is printing and PETG slumps), or print the spare cover on the same plate; three perimeters make the 1.5 lip; the wordmark is a 0.4 engraving in the top, two layers, that needs nothing |
| the PLA parts | A02 and B02 in dark blue PLA: 0.20 and 0.08, bed 60 C, fan 100 % from layer 3, no enclosure heat. PLA softens from about 55 C, so the camera does not live in a parked car; the PETG parts take 75. The cover (PETG) slides on the face (PLA): a dissimilar pair, which slides better than like on like |
| seams | scarf, painted: the face's into the window's lower-left corner and into the horizon's left wall corner above it; the shell's into the left wall's horizon channel corner (vertical in print), not the bottom wall (the grooves hide a seam only on straight runs and it jumps at the USB and LED openings); the cover's into the edge-relief notch; the button's toward the rear |
| bed | 80 C under the PETG shell, 70 under the PETG frame and cover, 60 under the PLA; no brim (the chamfered bed edges are the brim's job) |
| shrink compensation | 0.2 % in the slicer, every PETG part (T01, 2026-11-21: the 100.0 bar printed 99.8 uncompensated and 99.9 on the second plate, inside a calliper's 0.1). The model is never scaled |
| cavity | 0.5 mm a side as modelled; do not scale the shell to fit, measure the coupon |
| the track lips | slow the overhang perimeters on layers 7 to 16 of the face (the lips' 47 degree undersides); their roughness comes out of the 0.2 of play |
| regenerating | after a number changes in `params.mjs`: `npm i manifold-3d` once in the repository root, then `node generate-carrier-body.mjs` and `node promote.mjs` in this folder; a failed gate names what moved |

Coupons before the full print, in `coupons/`, each cut from the real part
with a box so a fit proved on the coupon is the fit in the part; same print
orientation as the parent; each with its ID engraved in the face that is
up in print. The two
pairs that print together ship as bed plates, `P1-COUPON_PLATE_T01_T02.stl`
and `P2-COUPON_PLATE_T03_T04.stl`, 10 mm apart, so a print job is one
file; `P3-COUPON_PLATE_B01_T08_T09.stl` is the three covers, B01 (no mark)
between T08 (softer arms) and T09 (stiffer), 6 mm apart, for the fifth T07. The first round (2026-11-21) set the shrink at 0.2 %, found the
8.7 pocket loose and refused the head-pocket feet and the frame pilots;
the second round (the same day) found the 8.1 pocket (`camBody` 7.9 +
0.2), the bar at 99.9, the carrier's corner flat on T03's ledge, and a
pod that would not take the plunger (0.2 of headroom) or the switch, so
T05 is a new piece again; the pins' hold on T03 and T04 is still to be
reported. Pass criteria, in numbers:

| Coupon | What it proves | You need | Pass | If not, the number |
|---|---|---|---|---|
| T01 + T02 on one plate (done) | the printer's shrink (0.2 %); which pocket width holds the head (8.1) | callipers; one camera module seated on its XIAO | the bar measures 99.8 to 100.0 with the compensation on (99.9); on the gauge, the head pushes into one of the 7.8, 8.1 and 8.4 pockets with a thumb and does not fall out inverted, the lens centred in the bore by eye (8.1, "fits perfectly") | `camBody` + `camBodySlack` = the pocket that held (7.9 + 0.2); `lensBoreD` (bore) |
| T03 + T04, reprinted with the 6.0 walls (T03 now 26 x 47, up past the station at (4, 36)) | the ledge under the carrier's corner (done on the first piece: flat), the face's screw station in the plate, the strap tunnel and slots, the frame's insert station in a wall end | the carrier, two M2 inserts, an M2 x 6 and an M2 x 4, the iron, 0.3 m of 2.5 mm cord, 10 kg, 5 kg | the carrier's corner drops into T03 and sits flat on the ledge with no rock (done); an insert set in T04's wall end sits flush with no bulge on the outer wall or in the cavity, takes the M2 x 4 ten times, and holds 50 N pulled on the screw; 100 N on T04's cord, no tear at the 1.2 mm skin; T06 screwed onto T03 through the counterbore with the M2 x 6 seats flat and the head sits flush in the counterbore | `insertHoleD`, `insertPullN`, `strapSlot`, `strapTunnelSkin` (`ledgeW`, `carrierClear` confirmed) |
| T06 (blue PLA), with T03 | the insert in the face's back under the horizon (4.2 there), the window's left wall with its channel and lower tooth | one M2 insert, the iron at 200 C, the M2 x 6 | the insert set flush with no mark on the front and no bulge at the window's wall; the channel prints clean under its 45 degree ceiling, the tooth's land is flush with the wall and its ramps are crisp | `insertHoleD`, `sliderChannelD` |
| T07 (blue PLA) with B01, T08 and T09 (black PETG, 0.20, on P3, with a 4 mm outer brim), sixth piece | the slide: the whole window band with the rail down it, both walls with their channels and taller teeth, the lips with their loading gaps, the two rims, the cells; the 3.0 cover with its groove, its two spring arms and taller bumps, and the 2.5 lip | the printed cover; any flat plate held behind the coupon for the shell's plate | at the loading position (its top edge level with the top of the lip gap) the cover presses in from the front, groove on the rail, without force and without a crack; then each of B01, T08 and T09 in turn: it clicks closed and clicks open under a thumb, about 5 N, and runs free and straight between the clicks; closed, the top edge is hard on the top rim with no light between and no rattle when shaken, WITHOUT bending the arms; stowed, the bottom edge is hard on the bottom rim, and shaken hard it stays in; 200 cycles and both stops still have no play, no PLA dust on the bumps; in a jeans pocket, in and out ten times, the closed cover does not open. The fourth piece (the rail, PLA leaves in the face, 2026-11-23 and 24): ran straight, but the PLA wore, it got "looser and looser", rattled, never fully closed even new, and shaken hard stowed the cover flew off. The fifth (2026-11-27, the arms and teeth): "a good route", the click right, but loose at the stops until the arms were bent out by hand; T08 and T09 curled off the bed (their arm islands, hence the brim). Say which of the three clicks right; if a stop still has play, which stop and which side | `sliderArmT` (1.3 softer, 1.6 stiffer), `sliderRestPress` and `sliderClosedRestPress` (0.45 and 0.3 hold harder into the rims), `sliderToothDeg` (30 softer click, 40 harder), `sliderGroove` (1.9 looser, 1.7 tighter on the rail) |
| the real B02 (blue PLA) then T05, third piece (done, 2026-11-21: "the button mechanism now works perfectly") | the slot and its ribs, the step, the chamber, the pocket, the leg channels, the mouth | the printed plunger, the switch with its two leads; a thumb over the mouth and the slot's front for the face | the slicer preview shows the four 0.2 ribs; deck up, the switch goes in through the mouth, legs in the channels, slides back and drops into its pocket; deck down, the plunger goes in with its cap in the slot and slides back over the switch to the round end, and cannot leave through the deck; deck up, the cap stands 2.0 proud, clicks within 0.6 of travel, returns on the switch, and runs 200 times without tick; shaken with a thumb over the mouth, nothing moves. If the plunger will not pass over the switch, or the cap does not click, report the switch's measured height, base to actuator top | `shutterSwitchBody[2]` (the switch's whole height), `shutterSwitchFree`, `shutterSwitchPocket` if the switch does not drop in or climbs out, `shutterGuideRib` [0.4, 0.8] if the ribs vanish, `shutterFlangeBoreClear` 0.7 in reserve |
| the new T05 (black PETG) with the switch and the new B02, then T10 (blue PLA) over it | the closed bore and its six ribs, the step all round, the plunger-first order, the switch's crush ribs, the button with the face on | the switch with its legs, B02, tape or a clamp to hold T10 on T05's front | deck down, B02 rides in through the mouth and lifts into the bore; then the switch slides in under it and its rear legs press into the crush ribs with a felt stop; shaken, the switch does not move; T10 sits flat on T05's front (the flange 0.3 short of it); the cap clicks under a fingertip pressing straight down and landing toward the face; 200 presses, no rub, no wobble you would call loose. If the legs go in without force or will not go in, report the leg's measured thickness | `shutterLegCrush` (0.05 looser, 0.15 tighter), `shutterLegT`, `shutterProud` |
| T11 (black PETG) with B03 (black PETG, 0.12) | the card door: the recess, the opening, the groove, the notch | a microSD card; B03 | B03 snaps in with a thumb and sits flush, the grooves lined up; a nail in the notch lifts it; it does not fall out shaken upside down; a card passes through the opening flat. On the body: the card clicks home under a fingertip and comes out between two nails | `tfDoorBumpOut` (0.55 looser, 0.75 tighter), `tfDoorClr` |
| the real A02 (blue PLA) and B01 (black PETG), fourth | the window, its lips, the teeth and the cover's arms, the slide's feel | six inserts, the iron; the shell's plate or any flat plate to close the track | the cover clicks closed and clicks open with a thumb, about 4 N; closed, it does not drop at 90 degrees of tilt or when shaken, and does not lift past the lips by hand; open, it stays open inverted; 200 cycles without the arms taking a set (both stops still have no play). If they pass they are the parts | `sliderClr`, `sliderArmT`, `sliderRestPress` |
| A03 at 0.10, then A01, last | | | | |

T07 is the track coupon the owner asked for (2026-11-21): the window's
whole band, 103 x 46 x 4.2 (about 11 g), not a one-sided cut (a cut piece
of the window ran the drop test cocked on one lip), and it takes the real
cover, which is its own part. T06 is the face's corner for the insert and
one tooth, not the track. The field body's `KINO_SLIDER_TRACK_COUPON` set
the clearances this track reuses. Before any detent number moves, the hang test on the whole body:
the cover held closed through 1,000 jogs on the top cord.

## What ships

The entry is the files, the print plan, the coupons and this list; a strap
that is not supplied is a scored fault.

- Prints: A01 shell, A03 rear frame and B01 cover in black PETG; A02 face
  and B02 button in dark blue PLA. Two spools, no filament change on
  any part.
- Hardware: twelve M2 brass heat-set inserts, OD 3.2 x 3 mm (C01), and
  twelve M2 pan-head screws, six 6 mm and six 4 mm (C03), the body's two
  joints; the carrier's own four M2 8 mm male-female
  standoffs and four M2 x 4 pan heads (male into the P4's brass inserts;
  the P4 ships with them, add none; the body touches none of them); one 6 x 6 x 4.3
  tactile switch on an 80 mm lead ending in a JST XH 2-way housing for
  J103; 2 mm PORON or silicone foam with adhesive (C02), 2 mm wide, two strips of
  101 mm and two of 60 mm for the frame's gasket groove, and the same
  again as spares; the cell for CN4 with its lead to J1001.
- Tools: a soldering iron with an M2 insert tip; one driver for the
  screws (PH0 or a 1.5 mm hex, whichever the kit's heads take).
- Cord: 2.5 mm braided, 1.2 m for the neck through the top slots, 0.3 m for
  the wrist through the bottom slots; a lark's head on the bar between the
  slots, inside the wall.
- Spares in the box: one cover (the wear part), one button, six screws
  of each length, four inserts, the second set of foam strips.
- The body's contract with any future carrier: the lens row at the four
  `cameraXs` (22 mm pitch) and `lensY`; keep those and the face and cover
  files do not change when the shell does.
- Known and accepted: the camera charges lying on its back because the
  carrier puts the USB-C on the bottom edge (the next carrier moves it);
  the carrier's three status LEDs are hidden with the frame on (no slots:
  they were holes for nothing; the screen carries status); the horizon is
  an open shelf and the track is open at
  the bottom, so grit rides the cover across the lens fronts, as on the
  XA; the blue PLA face and button soften from about 55 C, so the camera
  does not stay in a parked car (both are cheap reprints).

## Component register

The one list for the bins, the slicer, the CAD and the instructions. Two
printed materials, one fastener type, nothing glued.

| ID | Part | Function | Material, colour | Qty | Print orientation | Supports | Joined by | Fit that matters | Step |
|---|---|---|---|---:|---|---|---|---|---:|
| A01 | shell | front plate with the four camera pockets, four walls, the ledge, shutter pod, six counterbored screw holes through the plate, six insert holes in the rear wall ends, strap tunnels | black PETG | 1 | front plate on the bed | none | C03 screws into C01 inserts hold A02 and A03 on it | pockets (T02 gauge); the ledge under the carrier's edge (T03); cavity 0.5 a side; insert holes 3.0 (T04) | 1 |
| A02 | face | the blue front: horizon, grip, the cover's window with its floor, lips, detent channels and teeth, the four cells, six inserts in its back | dark blue PLA | 1 | back down | none | six M2 x 6 from inside A01 into its inserts | insert holes 3.0 (T06); rail 0.1 a side in the cover's groove; the bumps' press 0.5 over a land, 0.2 at rest | 3, 4 |
| A03 | rear frame | the ring round the display with the gasket groove, thumb pad, strap slots, six counterbored screw holes | black PETG | 1 | rear face up | none | six M2 x 4 from the back into A01's inserts | insert holes 3.0 in the wall ends (T04); 2.4 through the frame | 5 |
| B01 | lens cover | the sliding bar: closed over the cells, dropped into the tray; guided and keyed by the rail in its groove; a PETG spring arm with a bump at each end for the detents | black PETG | 1 | back down | none | captive in A02's lips, on A02's rail | groove 0.1 a side on the rail, 0.3 a side to the walls, 0.2 play under the lips | 3 |
| B02 | shutter plunger | the blue cap at the deck's front, 0.1 off six ribs in the closed bore | dark blue PLA | 1 | flange down | none | in first, up into the bore, captive under A01's step all round by its flange; A02 only covers the mouth | bore 14.6, step 1.5 over the flange, the flange 0.3 short of the face (T05, T10) | 1 |
| B03 | card door | the black lid in the top wall over the P4's microSD slot, flush, the grooves across it | black PETG | 1 | underside down | none | snapped into A01's recess by its two arms | recess 24 x 11 x 2.0, 0.25 a side, the bumps 0.4 into the groove (T11) | 1 |
| C01 | inserts | M2 brass heat-set, OD 3.2 x 3: six in A02's back, six in A01's rear wall ends | brass | 12 | | | heat-set | 3.0 holes 3.4 deep, countersunk 0.3 | 4 |
| C03 | screws | M2 pan head: six x 6 (face, from inside), six x 4 (frame, from the back) | steel | 12 | | | into C01 | 2.4 clearance holes, counterbores 4.4 x 1.4 (plate) and 4.0 x 0.6 (frame) | 4, 5 |
| C02 | foam strips | the clamp on the stack: 2 mm PORON, 2 wide, 101 + 101 + 60 + 60 | foam | 4 | | | adhesive to A03 | 40 % squeeze | 5 |
| T01 to T11 | coupons | shrink bar, pocket gauge, ledge corner, strap wall end, deck, the soft and the firm cover, the card door's wall (PETG); face corner, track, face's shutter corner (PLA) | as the parent | 1 each | as the parent | none | | each row of the coupon table | 0 |

Not in the body: the carrier's own four standoffs and four M2 x 4 (the
carrier's BOM), the switch and its 80 mm XH lead, the cell and its lead,
the cord.

Orientation keys, so nothing goes in two ways: A02 on A01 by the pin
pattern (top pair at X 30 and 90, bottom pair at 5 and 96.7); B01 in A02
by its groove on the off-centre rail; A03 on A01 by its hole pattern (bottom pair at
X 40 and 100 against the top pair's 30 and 90: turned round it misses by
2.4 mm, a gate) and the thumb pad; the stack in A01 by the camera pockets (turned
round, the heads hit the plate and the USB-C the top wall, a gate); B02 by its flange
(cannot pass the slot from outside); the switch in the pod by its legs
in the two channels (turned 90 degrees its legs stand on the floor and it
does not reach the pocket), and by the order (in second, it cannot pass
under the plunger's flange).

## Quality control

Inspection points, in the order they happen:

| When | Check | Pass |
|---|---|---|
| after T01 | the shrink bar | 99.8 to 100.0 mm with the 0.2 % compensation on (99.9 on 2026-11-21) |
| every print, off the bed | the ID reads (A parts and coupons; the B parts have none); no support scars (there are no supports); the bed chamfer present on every fitted edge; no elephant foot proud of it | by eye and thumbnail |
| A01 | the four pockets take a seated head with a thumb and hold it inverted; the twelve pin holes take a pin pushed 3 mm; the carrier drops to the ledge and sits flat | T02, T03, T04 criteria |
| A02 + B01 (the face subassembly) | the cover drops at 45 degrees of tilt, stays shut at 90, cannot lift past the lips; the wordmark reads; the four cells clear | before the face goes on |
| the switch and B02 in A01 | the switch down in its pocket, legs in the channels, leads hanging free into the cavity; the plunger up in the bore, the cap 2.1 proud, clicks within 0.6 of travel, runs 200 times without tick, returns on the switch | before the stack goes in; the face on before the deck turns down |
| A02 on A01 | flush all round, the 0.3 reveal even; hangs face-down from the cord for an hour, takes a 10 N pull | pins hold |
| the stack in | the carrier flat on the ledge all round, its heads clear of everything; the shutter lead on J103; the USB plug passes | no rock |
| A03 on | the foam in its groove, butted; six screws down, the heads 0.7 proud and even; the V joint closed all round; the window centred on the active area by eye; the glass does not touch the frame (a 0.1 feeler at the window's edge) | |
| finished | cover closed: the firmware sees four dark; dropped: four live; the button fires; the seams: the reveal round the face and the V at the frame joint even all round | |

## Assembly, counted

Measured on the files, not on a bench; the bench numbers come with the
first ten units.

| | this cut |
|---|---:|
| unique printed parts | 5 (in 5 files) |
| fastener types | 2 (an M2 pan-head screw in two lengths, an M2 heat-set insert) |
| fasteners | 12 screws, 12 inserts |
| glue | none |
| assembly operations (the numbered steps and their sub-steps) | 15 |
| product reorientations | 1 (front up for the face, then face down for the stack and frame) |
| operations needing more than two hands or a fixture | 0 |
| ambiguous orientations | 0 (every part keyed; the switch by its legs in the channels) |
| distinct tools | 2 (the iron with an insert tip, one driver) |
| slicer supports | none on any part; support removal 0 min |
| hands-on assembly time | estimate 12 min; measure |
| cover replacement | nail in the channel, face off, cover out: estimate 3 min |
| battery change | nail in the channel's rear end, frame off with its pins, stack out: estimate 3 min |
| printed parts per camera, mass | shell about 95 g, face 35, frame 20, cover 5, button 2 (estimates from the slicer; measure) |

## What a jury would read

Not a claim of novelty, a description of what holds together. The camera
is one silhouette in two materials, and the colour boundary is always a
part boundary, so what you see tells you how it is built: black carries,
blue is touched. Nothing is glued and no screw enters a board: twelve M2
screws into brass inserts hold the face (from inside, unseen) and the
frame (from the back, six heads where the concept draws them), and the
stack is clamped on foam against a ledge it rests on by its own edge, so
the electronics are a subassembly built and flashed on the bench and
dropped in, and the body never touches a board's screw. The face and its cover are
a second subassembly, tested on the bench before they meet the shell. Every
part goes in one way, and every part says what it is on a face you only
see when you open it. The form is the brand's: a black bar in a blue
field, one groove across the face, ribs on the layer rhythm, rounds in
plan and chamfers in Z, and the four eyes in the line when the bar drops.
The printed parts need no support anywhere, which the gates prove on every
build, and the whole thing is 51 mm deep around a 43.5 mm stack. What it
does not yet have is a printed unit; the coupons and the first body are
the next entry.

## Not in this cut

- "made for bad ideas." and any other line under 4 mm of cap height.
- The C6 service header.
- An interference gate against the carrier's own part model
  (`outputs/D1-print.stl`): the dummy here carries the sockets, modules, the
  carrier's USB-C, the window and the battery bay, not the LINK headers, the
  XH housings or the test pads.
- One `hand` parameter driving the four mirrored numbers and the
  firmware's `body.hand`.
- A 1/4-20 boss on the bottom wall: the next carrier should leave a 12 x 7
  notch at X 50 for it.
- Slicer profiles per part as files (a 3MF with the modifier boxes and the
  two filament changes baked in), and a per-part time and mass table.
- The serial and revision engraving, the face grain.
- The independent scan.

## Open inputs

Each one is a number in `params.mjs` and nothing else moves when it changes.

- `xiaoHeaderInsulator` 2.5: measure a soldered XIAO, socket top to board back.
- `p4CanH` 3.5: the P4 module can, and whatever else stands on the P4's back inside the bay rectangle (CN4, the C6 module).
- `spacer` 8.0 with the socket home: the carrier README's bench step says 7.7 expected.
- `camStackH` 15.0: a caliper on a seated node.
- `camBody` 7.9 (done, 2026-11-21): the gauge's 8.1 pocket holds the head; the head's own calliper size is still unrecorded.
- `insertHoleD` 3.0 and `insertPullN` 50: the kit's inserts in PLA (T06) and PETG (T04); flush, no bulge, 50 N on a pull.
- `sliderArmT` 1.45: the click, set by whichever of B01 (1.45), T08 (1.3) and T09 (1.6) feels right on the sixth T07 (the fifth, with 1.55 arms over 0.5 teeth, clicked right and held loose).
- `sliderGroove` [1.8, 1.2] on the 1.6 x 1.0 rail (the fifth T07: the rail runs right), `sliderToothDeg` 35, `sliderClosedLeaveDeg` 40, the bump's sides `sliderBumpRLo` 0.9 and `sliderBumpR` 1.5, the reach 1.0 and the rest presses 0.25 closed and 0.35 stowed: the hold at the stops on the sixth T07, without bending the arms; 0.3 and 0.45 if it still has play.
- `ledgeW` 2.0 with `carrierClear` 0.5 (done, 2026-11-21): the carrier's corner sits flat on T03's ledge.
- `shutterSwitchBody[2]` 4.3 and `shutterSwitchFree` 0.3 (done, 2026-11-21): the third pod coupon with the real plunger and switch "works perfectly".
- The customer review's two items the carrier fixes, not the body: the USB-C and the three status lights are on the bottom edge because the carrier puts them there, so the camera charges lying on its back; a later carrier can move them.
- `activeCentred`: the active area centred on the PCB is still an assumption; the window has 1.0 mm a side.
- `camFovDeg` 78: the OV3660's real field is `MEASURE_REQUIRED`.
- `tfSlotX` [64.43, 76.37] and `tfSlotMouthY` 67.89: from Guition's structure drawing (`OFFICIAL_CAD`); a caliper on the board's top edge makes them `MEASURED`.
- `tfCardZ` [0.4, 1.4], `tfCardProud` 1.0, `tfCardEject` 3.5: the socket's height, the seated card past its mouth and its spring, none in the drawing; measure with a card in.
