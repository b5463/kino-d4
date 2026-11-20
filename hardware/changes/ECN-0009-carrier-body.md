# ECN-0009: a body for the dev carrier stack, first cut

| Field | Value |
|---|---|
| Status | Design in progress; first cut generated and gated, nothing printed |
| Date | 2026-11-20 |
| Hardware revision | D4-V1 |
| Design version before | 0.1.9 |
| Design version after | 0.1.10 (additive: a third CAD package, `cad` artifact revision 4 -> 5) |
| Supersedes | Nothing. `KINO_FIELD_BODY` and `KINO_RESIN_BODY` stay as released. |
| Affected units | None; no body exists for the carrier stack yet |

## Problem

Both released bodies carry the electronics themselves: loose XIAOs on pads, a
Dupont loom with 14 mm of header room, a 14.6 mm component bay, the P4 on
posts behind a foam-shimmed door. The dev carrier D1 (ECN-0008, ordered
2026-11-20) removes every one of those jobs: the XIAOs plug into sockets on the
carrier, the carrier stacks on the P4's JP1 through 8 mm spacers on the P4's
own inserts, and the only loose leads are the shutter, the C6 service header and
the battery module. A body for that stack has no chassis to be; it has to hold
the carrier and capture the camera heads, which hang on short soft ribbons and
would otherwise shake.

## Proposed change

A third CAD package, `hardware/cad/KINO_CARRIER_BODY/`, FDM PETG on the
owner's printer. Two parts:

- **Shell**: the front plate and all four walls down to the display plane,
  128.0 x 80.4 x 54.2 mm, 4.5 mm walls, printed face down with no support.
  The plate's inner face is the camera module's Z datum, as in the field body:
  an 8.65 mm pocket 3.5 mm deep per head with two 0.2 mm pinch ribs on each of
  two walls, a 7.1 mm bore 1.5 mm ahead of the lens. Four pillars from the
  plate down to the carrier's front face at its M2 holes, each tied to its wall
  by a rib, each with a 4 mm driver shaft from the front and a 2.4 mm bore
  through a 3.8 mm foot: the four screws that hold the stack to the spacers
  hold the shell. The stack slides in from the rear, carrier first, and stops
  on the pillar feet. The carrier's USB-C opens through the bottom wall under a
  45 degree gable; three 2 x 4 mm slots show the edge LEDs.
- **Rear frame**: 3 mm, a 95.6 x 58.2 mm window over the 93.6 x 56.16 active
  area (1.0 mm a side; the area centred on the PCB is PROVISIONAL), four M2
  thread-forming screws into 1.7 mm pilots in the wall ends.
- **Face shell** (second cut, 2026-11-20): the shell's front prints on the
  bed and carries no relief, so the form is a separate face printed back
  down. A 2.5 mm base with an R2.5 edge; a lens band 4 mm proud with a
  recessed panel that is the sliding cover's track (the field body's
  bench-tuned track restated: dovetail lips, two detent pairs, 0.1 mm a side,
  a keeper closing the rim gap, drops 17.5 mm to shoot); four cells as stepped
  cones from the 82 degree field cone, 14 mm at the panel floor; the ODD JOBS
  symbol raised top left; the kino D4 wordmark raised on the cover. Located
  on the shell by four stepped printed pins in the driver shafts (press fits,
  tuned on the coupon); two rivet bosses on the upper deck carry the upper
  pin holes. The lens row sits low on the carrier, so the cover is 17 mm tall
  and blankets the 14 mm cells by 1.5 a side; both margins are gates.
- **Shutter and strap lug**: the field body's pod, plunger and retainer on
  the shell's top wall at X 104, between the plate and the carrier (1.1 mm
  above it), every bore with a teardrop roof pointing up in print; the switch
  leads run down the cavity to J103. A strap lug on the right wall, cord hole
  front to back, its underside sloped past 45 degrees.
- **ODD JOBS** (third cut, the same day, on the owner's brief that the body
  carry the brand's personality and the user's hand): the brand's own camera
  concept (`ODD JOBS/CAMERA 01`, v18 and v6) restated on this stack. A
  charcoal shell with 0.25 mm V-grooves at 1.6 mm pitch around the side and
  bottom walls (the layer texture, 49 degree flanks); the face a cream or
  cobalt plate standing proud inside a 4.5 mm charcoal margin; the pink
  shutter cap grown to 14 mm under the right index finger; finger ribs on the
  face's right under the middle finger; thumb grooves on the rear frame's
  right border; the strap on the right wall; "odd jobs" traced from the logo
  and raised on the upper deck; the symbol engraved on the back. The cover is
  charcoal so that, closed, it is one bar across the face (the UI's landed
  bar) and dropped it is the four-mark. Three filaments, one part each. A rim
  pocket (the face flush inside walls run past the plate) was drawn first and
  thrown out: face down, the recessed plate is 10,000 mm^2 of overhang.
- **Not a box** (fourth cut, the owner's call on the first render): plan
  corners R10 (2.65 mm of wall on the diagonal, gated; the carrier's
  near-square corner forbids more), the face a full-front pillow with a
  round over its whole thickness over the walls' ends, the rear frame
  rounded over its whole thickness and printed rear face up for it, the band
  pill-ended, the rivets and the shutter cap domed (R18), the strap tab
  rounded about its hole, a reveal line where the layer grooves stop so the
  top deck reads as a cap. Then trimmed on the owner's question about
  thinness: frame 3.0 (R3), face 2.5 (R2.5), band 3.5, the lower pin holes
  2.5 deep so they stay under the track floor. 128.0 x 80.4 x 63.2 mm over
  the band.
- **After two cold reviews** (fifth cut, 2026-11-20; an engineer's read of
  the files and renders, and a customer's read of the renders): an apron in
  the face's filament roofs the cover's stow zone so the closed front is a
  bar over a door, not an empty pocket; the cover's track is cut into a
  3.5 mm face under a 1 mm rim (the rivets and their pin holes are gone; six
  1.75 mm filament pins in the walls' front ends hold the face instead of a
  2.5 mm press fit); a 2.5 mm grip pad on the face's right carries the
  finger ribs; the cover's corners are R3 with a 3 mm lip on its top edge
  for the thumb; "kino D4" on the cover grows to 52 mm and is printed in the
  face's filament for contrast; "odd jobs" moves to the top deck, engraved;
  the pinch ribs become 0.8 x 0.3 triangles (0.4 mm columns do not print);
  the layer grooves go to 0.5 mm at 2.4 mm pitch; the strap tabs move to
  the lower rear corners, one each side; the rear frame is 2.5 mm with a
  chamfered window edge for the thumb, a raised thumb pad, plain screw
  holes with the pan heads proud, and an R1.5 round; the band's corners are
  R9, gated to keep rim around the panel's corners. Not taken: stowing the
  cover upward, which would centre the band; drop-to-open was settled on the
  bench coupon. 128.0 x 80.4 x 61.2 mm over the band, 63.5 over the grip,
  the body 8.5 of it.

Depth, re-added by a gate every build: 2.5 frame + 13.8 module + 3.3 inserts
+ 8.0 spacers + 1.6 carrier + 8.5 socket + 2.5 XIAO header insulator
(PROVISIONAL) + 15.0 XIAO back to lens front + 1.5 plate + 3.5 face +
1.0 band rim = 61.2 mm over the band, against the field body's 74.5 over its
lens bar. The body is 8.5 of it; the XIAO connectors (11.0) are the one
stack term the bench can shorten, with low-profile sockets and bare pins. The plate's inner face lands at Z 35.4
from the P4's PCB back, 3.9 mm above the Sense board's top.

## Gates

139 in `generate-carrier-body.mjs`, 0 failures: the depth chain, the lens
front on the pocket floor, the face over the whole front, the plan corner's
wall on the diagonal, the band's rim around the panel's corners, the apron
clear of the cover at every position and the stop under it, the six pin
holes open and blind, the window's chamfer, the marks and pads on
their decks, the shutter bore's roof inside the pod, the field cone clear of the shell, the face and
the stowed cover at every station, the closed cover blanketing every cell,
the cover held by its detents closed and open and free between, the keeper
as the stop, the pin holes blind, the shutter bores and lead routes open, the
battery bay (56.4 x 49.4 x 6.3 mm between the P4
and the carrier, between the spacers; the cell goes on the P4's CN4 and the
P4's IP5306 charges it from the carrier's USB-C, so there is no SW6106 module
and no lead leaves the shell; a 505573 pouch does not fit this plan, a 50 x 50
class cell does), both parts one solid, an electronics dummy clear of both
parts with only the pinch ribs inside the nominal heads (5.3 mm^3), every
pocket, bore, shaft, foot, slot, opening and pilot probed open, every pillar
inside the carrier's 7 mm fastener keep-out, the carrier's sweep from the rear
clear up to the feet, the frame window over the whole active area, both prints
support-free off the bed (each print's allowed bridges listed in its gate),
all on the bed. `validate-stl.mjs`: 6 files, manifold, at their part counts.
No independent scan yet; `promote.mjs` says so every run. Found by the gates
while the face was written: a face hull 0.01 mm into the shell (100 mm^3), a
straight frustum probe that bulged past the bore, a 6 mm band that put the
cone's foot under the stowed cover, a single detent pair that touched
nothing at the cover's R0.6 corners, pin holes through the 2.5 mm base and
through the track floor, a lip a hair shallower than 45 degrees, a zero-area
triangle from a hull of 0.01 mm slabs, a groove cutter that was a hull of
three slabs (a square groove with a flat ceiling), grooves at 43.6 degrees
where 46 was meant, and the rim pocket above.

## Compatibility

Additive. The carrier D1 is unchanged. The field body and the resin body stay
as released; their XIAO clamps and loom are not used here. Firmware
unchanged.

## Staged

The P4's TF slot opening and the C6 service access, an interference gate
against the carrier's own part model, the serial engraving and any line under
4 mm of cap height ("made for bad ideas."), the coupons (pillar with pin,
pocket, track, pod), the independent scan. Issue #252 carries the open
inputs: the soldered header's insulator height, the spacer height with the
socket home, the head size and stack height on a seated node, the active
area's position, the field of view.

## Files changed

- `hardware/cad/KINO_CARRIER_BODY/` (new)
- `hardware/cad/README.md`
- `hardware/manifest.json`, `hardware/CHANGELOG.md`, `versions.json`

## Verification

- [x] BOM and manifest agree (no new BOM lines; four M2 x 8 thread-forming screws from stock).
- [x] Wiring and GPIO records agree (unchanged).
- [ ] Assembly and acceptance procedures: the package README carries the assembly; `hardware/TESTING.md` unchanged until a body is printed.
- [x] Affected firmware and KDP assumptions were tested (none affected).
- [ ] Closed-enclosure checks: pending the first print.
- [x] `npm run version:check` passes.

## Decision

Design in progress. The first print waits on the owner's measurements of the
soldered header insulator, the P4 module can and the spacer height, and on a
cell that fits the bay.
