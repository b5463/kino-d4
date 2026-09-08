# KINO field body — P4 + four-camera wiggle camera

PETG camera body for the first field test: four-camera wiggle capture,
handheld, a battery bank in a pocket feeding the P4 over one USB-C cable, and
the P4 powering the four XIAOs through the JP1 harness. A measured-fit test
fixture, not the production enclosure. Design version 0.1.4,
[`ECN-0004`](../../changes/ECN-0004-field-body-slab-split-and-cover.md).

It is a plain rounded slab with a raised lens strip and a sliding lens cover.
The Nishika-styled version that preceded it — grip block, stepped top plate,
prism hump — carried 126 cm³ (36 % of the chassis) for the look, and its one
print failed on the bed. Everything below is measured off the released meshes
by the generator's release report or by `verify-release.mjs`.

**Size.** Chassis **131 × 90 × 65.5 mm**, printed as two parts; **74.5 mm** over
the lens bar with the face shell on. Width is set by the P4 module: 117.01 mm
plus two 6 mm walls is 129. Height is set by the module plus the shutter pod's
reach into the cavity, 89.4 minimum. A real N8000 is 205 × 117 × 68.

Depth is a summed stack, re-added by a gate every build:

| Term | mm | Source |
|---|---:|---|
| front plate | 5.0 | design |
| camera-module gap + XIAO stack | 11.5 | **derived**: see below — stack 7.6, stand-off 3.9 |
| XIAO header pins + Dupont loop | 14.0 | kept plugged, by decision |
| XIAO-to-module margin | 1.4 | design |
| component bay | 14.6 | straight USB-C plug, 16.0 less the margin |
| P4 module | 13.8 | drawing |
| foam shim gap | 1.2 | design |
| door plate | 4.0 | design |
| **body depth** | **65.5** | |

The two soft terms are the header loop and the bay: together 28.6 mm, 44 % of
the depth. Soldering the node wiring flat and a right-angle USB-C would take the
body to 49.5. Both were declined for now; the loom stays connectorised.

The stand-off inside that second term is **not a choice**, and treating it as
one is what left the first printed rig's cameras unable to see out. The camera
is a separate module on a **7 mm ribbon** whose connector is on the boards'
**outer** face — the same face the module folds back onto — so the module lies
flat on the stack and its lens looks along the boards' normal. Seeed give the
assembled stack as **21 × 17.8 × 15 mm**, and that 15.0 mm runs from the XIAO's
back face to the **lens's front face**, fold and connector included. So

    stand-off = 15.0 − 7.6 of boards − 3.5 of pocket = 3.9 mm

and the lens's front face lands exactly on the pocket floor. The body declared
3.0 and the wiggle rig declared 7.0; at 7.0 the lens stopped about 2 mm short of
the pocket, which is the fault the maintainer reported off the printed rig. Both
now read the derived figure, so what the rig proves about reach is what the body
does — which was the rig's purpose. Body depth 64.6 → 65.5 as a result.

## What is in the folder

```
print/     the eight camera parts, one file each, in print orientation
plates/    the same eight parts pre-arranged as the two bed jobs - load these
coupons/   bench coupons, the glue-up tool, the two rigs, two 1:1 A4 PDF templates
previews/  renders of every file (pictures, not evidence)
reports/   the release report and the per-shell overhang audits
brand/     the wordmark trace (reserved licence, read at build time)
fonts/     the typeface trace for the engraved serial (Apache-2.0, read at build time)
```

The scripts sit at the root: `generate-field-body.mjs` builds everything into
`.candidate/`; `promote.mjs` validates that set, copies it into the folders
above, removes anything stale and runs the independent scan; `validate-stl.mjs`,
`verify-release.mjs` and `release-set.mjs` (the list of what ships, where, and
in how many parts) are what it calls; `render-stl.py` and
`audit-printability.mjs` make the previews and audits.

## What it is made of

Twenty-one released files, all support-free, all reproduced by
`generate-field-body.mjs`. Print orientation is baked into every STL.

**The camera (`print/`: eight parts, 15.0 h at 0.20 mm / 2 perimeters / 0.4 nozzle)**

| File | Size (mm) | Volume | Time | Notes |
|---|---|---:|---:|---|
| `KINO_FIELD_BODY_FRONT_PRINT.stl` | 131 × 92.2 × 45.2 | 138.00 cm³ | 6.3 h | lens-face down. Plate, pockets, bores, XIAO seats and clamp bosses, posts, light bore, shutter; `D4` engraved on the top wall, serial on the bottom |
| `KINO_FIELD_BODY_REAR_PRINT.stl` | 137.5 × 92.2 × 33.6 | 78.26 cm³ | 3.9 h | cut-face down. Module seat, door grooves and detent ribs, cable exit and groove, tie slots, vents, the strap anchor on the -X wall, rounded rear rim; serial on the bottom |
| `KINO_FIELD_FACE_PRINT.stl` | 131 × 90 × 9 | 53.86 cm³ | 2.9 h | back down, relief up. Rounded front edge, grained plate, lens bar, cells, the cover's track with the hatched stow zone, an unbroken back; serial above the bar |
| `KINO_FIELD_LENS_SLIDER.stl` | 89.4 × 20.4 × 3.0 | 3.86 cm³ | 0.5 h | back down. The KINO D4 wordmark and the thumb ridge raised on it, serial in its back |
| `KINO_FIELD_SLIDER_KEEPER.stl` | 89.4 × 5.5 × 2.2 | 0.9 cm³ | 0.1 h | back down. The block glued into the track's entry gap once the cover is in — the stop |
| `KINO_FIELD_BEZEL_PRINT.stl` | 125 × 80.7 × 4 | 12.25 cm³ | 1.1 h | INNER face down, so the tongues sit on the bed and step in once. Grained outer face; serial under the window |
| `KINO_FIELD_XIAO_CLAMPS.stl` | 85.8 × 28.4 × 3.6 | 2.5 cm³ | 0.3 h | four clamps laid out as cameras 1–4: two straight, camera 3's short kink, camera 4's long short-reach kink |
| `KINO_FIELD_SHUTTER_BUTTON.stl` | 37.5 × 19.3 × 6.2 | 1.20 cm³ | 0.1 h | actuator + retainer, two parts. The retainer's cradle carries a terminal slot through both side walls and a lead notch on each side, so the switch's terminals and its two opposite-end leads are not clamped |

The 92.2 is 90 plus 2.2 mm of feet; the rear half's 137.5 is 131 plus the strap
anchor on the −X wall. Two bed jobs on a 250 × 210 bed, and **`plates/` carries each as one
file with the parts already placed**, 6 mm apart, so nothing is re-oriented in
the slicer: `KINO_PLATE_1_CHASSIS.stl` is front + rear stacked (137.5 × 190.4)
and `KINO_PLATE_2_FACE_DOOR_COVER.stl` is face + door stacked with the cover,
keeper, clamps and button in a column beside (226 × 178). Three gates hold each
plate to the bed, to its part count, and to the exact volume of its parts.

**Two-colour wordmark, for free.** On plate 2 (or the cover alone) the raised
mark begins at exactly Z 2.0. A filament change at that layer prints the KINO D4
mark and the thumb ridge in a second colour with no other change.

**Bench coupons (`coupons/`) — print these first.** Each is a chunk of a
released solid in its parent's print orientation, never a remodelled lookalike.

| File | Size (mm) | Volume | What it answers |
|---|---|---:|---|
| `KINO_SLIDER_TRACK_COUPON.stl` | 102 × 95 × 6.6 | 27.0 cm³ | **Second cut.** The track from the bar's bottom rim (with the entry gap) past the panel's top end, both lips, the detent ribs and the four cells, plus the cover (with its edge crests and relief) and the keeper — three parts. Slide the cover in from the bottom, click it up onto the detent, pull it forward, drop it open, then press the keeper into the gap dry and try to push the cover out. Tests the 0.1 mm side clearance, 0.10 mm of forward play, 0.15 mm detent bite and the keeper's 0.1 mm fit. The first cut (0.3 / 0.17, no stop) rattled and fell out |
| `KINO_SPLIT_JOINT_COUPON.stl` | 40 × 9.7 × 18 | 3.8 cm³ | **New.** One bolt station from each half: peg into socket, M2.5 × 16 down the channel with a 2 mm key into the pilot |
| `KINO_FACE_ALIGN_TOOL.stl` | 85 × 14 × 19 | 9.0 cm³ | **New. Not a coupon — the glue-up jig.** Four Ø6.9 pegs on the 22 mm pitch on a 6 mm bar. Pushed in from the front through the open lens cells, the pegs register in the shell's Ø7.1 land and 5 mm into the plate's own bores (0.10 mm per side) while the glue cures; a lanyard hole at each end pulls it out. It aligns the one thing that matters — the cells to the bores — from the side where nothing is in the way. Carries the serial on the face you hold |
| `KINO_XIAO_STACK_COUPON.stl` | 88 × 30 × 23 | 16.5 cm³ | four stations at true pitch, board stand-off graduated 3/5/7/9. Station 1 (3.0) was chosen from the measurements |
| `KINO_CAM_FIT_COUPON.stl` | 62 × 22 × 4 | 4.2 cm³ | five camera pockets stepped 0.1 mm about nominal |
| `KINO_P4_POST_SCREW_TEST.stl` | 83.5 × 76.2 × 15 | 9.19 cm³ | bridge gauge on the 61.9 × 54.8 standoff pattern; only its four pads may touch the board, and each pad carries the posts' conical socket — Ø4.2 mouth closing to Ø3.6 over 2.0 mm — so it is the fit test for that taper |
| `KINO_SHUTTER_COUPON.stl` | 77.6 × 19.3 × 23 | 6.7 cm³ | **New.** The whole shutter mechanism: a chunk of the front half around X 115 with the recessed collar, the access bore, the pod pilaster, the switch pocket and all four lead exits — plus both button parts beside it. Drop a real **6 × 6 × 4.3 mm** switch in, assemble the actuator and retainer, and press it. Answers whether the stem slides without binding, whether the retainer holds it captive, whether the travel closes the switch without bottoming the stem, and whether the leads get out. The shutter is the only thing a user operates besides the cover and the door, and it was the only one of the three with no coupon |
| `KINO_DOOR_JOINT_COUPON.stl` | 72 × 91 × 15 | 14.9 cm³ | 32 mm of both grooved walls with their square shoulders and detent ribs, plus the matching door length with its relief notch, ramp, crest and dimple. **Print it before the rear half:** it answers the 0.15 mm clearances and whether the click is a click or a shove. The one mechanism with no fallback |
| `KINO_INSERT_PILOT_COUPON.stl` | 64 × 30 × 14 | 10.3 cm³ | pilot diameters for the A2 M2 inserts, and for the M2 self-tappers that hold the bus board on the rigs (the face shell no longer uses any) |

`KINO_LIGHT_MOUNT_COUPON` is retired: the shaft and closed nut pocket it tested
went with the prism hump. The mount is a plain bore in a flat wall now.

**Rigs.** `KINO_WIGGLE_TEST_RIG.stl` (88 × 126 × 21, six parts) and
`KINO_WIGGLE_RIG_SKELETAL.stl` (88 × 85 × 21, five parts) are working
four-camera fixtures with the released body's own camera stations. Each now
carries its own four short bow clamps beside it: the camera's clamps grew a
21 mm reach (see the USB note under the XIAO stations) that the rigs, which
have no module and no light stud, do not need.

**Everything else.** `brand/kino-d4-mark.json` is the wordmark traced to
vector outlines by `brand/trace-mark.py` from
`docs/assets/brand/kino-d4-black-on-light.png` (12 polygons, 472 vertices:
the raster upsampled four times to 0.0175 mm, contours smoothed over 0.16 mm
and simplified to 0.01); both sit under the brand's
reserved terms in `REUSE.toml`, and the generator reads the trace at build time
rather than embedding reserved artwork in CERN-OHL-S source.
`reports/field-body-release-report.json` is the gate run that made these
files; `reports/*-overhang-audit.json` are per-shell >45° audits from
`audit-printability.mjs`; `coupons/KINO_P4_1TO1_HOLE_TEMPLATE.pdf` is the
print-at-100 % paper check for the standoff pattern and
`coupons/KINO_DOOR_FOAM_TEMPLATE.pdf` the 1:1 cutting template for the door's
foam gasket; `render-stl.py` makes `previews/`.

**Why the templates are PDFs.** An SVG has no page. It opens in a browser or an
editor that fits it to whatever paper is loaded, so there is nothing for "print
at 100 %" to obey — and a 1:1 sheet that has been silently scaled is worse than
no sheet, because it still reads as evidence. These are **A4, 210 × 297 mm, with
their own MediaBox**, so *Actual size* in any print dialog puts 65.5 mm on the
paper as 65.5 mm. Written by hand in the generator — uncompressed, no `/Info`,
no dates, pure ASCII text — so the bytes are identical on every build, which the
byte-for-byte rebuild check needs. Both sheets carry a **100 mm calibration
line**: measure it with the calipers that measured the board, because the one
thing no print dialog can be trusted about is whether it obeyed you.

## Why it is two shells, and why the chassis is two prints

A body printed lens-face down cannot carry raised form on its front — the front
face *is* the bed. So the chassis is a plain tub and the **face shell** carries
the lens bar, printed back-face down with its relief pointing up. Both are built
from one shared silhouette function, so they cannot drift apart, and a gate
checks the shell's cells are coaxial with the chassis bores (measured on the
shipped files: offsets under 0.05 mm).

The chassis is cut at **Z = 31.0, the component-bay floor**, into two prints
of 44.6 and 33.6 mm. Not for time — two mating faces add surface, and this part
is ~89 % perimeter — but so that no single print is 9 h and 65 mm tall on a
printer that has already lost one. The plane was chosen because **the whole
optical datum lands in the front half**: plate, camera pockets, lens bores, XIAO
seats and fences, the 22 mm pitch. The rear half holds only the module seat and
the door, so joint compliance cannot reach the wiggle. A gate measures it: the
rear carries 0.000 mm³ forward of the cut, the front carries 100 % of the plate.

The joint is four **M2.5 × 16 socket-head** bolts along Z in pads on the inside
of the top and bottom walls at X 18 and 92, each with a coaxial Ø4.6 × 3 mm peg
into a Ø4.9 socket. The bolt axis sits 1.25 mm inside the wall face, the head
pocket is open-sided to the cavity, and a 1.45 mm-deep channel in the wall's
inner face carries the head and a 2 mm key from the pocket up to the door plane.
The pads sit in the 4.3 mm strips above and below the module footprint — the
only room the bay keep-out leaves — which is what makes the heads reachable
with the module fitted: **the halves come apart with only the door off.** A
Ø2.5 driver clears the module by 1.80 mm.

The pad's front end stands on a 55° wedge and stops 9 mm forward of the cut. It
was first a gusset down to the plate, which walled off the Dupont loom's
raceway at X 87–97 (the gate read 45 mm² free against 45 needed); the loom now
passes under the pad in Z 5–17. There is no rabbet: one leaves half the wall
hanging 3 mm above the bed on whichever half prints cut-face-down.

**The seam is drawn, not left.** The two halves meet in a 442 mm line right
round the body at Z 31, and a butt joint there is two first layers touching:
the loudest thing on the camera that says "printed in two pieces". Each half's
outer edge is chamfered **0.6 mm deep at 50°**, so the line sits at the bottom
of a 1.2 × 1.43 mm V-groove and reads as a parting line somebody chose. It
costs a tenth of the wall, and the bolt's head pocket still stops 2.25 mm
short of that face. 50° and not 45: the rear half prints cut-face-down, so its
half of the V is a downward face — at 45 the slice epsilons made it 44.5,
shallower than the rule, and 426 mm² of overhang appeared the moment it was
built. 50 is the door window's angle and the same reasoning. The strap anchor
stands on the cut plane, so the groove is cut before the anchor is added and the
anchor bridges it; a groove through its base would leave it hanging in the
rear half's print. Four gates: grooved on all four faces, solid two rises
below, both halves carrying their half, and the wall left alone.

This joint took three passes. M3 with the axis mid-thickness put half of every
head pocket inside the wall with solid material above it — the head could never
have been lowered in — and the audit showed the pocket ceilings as four 24 mm²
overhangs. Two gates now probe the head's own diameter from the pocket floor to
the door plane, and the key shaft on through the door zone to open air.

## The P4 module

Drops in from the rear, display rearward. Its four **Ø3.5 × 3.3 mm** brass
standoffs (**measured** — re-measured twice; Ø5.4 × 3.0 stood in this record
and in every socket built to it until the maintainer caught it) sit in
**conical sockets**
in the posts: **Ø4.2 at the mouth closing to Ø3.6 at the floor over 2.0 mm** —
0.35 mm a side to find the brass, 0.05 a side where it bottoms, a light press
on a printer that shrinks holes, with 1.9 mm of post wall around the mouth.
Straight bores came before it (0.25 then 0.15 a side); the maintainer asked for
tighter with a lead-in, and a taper is what a printer reproduces — the first
tenth of a straight bore is what decides a press fit, and a printer misses that
by exactly its own tolerance. Floor at the old post-face plane so the PCB back stays at
Z 45.6 and the post rim stops 1.3 mm short of the board. The sockets locate the
board in plan; foam against the door holds it in Z. No screw enters the
module. Gated three ways per socket: a Ø3.48 brass fits to the floor, a Ø3.7
touches the wall in the first 0.3 mm, a Ø4.0 clears the top 0.3 mm. **The
bridge gauge carries the same cones in its four pads**, so its first print is
the fit test.

**Getting it out again.** There is no lift tab and nothing to push through
from the front, so the only grip on the module is its own long edges. The
strip beside each one is a real feature, not leftover space: **4.3 mm deep,
clear for 115 mm along the bottom edge and 95 along the top**, which is two
fingernails under the board. The scan measures both runs, so a boss or a rib
added later cannot quietly fill them.

**Use foam thicker than the gap.** The gap is 1.2 mm; the shim must be about
2 mm stock or there is no preload at all. Cut it against
`coupons/KINO_DOOR_FOAM_TEMPLATE.pdf`, printed at 100 %: two black lines give a
ring **5.3 mm wide at the sides and 3.3 top and bottom**, its inner edge on the
door's window and its outer edge 0.75 mm inside the module's outline, so the
foam bears on the module's border without hanging into the bay. The active area
is drawn on the sheet too — the ring's inner edge stays 5.7 / 2.6 mm clear of
it, so the gasket can never shadow the picture. A gate holds those figures to
the geometry.

The standoff pattern is **61.9 × 54.8 centre pitch** and the posts are
**Ø3.5 × 3.3 brass**, both measured off the module. The pitch was briefly
carried as 65.5 × 58.2 and the first bench print's four posts SPLAYED on it:
that figure was a span read across the standoffs' OUTSIDE EDGES and entered in
a field that means centre-to-centre. 61.9 + 3.5 = 65.4 and 54.8 + 3.5 = 58.3,
so it was the same four holes described from a different datum. A gate now
requires `pitch + standoffOD` to match the measured outside span within
0.5 mm, so an edge reading entered as a pitch fails the build instead of
reaching a printer. Its **9.3 mm offset from module centre** is the one number
on the module still unmeasured — `coupons/KINO_P4_1TO1_HOLE_TEMPLATE.pdf`
printed at 100 % checks it before the first full print.

## The door and its window

Slides in from the low-X end on square-shouldered tongues bitten 1.5 mm into the top
and bottom walls, stops against the far wall, clicks shut. Tool-less. A finger
scallop on its edge opens it.

**The door prints inner-face-down, and that is what makes the dovetail
printable.** It printed outer-face-down for two versions, because the bed gives
that face the best finish on the camera and the panel framing the screen
deserved it. The reasoning was fine; the orientation was wrong, and steepening
the ceiling (below) was necessary but not sufficient.

The wedge's section is a **Z** — full width at the door's inner face, narrowing
to the lip, flaring back out to the deep face. Printed outer-face-down that Z is
upside down, so the wedge's outermost tip arrived **1.5 mm above the bed with
nothing beneath it**: measured on the shipped STL, **36.9 mm² of material
appearing out of air in a single layer, 0.147 mm wide along the whole 125 mm of
both edges**, seeding a 337 mm² dovetail off a line the printer had to lay in
space. No angle fixes that. Every overhang gate passed it — here and in the
independent scan — because all of them asked how *steep* a downward face was,
and none asked whether its lowest edge had anything to land on.

Turned over, the same section sits on the bed at full width and tapers upward.
The dovetail has **no downward face at all**, and the surface that mates the
groove is now referenced to the bed, which is the best any face on the part can
be. Islands go from 36.9 mm² to **zero**; bridges from 45.7 mm² to 2.2; the
widest bridge from 1.48 mm to 0.04.

Three things fall out of it for free: the serial in the outer face stops being a
recess roof on the bed (24.9 mm² of it) and becomes an upward-opening recess,
the window's outer bevel becomes an upward cone, and the finger scallop opens
upward. What it costs is the show face, now the print's top surface instead of
bed-glass — answered the way the face plate answers it, with the same 45° grain,
so the camera reads as one finish across the walls, the plate and the door.

**No dovetail: a square-shouldered tongue.** A 1.5 mm tall rectangular tongue
on each door edge runs in a 1.85 mm rectangular groove under a flat shoulder.
The dovetail was tried at 47° and then at 55°, and **the angle was never the
problem** — the mechanism was wrong for these two print orientations:

> the foam pushes the door **outward**, so the body's retaining surface must
> face −Z; the rear half prints cut-face-down, so −Z is **down**; and a
> **sloped** retaining surface therefore always begins as an unanchored knife
> edge.

Measured layer by layer on the shipped rear half, in a 4 mm window across one
wall:

```
Z 30.60   Y: 85.51-87.00                    wall only
Z 30.80   Y: 84.00-84.11  85.51-87.00       0.11 mm island, 1.4 mm of air beside it
   ...                                       grows for eleven layers
Z 32.80   Y: 84.00-87.00                    only now does it meet the wall
```

That is a 118 mm long, 2.2 mm tall unsupported flag on each wall. A square
shoulder is **strictly better**, which is the counter-intuitive part: its roof
appears in **one layer at its full 1.5 mm width**, touching the groove's deep
wall in that same layer — material solid all the way down — so it is a one-sided
1.5 mm bridge off a root that exists, like the roof of any counterbore. Re-probed
after the change, the groove is open for seven layers and the shoulder closes
complete in one. On the door the tongue is a plain two-step plan, full width on
the bed and narrowing once, and the door now measures **zero unsupported
material of any kind** — no islands and no bridges at all.

What the dovetail was for — resisting the door lifting under preload — the foam
does not need. A square shoulder simply stops it, and a slope under load only
cams the door sideways. Retention is complete because both tongues are captured:
the door moves in X and nowhere else.

**How much this asks of the printer, measured.** The shoulder is the largest
unsupported event on the camera: **one layer, 310 mm² reaching 1.4 mm** from
anchored material, continuous over 118 mm on each wall. For scale, the worst
thing on the front half is the light stud's Ø8.5 bore roof at **1.0 mm** — so
the shoulder is 40 % further out and about 30× the area of anything else in the
job. In bead terms it is ~3.5 lines at 0.4 mm: the slicer lays the outermost
perimeter over air, then two or three more, the last landing on solid wall, and
the layer above is fully supported so nothing propagates.

It will print — a 1.4 mm one-sided ledge in PETG at 0.20 mm is ordinary
hole-roof work. It will also **sag a tenth or so** on that first line, and that
is the real risk, because the shoulder's underside is the surface that sets the
door's Z fit. So the Z clearance is **0.35 mm** while the sides stay at 0.15,
and the asymmetry is deliberate: on this joint Z clearance is *free*, since the
foam presses the door outward against the shoulder and takes up whatever gap is
drawn. The sag has somewhere to go and the joint still cannot rattle. It costs
0.2 mm of wall over the shoulder — 2.35 down to 2.15, against the 2.0 its gate
requires.

**This is what the door-joint coupon answers**, and it is the reason to print it
first: 14.9 cm³, and it carries 32 mm of both shoulders at full depth.

By **angle** the flat ledge scores worse than the cantilever it replaced (the
rear half's >45° downward goes from 100 to 455 mm², about 354 of it the
shoulder), so three angle budgets were raised and the per-triangle limits
removed. That is not a relaxation: triangle area was standing in for unsupported
*span* and cannot tell a 1.5 × 118 mm anchored ledge from a cantilever in mid
air. The layer gate can, and it is the authority for these parts now.

**Superseded, kept for the reasoning — the dovetail's angle.** The groove ceiling in the rear
half and the wedge's top face on the door are one surface seen from two sides,
and in both parts it is an unavoidable *downward* face — the rear half prints
cut-face-down, the door outer-face-down — leaning out over air for the door's
whole 118 mm. It was **47° from horizontal**, chosen as "comfortably past the
45° rule". It is not: 47° from horizontal is 43° from vertical, inside a
slicer's overhang shading and inside some slicers' support threshold, and that
is where the maintainer found it — **688 mm² on the rear half and 730 on the
door**, the four largest downward faces on either part and the shallowest large
surface anywhere on the camera. The rule this design actually uses for an
unavoidable downward face is **50°** — the window bevel and the seam chamfer
both — because at a nominal 45 the slice epsilons produced 44.5 and 426 mm² of
the seam read as overhang.

So the 2.15 mm rise stays and the bite shrinks from 2.0 to 1.5: **55.1°**, five
past the rule, and the face is shorter as well as steeper. The door now has
nothing shallower than 48° on it at all, and the rear half's shallowest large
face is a foot chamfer. It costs 0.5 mm of engagement a side — still more than
the 1.2 mm lips that hold the lens cover — and buys 0.5 mm more web between the
groove and the cable groove in the same wall, so that gate reads 2.5 mm rather
than 2.0. Keeping the bite at 2.0 and raising the rise to 2.86 was the other
route to 55°, and it would have left 0.14 mm of wall over the groove. Both
slopes derive from one pair of parameters, gated at ≥ 50°: a wedge cut to a
different angle than its groove either binds or rattles, and nothing else in
the assembly would tell you which.

**Second cut of the fit and the click, after the cover coupon.** The door was
built to the same numbers as the cover's first cut: 0.3 mm a side, 0.3 mm
under the groove ceiling. Now **0.15 and 0.15**; the wedge's top face is
parallel to the 55.1° ceiling above and its lip height is derived from that clearance.
And the detent it had did not exist: a Ø0.9 bump on the wedge stopped 0.05 mm
short of the groove wall and its dimple was 0.15 deep, so with the door centred
nothing touched — the gate that said it held (0.087 mm³ of "engagement") was
reading the same resting film the free-travel positions show. The detent is
turned round: a **Ø1.0 vertical rib on each groove's deep wall**, standing on
the groove floor 2.1 mm tall, 12 mm in from the entry, sunk so exactly 0.30 mm
stands proud (0.15 of clearance, 0.15 of bite). The door's wedge carries a
0.2 mm relief notch the rib rides in freely for the whole slide — open toward
the door's inner face, so it has no ceiling in print — a 0.8 mm ramp up onto a
2 mm crest of full bite, and a 0.25 mm dimple at the seat. Closing clicks in
the last 2.5 mm; opening climbs the crest. A rib, not a sphere, because a
vertical cylinder on a vertical wall prints as a pillar with no overhang, and
its flat flank is what the wedge's face rides. The gate is a needle at the
rib's tip: inside the wall, in the dimple when seated, in the crest 1.5 mm off
seat, in free air 20 mm off seat — four yes/no answers, not a volume — and the
independent scan repeats it on the shipped files.

The window is **105 × 61.4 mm** with a 2 mm flare at 50°, over a 93.6 × 56.16
active area from the module drawing. That leaves 5.7 / 2.6 mm per side of the
panel's own dead border visible and 6.0 / 4.0 mm of lip over the module's edge,
with a frame that is even at 10.0 / 10.3 mm per side. It was 94 × 57: 0.20 mm
per side over the active area in X against the 0.25 mm of module float the
sockets then allowed (0.15 now), so the door
would have clipped the picture, and uneven at 14.9 / 12.1, which is most of why
it read as heavy. Most of any frame here is the panel's own 11.7 mm dead border,
which no enclosure can remove.

**Assumption, named:** the active area is taken as centred on the PCB. Calipers
from PCB edge to glass edge on both sides, before printing the door.

## The lens cells and the field of view

Nothing the camera can see may be part of the camera. The cells are set out
from the sensor's **field cone** — a 78° diagonal *design* figure for the OV3660 modules fitted, plus 2° margin,
from a pupil assumed 2.6 mm behind the plate face, the worst case — not from
fixed diameters. The first version used Ø14 / Ø11.5 / Ø7.1 and left 5.06 mm of
parallel Ø7.1 bore in front of the pupil, which passes 70°: **the shell was in
every frame.** Cells are Ø18.4 at the panel floor now, 3.6 mm of web between
them, and the assembled shells pass **81.9° on all four lenses**, measured with
the lens cover fused in at its open position. Two gates: the clear angle, and
that all four agree to 0.00°.

**Assumption, named:** 78° is a **design figure, not a measurement**. The
modules are OV3660, and `docs/HARDWARE.md` carries their field of view as
`MEASURE_REQUIRED` — the lens on the module decides it, not the sensor. The
shells pass 81.9°, so any module up to about 81° diagonal is clear; a wider
lens needs `camFovDeg` raised and the cells re-cut. Measure it in two minutes:
photograph a ruler square-on at a known distance *d*, read the width *w* that
spans the frame corner to corner, and the diagonal field is 2·atan(*w*/2*d*).
(This was first written as "OV2640, 78°" — the XIAO Sense's default module,
which is not the one in this camera.)

The chassis bores are **Ø7.10** for a **Ø7.0 barrel (measured)** — 0.05 mm per
side, a guiding fit so the lens cannot shake in its socket. Ream with a 7 mm
bit if it prints tight; a barrel that binds crooked is worse than a loose one.
Each camera head is located by an 8.5 mm pocket with two 0.2 mm pinch ribs per
axis, and the XIAO behind it presses it onto the pocket's seat. The module's
PCB is **17.9 × 15.5 × 3.5 mm (measured)**, mounted long axis vertical, which
is what keeps four of them 6.5 mm apart at 22 mm pitch. `verify-release.mjs`
finds the four bores by slicing the shipped front half: pitches 22.000 /
22.000 / 22.000, all on Y = 43.000, all Ø7.100.

## The sliding lens cover

Vertical, over the cells only. Four lenses span 84.4 mm, so a sideways slider
needs 169 mm of face and two barn doors need 127 of 131; a cover over just the
cells needs 21 mm of travel with 21 mm of stow room.

**It drops to shoot.** The first coupon was built the other way, stowing above
the cells; the maintainer wanted the cover to go *down* from the shooting grip,
so the track is turned over. The lens bar runs Y 3.9–60.7 and its recessed
panel is the track: 2.2 deep, Y 11.1–53.5, with dovetail lips 1.2 mm deep on
both side walls (underside at 50°). The cover is an 89.4 × 20.4 × 2 mm plate
with matching 45° edge bevels and R0.6 plan corners. **Up covers** (Y 32.8–53.2,
100 % of every cell mouth), **down reveals** (Y 11.4–31.8, 0.000 mm³ over any
cell, top edge 2.0 mm below the cell bottoms), 21.4 mm of travel.

**The detent.** One Ø0.8 vertical rib on each track wall at Y 32.3, standing on
the track floor 0.8 mm tall, in the 1.0 mm between the two positions, sunk into
the wall so exactly 0.25 mm stands proud (0.1 of clearance, 0.15 of bite). The
cover's side edges carry the other half: a **1.5 mm crest** of full edge at each
end, a 0.6 mm ramp, and a 0.2 mm relief channel between, over the vertical part
of the edge where the ribs run. Leaving either position the end crest climbs
the ribs — that is the click, and what holds the cover closed against gravity —
and for the 18 mm between, the ribs ride in the relief and nothing touches.
The first version of this detent was two Ø1.2 spheres in a 0.5 mm gap against a
cover with R2 corners: the corner swept past the sphere with a millimetre to
spare, the generator's "runs free" gate passed for exactly that reason, and the
independent scan's needle probes were what found it. Gated four ways now: ribs
present at 0.25 and only there, edge crests share material with the ribs 1.0 mm
out of either position, nothing shared halfway, and both rest positions free.

**Tight, this time.** The first coupon (0.3 mm a side, 0.4 mm of depth
clearance, 0.17 mm of forward play) rattled in the hand. Now: **0.1 mm side
clearance, 0.2 mm below the bar's face, 0.10 mm of forward play** before the
bevel meets the lip (the lip was 1.25 deep; at 0.2 of depth clearance 1.2 gives
the 0.10). If the printed cover binds, fine paper on its edges; if it is loose,
the coupon has already told you before the face is printed.

**The lips are backed now.** The accent ledge used to run as a frame around the
whole panel, which put 0.8 mm of air behind the top of each dovetail lip: the
lip's top stood as a free fin 1.0 mm wide tapering to 0.3 — the retaining edge
of the cover, printed as one bead. The independent scan's thin-feature pass
found it. The ledge now runs along the top and bottom of the panel only, and
the lips have the full 4.7 mm side rim behind them.

**A stop, not a bump.** The cover enters from below through a gap in the bar's
bottom rim, at the open end. Once it is in, `KINO_FIELD_SLIDER_KEEPER.stl` — the
very piece of rim the gap removed, 89.4 × 5.5 × 2.2 mm, 0.1 mm smaller on its
three fitted sides — is glued into the gap. Its back sits on the track-floor
plane, its front is the bar's own rim, ledge and chamfer, and a cover pushed
1.5 mm past open meets 136 mm³ of it. The first coupon had only two bumps here
and the cover fell out. Gated: the keeper is one part, seats clear of the face
and the open cover, blocks the overrun, fills the gap's mouth, prints flat.

The cover carries
the **KINO D4 wordmark**, raised 0.6 mm and standing 0.2 mm proud of the bar:
80.0 × 10.7 mm, traced from the brand raster to vector outlines (12 polygons,
472 vertices, smoothed and straightened to 0.01 mm) so the italic diagonals and
the round letters print as smooth walls. A first trace followed the raster's
pixel edges at 0.07 mm and straightened to 0.05, which put 0.9 mm chords on
the "o" and still looked faceted in the slicer. The thinnest stroke, the D4 box
outline, measures 0.46 mm — one extrusion line, and gated. The thumb ridge
below it is the catch.

The panel floor the open cover uncovers is now *below* the closed position
(Y 12.6–31.3) and carries the hatch; the floor under the closed cover stays
solid.

## Soft edges, cable groove, vents, thumb ridge, wake on open

Five things added after the slab was done, all free in print terms.

**Rounded front and rear edges.** The chassis prints face-down and cannot
round its front; the face shell prints relief-up and can, and the rear half
prints cut-face-down so its rear rim is on top and can too. Both carry an R3
quarter round over their full edge — the face's over its 3 mm base plate, the
rear rim's over the last 3 mm before the rear face — built as a hull of six
insetting slices, every face of which points up-and-out in print. Front and
back edges soft, sides square, which is what the reference slab cameras do. The
feet hang below the outline and are kept by the same intersection.

**Cable groove.** The USB-C leaves through the bottom and the feet are 2.2 mm,
so a plugged camera rocked on its 4 mm cable. A **4.5 × 2.0 mm groove** runs
from the exit slot to the rear edge; the cable lies in it and leaves rearward,
0.2 mm clear of the table plane. 2.0 deep and no more: the door's dovetail
bites 1.5 into the same wall from inside over the door zone, and a gate holds the
web between them — now 2.5 mm, since the dovetail was steepened and its bite
shrank.

**Vent slots.** The module's heatsink faces forward into a closed PETG bay.
**Four 2 × 11 mm slots through each side wall** at Y 26 / 38 / 50 / 62, Z 33–45
— ahead of the module face, inside the rear half — with 45° gabled ends so no
end face is a ceiling. All eight gated open. Whether they are needed at all is a
temperature reading with the door on; they cost nothing to have.

**Thumb ridge on the cover.** A **22 × 1.6 mm ridge**, 1.0 proud of the cover
and so **0.8 mm proud of the bar**, below the wordmark. The thumb catches its
top edge to push the cover down (open) and its bottom edge to lift it closed,
without looking. Gated at 0.80 ± 0.05.

**Knowing where the cover is: no sensor.** There was a TO-92S Hall switch in a
Ø4.5 × 5.5 pocket cut from the face's back at X 107.5, Y 36, its lead in a
2.5 mm gabled channel down to Y 20 and through a Ø2.4 hole in the plate, with a
Ø3 × 1 N52 disc flush in the cover's back over it. **It is gone.** The cover's
state is read in firmware instead — all four sensors dark means the cover is
down, all four seeing colour means it is up — so the magnetic path answered a
question that was already answered, and it was the more expensive of the two:

- The switch had to be seated **before the shell was glued on**, and that joint
  is permanent. It was the only irreversible step in the assembly, and the only
  way to get it wrong was to forget it.
- Its GPIO is on a XIAO anyway, because JP1 has no free P4 pin (ECN-0003), so
  the state arrived over the UART link — the same path the luminance reading
  takes.
- It cost the front plate its only opening besides the four lens bores, and
  that hole sat 2.4 mm wide in the middle of the board field.

Nothing replaces the geometry: the shell's back is unbroken except at the lens
bores, and the cover's back carries only its serial. Four gates and one
independent check now assert the **absence** of all four features, because a
removal that half-happens is worse than either state — a blind pocket nobody
fills is a void in a permanent glue joint. What the firmware method cannot do is
in `docs/HARDWARE.md`: it cannot tell a closed cover from a dark room, it cannot
*wake* the camera (`camIdleTimeoutS` cuts the camera rail), and its two
thresholds are still `MEASURE_REQUIRED`.

## Identity marks

Every part with room for it carries **its design version and a build serial**,
engraved 0.4 mm deep: `REV 0.1.4 · SN 001`, 45 × 4.3 mm, set in **Roboto
Regular** at 4.0 mm caps, emboldened 0.08 mm a side so its thin joins clear one
nozzle line (a gate erodes the outline by 0.225 and re-dilates; under 1 % of
the ink is thinner than 0.45 mm). The typeface is traced to outlines by
`fonts/trace-font.py` into `fonts/roboto-regular.json` (Apache-2.0, declared in
`REUSE.toml`); no font software ships. It replaced a hand-drawn stroke font
the maintainer called too basic, which had replaced 5 × 7 pixel glyphs. The
version is read from `hardware/manifest.json` at build time, so the part and
the record cannot disagree; the serial is the `buildSerial` parameter. Where
each one is:

| Part | Face | Reads with |
|---|---|---|
| front half | bottom, X 65.5, Z 27 | camera upside down, lens away from you |
| rear half | bottom, X 88, Z 47 | same |
| face shell | front, above the lens bar at Y 68 | facing the camera |
| lens cover | its back, under the wordmark | cover out of the track, turned over |
| door | outer face, under the window at Y 7 | from behind the camera |
| alignment tool | the face you hold | — |
| spec line | bottom, X 65.5, Z 20 | same as the serial, and above it |

The clamps and the shutter button are too small for a legible 4 mm engraving at
a 0.4 mm nozzle and carry none. The chassis' top wall carries the **wordmark's
own boxed `D4`** as a badge: the six polygons of the box cut out of the brand
trace, scaled to 9.0 mm tall (25.3 wide, box outline 0.6 mm), engraved at X 90,
Z 24 — left of the shutter for the photographer, between the light bore and the
shutter collar. The face's stow zone — the track floor the open cover uncovers,
Y 12.6–31.3 — is **hatched** with 0.6 mm grooves on a 2.5 mm pitch at 45°,
0.3 mm deep (24 % of that floor); the floor under the *closed* cover is gated
100 % solid so the closed position reads as a clean rectangle.

**Camera numbers.** `1` to `4` are engraved 0.4 mm into the **plate's inner
face**, 1.5 mm above each board's top edge at Y 62, in the same 4 mm typeface.
Look into the open bay and each node names itself instead of being counted
across, and the number still shows with a board fitted. That face points up in
the front half's print, so they are upward-opening recesses and cost nothing.
A reader looking into the bay has +X on their right, which is the order the
cameras are counted in, so the digits are placed on the "rear" face normal.
Each is gated to sit on bare plate — nothing standing in the 3 mm above it —
and above its own board's edge. The rigs inherit them: their plate is a chunk
of this one.

Fifty gates cover the marks: for each of the eleven, that it is cut (uncut
residue under 3 % of the recess), reads the right way round (the part is
brought back into the text's frame and the ink in its left and right thirds
compared with the text's own), that every stroke clears one nozzle line, and
that it leaves material behind it; plus the four bare-plate checks, hatch
density and the closed zone unhatched. The marks on bed faces (cover, tool,
door) have 0.6 mm ceilings — bridges, not overhangs — and the coupon
support-free limit allows for them; the halves' serials are on a wall in print.

## XIAO stations, clamps, and reflashing a node in place

Each XIAO sits lens-down on two corner pads between two locating fences, its
camera head in the plate pocket, and a bow clamp presses a 9 mm strip of its
bare back between the header rows down onto the pads. The clamp screws into an
A2 M2 insert in a boss on the plate.

**The boss moved so a node can be reflashed without coming out.** The XIAO's
USB-C opens at the board's top end, on the side facing the plate. The boss used
to sit 2 mm past that end, dead in the plug's path: no plug could enter and a
node could only be flashed by unclamping it and lifting it out on its loom. The
boss for cameras 1–3 now sits against the top wall (Y 81.5, fused 2 mm into
it) on a 21 mm arm: cameras 1 and 2 straight, camera 3 kinked 4 mm to +X to
clear the light stud's nut sweep. **Camera 4 could not go to the top wall:**
the split-joint pad at X 87–97 hangs over that spot from Z 22, and no driver
reaches a screw under it — the maintainer saw it in the slicer, and there was
no gate for it. Its boss stays at the original 6.5 mm gap and kinks 11 mm to
+X (X 109.5), clear of its own plug channel, the shutter leads' run and the pod.
`KINO_FIELD_XIAO_CLAMPS.stl` holds the four clamps laid out left to right as
cameras 1–4: two straight, one short kink, one long kink. To reflash: door off,
module out, that node's one M2 out and the clamp lifted; then a plug has
16.5 mm of straight room along the board. Gated with a 12 × 7 mm plug envelope:
**nodes 2 and 3 take any plug; nodes 1 and 4 meet the P4 post with a straight
plug (23 and 8 mm³ of overlap), so they take a compact right-angle plug** (7 mm
body), which is gated clear for all four. Node 4 joined node 1 when the standoff
pattern was re-measured and the posts moved outward; the gate requires only that
every node be reflashable with *some* plug, and reports how many also take a
straight one, because the pattern is calipers on the board and the 12 × 7 mm
envelope is my own conservative guess at a moulded plug — not a figure worth
moving a measured post to protect. And every clamp screw is gated reachable: a Ø5 driver shaft from
the clamp's top face to the rear face, module out, must pass both halves and
every other clamp.

**Strap anchor.** A 10 × 6.5 × 8 mm lug on the **−X** wall of the rear half,
Y 66–76, standing on the cut plane (Z 31–39) with a **Ø3.5 vertical cord hole**.
In the rear half's print the cut is the bed, so the lug's underside is bed
contact and the hole is vertical: no overhang at all.

**It was on the +X wall, and that was wrong for the hand.** The shutter is at
X 115, so a right hand wraps the +X end and the palm covers most of that wall —
which is exactly where a 4.5 mm proud block with a cord hole was sitting, under
the heel of the hand. There is no spot on the grip-side wall a palm does not
cover, so it came off that wall rather than shuffling along it. The right hand
now grips a wall unbroken apart from the flutes, and the camera slings and hangs
from the left.

**It also had 0.5 mm of PETG between the cord and the outside.** The bore was
centred 2.25 mm proud of the wall face in a lug that ended 0.5 mm further out —
one bead, on the part that carries the whole camera if it swings, and nothing
checked it. Proud distance and bore position are **derived from the cord** now
(wall + cord + wall), so the lug cannot be drawn thinner than what it carries:
**1.5 mm each side**, gated on both. Protrusion goes 4.5 → 6.5 mm, which is
2 mm worse and free, because it is now on the wall nobody grips. Straddling the
bore across the wall face was tried first and is wrong — the wall fills the
inboard half and the hole comes out as a notch, not a loop.

Gated: hole open, walled both sides, on the rear half alone, clear of the vent
slots and the rear rim round, and **not on the wall the shooting hand grips** —
that last one derived from where the shutter is, so the two cannot drift apart.
There is still no tripod boss, and there is still only one anchor: a two-point
strap needs a second one, and the +X end is the only place for it, which is its
own trade.

**Open: microSD access.** The module's TF slot sits on a module edge that faces
a wall, and the body gives it no opening; `docs/HARDWARE.md` says to preserve
access to it. Cards come out only with the module removed until the slot's
position along the module edge is measured and a wall opening cut for it.

## Finish

Four things exist only so the camera does not advertise how it was made.

**Flutes on the body walls.** Both chassis halves print with Z straight up, so
all four outer walls are *vertical* walls and their only finish is the layer
line. Measured off the released meshes that was **88 % of everything the eye
sees on the rear half and 72 % on the front** — about 330 cm² wrapping the whole
camera, against the 91 cm² of face plate that had the grain. It was the largest
untreated show surface on the object by a factor of three, and it is the surface
a hand is actually on.

They run **along Z**, straight up in both prints: a vertical groove in a
vertical wall has no roof, no bridge and no overhang, and a texture hides layer
lines best when it runs *across* them. A **45° V, 0.25 mm deep and 0.5 mm wide
at the surface on a 1.6 mm pitch**, which is the face plate's grain by eye —
same 0.5 mm groove, same 1.1 mm land — so the body reads as one finish and not
two. A 0.4 nozzle rounds the valley off in the print, so the part comes out as
the half-round a round cutter would have drawn.

A V and not a round *because* of the Booleans: a round cutter has to be tangent
to the wall somewhere along its arc, and 267 tangential Booleans a band is a
sliver factory. It cost two degenerate triangles in the released rear half, and
fading the ends of a round flute out with a tapered clip made that 1027
degenerate triangles and 898 non-manifold edges. The V meets a flat wall at a
definite 45° everywhere and needs four vertices a station instead of
twenty-four.

**267 flutes on a 1.5976 mm step round a 426.5 mm loop.** The count is divided
into the perimeter, not stepped from a corner: step it and the last flute lands
a fraction of a pitch from the first, and the camera has one double line down
one corner for ever. A gate measures the closure.

Two bands, one per printed half, each inset from whatever bounds it — the front
half's bed face, the seam V on both sides (so the parting line stays a bright
drawn line rather than a texture running into a chamfer), and the door plane.
Nothing on an outer wall gets a flute run into it: every engraving, opening,
foot pad and the strap anchor keeps a **2 mm land**. The light's 18 mm base plate
has to seat on a flat, and sizing that land off the Ø8.5 bore instead of the
plate took the seat from 82 % solid to 74 % — the light-mount gate caught it.

Five gates hold it: density on every wall of both bands against an integral of
the V's own section, a solid shell just inboard of the floor (a 6 mm wall keeps
5.75), a land at every seat and parting line, and the closure above. Cost: the
outer perimeter grows about 18 %, and the flute ends put **137.6 mm² of
downward face in 472 regions** on the front half and 100.6 in 396 on the rear —
0.5 mm bridges, which the printability gates read as bridges and pass.

**Grain on the face plate.** The plate around the lens bar is the *top* surface
of the face shell's print, which is exactly where layer lines and ironing marks
show. It carries a linear grain at the stow hatch's 45°: **0.5 mm grooves on a
1.6 mm pitch, 0.2 deep**, taking 31 % of the top fifth of a millimetre and
leaving 1.1 mm lands — clear of the one-bead rule, and coarser than a moulding
texture because a 0.4 nozzle cannot do finer, so it is drawn as a deliberate
grain rather than a fake one. It is a field, not a wash: the plate keeps a
clean border **4 mm inside the outline**, **2.5 mm around the lens bar** and
**2 mm around the serial**, all three gated solid. Built as one cross-section
of 200-odd rotated quads and extruded once, because fusing that many boxes in
3-D is the slow road to the same solid. It costs about eight metres of extra
perimeter, roughly five minutes on that part; the slicer has the real number.

**The seam groove** is described with the split joint above.

**The spec line.** `KINO D4 FIELD BODY` engraved 0.4 mm into the front half's
bottom wall at Z 20, in 3 mm caps — smaller than the serial below it, so it
reads as the heading it is. On a bottom face the reader's up is −Z, so a
smaller Z is higher: model name over revision and serial, the way a plate is
set. It carries the same four gates every other mark does.

Two more finishes cost nothing and are yours at the printer: the accent ledge
around the lens bar is modelled to be picked out with a paint pen, and the
cover's raised wordmark starts at exactly Z 2.0, so one filament change there
prints the mark and the thumb ridge in a second colour.

## Openings

| Wall | Count | What |
|---|---:|---|
| front | 4 | lens cells at 22 mm pitch — **and nothing else**, gated by counting the voids in a slice through the plate |
| top | 1 | shutter, in a Ø17.5 round collar at X 115, Z 21 |
| top | 1 | Ø8.5 light stud bore at X 66, Z 16; the 18 mm base plate (**measured**) seats on the flat top, 13 mm of stud inside for its two nuts |
| left, right | 4 + 4 | 2 × 11 mm vent slots, gabled, Z 33–45 |
| bottom | 1 | 14 × 20 rounded slot at X 40 for the USB-C cable, with a 4.5 × 2 groove to the rear edge |
| bottom | 2 | 3.2 × 6.2 zip-tie slots |
| rear | 1 | the door opening |

No teardrop or gable shows anywhere on the outside: a regular hexagon was tried
as the "nicer point" and is a 60° overhang (its top edges lie 30° off
horizontal), so the answer was round holes and rounded slots, whose apex facets
are a few mm² each. The RESET needle hole is gone; a gate now proves the bottom
wall is solid where it was. There is no tripod boss; the strap anchor is on the
rear half's +X wall.

## Wiring room

The component bay is 14.6 mm deep, sized by a 16 mm straight USB-C plug on the
module's component side less the 1.4 mm module margin. The USB-C sits beside
the GPIO header, which runs down the board's **left** side at mid-height
(photographed; the mapping is not mirrored — RESET is measured at X 106.4, on
the right). The 54 × 33 mm hub board (12.6 mm with its plugged headers) floats
in the bay between the two post rows: a 54 × 33 × 12.6 box at X 38.5–92.5,
Y 26.5–59.5 is measured empty. It will not pass between the post *columns*,
which are 53.9 mm apart. Wrap it in Kapton. The Dupont loom needs 45 mm² of
raceway; the tightest station has 96.

## Hardware

- 4 × **M2.5 × 16** socket head — the split joint. 2 mm hex key.
- 4 × A2 brass M2 heat-set inserts, OD 3.5 × L 4, and **4 × M2 × 6** pan head
  — the XIAO clamps. 6 mm puts 2.4 mm into a 4 mm insert with the 3.6 mm
  clamp on top; an M2 × 8 would bottom 0.2 mm short of the pocket floor and
  is the longest that fits. Driven with a Ø5 or slimmer driver from the rear,
  module out; a gate holds that path open for all four.
- 2 × 1/4-20 nuts on the light stud: **fit and tighten them before the XIAO
  boards go in**, while the cavity is empty behind the plate. Once the boards
  and clamps are fitted the two clamp bosses either side leave 17 mm around
  the stud, room for fingers or long-nose pliers but not a spanner.
- **Glue** for the face shell — PETG-to-PETG, cyanoacrylate or a two-part
  epoxy, thin. No screws: the four corner pilots are gone from both parts.
  `KINO_FACE_ALIGN_TOOL` holds the alignment while it cures. The same glue
  fixes `KINO_FIELD_SLIDER_KEEPER` into the track's entry gap.
- (the light stud's two nuts are listed above with the clamps, because their
  order in the assembly matters)
- No magnet and no Hall switch. Both were on this list; the cover's position is
  read in firmware off the four sensors, and the geometry for them is gone.
- Foam strip, about 2 mm stock, around the door's window lip.
- 1 zip tie for the cable jacket. Kapton for the hub board.

## Assembly

0. Print `KINO_SLIDER_TRACK_COUPON`, `KINO_DOOR_JOINT_COUPON` and
   `KINO_SPLIT_JOINT_COUPON` (3.4 h together) and work them by hand before the
   camera; push the module's standoffs into `KINO_P4_POST_SCREW_TEST`. Print
   both SVGs at 100 %: lay the standoff template over the module, and cut the
   door's foam ring against the other.
1. Heat-set the four inserts into the clamp bosses in the front half. Flash
   the four nodes first if you can; they can be reflashed in place later
   (door off, module out, that node's M2 out - see the XIAO stations section).
   Seat the four XIAOs lens-down — **the plate is engraved 1 to 4 above each
   station**, so a node goes back where it came from — fit the clamps down the
   centre of each board between the header rows; the clamp file lays them out
   as cameras 1 to 4, left to right: two straight, camera 3's short kink
   toward the light bore, camera 4's long kink toward the right wall. Wire
   the JP1 loom and shutter leads with slack.
2. Fit the shutter: actuator through the pod's bore, switch into the retainer
   with its terminals in the cradle's slot — the slot runs out through both
   side walls, so the terminals sit in air and not under the cradle — a lead
   out of each end of the pocket into the bay, retainer cup home. There are
   four ways out of that cavity: one channel off each end of the switch and a
   pair under it, so the leads never bend back across the switch body.
3. Set the rear half on the front half — pegs into sockets — and drive the four
   M2.5 × 16 from the rear through the channels with the 2 mm key.
4. **Glue the face shell on — this step is permanent.** Nothing has to go in
   first any more: with the Hall switch gone there is no part to forget and no
   lead to thread. Push `KINO_FACE_ALIGN_TOOL` into the shell from the front,
   pegs through the four cells. Thin glue on the chassis' front plate, clear of
   the bores, and lower the shell on, letting the tool's pegs find the plate's
   bores — they register the cells to the bores at 0.10 mm per side. Press flat,
   let it cure, pull the tool out by its lanyard holes. Do this with the front
   half **empty**: no cameras, no boards.
5. Lower the module in, display rearward, standoffs into their sockets. Stick
   the foam to the door lip. Slide the door in from the low-X end until it
   clicks. It must press the glass evenly.
6. Slide the lens cover **up** into the track through the gap in the bar's
   bottom rim until it clicks onto the detent, closed. Then glue the keeper
   into the gap, back face on the track floor, rim outward, and let it cure
   with the cover closed. Up covers, down reveals; the keeper is what stops it
   at the bottom.
7. Plug the USB-C, route it out the bottom slot, zip-tie the jacket with a
   relaxed service loop. Thread the light stud through the top and fit its
   two nuts from inside before step 5 if a light is going on.

## Print

PETG, **0.4 mm nozzle, 0.20 mm layers, 2 perimeters**, 20 % gyroid, supports
**off**, brim off. Every part sits on its largest flat face as supplied; do not
re-orient. The first body print failed with supports the part never needed —
if the slicer offers to add any, the part is not sitting as shipped.

Time follows surface, not volume, on this part: the model is calibrated on the
one real slice (27 h at 0.25 mm / 4 perimeters, 2506 m of perimeter path).
Two perimeters of 0.45 mm is 0.9 mm of solid wall on 6 mm walls. Three
perimeters would be 21.4 h. Hollowing anything makes it slower.

At 0.20 mm on a 0.4 nozzle a 45° face has 50 % bead support; the door rails
and the cover's lips are exactly 45°, and print acceptably. They would not at
0.40 mm (33 %).

## How it is verified

**385 gates in the generator**, which throws on the first failure, so a written
`reports/field-body-release-report.json` means every gate passed on that exact
geometry. `promote.mjs` then runs `validate-stl.mjs` on the candidates — every
mesh manifold, the right part count, and, once promoted, in the right folder;
any file not in `release-set.mjs` fails, which is how a stale STL cannot sit in
this folder — copies them into place, removes anything stale, validates again
and runs the independent scan.

**`verify-release.mjs` is the second opinion, and it is deliberately not the
generator.** It re-imports the released STLs through Manifold's own importer,
inverts each print transform, and runs **82 independent checks** on the shipped
files: no penetration between mating parts (judged by the thickness of the
thickest shared piece, because parts that rest on each other share a µm film of
coincident faces), pegs in sockets, head and driver paths to the door, module
and standoff clearance, bores and cells located by slicing, line of sight past
the open cover, coverage under the closed one, the keeper's seat and stop, both
detents by needle probe (bump present, dimple open, crest bites, relief free;
cover crests meet the ribs, mid-travel free), a **thin-feature pass** (every
part sliced each millimetre, eroded 0.45 and re-dilated; a plan feature under
0.9 mm that persists through three slices is a wall one bead thick and fails),
every one of the 21 files on Z=0 and inside 250 × 210, letter direction, and
per-part print readiness.

**The gate that should always have existed** sits in the generator: *every part
builds layer on layer*. It slices each released part in its own print
orientation at 0.20 mm and requires every layer's material to be within reach of
the layer beneath it — one layer height at 45°. What is left over it splits in
two, because one number cannot judge both. A **bridge** has supported material
beside it in the same layer (a bore roof, the top of an engraved letter): the
nozzle starts on solid ground, crosses, and lands on solid ground, and those are
held to the 5 mm span used everywhere else. An **island** has nothing under it
*and* nothing beside it — no solid ground to start from at all — and gets two
limits: never as wide as one bead, because below that the slicer drops it and
the feature merely comes out rounded (the dovetail groove's mouth does exactly
this at 0.06 mm), and never more than 20 mm² in a single layer, because that is
not a stray sliver but the start of a feature. It was verified against the defect
it exists for: **it fails the old door at 36.9 mm² and passes the new one with
zero islands.** All eight printed parts are island-free; widest bridge 1.48 mm,
on the cover's lettering. It also re-measures the **finish** — the seam's
V-groove on all four faces of both halves, the grain's density and its border
land, the four camera numbers, the spec line against a plain band of the same
wall — that reference band now comes from inside the lettering's own 2 mm
land, because since the walls are fluted no other piece of that wall is plain —
and the strap anchor being on the rear half alone, walled both sides of its cord hole. It checks each
**plate against the singles it is made of**. That last one is the worst kind of
drift to have: both files would validate, and the one you actually load in the
slicer would not be the one the rest of this program measured. Measured 0.008
and 0.002 mm³ apart. On its first run it found an **870 mm² overhang on the door**
— a window bevel written as `flare / tan 50°` instead of `× tan 50°` — that the
gates had passed at 5 mm², because `overhangArea` excluded any triangle
*touching* the bed plane and so could not see a chamfer on a bed face. Both are
fixed. On its pre-print run it found three more: the cover's detent spheres
never touching a cover with R2 corners, the track lips standing free over the
accent ledge, and a door detent that the generator's own volume gate had been
passing on film noise. All three are fixed above. A check that imports the
generator is not independent; this one does not.

**Lettering direction.** The body frame is right-handed with the lens face at
−Z, so a reader facing the camera has **+X on their left**; text that reads
left-to-right advances toward −X, and that is how it is laid out. The face and
cover STLs are written by a 180° rotation, so the printed object is the model.
This has flipped twice: it was once "fixed" against a renderer that mapped +X
to screen-right while drawing the −Z faces — a mirror — and it once read
correctly on a printed part only because a Z-reflection print transform
cancelled a mirrored layout. Now the renderer is a true view, the transforms are
rigid, and direction is gated twice. The text layout helper is checked in the
model (`textRunX`, first character at highest X). The wordmark is a traced
outline, not text, so it has no letter to find; instead the trace records how
much ink sits in its left and right thirds — the "k" end carries 768 cells
against the boxed D4's 517 on a 0.45 mm grid — and a slice through the
print-frame cover must show the same imbalance the same way round (measured
1.46 against 1.49). `verify-release.mjs` repeats that test on the shipped file.
The engraved serials are gated the same way, against their own outline.

The renderer had a second fault, found when the cover's engraving appeared
mirrored in a preview: it kept the triangles facing *away* from the viewer and
painted nearest-first, so every thick part showed its far side. Both are fixed
and the previews now show the near side; they are still only previews — a
painter's algorithm can let a small hidden feature show through one large
triangle — the gates and the independent scan are the evidence.

## Removed in this version

Grip block, stepped top plate, prism hump, thumb rest, angled band, grip drum
and ribs, the raised `D4`/`V1` marks (a `D4` badge is engraved in the top wall
instead), the long lens legend, the RESET needle hole, the light-mount coupon,
the Hall switch and its magnet with the pocket, channel and plate hole that
carried them, and 40 parameters nothing read any more.

These are measured-fit test fixtures, not a safety-certified enclosure.
Dry-fit the real boards, inserts, nuts and light before the event.
