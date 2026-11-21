# KINO carrier body: a shell around the dev carrier D1 stack

Third body for the D4, and the first one that does not carry the electronics
itself. The dev carrier D1 ([`hardware/pcb/kino-d4-dev-carrier/`](../../pcb/kino-d4-dev-carrier/README.md),
issue #250) stacks on the P4's own inserts through 8 mm spacers, the four XIAOs
stand in sockets on it, and each camera module hangs off its XIAO on a short
soft ribbon. The carrier is the chassis. No screw from the body enters
either board: the shell clamps the stack, pillar feet on the carrier in
front and the rear frame's foam on the glass behind, and captures each
camera head in a pocket with pinch ribs, so the picture does not shake on
its ribbon. The face
shell carries the form. Issue #252; fifteenth cut, nothing printed yet; the
night colourway (cobalt face) prints first, the coupons in `coupons/`
before it.

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
| rear frame | 2.0 | -16.2 | chosen; 1.2 under the gasket groove; the thumb climbs it to the glass, so its window edge is chamfered |
| glass clearance | 0.4 | -14.2 | chosen; the frame never touches the glass; a foam gasket in the frame's groove takes the stack's tolerance and holds the module |
| P4 module, glass front to PCB back | 13.8 | 0.0 | OFFICIAL_CAD |
| P4 inserts | 3.3 | 3.3 | MEASURED |
| M2 spacers | 8.0 | 11.3 | the bench set; the J100 socket floats 0.3 mm off home |
| carrier PCB | 1.6 | 12.9 | |
| XIAO socket insulator | 8.5 | 21.4 | Wurth 61300711821 |
| XIAO male header insulator | 2.5 | 23.9 | **PROVISIONAL**: the headers soldered to the owner's XIAOs; the carrier's assembly print left this out |
| XIAO back face to the lens front | 15.0 | 38.9 | Seeed's assembled Sense stack |
| plate ahead of the lens | 1.0 | 39.9 | chosen; the shell's front; the bore and its 0.4 chamfer; five whole 0.2 layers |
| face | 3.2 | 43.1 | its edge a 1.2 mm 45 degree chamfer; the horizon is cut into it and the cover's window through it; nothing stands proud of it but the cover's 1.5 mm lip |
| **body** | **59.3** | | |

The module's PCB face is the Z datum for the camera, as in the field body: it
lands on the plate's inner face at Z 35.5 (the Sense board's top is at 31.5, so
the 3.5 mm module PCB has 0.4 mm of fold behind it), the 8.5 mm head sits in a
3.5 mm pocket with 0.2 mm pinch ribs on two walls pushing it onto the other two,
and the lens front is the pocket floor. If the real header insulator is not
2.5 mm, every Z above the socket moves by the difference and the plate must
move with it; `xiaoHeaderInsulator` in `params.mjs` is the one number to change.

Plan: the carrier's 118.40 x 70.80 outline plus 0.5 mm a side of cavity (PETG
shrinks 0.3 to 0.5 % and a 54 mm wall bows; 0.3 wedged on paper) plus
4.5 mm walls, 128.4 x 80.8 mm, R10 corners (the most the plan allows: the
carrier's near-square corner sits inside the wall, and R10 leaves 2.65 mm on
the diagonal, gated). The
lens row is 28.45 mm above the carrier's bottom edge (the heads sit 6.95 mm
below the socket centres, toward the pin-7 end), at X 17.2, 39.2, 61.2, 83.2
from the carrier's left edge. The block is 9 mm left of centre; the right side
carries the USB window and the shutter.

What the depth is made of, lens front to glass, and what the body adds:

| | mm |
|---|---:|
| electronics, lens front to glass | 52.7 |
| of which the P4 module | 13.8 |
| of which the P4-to-carrier layer (inserts and spacers; the battery lives in it) | 11.3 |
| of which the XIAO connectors (8.5 socket + 2.5 male header insulator) | 11.0 |
| of which the XIAO, Sense board and camera | 15.0 |
| body in front: plate ahead of the lens 1.0, face 3.2 | 4.2 |
| body behind: the rear frame 2.0 and its 0.4 off the glass | 2.4 |
| **in all** | **59.3** |

The body is 6.6 mm of the 59.3; the face's 3.2 is the track's lips and the groove
and the groove it sits in. The one stack term that is a bench choice
is the XIAO connectors: the eight 1x07 sockets are hand-fit, so 4.3 mm
low-profile strips in place of the 8.5 mm Wurth part, and XIAOs soldered on
bare pins without the 2.5 mm insulator, would take up to 6.7 mm out of the
camera; `socketH` and `xiaoHeaderInsulator` are the two numbers. The J100
socket fixes the 11.3 mm layer.

## Thinner

The body is 6.6 mm of the depth and is at its floor: 2.0 of frame (1.2
under the gasket groove), 0.4 off the glass, 1.0 of plate ahead of the
lens (the bore and its chamfer), 3.2 of face (2.4 of track lips and a 0.8
groove). The other 52.7 mm are the electronics, and three of those terms
are bench choices, each one number in `params.mjs`:

| Lever | Now | Thin | Saves | What it costs |
|---|---:|---:|---:|---|
| `socketH`, the XIAO female headers | 8.5 | 4.3 | 4.2 | low-profile 1x07 sockets on the carrier (hand-fit, so this is a BOM line) |
| `xiaoHeaderInsulator`, the soldered male header | 2.5 | 0.0 | 2.5 | XIAOs soldered with bare pins, or castellated straight to the carrier: no insulator under the board |
| `spacer`, the P4-to-carrier layer | 8.0 | 5.0 | 3.0 | a 3 mm cell in the bay (the bay is `cellT` + 0.5 foam + 10 % swell between the P4's 3.5 mm can and the carrier's 1.5 mm back parts); with no cell in the layer, 3.0 and 5.0 saved |

All three together: 49.6 mm, 9.7 thinner, with the same body files. The
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

## The stack, held without a screw into it

The P4's four inserts carry the carrier's standoffs, and the standoffs
carry the carrier's own four M2 screws; the owner's rule is that nothing
from the body screws into either board. The stack is held three ways, none
of them a screw:

- Forward, by the pillar feet: four pillars from the shell's front plate
  end in feet that land on the carrier's front face round its own screw
  heads (a 4.4 mm pocket 1.6 deep in each foot takes the M2 pan head, 1.2
  of wall round it, inside the 7 mm keep-out). The stack slides in from the
  rear and stops there. The plate's front is solid: no driver shafts.
- Backward, by the rear frame through a gasket. The frame's inner face
  stands 0.4 mm behind the glass front (a gate: a rigid PETG frame never
  touches glass) and carries a 2 mm foam strip, 2 mm wide, in a 0.8 mm
  groove round the window, on the glass's margin: 1.8 mm outside the
  window past its chamfer, 0.5 mm inside the module's edge. The four frame
  screws squeeze the foam to 1.2 mm (40 %; 25 to 55 % over +-0.3 mm of
  stack tolerance, a gate). The 114 x 67 module hangs 26 mm past its
  standoffs in X; the foam carries that overhang, so a thumb on the glass
  loads foam and not the inserts, nothing rattles, and the window is sealed
  against dust. The four frame screws, case into case through the wall-end
  pilots, are the only fasteners in the body: they squeeze the foam, the
  foam pushes the glass, the glass the module, the standoffs the carrier,
  the carrier the feet. About 16 N at 40 % on 644 mm^2 of PORON, twelve
  times the stack's weight (a gate; the foam's pressure and the stack's
  mass are provisional until both are on the bench).
- In plan, by the standoffs on the carrier, which the pillar feet locate;
  the cavity wall is 2.5 mm from the module's edge. Nothing in the cavity
  can reach the module: the carrier sweeps in from the rear past every
  plane the module occupies, so a ledge under it is impossible.

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
v18 and v6: a charcoal body with the layer texture on its walls, a cobalt or
cream fascia, a pink shutter, quiet lowercase markings, "made for bad
ideas"). Three filaments, each on its own part:

| File | What | Filament | Print |
|---|---|---|---|
| `print/KINO_CARRIER_SHELL.stl` | front plate with the four pockets (0.5 mm corner reliefs) and 7.5 mm bores, all four walls to the display plane with R10 plan corners, 0.5 mm V-grooves at 2.4 mm pitch round the whole body, the deck included whole (one 1.5 mm smooth ring round the collar), clear of the frame pilots; nothing engraved; the horizon carried round the left wall only; four pillars ending in feet with a pocket for the carrier's own screw heads (no screw from the shell), the shutter pod (every bore gabled; the collar a 0.4 mm round shadow line), the LED slots, the USB-C opening, the frame pilots, six countersunk pin holes in the walls' front ends, four strap tunnels inside the top and bottom walls' ends under 1.2 mm of wall, three ribs in the shutter's guide bore; the bores, the front edge and the rear edge chamfered 0.4 | charcoal, its first 1.0 mm in the face's filament | front plate on the bed (`previews/KINO_CARRIER_SHELL_PRINT.png`), PETG, 0.20 mm, no support (gated) |
| `print/KINO_CARRIER_REAR_FRAME.stl` | the 2.0 mm frame around the display, a 0.8 mm gasket groove in its inner face round the window (the P4 is held by 2 mm foam in it), its outer edge chamfered 1.2 toward the rear and 0.4 toward the shell (the joint is a drawn V on the groove rhythm), 95.6 x 58.2 window with a 1.0 mm chamfer toward the rear, a thumb pad with 1.0 x 0.6 grooves over the whole right border (X 109.5 to 121), the ODD JOBS symbol engraved 1 mm deep with a stepped edge on the left, four plain M2 holes (the pan heads sit proud, as the brand's concept shows its rear screws), eight 3.0 x 2.8 strap slots, two at each corner | charcoal | rear face UP (`previews/KINO_CARRIER_REAR_FRAME_PRINT.png`; the gasket groove on the bed), 0.10 mm |
| `print/KINO_CARRIER_FACE.stl` | the face: a 3.2 mm plate inset 0.3 mm from the shell's outline (a reveal line in one colour), its front edge a 1.2 mm 45 degree chamfer, its back edge chamfered 0.4; the horizon, a 0.8 mm groove edge to edge at the bar's height with its lips chamfered 0.8 above and 0.4 below, its right end ramping at 45 degrees to 2.2 mm deep as the grip; the cover's window, 87 x 34.5 with R3.1 corners, through the whole plate, its front edges chamfered 0.8 (bottom rim) and 0.4 (sides), with dovetail lips on its two side walls (the short ones, along the travel) and two detent pairs; six countersunk pin holes in the back; the signature engraved 0.4 mm inside, mirrored (the symbol, "odd jobs", "kino D4") | cobalt (night) or cream (day) | back down (`previews/KINO_CARRIER_FACE_PRINT.png`), 0.20 mm, no support |
| `print/KINO_CARRIER_LENS_COVER.stl` | the sliding cover, 86.8 x 16.5 x 2 with R3 corners, its back edge chamfered 0.4, "odd jobs" raised 0.8 (the flush to CREAM at 2.00 mm, the bar's top face, on both colourways; the lip prints cream too), a 20 x 1.5 lip with a 0.4 mm root on its top edge from 45 to 65 mm off the bar's left end, 1.5 proud of the face | charcoal, then cream | back down (`previews/KINO_CARRIER_LENS_COVER_PRINT.png`), 0.08 mm layers, filament change at Z 2.00 |
| `print/KINO_CARRIER_SHUTTER_BUTTON.stl` | the plunger (14 mm flat cap with a 0.5 mm 45 degree edge, 2 mm proud of the deck, the 16 mm flange chamfered at the bed, 0.15 a side in its bore, the cap running on three 0.2 mm ribs in the guide) and the switch retainer (6 x 6 x 4.3 mm tactile switch) | pink | flange down (`previews/KINO_CARRIER_SHUTTER_BUTTON_PRINT.png`), 0.08 mm layers |
| six pins | 1.75 mm filament cut 4.8 mm long into 1.9 mm holes countersunk 0.4: 3 into the wall end, 1.8 into the face, pushed flush; they locate and retain, no glue; the pull test on the real face decides | any | |

Where it comes from, and what each thing is for:

- **The horizon.** One line is cut across the face, edge to edge, at the
  bar's height, its ends open through the pillow round. The bar sits in it;
  the face is built around the line, and the lens row's position (fixed low
  and left by the stack) becomes a position on that line rather than a
  misalignment. The jury's one move.
- **The hand.** The right hand holds the right end (the on-device UI is laid
  out for it: `firmware/UI_DIRECTION.md`). The pink shutter is on the top deck
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
  loads the shell and not the frame's four screws; inside the outline, out
  of the palm. The top pair hangs the camera upright on a neck cord, button
  up; the bottom pair is the wrist loop. A left-handed body is a mirror
  of four numbers, not one: `shutterX`, the grip end, `thumbPadX` and the
  horizon's wall side, plus the firmware's `body.hand`; one `hand` switch
  that drives all four is on the list, not in this cut.
- **The four-mark.** The cover closed is one dark bar in the line, the UI's
  landed bar, and it carries the brand; dropped, it slides down its window
  into the open stow zone and the four bores show in the line, the UI's
  four-mark. The window is open: the charcoal plate shows through it under
  the bar, and the dropped cover sits in it in plain view. The twelfth cut
  chose that over a roof, a slot, a keeper and five breakaway blades.
- **Colour is an event.** Charcoal and cream (or cobalt) at rest; the one
  pink thing is the button you press. No other colour on the body.
- **One word outside, the rest inside.** The brand on the bar: "odd jobs"
  (traced from the logo by `brand/trace-wordmark.py`, 30 x 6.8 mm, strokes
  1.3) raised 0.8 on the cover, its last four layers in cream on both
  colourways (one filament change on one small part; charcoal on cobalt was
  a low pair). The symbol on the back, engraved 1 mm with a 0.3 mm stepped
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
  is where the care goes: the track, the pins, the pockets, and the print
  plan below.
- **Ribs.** 0.5 mm V-grooves at 2.4 mm pitch round the whole body, the
  deck included whole (in print the deck is a wall like the others), one
  1.5 mm smooth ring round the shutter collar. They are ribs, not the layer
  lines: twelve 0.2 mm layers to a pitch, so every groove slices the same
  and the print's own lines fall inside them. The first groove's waist at
  Z -6.6 lands on a whole layer and clears the frame pilots, and three
  pitches later the frame joint lands on the rhythm. 49 degree flanks, so
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
  wall caps it near R10.6), the face a pillow framed by a 0.8 mm line of
  charcoal, the shutter cap domed, the cover's corners R3, every tab and
  ear gone from the outline. The shell's front edge is on the bed, so its
  softness is the face's; the rear frame's round is R1.5, its screw holes
  2.55 mm from the edge.
- **Seven reviews.** Cuts four to nine each answered a cold read: an
  engineer on the files (press-fit face, 0.4 mm ribs, shallow grooves, the
  strap under the palm), a customer on the renders (the empty pocket under
  the closed bar, the rivets, the invisible brand, no grip), a design-award
  juror (the band pinned low-left in an empty field, a lid instead of a
  frame, the product name where the brand belongs, the apron as a door that
  does nothing, ears outside the outline, a smooth cap on a ribbed body), a
  second juror on the night body (the engraved name on the deck as the one
  decoration left, the slot stopping short of the groove, the cord on the
  frame's screws) and a print technician (0.3 mm cavity clearance against
  PETG shrink, 1.8 mm pin holes closing to 1.5 at the bed, a 7.1 bore
  around a 7.0 barrel, the elephant foot at every fitted bed edge, the
  roof's sag over the track, a 0.6 stroke engraved in a vertical wall, the
  collar's flat-ceilinged recess, the lip slot's free-ended bridges, the
  grooves over the pilots' threads), then, after the award winners were
  read, two jurors and a print foreman together (closed, the silhouette was
  a cassette or a speaker, with ribs and a pink dot; the deck half smooth
  for a name that was gone; the horizon invisible from the front; the
  pillow round terraced; the grip a fingertip's edge and the right wall's
  ribs erased under the fingers; a letter showing through the lip slot; the
  collar an arrow; a 2.2 cord a key fob and the camera hanging inverted on
  it; the dome a contour map; the keeper a tooth under the round), and
  then, with the whole field of design awards read, an IDEA and Red Dot
  generalist, a Good Design and Compasso d'Oro juror and a jury chair (the
  glued keeper sealing in the one wear part; pins that locate but do not
  retain; the button ticking in its guide, the first thing a juror
  touches; a 30 mm slot reading as a mouth; a 1 mm sill a glove cannot
  lift; a 9 mm thumb pad for a 20 mm thumb; no cord, no spares, no BOM in
  the entry; a swelling cell with no gate; a left-hand promise that was
  four numbers; "layer lines" that are ribs; a lug sentence left over).
  Each is in ECN-0009 with what it changed. Not taken, six times: stowing
  the cover up; drop-to-open was settled on the bench. Also not taken: a
  5.5 mm wall for heat-set frame inserts (the frame screws are on the
  battery's path; the cycle count and spares are stated instead), a fake
  lens tell on the closed front, a tripod boss (the next carrier's).

### What the design awards taught

Read before the eighth cut (2026-11-20) and widened for the ninth (the
owner: "not just award cameras, the whole design awards"): the published
criteria and the juries' own words across Red Dot (Best of the Best), iF
(Gold), IDEA (Gold, Best in Show), the Good Design Award Japan (Grand, Gold,
Long Life), the Compasso d'Oro, D&AD and the Braun Prize, in every
category, and the record of award-praised objects that failed in use. The
owner's brief was that the body be printable and recognisable.

The criteria, as published. Red Dot: innovation, ergonomics, product
periphery, functionality, durability, self-explanatory quality, formal
quality, ecological compatibility, symbolic and emotional content; the unit
is judged in the hand. IDEA, unchanged for 40 years: design innovation
(what problem does it solve, how clever is the solution, does it advance
its category), benefit to the user, benefit to the brand, benefit to
society, appropriate aesthetics (form suits use; colours, materials and
finishes fit the purpose). Good Design: the Grand Award is voted from the
Gold list by the jury and the other winners; the Long Life award goes to
what is still right after ten years; 2025's Grand went to thirty years of
disaster housing, not an object. Compasso d'Oro: pre-screened on measurable
criteria (performance, reduced environmental impact, new technology); the
2022 jury's words were development, sustainable, responsible; its citations
praise "technological and formal innovation to the archetype" and "a poetic
solution to a static and mechanical problem". Rams's ten, which every one
of these juries still quotes: innovative, useful, aesthetic, understandable,
unobtrusive, honest, long-lasting, thorough to the last detail,
environmentally friendly, as little design as possible.

What wins, in every category: a real problem solved cleverly inside an
archetype people already know (the citations name the problem first and
the form second); one idea carried through the whole object; one visible,
physical main action with a sound and a stop; benefit to the user and now
to society (repairable, screw-apart, replaceable parts, open documentation:
Fairphone, Framework, the Xbox Adaptive Controller designed from the edge
user inward); appropriate aesthetics, colour as information; workmanship at
the edges and joints; longevity, since trend finishes date and an archetype
with one clear move does not; thoroughness, since the strap, the packaging,
the manual and the service procedure are part of the entry.

What fails, including award-praised work: a device without a need (Juicero,
the Humane AI Pin, the Rabbit R1: "a brilliant exercise in design", hollow
in use); minimal to a fault; style that does not carry into handling;
decoration in costume; fragile novelty and glue where a pin belongs; one
wrong detail at the point of use; hype over implementation ("it is always
the implementation that lets them down").

The camera winners, in the juries' words: one idea carried through the whole object
(Sigma BF, Red Dot Best of the Best 2026 at 100 points, iF Gold 2026, Good
Design Gold 2025: "a single aluminium block", "a stripped-down interface";
Leica T: "reduction to essentials"; Fujifilm GFX100RF: "closer to an analog
tool than a piece of technology"); continuity, a silhouette drawn from memory
(Ricoh GR IV, Good Design 2025: "a consistent design for 30 years, evolving
alongside its users"); the ritual visible and physical (Instax mini Evo, Red
Dot Best of the Best 2024: "instant-camera rituals", its crank lever really
advances the print); self-explanatory controls, one thing each; honest
symbolism (the Charmera's 1987 Fling shape); workmanship at the edges, since
the jury holds the unit.

What failed, in the reviews of the same winners: minimal to a fault (the
BF "virtually flat", "ergonomics non-existent"; the Leica T's touchscreen
"95 per cent there"), so reduce controls, never grip; style that does not
carry into handling (X half, X1D); no strap (Camp Snap); decoration in
costume (fake leatherette, dials that are not dials); fragile novelty (Paper
Shoot); one wrong detail at the point of use (Camp Snap's LED in the
viewfinder).

Applied here as the eighth and ninth cuts' brief: the jury holds the print,
so every surface the hand meets is judged as a printed surface, and the
process is either shown on purpose (the ribs on the layer rhythm; rounds
in plan, chamfers in Z) or it must not show at all; recognisable
means three lines on a napkin that are nothing else, and "a camera" at
arm's length with the cover closed; responsible means screw-apart, pins not
glue, a replaceable wear part, a strap supplied, the print plan and the
coupons in the entry, and nothing that dates in two years. Sources are
listed in ECN-0009.

### The face and the cover

The shell's front plate prints on the bed, so it can carry no relief; the
face does. It covers the front to 0.3 mm of the walls' outer edge, 3.2 mm
thick with its front edge a 1.2 mm 45 degree chamfer (the frame's own size; 2.0 ran over the pin holes on a 3.2 plate) and its back edge
chamfered 0.4 against the elephant foot. Into it, from the front: the
horizon, 0.8 mm deep across the full width (the chamfer family's own
size; the window's chamfered rims carry the line on), its upper lip
chamfered 0.8 and its lower 0.4 so the line catches light from every
angle, its right end ramping down at 45 degrees to 2.2 deep as the grip
(1.0 of plate left under it). Through it: the cover's
window, 87 x 34.5 mm with R3.1 corners, from the stow zone's bottom rim to
0.5 above the closed cover's top. The shell's own plate is the track
floor, and the shell prints its first 1.0 mm in the face's filament, so
the tray is a cut pocket in the face's colour and not a charcoal mouth
(closed, a dark bar on a colour field, as the brand draws it). The
window's two side walls (the short ones, along the travel) carry the
dovetail lips (1.0 wide, 1.1 deep from 2.4 above the plate, so the
cover's 1.0 bevel runs under them with 0.4 of play) and two detent pairs
past the cover's R3 corners, 1.0 tall so three layers bite after the
elephant-foot compensation; 0.1 mm a side. The window's bottom rim is the
stowed cover's stop and its top rim the closed cover's. Its front edges
are chamfered as the horizon's lips are, 0.8 on the bottom rim and 0.4 on
the sides, so the open stow zone reads as the second line of a cut tray
and the bar sits between two lit edges. The tray's floor is plain plate
in the face's colour. The four cells are the shell's 7.5 mm bores with their 0.4
chamfer, seen through the window.

The cover drops 17.6 mm to shoot; the travel is derived from the face's
edge. 16.5 mm tall, it blankets the 7.5 mm cells by 4.5 a side when closed
and its top edge clears the field cone when stowed. Both are gates, as is
the closed cover blanketing every cell (the firmware's cover-closed test
needs all four dark). Closed, its top sits 0.4 below the groove floor and
its raised mark 0.4 above it. Its lip, 20 mm wide with a 0.4 mm root,
from 45 to 65 mm off the bar's left end and 1.5 mm proud of the face (a
thumb needs 16; at 1.0 a glove could not lift it), is what the thumb
pushes down and lifts back. Dropped, the cover sits in the open stow zone
in plain view, the bar's top 0.8 below the face.

Loading: the cover goes into the window from the face's back, bevels
under the lips, before the face goes onto the shell; the shell's plate
then closes the track. To service it: six pins, face off, cover out. The
face is held by six 1.75 mm filament pins in 1.9 mm holes countersunk 0.4
at every mouth (a 1.8 hole at a bed face closed to 1.5 with the elephant
foot; 2.0 with the countersink and the 0.2 compensation did not retain),
3 mm into the walls' front ends and 1.8 mm into its back (4.8 mm pins,
pushed flush). They locate and retain; there is no glue anywhere in the
body. The pillar coupon sets the hole; the real face, hung face-down from
the cord for an hour and then pulled, proves the hold. To take the face
off: the horizon channel on the left wall exposes 1.5 mm of the face's
back edge at its left end; a nail lifts it there. No knife on cobalt.

Earlier drafts, each thrown out by a gate or a review: a rim pocket (the
face flush inside walls run past the plate: 10,000 mm^2 of overhang face
down); a proud face inside a flat margin (a lid on a tin); a 1 mm band rim
with rivet bosses over the pin holes; a glued apron plate over the stow
zone (a door that did nothing, and 0.6 mm proud by arithmetic); the face
roofing the stow zone with a slot for the lip, an entry gap below the
track and a captive keeper refilling it (sixth to eleventh cuts: the roof
was two cantilevers in print and needed five breakaway blades, the keeper
a foot and a pocket, the track a relieved floor; the owner's call on the
twelfth cut was to open the stow zone and drop all of it).

### The shutter

The field body's pod and button, the cap grown to the brand's and made
flat. A 24 mm pilaster on the shell's top wall between the plate and the
carrier (Z 14 to 35.7, 1.1 above the carrier), bore axis at Z 26.2, X 104:
the plunger (14 mm cap, 16 mm flange at 0.15 a side, 4.1 mm stem) comes out
through a 14.6 mm guide carrying three 0.2 x 0.8 ribs on its face side, so
the cap runs on three lines instead of ticking in a gap, and a 0.4 mm
collar in the top face; the switch sits in a retainer cup pushed into the 17 mm access bore
from inside the cavity with the stack out; its two leads leave through
gabled channels either side and run down the cavity to J103 on the carrier.
Every bore has a teardrop roof pointing up in print, which is why the axis
sits 12 mm above the pod's bottom.

### Assembly

0. Before anything goes in: flash the P4 and the four nodes (the P4's USB
   ports are unreachable with the shell on), and fit the four M2 8 mm
   male-female standoffs into the P4's own brass inserts (it ships with
   them; add no heat-set inserts), and screw the carrier to the standoffs
   with its own four M2 x 4 pan heads: those heads are what the shell's
   feet land round. Stack the P4, the cell on CN4 with its
   lead to J1001 RAIL (the carrier README's bring-up step 7 with an SW6106
   is superseded here), the carrier on the standoffs, the nodes in their
   sockets, outside the body.
1. Plunger into the pod from the cavity, cap first, out through the top
   face: its 16 mm flange cannot pass the 14.6 mm guide, so it never goes in
   from the top. Then the switch into the retainer, the retainer into the
   pod from the rear behind the flange, leads out through the side channels.
   Plug the switch lead's JST XH housing into J103 on the carrier's front
   NOW: J103 is inside the cavity and unreachable once the stack is in.
2. Slide the stack into the shell from the rear, carrier first, until the
   carrier meets the four pillar feet, its screw heads in their pockets.
   Nothing screws here: the frame clamps it in step 5.
3. Cover into the face's window from the face's back: wordmark toward the
   face's front, lip toward the horizon (the top), bevels under the lips,
   up to its closed detent. The lips hold it from falling out forward, so
   with the shell front-up on the bench and the face lowered back-down
   onto it the cover cannot drop.
4. Six 4.8 mm filament pins into the walls' front ends, 3 mm in (1.8
   proud); face pressed on over them until flush, the shell's plate closing
   the track. To service the cover: nail into the left wall's horizon
   channel under the face's edge, face off, cover out.
5. Four foam strips into the frame's groove (two of 101 mm, two of 60 mm,
   adhesive down, butted at the corners, pressed flat). Frame onto the wall
   ends with four M2 x 8 thread-forming pan-head screws; the heads sit
   proud on the back. The screws squeeze the foam onto the glass's margin
   and the stack onto the pillar feet: that is what holds the whole stack,
   and they are the only four screws in the body.
6. Power up. The three slots on the bottom wall show the carrier's LEDs:
   PWR, CAM, FLT, left to right (the carrier README has the legend). Close
   the cover: the firmware's cover-closed test must see all four cells
   dark. Drop it: all four live.

A battery change is the frame off and the stack out; count it as one of
the frame pilots' ten cycles.

The carrier's USB-C comes out through the bottom wall at the right; the three
edge LEDs show through three 2 x 4 mm slots beside it. The P4's own USB ports
are reached through the carrier's window only with the shell off.

Previews: `previews/KINO_CARRIER_NIGHT_*.png` (the print target) and
`DAY_*.png` are the colour views from `render-parts.py` (each part's STL in its filament's colour,
triangles split to 5 mm so the painter's order holds); the `*_PRINT.png` views
are each part in print orientation from `render-stl.py`. `KINO_CARRIER_EXPLODED.png` and `_EXPLODED_SIDE.png` pull every part apart along the depth axis: rear frame, the electronics stack (green) with its glass, the shell with its button, the face, the cover; the pins, the foam strips and the switch are too small to show.

## Gates

`node generate-carrier-body.mjs` writes `.candidate/` and runs 161 gates,
throwing on the first failure (`KINO_SOFT_GATES=1` collects them): the depth
chain re-added over the lens band, the lens front on the pocket floor, the
module PCB with the plate to land on, the battery bay tall enough for the cell
and clear of the spacers and the outline, each part one solid (the pins four,
the button two), the face on the shell and the electronics dummy clear of
every part with only the pinch ribs inside the nominal heads, every pocket
open with its ribs standing, the field cone (bore then cone, two probes) clear
of the shell, the face and the stowed cover at every station, the closed
cover blanketing every cell, the carrier's screw head in every pillar foot's pocket,
every pillar foot standing on the carrier inside its 7 mm keep-out, every pin
hole open and blind, the carrier's sweep from the rear clear up to the feet
with the pod above it, the USB plug and the LED slots through the bottom wall,
the frame window over the whole active area with 3 mm of border, the frame
pilots and holes aligned, the cover held by the detents closed and open and
free between, stowed above the window's rim, the wordmark inside the cover's
band, the shutter bores open from the top face and from the cavity, the lead
routes open, the pod above the carrier, the stem positive, the retainer
passing its bore, the strap tunnels open under their skin, the signature
inside the plate clear of the track and the pins, the deck bare, every
print's overhang inside its named bridges, holes and pockets (each print
lists the places a face may point down past 45 degrees, a bridge, a hole
or a pocket where a support could not stand or its scar would never show;
anything down-facing outside them fails, with its position; a chamfer
counts only past 45 degrees, so every chamfer here is exactly 45) and on a
250 x 210 bed, the horizon above the track's lips with plate under the
grip, the battery bay with 10 % of swell, the foam's clamp on the stack, the horizon channel as the pry point, the strap coupon carrying a frame pilot, the frame off the glass, the gasket
groove on the glass's margin, open, and its squeeze over the stack's
tolerance, and every coupon one piece on the bed.

`node promote.mjs` validates the candidates, copies the five parts into
`print/`, the five coupons into `coupons/` and the report into `reports/`,
sweeps stale files and validates again. There is no independent scan yet; promote says so every run.

## Print plan

The print technician's settings for the owner's PETG, written down so the
first print is not a guess. 0.4 mm nozzle; 0.20 mm layers on the shell and the face, 0.10 on the frame
(every one of its heights is then a whole layer), 0.08 on the cover and the
button. Orientations are in the parts table, each with its preview, and in
`release-set.mjs`; they agree.

| | |
|---|---|
| supports | off, on every part. No part needs any: every down-facing surface is a bridge of 4.5 mm or less, a blind hole or a groove at the bed (the gate lists them per print, and anything else fails with its position). Supports here do damage: trees in the pin holes and the strap tunnels block them, trees in the gasket groove and the collar's recess fill a 0.9 and a 0.4 mm fit. If the slicer insists, set its overhang threshold so the 45 degree chamfers, the 49 degree groove flanks and the track lips' 48 degree undersides never trigger (faces steeper than 40 degrees from the bed unsupported) and keep bridge detection on |
| the shell's first 1.0 mm | in the face's filament (cobalt or cream), then a filament change at Z 1.00 (layer 6) to charcoal. The plate's front, the stow zone's floor, the lens bores' rims and the wall ends come out in the face's colour; the ribs start charcoal |
| filament changes | M600 or the slicer's change at a layer: the shell at Z 1.00 to charcoal; the cover at Z 2.00 (layer 26 at 0.08) to cream. On a single-extruder printer purge about 200 mm^3 by hand each time (the first cream layers on a 1.3 mm stroke come out grey; the mark's ten layers hide them) |
| elephant foot compensation | 0.2 mm (the chamfers are a second defence, not the first; it takes the detent bumps' first layer, which is why they are 1.0 tall) |
| seam | scarf, painted onto the bottom wall; the grooves hide a seam only where it is straight |
| bridges | fan 100 %, bridge speed 20 mm/s, thick bridges off: the strap tunnels, the LED slots, the frame's gasket groove |
| face | 40 % gyroid with six top layers (1.2 mm) and two 100 % modifier boxes, 128 x 24 x 3.2 over the horizon band (Y 18 to 42) and 100 x 42 x 3.2 round the window (X 0 to 100, Y 0 to 42) (100 % over 128 mm bowed at the corners and kept moving for weeks); top solid lines monotonic along X on the face, the horizon's floor and the cover's front, line width 0.42, flow +2 %; no ironing (PETG gums and the gloss goes uneven on cobalt); no modelled texture on the front (nothing under one layer exists, and a 0.2 relief reads as a sticker) |
| frame | 0.10 mm layers throughout (20 layers: the groove 0.8, the chamfers 1.2, 1.0 and 0.4, the pad 1.5 and the 2.0 plate are all whole layers; at 0.12 none was); bed 75 C, a 2 mm ring lifts at the corners at 65 |
| cover | charcoal to 2.00 mm, the bar's top face, then the flush to cream: the lip and the mark's raised layers print cream; both colourways; purge 200 mm^3; minimum layer time 10 s with the fan at 100 % (after Z 2.8 only the 20 x 1.5 lip is printing, 3 s a layer, and PETG slumps), or print the spare cover on the same plate; three perimeters make the 1.5 lip |
| seams | scarf, painted: the face's into the window's lower-left corner and into the horizon's left wall corner above it; the shell's into the left wall's horizon channel corner (vertical in print), not the bottom wall (the grooves hide a seam only on straight runs and it jumps at the USB and LED openings); the cover's into the edge-relief notch; the button's toward the rear |
| bed | 80 C under the shell, 70 to 75 under the plates; no brim (the chamfered bed edges are the brim's job) |
| cavity | 0.5 mm a side as modelled; do not scale the shell to fit, measure the coupon |
| the track lips | slow the overhang perimeters on layers 7 to 12 of the face (the lips' 47 degree undersides); their roughness comes out of the 0.4 of play |
| regenerating | after a number changes in `params.mjs`: `npm i manifold-3d` once in the repository root, then `node generate-carrier-body.mjs` and `node promote.mjs` in this folder; a failed gate names what moved |

Coupons before the full print, in `coupons/`, each cut from the real part
with a box so a fit proved on the coupon is the fit in the part; same print
orientation as the parent. Pass criteria, in numbers:

| Coupon | What it proves | You need | Pass | If not, the number |
|---|---|---|---|---|
| `KINO_COUPON_SHRINK_BAR` + `_POCKET` on one plate, first | the printer's shrink; the pinch ribs, the corner reliefs, the 7.5 bore | callipers; one camera module seated on its XIAO | the 100.0 mm bar measures 99.5 to 100.0 (set the slicer's shrink compensation, never scale the shell); a seated head pushes in with a thumb, does not fall out inverted, the lens centred in the bore by eye | `camBodySlack` (pocket), `lensBoreD` (bore) |
| `KINO_COUPON_PILLAR` + `_STRAP_SHELL`, second | a pillar foot's head pocket, a 1.9 pin hole, the strap tunnel and slots, a frame pilot | the carrier with a screw in one hole (or an M2 pan head in any scrap PCB), a 4.8 mm filament pin, 0.3 m of 2.5 mm cord, 10 kg, one M2 x 8 | the foot sits flat on the PCB with the pan head inside its pocket, no rock; the pin pushed 3 mm holds the coupon inverted and pulls with a finger; 100 N on the cord, no tear at the 1.2 mm skin; an M2 x 8 drives into the pilot and backs out ten times | `facePinD`, `carrierHeadClr`, `strapSlot`, `strapTunnelSkin`, `framePilotD` |
| the real `KINO_CARRIER_SHUTTER_BUTTON` then `KINO_COUPON_DECK`, third | the gabled bores, the 0.4 collar, the guide ribs | the printed button and the switch | the slicer preview shows the three 0.2 ribs; the plunger runs without tick and returns on the switch; the retainer passes the 17 bore | `shutterGuideRib` [0.4, 0.8] if the ribs vanish; `shutterFlangeBoreClear` 0.2 in reserve |
| the real `KINO_CARRIER_FACE` and `KINO_CARRIER_LENS_COVER`, fourth | the window, its lips, the detents, the pins' hold | the shell's plate or any flat plate; the six pins | the cover drops at 45 degrees of tilt and stays shut at 90, does not lift past the lips by hand, the cream mark clears the window's top rim; the face on its pins hangs face-down for an hour and takes a 10 N pull. If they pass they are the parts | `sliderClr`, `sliderBumpBite`, `facePinD` |
| the frame at 0.10, then the shell, last | | | | |

There is no face or cover coupon: a cut piece of the window ran the drop
test cocked on one lip, and the real parts cost 40 g. The field body's
`KINO_SLIDER_TRACK_COUPON` set the clearances this track reuses. Before any detent number moves, the hang test on the whole body:
the cover held closed through 1,000 jogs on the top cord.

## What ships

The entry is the files, the print plan, the coupons and this list; a strap
that is not supplied is a scored fault.

- Prints: shell (its first 1.0 mm in the face's filament), rear frame,
  face, cover, shutter button (plunger and retainer). Night body: charcoal, cobalt, pink, and cream for the
  mark's last layers and the lip (four spools). Day body: charcoal, cream,
  pink (three).
- Hardware: four M2 x 8 thread-forming pan-head screws (frame; the only
  screws in the body); the carrier's own four M2 8 mm male-female
  standoffs and four M2 x 4 pan heads (male into the P4's brass inserts;
  the P4 ships with them, add none; nothing from the body screws into a
  board); six pins cut from 1.75 mm filament, 4.8 mm; one 6 x 6 x 4.3
  tactile switch on an 80 mm lead ending in a JST XH 2-way housing for
  J103; 2 mm closed-cell foam with adhesive, 2 mm wide, two strips of
  101 mm and two of 60 mm for the frame's gasket groove, and the same
  again as spares; the cell for CN4 with its lead to J1001.
- Tools: a Phillips for M2; a 1.7 mm drill for the frame pilots' eleventh
  cycle.
- Cord: 2.5 mm braided, 1.2 m for the neck through the top slots, 0.3 m for
  the wrist through the bottom slots; a lark's head on the bar between the
  slots, inside the wall.
- Spares in the box: one cover (the wear part), one button, six pins,
  eight M2 x 8, the second set of foam strips. The frame pilots are thread-forming in PETG and
  are on the battery's path: count on about ten cycles, then the spare
  screws and a 1.7 drill.
- The body's contract with any future carrier: the lens row at the four
  `cameraXs` (22 mm pitch) and `lensY`; keep those and the face and cover
  files do not change when the shell does.
- Known and accepted: the camera charges lying on its back, with the LEDs
  down, because the carrier puts the USB-C on the bottom edge (the next
  carrier moves it); the horizon is an open shelf and the track is open at
  the bottom, so grit rides the cover across the lens fronts, as on the
  XA; cream and pink PETG yellow first in sun (the button is a 2 g
  reprint).

## Not in this cut

- "made for bad ideas." and any other line under 4 mm of cap height.
- The P4's TF slot opening (position unmeasured) and the C6 service header.
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
- `camStackH` 15.0 and the head size 8.5: the field body's `KINO_CAM_FIT_COUPON` and a caliper on a seated node.
- `facePinD` 1.9: the filament pins' fit in the wall ends and the face, on the pillar coupon; they must retain without glue.
- `shutterFlangeBoreClear` 0.3: the technician's number; the juror expects a rattle. The pod coupon says.
- The customer review's two items the carrier fixes, not the body: the USB-C and the three status lights are on the bottom edge because the carrier puts them there, so the camera charges lying on its back; a later carrier can move them.
- `activeCentred`: the active area centred on the PCB is still an assumption; the window has 1.0 mm a side.
- `camFovDeg` 78: the OV3660's real field is `MEASURE_REQUIRED`.
