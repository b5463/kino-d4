# ECN-0009: a body for the dev carrier stack, first cut

| Field | Value |
|---|---|
| Status | Design in progress; twenty-third cut generated and gated after the second coupon round (2026-11-21: the 8.1 gauge pocket holds the head, the bar 99.9 at 0.2 %, the carrier's corner flat on the ledge; the front-entry button took neither the plunger nor the switch, so the slot is open to the face and the switch goes in first); the third pod coupon T05 with B02 is next on the bed, with the pin-hold tests on T03 and T04 still to report |
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
- **No screw into either board** (fourteenth cut, 2026-11-21; the owner:
  "the M2 cannot be attached to the case, only P4 to carrier; hold the P4
  down with no screws that go into the P4 or the carrier"). The four stack
  screws from the pillar feet into the standoffs are gone, with the four
  4 mm driver shafts in the plate and the screw ports the thirteenth cut
  had chamfered. The carrier is screwed to its standoffs with its own M2
  pan heads, and each pillar foot now carries a 4.4 mm pocket 1.6 deep
  round the head (`carrierHead`, `carrierHeadClr`; `bossD` 6.8 so 1.2 mm
  of wall rings the pocket inside the keep-out). The stack is clamped:
  the frame's four screws into the wall-end pilots squeeze the foam, the
  foam the glass, the glass the module, the standoffs the carrier, the
  carrier the feet. A gate puts the clamp at about 16 N on 644 mm^2 of
  foam at 25 kPa against a 130 g stack, both numbers provisional; the
  foam is now specified PORON or silicone, not PE, because PE takes a set
  and the clamp with it. The dummy carries the screw heads, so the
  clearance gate proves the pockets. The plate's front is solid and the
  stow zone's floor plain. Battery change is frame off, stack out. 154
  gates.
- **As thin as possible** (fifteenth cut, 2026-11-21; the owner). The
  body's own terms taken to their floor: the frame 2.5 to 2.0 (1.2 under a
  0.8 gasket groove, the window chamfer 1.0, the foam at 40 %), the plate
  ahead of the lens 1.6 to 1.0 (the bore and its chamfer; `plate` 4.4 so
  the pocket depth and the module's landing do not move), the face 4.0 to
  3.2 (lips 2.4, the horizon 0.8, the chamfer family's own size; the grip
  2.2 with 1.0 under it; the edge chamfer 1.2, the frame's size, since 2.0
  ran over the pin holes; pins 4.8 into 1.8). Body 61.2 to 59.3, of which
  the body is 6.6. The other 52.7 are the electronics; the README's
  "Thinner" table names the three bench levers (`socketH` 8.5 to 4.3,
  `xiaoHeaderInsulator` 2.5 to 0, `spacer` 8.0 to 5.0 with a 3 mm cell)
  that take the camera to 49.6 with the same body files.
- **The stack measured** (sixteenth cut, 2026-11-21; the owner: "the
  height of the P4 with screen, the standoffs and the carrier board
  without the female headers or XIAOs is 17.5 mm"). The chain had 26.7
  for that: module 13.8 (OFFICIAL_CAD) + inserts 3.3 + standoffs 8.0 +
  carrier 1.6. The measurement is now `glassToCarrierFront` 17.5 and a
  gate re-adds the four terms to it; with the inserts and standoffs as
  measured, `p4T` is 4.6, DERIVED, and the split is the bench's to
  confirm (if the standoffs are not 8.0, `spacer` moves and `p4T` with
  it; the body regenerates). Nothing else moved: the frame, the glass
  clearance, the gasket, the window and the bay are all referenced from
  the glass or the carrier. Body 59.3 to 50.1; the thin levers now reach
  40.4.
- **Two materials, IDs, keys** (seventeenth cut, 2026-11-21; the owner's
  master brief: an award-credible two-colour camera in black PETG and dark
  blue PLA, exceptional to assemble, built on the existing design). Taken:
  one material per part (PLA on PETG does not bond), so the shell, frame
  and cover are black PETG and the face and button dark blue PLA; the
  face's own 1.0 mm track floor is back (the tray in the face's colour
  without a filament change, and the face with its cover a subassembly
  tested on the bench; +1.0 depth, 51.1); the wordmark engraved 0.4 in the
  cover; the cover keyed by its bevels (1.0 left, 1.5 right, lips to
  match, a gate that the turned cover is refused); part IDs A01 to B03,
  C01 to C03, T01 to T05, embossed in a 5 x 7 block font on a hidden face
  of every printed part (`blockText` in lib), in every file name
  (`release-set.mjs`), in the README's register and on the bins; the
  renderer labels the exploded view by ID; the README gains the component
  register, the orientation keys, the QC plan, the counted assembly and
  the jury paragraph. Every cut's renders are now archived under
  `docs/assets/making-of/` by `archive-previews.py` for the website's
  making-of page (`docs/MAKING_OF.md`). 156 gates.
- **Clean, and the coupons** (eighteenth cut, 2026-11-21; the owner:
  "clean up the body fully and then make me the coupons"). Dead
  parameters gone (the dome, the press face, the wire exit, the edge
  steps, the foot height, the deck engraving depth, the active-area flag),
  every comment that still spoke of charcoal, cream, pink, the lug, the
  apron, the shafts or the swap rewritten, the unused overhang sum
  removed from lib, the generator's header for two materials; the README
  loses its review-by-review narrative and its earlier-drafts paragraph
  (they live in this ECN and on the making-of page) and keeps a short
  "what the reviews taught" with the rules. Coupons: T02 to T05 carry
  their own IDs in their bed faces (a gate proves each engraving sits in
  material); two bed plates ship as one file each, P1 (T01 + T02) and P2
  (T03 + T04), so a print job is one file.
- **The first prints** (nineteenth cut, 2026-11-21; the owner printed P1,
  P2 and T05 and reported: "t01 is 99.8mm", "t02 it is extremely loose
  and doesnt hold the camera", "for the foot and the wall end you need to
  figure out a completely different mounting mechanism for the boards
  inside that doesnt at all utilise the m2s", "dont put the part codes on
  the bottom side of prints it screws up the print a bit and is
  unreadable", "dont use pixelated codes use a normal font and something
  understandable for a factory"). Shrink: 0.2 %, `shrinkPct`, set in the
  slicer; the model is never scaled. Pocket: the 8.7 pocket with 0.3 ribs
  does not hold the head, so the head is not 8.5; T02 is now a gauge, three
  real pockets of 7.8, 8.1 and 8.4 in one plate, each labelled, drawn by
  the same `cameraPocket` function as the shell's. The hold, with no M2
  anywhere in it: the pillars, their head pockets, the frame pilots, the
  frame screws (C03) and `carrierHeadClr`, `bossD`, `bossRib`,
  `fastenerKeepOutD`, `framePilotD`, `framePilotDepth`,
  `frameScrewHoleD`, `frameScrewXs` are gone. The cavity is 2.0 mm
  narrower from the carrier's front face to the plate (`ledgeW`), so the
  carrier's edge lands on a ledge all round (1.5 of bearing at 0.5 of
  clearance; nothing on the carrier's front face within 4.3 of its edge,
  `carrierEdgeKeepOut` 4.0 gated; the P4 is 2.0 inside the outline, so the
  stack still enters from the rear); gates: the ledge ring in material,
  the bearing inside the keep-out, nothing of the body within 1 mm of any
  carrier head, the stack refused turned round (the heads meet the plate,
  the USB-C the top wall). The frame is held by six of the same 4.8 mm
  filament pins as the face: blind 1.9 holes 3 mm into the walls' rear
  ends (`framePinsTop` 30/90, `framePinsBottom` 40/100, `framePinsSideY`
  52), 1.8 holes through the frame countersunk at its inner face
  (`framePinHoleD`), the pin 0.2 under the rear face; the frame seats on
  the wall ends, so the pins carry the foam's 16 N and nothing else, six
  at `pinHoldN` 5 N (PROVISIONAL, the hang test on T04) gated at 1.5
  times; the bottom pair is not the top pair's mirror, so turned round the
  frame misses by 2.4 mm (gated), and the pattern differs from the face's
  (gated). The left wall's horizon channel now runs through to the joint:
  at its rear end it exposes 1.8 mm of the frame's inner face, the frame's
  pry point, as its front end is the face's (gated, and probed open). IDs:
  the 5 x 7 pixel font is gone; `text-outline.py` draws DejaVu Sans Bold
  outlines with matplotlib at build time and `textSolid` extrudes them.
  A01 5 mm in the plate's inner face (up in print), A03 3 mm in the rear
  face under the thumb pad (up in print), A02 2.2 mm in the face's bottom
  edge wall (vertical in print, inside the reveal); B01, B02 and B03 carry
  no mark (their only hidden faces are the bed, and each is the only part
  of its shape and colour); every coupon carries its ID in the face that
  is up in print, gated in material. T03 is now the cavity's lower-left
  corner with 24 mm of ledge and the face pin hole at X 5; T04 the bottom
  wall's rear end with the frame pin hole at X 40 in place of the pilot.
  Pins C01: twelve. One fastener type, no screwdriver.
- **The button, after its first print** (twentieth cut, 2026-11-21; the
  owner: "the button has two wires ... there is no clearance there for
  them or a way to route them", "no need for the water droplet shape",
  "the button doesnt even reach the upper printed button", "there is no
  way to hold the bottom part to the body", and on the bottom wall "these
  holes are doing nothing for the esthetic too much like the teardrop").
  The retainer cup, the 17 mm access bore, the side lead channels and
  every teardrop are gone (`shutterAssemblyAccessD`, `shutterRetainer*`,
  `shutterWireBayW`, `shutterSwitchLeg*`, `shutterSideWireW`,
  `shutterPodW`, `shutterPodReach`, `teardropY`). The pod now runs from X
  95 into the right wall and 7.2 mm below it; from the deck: a round 14.6
  guide 2.5 long (ribbed, round at the deck, flat-ceilinged 0.4 above the
  circle below), a 16.3 flange bore 2.6 long with the step that keeps the
  plunger in, a 9 x 6.6 switch pocket, and a 1.8 slit across the pod's
  foot for a floor plate B03 (17.5 x 12 x 1.6 PLA, two 2 x 5.5 slots for
  the legs and leads, one pin hole) slid in from the pod's left face and
  locked by one 4.8 mm filament pin up through the lower lip, the plate
  and into the pod. The press lands on 1.5 mm of pod; the pin is in shear.
  The chain is a gate: floor + the switch's whole height (4.3, base to
  actuator top, `shutterSwitchBody[2]`) = the flange's underside at rest,
  the flange bore 1.0 below that (`shutterTravelClr`) for a 0.25 stroke.
  The dummy now carries the carrier's front-face connectors and links
  (`frontParts`: J1001, J103, J101, JP200 to JP500) and the pod is gated
  5 mm above them and 2.5 clear of CAM 4's XIAO. T05 is the whole pod with
  the wall corner it joins. On the bottom wall: the three LED slots are
  gone (the LEDs are read with the frame off; the screen carries status)
  and the USB opening is a plain R1 rectangle (`usbOpenR`), its 13.4 mm top
  a bridge inside the wall. 182 gates.
- **The button, simplified** (twenty-first cut, 2026-11-21; the owner:
  "this button setup is gonna be a manufacturing and asembly nightmare").
  Found on the way: the pinned-plate pod could not be assembled at all
  (the 16 mm flange had no entry past the 9 mm pocket), and a chamber open
  to the rear fails because the cap stands 2.2 mm above the top wall's
  inner face and cannot slide along it. Now one printed part and the
  switch: the chamber (16.3 wide, 6.1 tall, closed at the rear) opens to
  the FRONT through a hole in the plate's top-right corner (and 2.2 mm into
  the wall's front end; 1.8 of wall left under a groove, gated) that the
  face's back covers; the plunger rides in on the floor with its cap under
  the step (5.9 in 6.1, gated) and, deck down, drops into the guide; the
  lift from floor to step is the switch's height plus 0.2 (gated), so the
  switch slides in under the seated flange, legs in two 2 mm channels
  through the 2 mm floor that run out to the front and stop it centred
  under the cap, leads trailing through them into the cavity. The face is
  the door; nothing is in tension; B03, the floor plate, the thirteenth pin
  and `shutterFloor*`, `shutterPocketX`, `shutterSwitchClearance`,
  `shutterTravelClr` are gone. The dummy's connectors stay. T05 now
  includes the plate with the chamber's mouth. Then, on the owner's two
  questions ("will the switch not slide" and "the switch has to be put in
  first ... think about the order of operations"): the switch could walk
  forward out from under the cap, so each leg channel carries a detent rib
  (`shutterLegRib` 1.35, a 45 degree ramp toward the front, square toward
  the switch) that the 0.3 mm legs flex past and sit behind; and the order
  is now proved by swept gates (the plunger's ride clear of the shell, the
  seated plunger clear and 2.0 proud, the switch's ride clear of the shell
  and of the seated plunger, a switch at its stop blocking the plunger's
  ride): plunger first, switch second, face third; switch-first is
  geometrically impossible and the README says so. 187 gates.
- **The second coupon round, and the slot** (twenty-third cut, 2026-11-21;
  the owner: "camera fits perfectly in 8.1, shrink bar is 99.9mm, carrier
  board fits perfectly in the corner, and the button mechanism still has
  no way for the switch and the button to be fit in there and also its too
  tight for the button to even fit in without the switch"). `camBody` 7.9
  (+ 0.2 = the 8.1 pocket), `shrinkPct` stays 0.2 (99.9 is inside the
  calliper), `ledgeW` and `carrierClear` confirmed. The button: the 0.2 of
  headroom was not a tolerance but an identity (switch height less the
  deck less the proud cap), so the guide is now a slot in the deck open
  toward the face, the pod moved to the deck's front edge (axis Z 32.5, X
  105.5, the cap's front 0.4 off the face's back), the chamber 18.6 wide
  with 0.5 a side round a 17.6 flange (1.5 over the step all round), the
  floor carrying a 6.6 x 6.6 x 0.5 pocket the switch seats in, the leg
  channels ending inside it, the detent ribs gone, four 0.2 ribs in the
  slot (two on the round end 60 degrees off its apex, printable). The
  order reverses: switch first (1.4 of headroom), plunger second hanging on
  the step over the seated switch (1.1 over its body, 0.3 over its
  actuator), face third; a switch not yet in its pocket blocks the plunger
  (gated). `shutterSwitchFree` 0.3, `shutterPodBottomZ` 21. 189 gates.
  Then, as the coupon went to the bed (the owner: "a slight indent to give
  it a tactile feel"): the cap's top carries an 11 mm spherical dish 0.4
  deep inside a 1.0 flat rim (`shutterCapDish`), gated.

Depth, re-added by a gate every build: 2.0 frame + 0.4 off the glass + 4.6 module (DERIVED from the bench's 17.5 glass to carrier front) + 3.3 inserts
+ 8.0 spacers + 1.6 carrier + 8.5 socket + 2.5 XIAO header insulator
(PROVISIONAL) + 15.0 XIAO back to lens front + 1.0 plate + 4.2 face
= 51.1 mm, against the field body's 74.5 over its lens bar. The body is 7.6
of it; the XIAO connectors (11.0) are the one
stack term the bench can shorten, with low-profile sockets and bare pins. The plate's inner face lands at Z 35.4
from the P4's PCB back, 3.9 mm above the Sense board's top.

## Gates

189 in `generate-carrier-body.mjs`, 0 failures (the list below is the
first cut's; the package README's "Gates" names the current set, which
adds the ledge, the carrier heads' clearance, the stack and the frame
refused turned round, the frame pins and their hold, the pry point open at
the joint, and every coupon's ID in material): the depth chain, the lens
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
4 mm of cap height ("made for bad ideas."), the second round of coupons
(the gauge T02 for the head size, T03 for the ledge and the face pin, T04
for the strap skin and the frame pin's hold), a `hand` parameter, the
independent scan. Issue #252 carries the open inputs: the soldered
header's insulator height, the spacer height with the socket home, the
head size (the first pocket was loose) and stack height on a seated node,
the pins' hold, the active area's position, the field of view.

## Files changed

- `hardware/cad/KINO_CARRIER_BODY/` (new; `print/` and `coupons/`)
- `docs/MAKING_OF.md`, `docs/assets/making-of/` (the archive of every cut's renders)
- `hardware/cad/README.md`
- `hardware/manifest.json`, `hardware/CHANGELOG.md`, `versions.json`

## Verification

- [x] BOM and manifest agree (no new BOM lines; no screw in the body, the pins are cut from filament).
- [x] Wiring and GPIO records agree (unchanged).
- [ ] Assembly and acceptance procedures: the package README carries the assembly; `hardware/TESTING.md` unchanged until a body is printed.
- [x] Affected firmware and KDP assumptions were tested (none affected).
- [ ] Closed-enclosure checks: pending the first print.
- [x] `npm run version:check` passes.

## Decision

Design in progress. Two coupon rounds are printed and read (2026-11-21):
the head size (8.1) and the ledge fit are settled; the pins' hold (T03,
T04) and the third pod coupon with the button decide before the body
prints. Still open: the soldered header insulator, the P4 module can, the
spacer height, a cell that fits the bay.
