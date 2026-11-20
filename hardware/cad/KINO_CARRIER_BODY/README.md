# KINO carrier body: a shell around the dev carrier D1 stack

Third body for the D4, and the first one that does not carry the electronics
itself. The dev carrier D1 ([`hardware/pcb/kino-d4-dev-carrier/`](../../pcb/kino-d4-dev-carrier/README.md),
issue #250) stacks on the P4's own inserts through 8 mm spacers, the four XIAOs
stand in sockets on it, and each camera module hangs off its XIAO on a short
soft ribbon. The carrier is the chassis. The shell holds the carrier by the
same four M2 screws that hold the stack and captures each camera head in a
pocket with pinch ribs, so the picture does not shake on its ribbon. The face
shell carries the form. Issue #252; seventh cut, nothing printed yet; the
night colourway (cobalt face) prints first.

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
| rear frame | 2.5 | -16.3 | chosen; the thumb climbs it to the glass, so its window edge is chamfered |
| P4 module, glass front to PCB back | 13.8 | 0.0 | OFFICIAL_CAD |
| P4 inserts | 3.3 | 3.3 | MEASURED |
| M2 spacers | 8.0 | 11.3 | the bench set; the J100 socket floats 0.3 mm off home |
| carrier PCB | 1.6 | 12.9 | |
| XIAO socket insulator | 8.5 | 21.4 | Wurth 61300711821 |
| XIAO male header insulator | 2.5 | 23.9 | **PROVISIONAL**: the headers soldered to the owner's XIAOs; the carrier's assembly print left this out |
| XIAO back face to the lens front | 15.0 | 38.9 | Seeed's assembled Sense stack |
| plate ahead of the lens | 1.5 | 40.4 | chosen; the shell's front |
| face | 6.0 | 46.4 | its edge an R3.5 pillow round; the horizon, the track and the roof over the stow zone are cut into it; nothing stands proud of it |
| **body** | **62.7** | | |

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
the diagonal, gated); 134.5 wide over the strap lug. The
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
| body in front: plate ahead of the lens 1.5, face 6.0 | 7.5 |
| body behind: the rear frame | 2.5 |
| **in all** | **62.7** |

The body is 10.0 mm of the 62.7; 4.5 of the face's 6.0 is the cover's track
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

## The parts, and the brand

ODD JOBS, as the brand's own camera concept draws it (`ODD JOBS/CAMERA 01`,
v18 and v6: a charcoal body with the layer texture on its walls, a cobalt or
cream fascia, a pink shutter, quiet lowercase markings, "made for bad
ideas"). Three filaments, each on its own part:

| File | What | Filament | Print |
|---|---|---|---|
| `print/KINO_CARRIER_SHELL.stl` | front plate with the four pockets (0.5 mm corner reliefs) and 7.5 mm bores, all four walls to the display plane with R10 plan corners, 0.5 mm V-grooves at 2.4 mm pitch round the whole body, the deck included, clear of the shutter collar and of the frame pilots; nothing engraved; four screw pillars, the shutter pod (every bore gabled, the collar too), the LED slots, the USB-C opening, the frame pilots, six countersunk pin holes in the walls' front ends, two strap tunnels inside the bottom wall's end under 0.6 mm of wall; the bores and the front edge chamfered 0.3 at the bed | charcoal | face down, PETG, 0.20 mm, no support (gated) |
| `print/KINO_CARRIER_REAR_FRAME.stl` | the 2.5 mm frame around the display, its outer edge rounded R1.5, 95.6 x 58.2 window with a 1.5 mm chamfer toward the rear, a thumb pad with three half-round ridges on the right border, the ODD JOBS symbol engraved 1 mm deep with a stepped edge on the left, four plain M2 holes (the pan heads sit proud, as the brand's concept shows its rear screws), four strap slots at the lower corners | charcoal | rear face UP |
| `print/KINO_CARRIER_FACE.stl` | the face: a 6.0 mm plate inset 0.8 mm from the shell's outline so a line of charcoal wall end frames it, its edge an R3.5 pillow round, its back edge chamfered 0.3; the horizon, a 1.5 mm groove edge to edge at the bar's height, its right end 2 mm deep as the grip; the cover's track cut below the groove; the face itself the roof over the stow zone, with a full-height slot for the cover's lip; four 7.5 mm cells; six countersunk pin holes in the back; the signature engraved 0.4 mm inside, mirrored (the symbol, "odd jobs", "kino D4") | cobalt (night) or cream (day) | back down, 100 % infill; the roof over the stow zone is a 1.5 mm plate bridging 16 mm |
| `print/KINO_CARRIER_LENS_COVER.stl` | the sliding cover, 86.8 x 16.5 x 2 with R3 corners, its back edge chamfered 0.3, "odd jobs" raised 0.8 (four layers at 0.2; the flush to CREAM at 1.5 mm on both colourways, so the lip prints cream too), a 1.5 mm lip on its top edge | charcoal, then cream | back down, 0.08 mm layers |
| `print/KINO_CARRIER_KEEPER.stl` | the block that refills the cover's entry gap under the track and is the track's stop, its back edges chamfered 0.3 | as the face | as laid; glued in after the cover is in |
| `print/KINO_CARRIER_SHUTTER_BUTTON.stl` | the plunger (14 mm cap with a convex R18 dome, 2 mm rim plus 1.4 of dome proud, the 16 mm flange chamfered at the bed, 0.3 a side in its bore) and the switch retainer (6 x 6 x 4.3 mm tactile switch) | pink | flange down, 0.08 mm layers |
| six pins | 1.75 mm filament cut 4.5 mm long into 2.0 mm holes countersunk 0.4: 3 into the wall end, 2 into the face | any | |

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
  and the thumb pushes it down. The strap is a cord through two slots in
  the frame's border at each lower corner into a tunnel inside the wall
  end: the shell's own wall between the slots is the bar it pulls on, so a
  drop loads the shell and not the frame's four screws; inside the outline,
  out of the palm. A left-handed body is a mirror of `shutterX` and the
  grip end, nothing else.
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
- **Layer texture.** 0.5 mm V-grooves at 2.4 mm pitch round the whole
  body, the deck included (in print the deck is a wall like the others),
  clear of the shutter collar; the first groove starts at Z -6.5 so no
  groove thins the wall round a frame pilot. 49 degree flanks, so the
  face-down print has no overhang. The body is one thing; the reveal line
  and the smooth cap are gone.
- **Not a box.** R10 plan corners (the carrier's square corner inside the
  wall caps it near R10.6), the face a pillow framed by a 0.8 mm line of
  charcoal, the shutter cap domed, the cover's corners R3, every tab and
  ear gone from the outline. The shell's front edge is on the bed, so its
  softness is the face's; the rear frame's round is R1.5, its screw holes
  2.55 mm from the edge.
- **Five reviews.** Cuts four to seven each answered a cold read: an
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
  grooves over the pilots' threads). Each is in ECN-0009 with what it
  changed. Not taken, four times: stowing the cover up; drop-to-open was
  settled on the bench.

### The face and the cover

The shell's front plate prints on the bed, so it can carry no relief; the
face does. It covers the front to 0.8 mm of the walls' outer edge, 6.0 mm
thick with its edge rounded R3.5 and its back edge chamfered 0.3 against
the elephant foot. Into it, from the front: the horizon, 1.5 mm deep across
the full width; below the groove's floor, the cover's track, 3.0 mm deep
(the cover 2.0, its raised mark 0.8 and 0.2 under the roof), its panel from
the entry gap at the bottom to 0.5 above the closed cover's top, with
1.25 mm of plate left under the relieved floor. The plate above the track
outside the groove is the roof over the stow zone, a 1.5 mm plate the
printer bridges across the 16 mm track (the technician's call: 1 mm sagged
onto the mark in his experience; the coupon decides). In the track:
dovetail lips on both walls, two detent pairs past the cover's R3 corners,
0.1 mm a side, the cover riding on two 2.5 mm lands. The four cells are
plain 7.5 mm bores: with the pupil 1.1 mm behind the lens face, the 82
degree field does not outgrow 7.5 mm inside this face, so the stepped
cones of the earlier cuts collapsed to the bore (a gate probes the true
cone through every part).

The cover drops 17.6 mm to shoot, from the groove down under the roof; the
travel is derived from the face's edge. 16.5 mm tall, it blankets the 7.5 mm
cells by 4.5 a side when closed and its top edge clears the field cone when
stowed. Both are gates, as is the closed cover blanketing every cell (the
firmware's cover-closed test needs all four dark). Its lip rides in a
24.6 mm slot through the roof that runs the roof's full height, from the
panel's bottom rim up into the groove, so every bridge line of the roof
lands on a wall at both ends (a slot that stopped short left free-ended
bridges); dropped, the bar shows through the slot.

The keeper refills the cover's entry gap in the plate below the track and
is the track's stop, flush with the face's front, in the face's filament,
glued in once the cover is in. The face is held by six 1.75 mm filament
pins in 2.0 mm holes countersunk 0.4 at every mouth (a 1.8 hole at a bed
face closed to 1.5 with the elephant foot), 3 mm into the walls' front ends
and 2 mm into its back (the two bottom pins sit outside the entry gap). They
locate; a bead of glue at the pins retains, if the face ever lifts.

Earlier drafts, each thrown out by a gate or a review: a rim pocket (the
face flush inside walls run past the plate: 10,000 mm^2 of overhang face
down); a proud face inside a flat margin (a lid on a tin); a 1 mm band rim
with rivet bosses over the pin holes; a glued apron plate over the stow
zone (a door that did nothing, and 0.6 mm proud by arithmetic).

### The shutter

The field body's pod and button, the cap grown to the brand's. A 24 mm
pilaster on the shell's top wall between the plate and the carrier (Z 14 to
35.7, 1.1 above the carrier), bore axis at Z 26.2, X 104: the plunger (14 mm
cap, 16 mm flange, 4.1 mm stem) comes out through a 20 mm collar in the top
face; the switch sits in a retainer cup pushed into the 17 mm access bore
from inside the cavity with the stack out; its two leads leave through
gabled channels either side and run down the cavity to J103 on the carrier.
Every bore has a teardrop roof pointing up in print, which is why the axis
sits 12 mm above the pod's bottom.

### Assembly

1. Plunger into the pod from the cavity, cap first, out through the top
   face: its 16 mm flange cannot pass the 14.6 mm guide, so it never goes in
   from the top. Then the switch into the retainer, the retainer into the
   pod from the rear behind the flange, leads out through the side channels.
2. Cover into the face's track from below, under the roof; keeper glued
   into the entry gap.
3. Six filament pins into the walls' front ends; face pressed on.
4. Stack the P4, spacers, carrier and nodes outside the body. Slide the stack
   into the shell from the rear, carrier first, until the carrier meets the
   four pillar feet. Face off, drive the four M2 screws through the shafts,
   through the pillar feet and the carrier, into the spacers. Face back on.
5. Frame onto the wall ends with four M2 x 8 thread-forming pan-head screws;
   the heads sit proud on the back.

The carrier's USB-C comes out through the bottom wall at the right; the three
edge LEDs show through three 2 x 4 mm slots beside it. The P4's own USB ports
are reached through the carrier's window only with the shell off.

Previews: `previews/KINO_CARRIER_NIGHT_*.png` (the print target) and
`DAY_*.png` are the colour views from `render-parts.py` (each part's STL in its filament's colour,
triangles split to 5 mm so the painter's order holds); the `*_PRINT.png` views
are each part in print orientation from `render-stl.py`.

## Gates

`node generate-carrier-body.mjs` writes `.candidate/` and runs 151 gates,
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
inside the plate clear of the track and the pins, the deck bare, and every
print support-free off the bed (each one's allowed bridges listed in its
gate; a chamfer counts only past 45 degrees, so every chamfer here is
exactly 45) and on a 250 x 210 bed.

`node promote.mjs` validates the candidates, copies the six parts into
`print/` and the report into `reports/`, sweeps stale files and validates
again. There is no independent scan yet; promote says so every run.

## Print plan

The print technician's settings for the owner's PETG, written down so the
first print is not a guess. 0.4 mm nozzle; 0.20 mm layers on the shell, the
frame and the face; 0.08 on the cover and the button.

| | |
|---|---|
| elephant foot compensation | 0.2 mm (the chamfers are a second defence, not the first) |
| seam | scarf, painted onto the bottom wall; the grooves hide a seam only where it is straight |
| bridges | fan 100 %, bridge speed 20 mm/s, thick bridges off: the roof over the track, the strap tunnels, the LED slots |
| face | 100 % infill, top solid lines monotonic along X so the horizon's floor has one grain |
| cover | charcoal to 1.5 mm, then the flush to cream: the lip and the mark's four raised layers print cream; both colourways |
| bed | 80 C under the shell, 65 under the plates; no brim (the chamfered bed edges are the brim's job) |
| cavity | 0.5 mm a side as modelled; do not scale the shell to fit, measure the coupon |

Coupons before the full print, each a few minutes: a 100 mm shrink bar (the
cavity clearance), one pillar with its screw stack and a pin in a 2.0 hole
(the pin fit), one camera pocket (the ribs and the corner reliefs against a
seated head), the cover's track with the roof (the sag and the 0.1 lips),
and the deck with the pod (the gabled bores and the collar). The field
body's `KINO_SLIDER_TRACK_COUPON` set the clearances this track reuses.

## Not in this cut

- "made for bad ideas." and any other line under 4 mm of cap height.
- The P4's TF slot opening (position unmeasured) and the C6 service header.
- An interference gate against the carrier's own part model
  (`outputs/D1-print.stl`): the dummy here carries the sockets, modules, the
  carrier's USB-C, the window and the battery bay, not the LINK headers, the
  XH housings or the test pads.
- Coupons before the full print: one pillar with its screw stack and pin, one
  camera pocket, the cover's track (the field body's
  `KINO_SLIDER_TRACK_COUPON` set the clearances this track reuses), the
  shutter pod.
- The serial and revision engraving, the face grain.
- The independent scan.

## Open inputs

Each one is a number in `params.mjs` and nothing else moves when it changes.

- `xiaoHeaderInsulator` 2.5: measure a soldered XIAO, socket top to board back.
- `p4CanH` 3.5: the P4 module can, and whatever else stands on the P4's back inside the bay rectangle (CN4, the C6 module).
- `spacer` 8.0 with the socket home: the carrier README's bench step says 7.7 expected.
- `camStackH` 15.0 and the head size 8.5: the field body's `KINO_CAM_FIT_COUPON` and a caliper on a seated node.
- `facePinD` 2.0: the filament pins' fit in the wall ends and the face, on the pillar coupon.
- The customer review's two items the carrier fixes, not the body: the USB-C and the three status lights are on the bottom edge because the carrier puts them there, so the camera charges lying on its back; a later carrier can move them.
- `activeCentred`: the active area centred on the PCB is still an assumption; the window has 1.0 mm a side.
- `camFovDeg` 78: the OV3660's real field is `MEASURE_REQUIRED`.
