# KINO carrier body: a shell around the dev carrier D1 stack

Third body for the D4, and the first one that does not carry the electronics
itself. The dev carrier D1 ([`hardware/pcb/kino-d4-dev-carrier/`](../../pcb/kino-d4-dev-carrier/README.md),
issue #250) stacks on the P4's own inserts through 8 mm spacers, the four XIAOs
stand in sockets on it, and each camera module hangs off its XIAO on a short
soft ribbon. The carrier is the chassis. The shell holds the carrier by the
same four M2 screws that hold the stack and captures each camera head in a
pocket with pinch ribs, so the picture does not shake on its ribbon. The face
shell carries the form. Issue #252; eleventh cut, nothing printed yet; the
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
| rear frame | 2.5 | -16.7 | chosen; the thumb climbs it to the glass, so its window edge is chamfered |
| glass clearance | 0.4 | -14.2 | chosen; the frame never touches the glass; a foam gasket in the frame's groove takes the stack's tolerance and holds the module |
| P4 module, glass front to PCB back | 13.8 | 0.0 | OFFICIAL_CAD |
| P4 inserts | 3.3 | 3.3 | MEASURED |
| M2 spacers | 8.0 | 11.3 | the bench set; the J100 socket floats 0.3 mm off home |
| carrier PCB | 1.6 | 12.9 | |
| XIAO socket insulator | 8.5 | 21.4 | Wurth 61300711821 |
| XIAO male header insulator | 2.5 | 23.9 | **PROVISIONAL**: the headers soldered to the owner's XIAOs; the carrier's assembly print left this out |
| XIAO back face to the lens front | 15.0 | 38.9 | Seeed's assembled Sense stack |
| plate ahead of the lens | 1.5 | 40.4 | chosen; the shell's front |
| face | 6.4 | 46.8 | its edge a 2 mm 45 degree chamfer; the horizon, the track and the roof over the stow zone are cut into it; nothing stands proud of it but the cover's 1.5 mm lip |
| **body** | **63.5** | | |

The module's PCB face is the Z datum for the camera, as in the field body: it
lands on the plate's inner face at Z 35.4 (the Sense board's top is at 31.5, so
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
| body in front: plate ahead of the lens 1.5, face 6.4 | 7.9 |
| body behind: the rear frame 2.5 and its 0.4 off the glass | 2.9 |
| **in all** | **63.5** |

The body is 10.8 mm of the 63.5; 4.9 of the face's 6.4 is the cover's track
and the groove it sits in. The one stack term that is a bench choice
is the XIAO connectors: the eight 1x07 sockets are hand-fit, so 4.3 mm
low-profile strips in place of the 8.5 mm Wurth part, and XIAOs soldered on
bare pins without the 2.5 mm insulator, would take up to 6.7 mm out of the
camera; `socketH` and `xiaoHeaderInsulator` are the two numbers. The J100
socket fixes the 11.3 mm layer.

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

## The P4, held without its screws

The P4's four inserts carry the carrier's standoffs, so the module cannot
be screwed to the body as it was in the field body. It is held three ways,
none of them a screw into it:

- Forward, by the stack: the standoffs in its inserts, the carrier on them,
  the carrier against the pillar feet, the four stack screws.
- Backward, by the rear frame through a gasket. The frame's inner face
  stands 0.4 mm behind the glass front (a gate: a rigid PETG frame never
  touches glass) and carries a 2 mm closed-cell foam strip, 1.5 mm wide, in
  a 0.9 mm groove round the window, on the glass's margin: 2 mm outside the
  window past its chamfer, 0.8 mm inside the module's edge. The four frame
  screws squeeze the foam to 1.3 mm (35 %; 20 to 50 % over +-0.3 mm of
  stack tolerance, a gate). The 114 x 67 module hangs 26 mm past its
  standoffs in X; the foam carries that overhang, so a thumb on the glass
  loads foam and not the inserts, nothing rattles, and the window is sealed
  against dust.
- In plan, by the standoffs on the carrier, which the pillar feet locate;
  the cavity wall is 2.5 mm from the module's edge. Nothing in the cavity
  can reach the module: the carrier sweeps in from the rear past every
  plane the module occupies, so a ledge under it is impossible.

Foam: 2 mm closed-cell PE or EVA with adhesive on one side (a 3M 4000-series
tape cut to 1.5 mm, or sheet), four strips butted at the corners, stuck into
the groove before the frame goes on (`previews/KINO_CARRIER_REAR_FRAME_INNER.png`
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
| `print/KINO_CARRIER_SHELL.stl` | front plate with the four pockets (0.5 mm corner reliefs) and 7.5 mm bores, all four walls to the display plane with R10 plan corners, 0.5 mm V-grooves at 2.4 mm pitch round the whole body, the deck included whole (one 1.5 mm smooth ring round the collar), clear of the frame pilots; nothing engraved; the horizon carried round the left wall only; four screw pillars, the shutter pod (every bore gabled; the collar a 0.4 mm round shadow line), the LED slots, the USB-C opening, the frame pilots, six countersunk pin holes in the walls' front ends, four strap tunnels inside the top and bottom walls' ends under 0.6 mm of wall, the keeper's foot pocket in the plate's front under the face, three ribs in the shutter's guide bore; the bores, the front edge and the rear edge chamfered 0.4 | charcoal | face down, PETG, 0.20 mm, no support (gated) |
| `print/KINO_CARRIER_REAR_FRAME.stl` | the 2.5 mm frame around the display, a 0.9 mm gasket groove in its inner face round the window (the P4 is held by 2 mm foam in it), its outer edge chamfered 1.2 toward the rear and 0.4 toward the shell (the joint is a drawn V on the groove rhythm), 95.6 x 58.2 window with a 1.5 mm chamfer toward the rear, a thumb pad with 1.0 x 0.6 grooves over the whole right border (X 109.5 to 121), the ODD JOBS symbol engraved 1 mm deep with a stepped edge on the left, four plain M2 holes (the pan heads sit proud, as the brand's concept shows its rear screws), eight 3.0 x 2.4 strap slots, two at each corner | charcoal | rear face UP, 0.12 mm |
| `print/KINO_CARRIER_FACE.stl` | the face: a 6.4 mm plate inset 0.8 mm from the shell's outline so a line of charcoal wall end frames it, its front edge a 2 mm 45 degree chamfer, its back edge chamfered 0.4; the horizon, a 1.5 mm groove edge to edge at the bar's height with its lips chamfered 0.8 above and 0.4 below, its right end 3.5 mm deep as the grip; the cover's track cut below the groove; the face itself the roof over the stow zone, with a full-height slot for the cover's lip, right of the wordmark; four 7.5 mm cells with a 0.8 mm rim; six countersunk pin holes in the back; the signature engraved 0.4 mm inside, mirrored (the symbol, "odd jobs", "kino D4") | cobalt (night) or cream (day) | back down, 40 % gyroid with 100 % under the horizon and the track; the roof over the stow zone is a 1.5 mm plate bridging 16 mm |
| `print/KINO_CARRIER_LENS_COVER.stl` | the sliding cover, 86.8 x 16.5 x 2 with R3 corners, its back edge chamfered 0.4, "odd jobs" raised 0.8 (the flush to CREAM at 2.00 mm, the bar's top face, on both colourways; the lip prints cream too), a 20 x 1.5 lip with a 0.4 mm root on its top edge from 45 to 65 mm off the bar's left end, 1.5 proud of the face | charcoal, then cream | back down, 0.08 mm layers |
| `print/KINO_CARRIER_KEEPER.stl` | the block that refills the cover's entry gap through the whole plate under the track and is the track's stop, cut from the face's own solid so the edge chamfer runs through it, with a 0.9 x 1.1 foot on its back that sits in a pocket in the shell's plate under the face: captive, no glue, so the cover is a serviceable part | as the face | front down, the foot up |
| `print/KINO_CARRIER_SHUTTER_BUTTON.stl` | the plunger (14 mm flat cap with a 0.5 mm 45 degree edge, 2 mm proud of the deck, the 16 mm flange chamfered at the bed, 0.15 a side in its bore, the cap running on three 0.2 mm ribs in the guide) and the switch retainer (6 x 6 x 4.3 mm tactile switch) | pink | flange down, 0.08 mm layers |
| six pins | 1.75 mm filament cut 4.5 mm long into 1.9 mm holes countersunk 0.4: 3 into the wall end, 2 into the face; they locate and retain, no glue | any | |

Where it comes from, and what each thing is for:

- **The horizon.** One line is cut across the face, edge to edge, at the
  bar's height, its ends open through the pillow round. The bar sits in it;
  the face is built around the line, and the lens row's position (fixed low
  and left by the stack) becomes a position on that line rather than a
  misalignment. The jury's one move.
- **The hand.** The right hand holds the right end (the on-device UI is laid
  out for it: `firmware/UI_DIRECTION.md`). The pink shutter is on the top deck
  at X 104 under the index finger; the grip is the horizon's right end cut
  2 mm deep, so the middle finger pulls against its wall; the thumb pad
  stands 1.5 mm off the rear frame's right border with three ridges, and the
  window's edge is chamfered so the thumb slides onto the glass's edge
  targets. The cover is a LEFT-hand action: its lip is at the top of the bar
  and the thumb pushes it down; its lip stands 1.5 mm proud, a sill you can
  see from across the room, as the XA's and the Minox's, and a glove or a
  dry thumb can lift it closed. The grip is 3.5 mm
  deep, a wall for the middle finger (2 mm was a fingertip's edge), and the
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
  landed bar, and it carries the brand; dropped, it slides under the face
  (the plate above the track is the roof over the stow zone) and the four
  cells show in the line, the UI's four-mark. Only the lip shows, in its
  slot, as the thumb's cue. No door, no apron: the face is the door.
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
  (2 mm), the frame's rear edge (1.2), the horizon's two lips (0.8 and
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
face does. It covers the front to 0.8 mm of the walls' outer edge, 6.4 mm
thick with its front edge a 2 mm 45 degree chamfer and its back edge
chamfered 0.4 against the elephant foot. Into it, from the front: the
horizon, 1.5 mm deep across the full width, its upper lip chamfered 0.8 and
its lower 0.4 so the line catches light from every angle (a flat-floored
slot had no highlight and the jury's one move was invisible from the
front), its right end 3.5 deep as the grip; below the groove's floor, the
cover's track, 3.4 mm deep (the cover 2.0, its raised mark 0.8 and 0.6
under the roof), its panel from the entry gap at the bottom to 0.5 above
the closed cover's top, with 1.25 mm of plate left under the relieved
floor (the relief is 0.25 mm cut into the plate between two 2.5 mm lands;
the first nine cuts cut it upward into the track's own void, so the lands
were 0.01 mm and the cover dragged on the whole floor; a gate now probes
the relief and a land). The plate above the track outside the groove is
the roof over the stow zone, 1.5 mm thick (the technician's call: 1 mm
sagged onto the mark in his experience; 0.6 under it after the generalist
jury found the mark riding on the sag; the coupon decides). In a back-down
print that roof is a plate with both of its Y edges free, the entry gap
below it and the horizon above, and the lip slot through it: two flaps
hanging 45 and 21 mm from one wall each, not a bridge, and a slicer would
fill the track with tree supports and scar the roof's underside and the
floor the cover rides on. So the print file carries five breakaway
blades, 0.8 mm wide, standing on the relieved band off the lands, one
within 0.2 mm of each edge of the lip slot, rising to one layer (0.2 mm)
under the roof: the roof's lines bridge 10 to 16 mm onto them (gated:
every span, a blade at each slot edge, the witness leaving the mark 0.4).
Each blade stands on a one-line neck and snaps out through the entry gap
before the keeper goes in; the stubs sit 0.25 below the lands, where the
cover never touches, and the witness is on a ceiling nothing rides on.
They are in `KINO_CARRIER_FACE.stl` and the track coupon only; the
previews show the part. In the track: dovetail lips on both walls, two
detent pairs past the cover's R3 corners, 0.1 mm a side, the cover riding
on the two lands. The four cells are
plain 7.5 mm bores with a 0.8 mm 45 degree rim at the mouth, so they read
as eyes and not as a microphone array: with the pupil 1.1 mm behind the
lens face, the 82 degree field does not outgrow 7.5 mm inside this face,
so the stepped cones of the earlier cuts collapsed to the bore (a gate
probes the true cone through every part).

The cover drops 17.6 mm to shoot, from the groove down under the roof; the
travel is derived from the face's edge. 16.5 mm tall, it blankets the 7.5 mm
cells by 4.5 a side when closed and its top edge clears the field cone when
stowed. Both are gates, as is the closed cover blanketing every cell (the
firmware's cover-closed test needs all four dark). Its lip, 20 mm wide
with a 0.4 mm root, from 45 to 65 mm off the bar's left end and 1.5 mm
proud of the face (a thumb needs 16; at 30 the open slot read as a mouth;
at 1.0 a glove could not lift it), rides in a 21 mm slot through the roof that runs the roof's full height,
from the panel's bottom rim up into the groove (the roof's bridge lines
run across the slot's edges onto the blades beside them); dropped, plain
bar shows through the slot, never a letter (the wordmark ends at 36 mm;
the seventh cut's centred slot showed the "s").

The keeper refills the cover's entry gap, which now runs through the
whole plate below the track, and is the track's stop, cut from the face's
own solid so the edge chamfer runs through it, in the face's filament. No
glue: a 0.9 x 1.1 mm foot on its back, under the plate above the gap, sits
in a pocket in the shell's plate; the face traps it forward, the pocket
holds it down and back. The cover is the wear part, and it comes out: six
pins, face off, keeper lifts, cover drops. The foot's underside slopes 47
degrees back to the body, so the keeper prints front down with the foot
up and hangs nothing. The face is held by six 1.75 mm filament
pins in 1.9 mm holes countersunk 0.4 at every mouth (a 1.8 hole at a bed
face closed to 1.5 with the elephant foot; 2.0 with the countersink and the
0.2 compensation did not retain), 3 mm into the walls' front ends and 2 mm
into its back (the two bottom pins sit outside the entry gap). They locate
and retain; there is no glue anywhere in the body. The pillar coupon sets
the hole.

Earlier drafts, each thrown out by a gate or a review: a rim pocket (the
face flush inside walls run past the plate: 10,000 mm^2 of overhang face
down); a proud face inside a flat margin (a lid on a tin); a 1 mm band rim
with rivet bosses over the pin holes; a glued apron plate over the stow
zone (a door that did nothing, and 0.6 mm proud by arithmetic).

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

1. Plunger into the pod from the cavity, cap first, out through the top
   face: its 16 mm flange cannot pass the 14.6 mm guide, so it never goes in
   from the top. Then the switch into the retainer, the retainer into the
   pod from the rear behind the flange, leads out through the side channels.
2. Cover into the face's track from below through the entry gap, up under
   the roof to its detent.
3. Six filament pins into the walls' front ends; keeper into its pocket in
   the plate, foot down; face pressed on over it, the keeper's body rising
   into the gap. To service the cover, reverse: face off, keeper out, cover
   drops.
4. Stack the P4, spacers, carrier and nodes outside the body. Slide the stack
   into the shell from the rear, carrier first, until the carrier meets the
   four pillar feet. Face off, drive the four M2 screws through the shafts,
   through the pillar feet and the carrier, into the spacers. Face back on.
5. Four foam strips into the frame's groove, adhesive to the frame. Frame
   onto the wall ends with four M2 x 8 thread-forming pan-head screws; the
   heads sit proud on the back. The screws squeeze the foam onto the
   glass's margin: that is what holds the P4.

The carrier's USB-C comes out through the bottom wall at the right; the three
edge LEDs show through three 2 x 4 mm slots beside it. The P4's own USB ports
are reached through the carrier's window only with the shell off.

Previews: `previews/KINO_CARRIER_NIGHT_*.png` (the print target) and
`DAY_*.png` are the colour views from `render-parts.py` (each part's STL in its filament's colour,
triangles split to 5 mm so the painter's order holds); the `*_PRINT.png` views
are each part in print orientation from `render-stl.py`.

## Gates

`node generate-carrier-body.mjs` writes `.candidate/` and runs 180 gates,
throwing on the first failure (`KINO_SOFT_GATES=1` collects them): the depth
chain re-added over the lens band, the lens front on the pocket floor, the
module PCB with the plate to land on, the battery bay tall enough for the cell
and clear of the spacers and the outline, each part one solid (the pins four,
the button two), the face on the shell and the electronics dummy clear of
every part with only the pinch ribs inside the nominal heads, every pocket
open with its ribs standing, the field cone (bore then cone, two probes) clear
of the shell, the face and the stowed cover at every station, the closed
cover blanketing every cell, the driver shaft and screw bore at every pillar,
every pillar foot standing on the carrier inside its 7 mm keep-out, every pin
hole open and blind, the carrier's sweep from the rear clear up to the feet
with the pod above it, the USB plug and the LED slots through the bottom wall,
the frame window over the whole active area with 3 mm of border, the frame
pilots and holes aligned, the cover held by the detents closed and open and
free between, stowed above the panel's rim, the keeper filling the gap and
sitting under the stowed cover as its stop, the wordmark inside the cover's
band, the shutter bores open from the top face and from the cavity, the lead
routes open, the pod above the carrier, the stem positive, the retainer
passing its bore, the strap tunnels open under their skin, the signature
inside the plate clear of the track and the pins, the deck bare, every
print's overhang inside its named bridges, holes and pockets (each print
lists the places a face may point down past 45 degrees, a bridge, a hole
or a pocket where a support could not stand or its scar would never show;
anything down-facing outside them fails, with its position; a chamfer
counts only past 45 degrees, so every chamfer here is exactly 45) and on a
250 x 210 bed, the cover on two lands over a relieved floor, each roof
blade in the band off the lands with its layer of air, the roof's spans
and the blades at the slot's edges, the witness clear of the mark, the
battery bay with 10 % of swell, the keeper's stop face under the stowed
cover with its foot behind the face, the frame off the glass, the gasket
groove on the glass's margin, open, and its squeeze over the stack's
tolerance, and every coupon one piece on the bed.

`node promote.mjs` validates the candidates, copies the six parts into
`print/`, the nine coupons into `coupons/` and the report into `reports/`,
sweeps stale files and validates again. There is no independent scan yet; promote says so every run.

## Print plan

The print technician's settings for the owner's PETG, written down so the
first print is not a guess. 0.4 mm nozzle; 0.20 mm layers on the shell, the
frame and the face; 0.08 on the cover and the button.

| | |
|---|---|
| supports | off, on every part. No part needs any: every down-facing surface is a bridge of 4.5 mm or less, a blind hole, a pocket at the bed, or the roof on its blades (the gate lists them per print, and anything else fails). Supports here do damage: trees in the track scar the roof and the floor the cover rides on, trees in the pin holes and the strap tunnels block them, trees in the keeper's pocket and the collar's recess fill a 0.9 and a 0.4 mm fit. If the slicer insists, set its overhang threshold so the 45 degree chamfers and the 49 degree groove flanks never trigger (faces steeper than 40 degrees from the bed unsupported) and keep bridge detection on; tree supports painted on by hand are allowed under the face's roof only, and the blades make them unnecessary |
| the face's roof | five breakaway blades are in the STL, in the track under the roof; after the print, snap each out through the entry gap (pull toward the gap; the neck is one line), before the keeper goes in. Check the roof's underside is clean over the slot's edges and the floor's lands are untouched |
| elephant foot compensation | 0.2 mm (the chamfers are a second defence, not the first) |
| seam | scarf, painted onto the bottom wall; the grooves hide a seam only where it is straight |
| bridges | fan 100 %, bridge speed 20 mm/s, thick bridges off: the roof over the track, the strap tunnels, the LED slots |
| face | 40 % gyroid with six top layers (1.2 mm) and 100 % modifier volumes under the horizon and the track (100 % over 128 mm bowed at the corners and kept moving for weeks; 40 g lighter); top solid lines monotonic along X on the face, the horizon's floor, the keeper and the cover's front, line width 0.42, flow +2 %; no ironing (PETG gums and the gloss goes uneven on cobalt); no modelled texture on the front (nothing under one layer exists, and a 0.2 relief reads as a sticker) |
| keeper | front down, the foot up, 0.20 mm |
| frame | 0.12 mm layers throughout (21 layers; the 1.2 chamfer steps 0.12) |
| cover | charcoal to 2.00 mm, the bar's top face, then the flush to cream: the lip and the mark's four raised layers print cream; both colourways; purge 120 mm^3 (the first cream layers on a 1.3 mm stroke come out grey) |
| seams | scarf, painted: the face's into the inside corner of the entry gap below the track and into the horizon's left wall corner above it; the shell's into the left wall's horizon channel corner (vertical in print), not the bottom wall (the grooves hide a seam only on straight runs and it jumps at the USB and LED openings); the cover's into the edge-relief notch; the button's toward the rear |
| bed | 80 C under the shell, 65 under the plates; no brim (the chamfered bed edges are the brim's job) |
| cavity | 0.5 mm a side as modelled; do not scale the shell to fit, measure the coupon |

Coupons before the full print, in `coupons/`, each cut from the real part
with a box so a fit proved on the coupon is the fit in the part; same print
orientation as the parent. Pass criteria, in numbers:

| Coupon | What it proves | Pass |
|---|---|---|
| `KINO_COUPON_SHRINK_BAR` | the printer's shrink | 100.0 mm bar measures 99.5 to 100.0; set the slicer's compensation, never scale the shell |
| `KINO_COUPON_PILLAR` | the screw stack and a 1.9 pin hole | M2 drives into the spacer by hand; a 1.75 pin pushed 3 mm holds the coupon inverted and pulls with a finger |
| `KINO_COUPON_POCKET` | the pinch ribs, the corner reliefs, the 7.5 bore | a seated head pushes in with a thumb, does not fall out inverted, the lens centred in the bore by eye |
| `KINO_COUPON_TRACK_FACE` + `_COVER` + `_KEEPER` | the track, the roof on three of its blades, the lip slot, the detents, the keeper's foot | the three blades snap out through the gap without lifting a land; the roof's underside is flat to 0.3 between them (the mark clears it); the cover drops at 45 degrees of tilt and stays shut at 90; the keeper's foot clicks into the pocket coupon of the plate (print `KINO_COUPON_PILLAR`'s plate face against it) |
| `KINO_COUPON_DECK` | the gabled bores, the 0.4 collar, the guide ribs | the plunger runs without tick and returns on the switch; the retainer passes the 17 bore |
| `KINO_COUPON_STRAP_SHELL` + `_FRAME` | the tunnel and slots | 100 N on a 2.5 mm cord, no tear at the 0.6 skin |

The field body's `KINO_SLIDER_TRACK_COUPON` set the clearances this track
reuses. Before any detent number moves, the hang test on the whole body:
the cover held closed through 1,000 jogs on the top cord.

## What ships

The entry is the files, the print plan, the coupons and this list; a strap
that is not supplied is a scored fault.

- Prints: shell, rear frame, face, cover, keeper, shutter button (plunger
  and retainer). Night body: charcoal, cobalt, pink, and cream for the
  mark's last layers and the lip (four spools). Day body: charcoal, cream,
  pink (three).
- Hardware: four M2 x 8 thread-forming pan-head screws (frame); the four
  M2 stack screws and 8 mm spacers from the carrier's BOM; six pins cut
  from 1.75 mm filament, 4.5 mm; one 6 x 6 x 4.3 tactile switch and two
  leads to J103; 2 mm closed-cell foam with adhesive, cut to 1.5 mm strips,
  340 mm, for the frame's gasket groove.
- Cord: 2.5 mm braided, 1.2 m for the neck through the top slots, 0.3 m for
  the wrist through the bottom slots; a lark's head on the bar between the
  slots, inside the wall.
- Spares in the box: one cover (the wear part), one button, one keeper,
  six pins, eight M2 x 8. The frame pilots are thread-forming in PETG and
  are on the battery's path: count on about ten cycles, then the spare
  screws and a 1.7 drill.
- The body's contract with any future carrier: the lens row at the four
  `cameraXs` (22 mm pitch) and `lensY`; keep those and the face, cover and
  keeper files do not change when the shell does.
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
- Slicer profiles per part as files, and a per-part time and mass table.
- A print of the face with the blades: whether five 0.8 mm blades on a
  one-line neck snap clean in PETG or need a notch, and whether 16 mm
  bridges between them sag under 0.3 at full fan. The track coupon decides;
  the fallback is a blade every 10 mm.
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
