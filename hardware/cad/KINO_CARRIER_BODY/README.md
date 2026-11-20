# KINO carrier body: a shell around the dev carrier D1 stack

Third body for the D4, and the first one that does not carry the electronics
itself. The dev carrier D1 ([`hardware/pcb/kino-d4-dev-carrier/`](../../pcb/kino-d4-dev-carrier/README.md),
issue #250) stacks on the P4's own inserts through 8 mm spacers, the four XIAOs
stand in sockets on it, and each camera module hangs off its XIAO on a short
soft ribbon. The carrier is the chassis. The shell holds the carrier by the
same four M2 screws that hold the stack and captures each camera head in a
pocket with pinch ribs, so the picture does not shake on its ribbon. The face
shell carries the form. Issue #252; second cut, nothing printed yet.

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
| face | 3.5 | 43.9 | its edge an R3.5 pillow round; the cover's track is cut into it |
| lens band rim | 1.0 | 44.9 | |
| **body, over the band** | **61.2** | | 63.5 over the grip's ribs, 64.1 over the apron |

The module's PCB face is the Z datum for the camera, as in the field body: it
lands on the plate's inner face at Z 35.4 (the Sense board's top is at 31.5, so
the 3.5 mm module PCB has 0.4 mm of fold behind it), the 8.5 mm head sits in a
3.5 mm pocket with 0.2 mm pinch ribs on two walls pushing it onto the other two,
and the lens front is the pocket floor. If the real header insulator is not
2.5 mm, every Z above the socket moves by the difference and the plate must
move with it; `xiaoHeaderInsulator` in `params.mjs` is the one number to change.

Plan: the carrier's 118.40 x 70.80 outline plus 0.3 mm a side of cavity plus
4.5 mm walls, 128.0 x 80.4 mm, R10 corners (the most the plan allows: the
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
| body in front: plate ahead of the lens 1.5, face 3.5, band rim 1.0 | 6.0 |
| body behind: the rear frame | 2.5 |
| **over the band** | **61.2** |

The body is 8.5 mm of the 61.2. The one stack term that is a bench choice
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
| `print/KINO_CARRIER_SHELL.stl` | front plate with the four pockets and bores, all four walls to the display plane with R10 plan corners, 0.5 mm V-grooves at 2.4 mm pitch around the side and bottom walls under a deck reveal, "odd jobs" engraved on the deck, four screw pillars, the shutter pod, two rounded strap tabs at the lower rear corners, the LED slots, the USB-C opening, the frame pilots, six pin holes in the walls' front ends | charcoal | face down, PETG, 0.20 mm, no support (gated) |
| `print/KINO_CARRIER_REAR_FRAME.stl` | the 2.5 mm frame around the display, its outer edge rounded R1.5, 95.6 x 58.2 window with a 1.5 mm chamfer toward the rear, a raised thumb pad with grooves on the right border, the ODD JOBS symbol engraved on the left, four plain M2 holes (the pan heads sit proud, as the brand's concept shows its rear screws) | charcoal | rear face UP |
| `print/KINO_CARRIER_FACE.stl` | the face: a 3.5 mm plate over the whole front, the walls' ends included, its edge an R3.5 pillow round; the lens band, a 1 mm pill-ended rim around the cover's track cut into the plate, with four stepped cells; the grip, a 2.5 mm pad on the right with the finger ribs on it; six pin holes in the back | cream (day) or cobalt (night) | back down |
| `print/KINO_CARRIER_LENS_COVER.stl` | the sliding cover, 86.8 x 16.5 x 2 with R3 corners, the kino D4 wordmark raised 0.6 (print those last layers in the face's filament), a 3 mm lip on its top edge | charcoal | back down |
| `print/KINO_CARRIER_APRON.stl` | the door over the stow zone: a 1 mm plate across the band's lower half, with the block that refills the cover's entry gap and is the track's stop | as the face | plate face down; glued in after the cover is in |
| `print/KINO_CARRIER_SHUTTER_BUTTON.stl` | the plunger (14 mm cap with a convex R18 dome, 2 mm rim plus 1.4 of dome proud) and the switch retainer (6 x 6 x 4.3 mm tactile switch) | pink | flange down |
| six pins | 1.75 mm filament cut 4.5 mm long: 3 into the wall end, 2 into the face | any | |

Where it comes from, and what each thing is for:

- **The hand.** The right hand holds the right end (the on-device UI is laid
  out for it: `firmware/UI_DIRECTION.md`). The pink shutter is on the top deck
  at X 104 under the index finger; the grip is a 2.5 mm pad on the face's
  right with 0.8 mm ribs, under the middle finger, so a stranger's hand lands
  in the same place and off the lens row; the thumb pad stands 1.2 mm off the
  rear frame's right border beside the glass, and the window's edge is
  chamfered so the thumb slides onto the glass's edge targets instead of
  climbing a wall. The cover is a LEFT-hand action: its lip is at the top of
  the bar and the thumb pushes it down. The strap tabs are at the lower rear
  corners, out of the palm (the first one sat under the heel of the hand); a
  wrist loop on the right one, a neck strap on both. A left-handed body is a
  mirror of `shutterX`, the pads and the deck mark, nothing else.
- **The four-mark.** The band is the camera's identity. The cover closed is
  one dark bar across the cream face, the UI's landed bar; dropped, the four
  cells show, the UI's four-mark. The cover is charcoal so the bar reads, and
  its corners are R3 so the bar is not a square inside a pill. The apron
  roofs the stow zone, so closed the front is a bar over a door and never an
  empty pocket; dropped, the cover slides under the door and only its lip
  shows.
- **Colour is an event.** Charcoal and cream (or cobalt) at rest; the one
  pink thing is the button you press. No other colour on the body.
- **One mark per face.** "kino D4" on the cover, 52 x 7 mm, raised 0.6 with
  its last layers printed in the face's filament so the bar carries the name
  in contrast (a filament change at that height; strokes about 0.8 mm, one
  nozzle line and a margin, gated). "odd jobs" (traced from the logo by
  `brand/trace-wordmark.py`, 22 mm) engraved 0.5 deep on the top deck left
  of the shutter, read from behind the camera, the way the brand's concept
  carries its maker plate. The symbol engraved on the back. "made for bad
  ideas." is not on this body: at a size the brand would set it, its strokes
  are under one nozzle line.
- **Layer texture.** 0.5 mm V-grooves at 2.4 mm pitch around the side and
  bottom walls, parallel to the layers, stopped 8 mm short of the top under
  a reveal line so the deck reads as a cap. 49 degree flanks, so the
  face-down print has no overhang. 0.25 mm at 1.6 was three layers deep, at
  PETG's own ripple.
- **Not a box.** The owner's call on the first ODD JOBS render. The plan
  corners went to R10, the face to a full-front pillow with an R3.5 round,
  the band pill-ended, the shutter cap domed, the strap tabs rounded about
  their holes. The plan corner cannot pass about R10.6 with the carrier's
  square corner inside the wall, and the shell's front edge is on the bed, so
  its softness is the face's. The rear frame's round is R1.5: its screw holes
  sit 2.55 mm from the edge and a bigger round broke out through them.
- **What the reviews changed.** Two cold reads of the fourth cut, one by an
  engineer and one as a customer (2026-11-20): the empty stow pocket under
  the closed bar ("a part fell out"), the two rivet domes with no story, the
  tone-on-tone marks, no place for the hand, the strap under the palm, a
  2.5 mm press fit holding the face, 0.4 mm pinch ribs, grooves at
  layer-noise depth, the thumb climbing a wall to the glass. The apron, the
  grip, the contrast wordmark, the filament pins in the wall ends, the
  triangular ribs, the corner tabs, the chamfered window and the 0.5 mm
  grooves are those answers. One suggestion was not taken: stowing the cover
  UP, which would centre the band; drop-to-open was settled on the bench
  coupon and the empty pocket exists in either direction. The apron is the
  fix.

### The face and the cover

The shell's front plate prints on the bed, so it can carry no relief; the
face does. It covers the whole front, the walls' ends included, 3.5 mm thick
with its edge rounded over the full thickness. The cover's track is a 2.2 mm
panel cut into the plate (1.2 of plate left under the relieved floor), ringed
by the band, a 1 mm pill-ended rim chamfered 1.5, from X 3.2 to 97.2, its
bottom at the inner edge of the face's round. In the track: dovetail lips on
both walls, two detent pairs past the cover's R3 corners, 0.1 mm a side, the
cover riding on two 2.5 mm lands. The four cells are two stepped cones cut
from the 82 degree field cone (pupil 1.1 mm behind the lens face), 14 mm at
the panel floor, rings 0.6 mm proud of the cone. The band's R9 corners keep
1.1 mm of rim around the panel's corners (gated; R12 cut into them).

The cover drops 17.6 mm to shoot, down to the band's bottom rim; the travel
is derived from the face's edge. The lens row sits low on the carrier, so
every millimetre of cover is a millimetre of travel: 16.5 mm tall, it blankets
the 14 mm cells by 1.25 a side when closed and its top edge clears the field
cone by 3 mm when stowed. Both are gates, as is the closed cover blanketing
every cell (the firmware's cover-closed test needs all four dark).

The apron is one part in the face's filament: the block that refills the
cover's entry gap in the bottom rim (the track's stop) and a 1 mm plate over
the stow zone, 0.8 mm in front of the cover so the raised wordmark passes
under it. Its top edge stops 0.3 mm under the stowed cover's lip, so closed,
3.9 mm of track floor shows between the door and the bar as a shadow line.
It prints plate face down and is glued in once the cover is in the track.
Gates: it clears the cover closed, open and mid-travel, sits on the face
without overlap, and is the stop under the stowed cover.

The face is held by six 1.75 mm filament pins, 3 mm into the walls' front
ends and 2 mm into its back (the two bottom pins sit outside the cover's
entry gap, where the plate is thinner). They locate; a bead of glue at the
pins retains, if the face ever lifts. A rim pocket (the face flush inside
walls run past the plate) was the first draft of this cut: printed face
down, the recessed plate hung 2.5 mm over the bed as 10,000 mm^2 of
overhang. A proud face inside a flat margin came next; the full-front
pillow replaced it when the body read as a box.

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

1. Switch into the retainer, retainer into the pod from the rear, leads out
   through the side channels. Plunger in from the top.
2. Cover into the face's track from below; apron glued over the stow zone,
   its block in the rim gap.
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

Previews: `previews/KINO_CARRIER_DAY_*.png` and `NIGHT_FRONT.png` are the
colour views from `render-parts.py` (each part's STL in its filament's colour,
triangles split to 5 mm so the painter's order holds); the `*_PRINT.png` views
are each part in print orientation from `render-stl.py`.

## Gates

`node generate-carrier-body.mjs` writes `.candidate/` and runs 139 gates,
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
passing its bore, the strap hole open, and every print support-free off the
bed (each one's allowed bridges listed in its gate) and on a 250 x 210 bed.

`node promote.mjs` validates the candidates, copies the six parts into
`print/` and the report into `reports/`, sweeps stale files and validates
again. There is no independent scan yet; promote says so every run.

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
- `facePinD` 1.8: the filament pins' fit in the wall ends and the face, on the pillar coupon.
- The customer review's two items the carrier fixes, not the body: the USB-C and the three status lights are on the bottom edge because the carrier puts them there, so the camera charges lying on its back; a later carrier can move them.
- `activeCentred`: the active area centred on the PCB is still an assumption; the window has 1.0 mm a side.
- `camFovDeg` 78: the OV3660's real field is `MEASURE_REQUIRED`.
