# ECN-0009: a body for the dev carrier stack, first cut

| Field | Value |
|---|---|
| Status | Design in progress; thirteenth cut generated and gated, nothing printed; the night colourway prints first, the coupons before it |
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
- **After the award cameras** (eighth cut, 2026-11-21; the owner: printable
  and recognisable, read the winners first, then run the judges again).
  The juries' words for the camera winners of Red Dot, iF and Good Design
  2014 to 2026 and the reviews that followed them into use were read and
  set down in the package README (one idea carried through; a silhouette
  drawn from memory; the ritual visible; reduce controls, never grip; no
  strap is a fault; decoration in costume is marked down; the jury holds
  the print). Two jurors and a print foreman then judged the seventh cut's
  renders and files against them. Taken: the deck grooved whole with a
  1.5 mm ring round the collar (the plateau carried a name that was gone);
  rounds in plan, chamfers in Z (the face's R3.5 pillow terraced 1.17,
  0.46, 0.33 mm at 0.2 layers along the first edge a hand meets: now a
  2 mm 45 degree chamfer; the frame's R1.5 now 1.2; the R18 dome, a 3.4 mm
  disc and rings under the finger, now a flat cap with a 0.5 edge); the
  grip 3.5 deep and the horizon carried round the left wall only, so the
  ribs run unbroken under the fingers on the right; the horizon's lips
  chamfered 0.8 and 0.4 so the line reads from the front; the cover's lip
  30 wide at 40 to 70 mm off the bar's left end and 1.0 proud, so the slot
  frames plain bar (a letter showed) and the slide is visible as a slide;
  0.8 mm rims on the cells (eyes, not a microphone array); the collar 0.4
  deep and round (an arrow at 1.6); a second strap pair at the top corners
  (a neck cord hung the camera inverted) and 3.0 x 2.4 slots for a 2.5 mm
  cord; the shell's rear edge and the frame's bed edge chamfered 0.4 so
  the joint is a drawn V on the groove rhythm; every bed chamfer 0.4 (two
  whole layers); the groove waist on a whole layer at Z -6.6; the keeper
  cut from the face's solid; thumb grooves 1.0 x 0.6; the roof's clearance
  0.3; the frame screws at X 17 to clear the top tunnels; the print plan's
  flush at 2.00 mm, purge, seams, 0.12 layers on the frame, no ironing.
  Not taken: a keeper pin (3.6 mm wide block), rear screw counterbores
  (the wall cannot give 0.4), a fake lens tell on the closed front (the
  four cells behind one bar are the signature; closed, the button says
  camera). Face 6.1; 128.4 x 80.8 x 62.8 mm, the body 10.1 of it.
- **After the whole field of design awards** (ninth cut, 2026-11-21; the
  owner: "not just award cameras, the whole design awards, rerun it"). The
  published criteria and jury practice of Red Dot, iF, IDEA, Good Design,
  the Compasso d'Oro, D&AD and the Braun Prize across every category, and
  the record of award-praised objects that failed in use, were read and set
  down in the README; an IDEA and Red Dot generalist, a Good Design and
  Compasso d'Oro juror and a jury chair then judged the eighth cut against
  them. The scored faults were responsibility and the hand, not form: the
  glued keeper sealed in the one wear part, the pins located but did not
  retain, the button ticked in its guide, the entry had no cord, no spares
  and no BOM. Taken: the cover's entry gap through the whole plate and the
  keeper captive by a 0.9 x 1.1 foot in a pocket in the shell's plate
  under the face (no glue anywhere; the cover comes out with the pins);
  pins 1.9; the plunger's bore 0.15 a side with three 0.2 x 0.8 ribs in the
  guide; the lip 20 wide with a 0.4 root, 1.5 proud, at 45 to 65 mm (a
  thumb needs 16, a glove needs 1.5); the track 3.4 under the roof; the
  thumb pad over the whole right border; a 10 % swell term in the battery
  gate; nine coupons cut from the real parts with boxes, in `coupons/`,
  with pass criteria; a "What ships" list (BOM, cord, spares, the pilots'
  cycle count, the lens-pitch contract, the known and accepted faults); the
  face at 40 % gyroid with 100 % modifiers; the README's lug sentence gone
  and "layer lines" renamed ribs; the left-hand mirror stated as four
  numbers. Not taken: a 5.5 mm wall for heat-set frame inserts (stated
  cycle count and spares instead), a tripod boss (the next carrier's), one
  `hand` parameter (listed). Face 6.4; 128.4 x 80.8 x 63.1 mm, the body
  10.4 of it.
- **Supports** (tenth cut, 2026-11-21; the owner: "printable with
  supports, tree supports, but minimal, they affect the look"). Every
  print's down-facing area was binned by position. Five parts need none:
  the shell's are the LED slots (4.5 mm bridges), the pin holes, the
  strap tunnels, the keeper's pocket and the collar's recess, the four
  screw-foot shoulders in the cavity and the USB gable at 45; the cover's
  are two 0.2 mm ledges; the frame and the keeper have none; the button's
  is the retainer's leg slot. The face's roof over the stow zone was not a
  bridge: with the entry gap through the whole plate (ninth cut) and the
  horizon above, both Y edges are free, and the lip slot cuts the 87 mm
  X-span into flaps of 45 and 21 mm from one wall each, which the old
  area gate accepted as "a 16 mm bridge". A slicer would have filled the
  track with trees and scarred the roof and the floor. Taken: five
  breakaway blades in the print file, 0.8 wide on a 0.42 x 0.4 neck,
  standing on the track's relieved band off the lands, one at each edge
  of the lip slot, one layer under the roof, so the roof bridges 10 to 16
  mm; removed through the gap before the keeper. The floor relief itself
  was found cut upward into the track's void (the lands were 0.01 mm;
  the cover dragged on the whole floor) and is now 0.25 into the plate.
  The left wall's horizon channel ended in a 0.01 mm skin at the rear
  (27 mm^2 of ceiling at the top of the print); it now runs out in a 45
  degree ramp at the joint's chamfer. The overhang gate is replaced by a
  per-print list of named places (bridge, hole, pocket) where a face may
  point down; anything outside fails with its position. Slicer supports
  off on every part, written into the print plan with the reasons; tree
  supports allowed by hand under the roof only. Not changed: geometry the
  eye sees. 176 gates.
- **The P4 held** (eleventh cut, 2026-11-21; the owner: "the P4 can't
  screw into the body on its own now that we have the carrier; figure out
  a system to hold it in place"). Its inserts carry the carrier's
  standoffs, so there is no screw into it. Taken: the module clamped
  between the standoffs and the rear frame through a gasket. The frame's
  inner face now stands 0.4 mm behind the glass front (`glassClear`; the
  shell's walls and the frame move back by it; a gate probes the module's
  outline past that plane) and carries a 2 mm closed-cell foam strip, 1.5
  wide, in a 0.9 mm groove round the window, 2.0 outside the window past
  its chamfer and 0.8 inside the module's edge; the four frame screws
  squeeze it to 1.3 (35 %; 20 to 50 % over +-0.3 of stack). The 114 x 67
  module hangs 26 mm past its standoffs in X, and the foam carries that,
  so a thumb on the glass loads foam, not the inserts. In plan the
  standoffs locate it; a ledge under it in the cavity is ruled out by the
  carrier's sweep. Not taken: corner cradles on the frame (they would
  stand on the print's bed face), ledges in the shell (the sweep). Four
  gates; 180. Body 63.5 deep, 10.8 of it the body.
- **Simplified** (twelfth cut, 2026-11-21; the owner: "open it up and
  let's simplify", choosing "keep the cover, open the stow zone"). The
  cover's panel is now a window through the whole face plate; the shell's
  own plate is the track floor; the cover goes in from the face's back
  before the face goes on. Gone: the roof over the stow zone, the lip
  slot, the entry gap, the keeper with its foot and pocket, the five
  breakaway blades, the relieved floor and its lands, the cells in the
  face (the shell's bores show through the window), the keeper coupon,
  a part, 22 gates and three parameters' worth of fits. The face is 4.0
  (lips 2.3 over the plate with 0.3 of play under them, the horizon 1.7
  above), the grip 3.0 with 1.0 of plate under it. The dropped cover sits
  in the open stow zone in plain view, which the jurors scored against
  in the fifth and sixth cuts and the owner now accepts for the
  simplicity. 158 gates. Body 61.1 deep, 8.4 of it the body.
- **Reviews on the simplified body** (thirteenth cut, 2026-11-21; the
  owner: "run all the reviews and inspos on the model, and another for
  the people actually building it"). Two jurors, a print foreman and a
  first-time builder following the README. Converged and taken: the two
  stack-screw shafts that show in the open stow zone stay and get a 0.8
  chamfered mouth and a sentence (the screw ports); the stow zone's floor
  in the face's colour by a filament change on the shell at Z 1.0 (closed,
  a dark bar on a colour field as the brand draws it, not a charcoal
  mouth) with `faceInset` 0.8 to 0.3; the window's front edges chamfered
  0.8 and 0.4 like the horizon's lips; the grip's floor a 45 degree ramp
  from 101.0 instead of a step; `facePinFace` 2.5 and 5.5 mm pins with a
  hang-and-pull test on the real face; the gasket 2 mm wide (a stock
  tape) with the four strip lengths and spares in the ship list;
  `strapSlot` 2.8 for the 2.5 cord and `strapTunnelSkin` 1.2 (0.6 was a
  bridge at the top of the print); the left wall's horizon channel 1.8 so
  it exposes 1.5 of the face's edge as the pry point; `panelDepth` 2.4
  and `platePocketAhead` 1.6 on whole layers; `sliderBumpH` 1.0 past the
  elephant-foot compensation; the frame at 0.10 (every height a whole
  layer); the cover's minimum layer time and purge; `release-set.mjs`
  orientations and layer heights brought to the README's; the README
  rewritten for the builder: assembly in build order (flash and stack
  first, the switch lead into J103 before the stack goes in, the cover's
  orientation, the driver's shank, the standoffs, the foam lengths, the
  power-up check), a "you need" and "which number" column on the coupon
  table, the preview named per part, the regeneration line. Coupons: the
  face and cover cut-outs and the frame corner dropped (print the real
  parts; the frame's slots prove nothing), a frame pilot added to the
  strap coupon. Stale parameters removed. Not taken: plugging the ports
  or moving the window (a part and a coupon). 161 gates. Body 61.2.

Depth, re-added by a gate every build: 2.5 frame + 0.4 off the glass + 13.8 module + 3.3 inserts
+ 8.0 spacers + 1.6 carrier + 8.5 socket + 2.5 XIAO header insulator
(PROVISIONAL) + 15.0 XIAO back to lens front + 1.6 plate + 4.0 face
= 61.2 mm, against the field body's 74.5 over its lens bar. The body is 8.5
of it; the XIAO connectors (11.0) are the one
stack term the bench can shorten, with low-profile sockets and bare pins. The plate's inner face lands at Z 35.4
from the P4's PCB back, 3.9 mm above the Sense board's top.

## Gates

161 in `generate-carrier-body.mjs`, 0 failures: the depth chain, the lens
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
clear up to the feet, the frame window over the whole active area, every
print's overhang inside its named bridges, holes and pockets (nothing
down-facing anywhere else), the cover on two lands over a relieved floor,
the frame off the glass and the gasket groove on the glass's margin with
its squeeze, all on the bed. `validate-stl.mjs`: 15 files, manifold, at their part counts.
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
(44 degrees, counted as overhang) instead of the radius. In the eighth: the
frame's bed chamfer drawn 0.39 high (61 mm^2 at 44 degrees), and the
panel datum moving 1.5 mm with the face's edge (the mid-travel probe
touched a detent) until `bandBottomInset` was re-based on the chamfer. In
the ninth: the keeper's foot drawn with a flat underside (85 mm^2 hanging
in a foot-up print) until it was sloped 47 degrees, and the keeper gate
reading the foot as the stop face. In the tenth, by binning the overhang
by position instead of summing it: the roof over the stow zone as two
cantilevers the area gate had passed as a bridge, the floor relief cut
into the void, and the horizon channel's 0.01 mm end skin.

## Sources read for the eighth cut

The owner asked (2026-11-20) that the body be printable and recognisable and
that the award winners be studied before the judges ran again. Read:
[Sigma BF, Red Dot Best of the Best 2026](https://press.sigmaphoto.com/corporate/05/sigma-bf-wins-red-dot-best-of-the-best-in-red-dot-award-product-design-2026/),
[Sigma BF, iF Gold 2026](https://press.sigmaphoto.com/corporate/03/sigma-bf-camera-wins-if-design-award-2026-gold/),
[Sigma BF, Good Design Gold 2025](https://press.sigmaphoto.com/corporate/10/sigma-bf-camera-wins-good-design-gold-award-and-minister-of-economy-trade-and-industry-award/),
[Sigma BF reviews: "minimal to a fault"](https://www.engadget.com/cameras/sigma-bf-hands-on-minimal-to-a-fault-144024445.html) and
[PetaPixel](https://petapixel.com/2025/03/06/sigma-bf-review-riding-the-knifes-edge-of-too-simple/),
[Fujifilm GFX100RF, Red Dot](https://www.red-dot.org/project/fujifilm-gfx100rf-89157),
[Leica T, Red Dot](https://www.red-dot.org/project/leica-t-33976) and
[its touchscreen reviews](https://www.dpreview.com/reviews/leica-t-typ701),
[Instax mini Evo Brown, Red Dot Best of the Best 2024](https://www.red-dot.org/ko/magazine/fujifilm-instax-mini-evotm-brown),
[Ricoh GR IV, Good Design 2025](https://www.digitalcameraworld.com/photography/awards-and-competitions/cult-compact-camera-wins-major-design-award-for-its-redefined-minimalist-style),
[Red Dot judging criteria](https://www.red-dot.org/pd/red-dot-jury-1),
[Fujifilm X half reviews](https://www.dpreview.com/reviews/2988698485/1),
[Hasselblad X1D reviews](https://www.techradar.com/reviews/hasselblad-x1d-review),
[Camp Snap](https://www.techradar.com/cameras/compact-cameras/camp-snap-camera-review),
[Paper Shoot](https://www.digitalcameraworld.com/uk/reviews/paper-shoot-paper-camera-review),
[Kodak Charmera](https://petapixel.com/2025/12/20/kodak-charmera-review-reto-makes-a-retro-redo/).
Widened for the ninth cut (2026-11-21, the owner: "not just award cameras,
the whole design awards") with the published criteria and jury practice
across awards and categories:
[Red Dot judging qualities](https://www.red-dot.org/pd/red-dot-jury-1),
[Red Dot Best of the Best, how few win](https://www.red-dot.org/zh/magazine/finest-quality-red-dot-jurors-award-top-class-design-products),
[IDEA criteria and jury](https://www.idsa.org/awards-recognitions/idea/),
[Good Design Award: types of awards and the Grand Award vote](https://www.g-mark.org/en/apply/gda/guide/typesofawards),
[Good Design Award 2025 results](https://www.g-mark.org/en/learn/past-awards/gda-2025/results),
[Compasso d'Oro, ADI](https://www.adidesignmuseum.org/en/?p=8378) and
[the 2022 winners](https://domusweb.it/en/design/gallery/2022/06/20/the-winners-of-the-2022-compasso-doro-awards.html),
[iF Design Award 2025 winners](https://ifdesign.com/en/if-magazine/newsroom/if-design-award-2025-the-winners),
[a juror's account of judging](https://www.mckinsey.com/capabilities/mckinsey-design/how-we-help-clients/design-blog/learning-by-doing-a-design-award-jury-experience),
and the failures:
[the Humane AI Pin](https://www.engadget.com/ai/the-humane-ai-pin-debacle-is-a-reminder-that-ai-alone-doesnt-make-a-compelling-product-190119112.html),
[the AI gadget debacle of 2024](https://www.fastcompany.com/91231902/the-great-ai-gadget-debacle-of-2024),
[consumer product design failures](https://www.onshape.com/de/blog/epic-consumer-product-design-failures).
The lessons are in the package README ("What the design awards taught").

## Compatibility

Additive. The carrier D1 is unchanged. The field body and the resin body stay
as released; their XIAO clamps and loom are not used here. Firmware
unchanged.

## Staged

The P4's TF slot opening and the C6 service access, an interference gate
against the carrier's own part model, the serial engraving and any line under
4 mm of cap height ("made for bad ideas."), the coupon prints and their
results (the track coupon decides whether the roof's blades snap clean and
the 16 mm bridges hold), a `hand` parameter, the independent scan. Issue #252 carries the open
inputs: the soldered header's insulator height, the spacer height with the
socket home, the head size and stack height on a seated node, the active
area's position, the field of view.

## Files changed

- `hardware/cad/KINO_CARRIER_BODY/` (new; `print/` and `coupons/`)
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
