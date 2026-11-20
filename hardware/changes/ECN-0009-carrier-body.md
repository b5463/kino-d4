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

Depth, re-added by a gate every build: 3.0 frame + 13.8 module + 3.3 inserts
+ 8.0 spacers + 1.6 carrier + 8.5 socket + 2.5 XIAO header insulator
(PROVISIONAL) + 15.0 XIAO back to lens front + 1.5 plate + 2.5 face base +
4.0 lens band = 63.7 mm over the band, against the field body's 74.5 over its
lens bar. The plate's inner face lands at Z 35.4
from the P4's PCB back, 3.9 mm above the Sense board's top.

## Gates

122 in `generate-carrier-body.mjs`, 0 failures: the depth chain, the lens
front on the pocket floor, the face inside its margin, the marks and pads on
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
all on the bed. `validate-stl.mjs`: 7 files, manifold, at their part counts.
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
