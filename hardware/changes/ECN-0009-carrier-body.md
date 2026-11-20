# ECN-0009: a body for the dev carrier stack, first cut

| Field | Value |
|---|---|
| Status | Design in progress; seventh cut generated and gated, nothing printed; the night colourway prints first |
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
- **After a design-award jury read** (sixth cut, 2026-11-20): the band
  rim and the grip pad go; one groove, the horizon, is cut across the face
  edge to edge at the bar's height, its right end 2 mm deep as the grip; the
  face steps in 0.8 mm so a line of charcoal wall end frames it (the concept
  frames its colour field); the face itself roofs the stow zone, with a
  slot for the cover's lip, and the apron is gone (the keeper block stays);
  the brand "odd jobs" goes on the bar, raised, its last layers cream on
  both colourways, and the model "kino D4" to the deck, engraved 40 mm wide;
  the layer grooves run over the deck too and the reveal line is gone; the
  strap tabs become cord slots through the frame's corners over channels in
  the wall end; the thumb pad gets three half-round ridges; the symbol is
  engraved 1 mm with a stepped edge. Face 5.3 mm (horizon 1.0 + track 2.8 +
  1.25 under the floor). 128.0 x 80.4 x 62.0 mm, the body 9.3 of it,
  nothing proud of the face. Not taken: a fourth filament as a requirement
  (it is a note on the cover's last layers).
- **After a print technician and a second juror** (seventh cut,
  2026-11-20; the owner: the night body prints, keep reviewing; drop-to-open
  stays; and a Japanese or Chinese sense of work and of less). The
  technician's list, each a number: the cavity 0.5 mm a side (PETG shrink
  and a bowing 54 mm wall); the pin holes 2.0 mm, countersunk 0.4 at every
  mouth (1.8 closed to 1.5 with the elephant foot); the bore 7.5 (7.1 round
  a 7.0 barrel did not pass at the bed); 0.3 mm chamfers on every fitted
  bed edge (the cover's and keeper's backs, the face's back edge, the
  shell's front edge, the plunger's flange) and 0.3 a side round the flange
  in its bore; the frame pilots 1.8; the head pockets 8.70 with 0.5 mm
  corner reliefs; the track 3.0 deep under a 1.5 mm roof (the roof sagged
  onto the mark at 1 mm); the mark raised 0.8 (the first cream layer after
  the flush comes out grey); the lip slot the roof's full height so every
  bridge line lands on a wall; the collar recess gabled; the first groove
  at Z -6.5 clear of the pilots' threads; the guide bore 14.6. The juror's
  two: the engraved name on the deck was the last decoration (a 0.6 stroke
  in a vertical wall is one wobbling perimeter anyway), so the deck is
  bare; the cord looped the frame's screws, so it now loops a tunnel inside
  the shell's wall end under 0.6 mm of wall and the frame's slots are
  pass-throughs. The owner's note became the rule for every surface: one
  word outside (the bar), the symbol on the back, and the rest of the
  signature (symbol, "odd jobs", "kino D4") engraved 0.4 mm inside the
  face's back, mirrored, where only the person who opens it reads it. With
  the 7.5 bore the field cone never outgrows the cells inside the face, so
  the stepped cones collapsed to plain bores. A print plan (layers,
  elephant-foot compensation, scarf seam, bridge settings, 100 % face,
  the cover's flush at 1.5 mm, bed temperatures, five coupons) is in the
  package README. Face 6.0 (horizon 1.5 + track 3.0 + 1.25 under the
  floor); 128.4 x 80.8 x 62.7 mm, the body 10.0 of it.

Depth, re-added by a gate every build: 2.5 frame + 13.8 module + 3.3 inserts
+ 8.0 spacers + 1.6 carrier + 8.5 socket + 2.5 XIAO header insulator
(PROVISIONAL) + 15.0 XIAO back to lens front + 1.5 plate + 6.0 face
= 62.7 mm, against the field body's 74.5 over its lens bar. The body is 10.0
of it; the XIAO connectors (11.0) are the one
stack term the bench can shorten, with low-profile sockets and bare pins. The plate's inner face lands at Z 35.4
from the P4's PCB back, 3.9 mm above the Sense board's top.

## Gates

151 in `generate-carrier-body.mjs`, 0 failures: the depth chain, the lens
front on the pocket floor, the face inset from the outline and over the
pins, the plan corner's wall on the diagonal, the roof over the stow zone
clear of the cover and its mark, the lip's slot, the keeper clear of the
cover at every position and the stop under it, the six pin holes open and
blind, the strap slots and channels open and clear of the screws, the
window's chamfer, the marks and pads on
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
where 46 was meant, and the rim pocket above. In the seventh cut: two
zero-taper cones left on a bore that no longer needed them (four degenerate
triangles), a pocket probe sized for two ribbed walls when the pocket has
one per axis, a straight-line cone probe that overshot the real cone at
the track floor, and chamfers drawn with their 0.01 overshoot in the height
(44 degrees, counted as overhang) instead of the radius.

## Compatibility

Additive. The carrier D1 is unchanged. The field body and the resin body stay
as released; their XIAO clamps and loom are not used here. Firmware
unchanged.

## Staged

The P4's TF slot opening and the C6 service access, an interference gate
against the carrier's own part model, the serial engraving and any line under
4 mm of cap height ("made for bad ideas."), the coupons (shrink bar, pillar
with pin, pocket, track with roof, deck with pod), the independent scan. Issue #252 carries the open
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
