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
| rear frame | 3.0 | -16.8 | chosen; its R3 edge round over the full thickness |
| P4 module, glass front to PCB back | 13.8 | 0.0 | OFFICIAL_CAD |
| P4 inserts | 3.3 | 3.3 | MEASURED |
| M2 spacers | 8.0 | 11.3 | the bench set; the J100 socket floats 0.3 mm off home |
| carrier PCB | 1.6 | 12.9 | |
| XIAO socket insulator | 8.5 | 21.4 | Wurth 61300711821 |
| XIAO male header insulator | 2.5 | 23.9 | **PROVISIONAL**: the headers soldered to the owner's XIAOs; the carrier's assembly print left this out |
| XIAO back face to the lens front | 15.0 | 38.9 | Seeed's assembled Sense stack |
| plate ahead of the lens | 1.5 | 40.4 | chosen; the shell's front |
| face | 2.5 | 42.9 | its edge an R2.5 pillow round |
| lens band | 3.5 | 46.4 | the cover, its set-back and 1.3 of floor over the lower pin holes |
| **body, over the lens band** | **63.2** | | |

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
| body in front: plate ahead of the lens 1.5, face 2.5, band 3.5 | 7.5 |
| body behind: the rear frame | 3.0 |
| **over the band** | **63.2** |

The body is 10.5 mm of the 63.2. The one stack term that is a bench choice
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
| `print/KINO_CARRIER_SHELL.stl` | front plate with the four pockets and bores, all four walls to the display plane with R10 plan corners, V-grooves around the side and bottom walls under a deck reveal, four screw pillars, the shutter pod, the rounded strap tab, the LED slots, the USB-C opening, the frame pilots | charcoal | face down, PETG, 0.20 mm, no support (gated) |
| `print/KINO_CARRIER_REAR_FRAME.stl` | the 3 mm frame around the display with its outer edge rounded R3, 95.6 x 58.2 window, thumb grooves on the right border, the ODD JOBS symbol engraved on the left, four counterbored M2 holes | charcoal | rear face UP, so the round faces up; the counterbore shoulders are 0.9 mm bridges |
| `print/KINO_CARRIER_FACE.stl` | the face: a 2.5 mm plate over the whole front, the walls' ends included, its edge an R2.5 pillow round; the pill-ended lens band with four stepped cells and the cover's track; the finger pad's ribs in a pill field; "odd jobs" raised; two domed rivets | cream (day) or cobalt (night) | back down |
| `print/KINO_CARRIER_LENS_COVER.stl` | the sliding cover, 86.8 x 16.5 x 2, the kino D4 wordmark raised 0.6, a thumb ridge | charcoal | back down |
| `print/KINO_CARRIER_COVER_KEEPER.stl` | the block that closes the cover's track at the band's bottom rim | as the face | as laid, glued in after the cover is in |
| `print/KINO_CARRIER_FACE_PINS.stl` | four stepped pins, 3.8 x 5.5 into the shell's driver shafts, 3.5 x 3 into the face's back | any | standing; press fits, tune on the coupon |
| `print/KINO_CARRIER_SHUTTER_BUTTON.stl` | the plunger (14 mm cap with a convex R18 dome, 2 mm rim plus 1.4 of dome proud) and the switch retainer (6 x 6 x 4.3 mm tactile switch) | pink | flange down |

Where it comes from, and what each thing is for:

- **The hand.** The right hand holds the right end (the on-device UI is laid
  out for it: `firmware/UI_DIRECTION.md`). The pink shutter is on the top deck
  at X 104 under the index finger; the finger pad's 0.8 mm ribs are on the
  face's right, under the middle finger; the thumb grooves are on the rear
  frame's right border beside the glass; the wrist strap hangs off the right
  wall between the USB-C and the shutter. A left-handed body is a mirror of
  `shutterX`, the pads and the lug, nothing else.
- **The four-mark.** The band is the camera's identity. The cover closed is
  one dark bar across the cream face, the UI's landed bar; dropped, the four
  cells show, the UI's four-mark. The cover is charcoal so the bar reads.
- **Colour is an event.** Charcoal and cream (or cobalt) at rest; the one
  pink thing is the button you press. No other colour on the body.
- **Quiet markings.** "odd jobs" (traced from the logo by
  `brand/trace-wordmark.py`, 26 mm, raised 0.5) on the upper deck; the kino D4
  wordmark on the cover in the cover's own colour; the symbol engraved on the
  back. "made for bad ideas." is not on this body: at a size the brand would
  set it, its strokes are under one nozzle line.
- **Layer texture.** 0.25 mm V-grooves at 1.6 mm pitch around the side and
  bottom walls, parallel to the layers, stopped 8 mm short of the top so the
  deck reads as a cap. 49 degree flanks, so the face-down print has no
  overhang.
- **The rivets.** The two domes on the upper deck are the upper pin holes'
  material (the plate alone is thinner than the hole is deep). They stay
  because they read as rivets, and the lower two holes sit under the track.
- **Not a box.** The owner's call on the first ODD JOBS render. The plan
  corners went to R10, the face to a full-front pillow with an R3.5 round,
  the rear frame rounded R3 over its 3 mm (printed rear face up for it), the
  band pill-ended, the rivets and the shutter cap domed, the strap tab
  rounded about its hole. Everything else the walls forbid: the plan corner
  cannot pass about R10.6 with the carrier's square corner inside the wall,
  and the shell's front edge is on the bed, so its softness is the face's.

### The face and the cover

The shell's front plate prints on the bed, so it can carry no relief; the
face does. It covers the whole front, the walls' ends included, 2.5 mm thick
with its edge rounded over the full thickness, and one thing stands proud of
it: the lens band, 3.5 mm proud, chamfered 1.5, pill-ended, from X 3.2 to
97.2, its bottom at the inner edge of the face's round. The band's recessed panel (2.2 deep) is the cover's track:
dovetail lips on both walls, two detent pairs, the cover entering through a
gap in the bottom rim that the keeper closes, 0.1 mm a side, the cover riding
on two 2.5 mm lands. The four cells are two stepped cones cut from the 82
degree field cone (pupil 1.1 mm behind the lens face), 14 mm at the panel
floor, rings 0.6 mm proud of the cone.

The cover drops 16.45 mm to shoot, down to the band's bottom rim; the travel
is derived from the face's edge. The lens row sits low on the carrier, so
every millimetre of cover is a millimetre of travel: 16.5 mm tall, it blankets
the 14 mm cells by 1.25 a side when closed and its top edge clears the field
cone by 0.5 mm when stowed. Both are gates, as is the closed cover blanketing
every cell (the firmware's cover-closed test needs all four dark).

A rim pocket, the face flush inside walls that run past the plate, was the
first draft of this cut: printed face down, the recessed plate hung 2.5 mm
over the bed as 10,000 mm^2 of overhang. A proud face inside a flat margin
came next; the full-front pillow replaced it when the body read as a box.

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
2. Cover into the face's track from below, keeper glued into the rim gap.
3. Pins into the face's back; face onto the shell, pins into the shafts.
4. Stack the P4, spacers, carrier and nodes outside the body. Slide the stack
   into the shell from the rear, carrier first, until the carrier meets the
   four pillar feet. Face off, drive the four M2 screws through the shafts,
   through the pillar feet and the carrier, into the spacers. Face back on.
5. Frame onto the wall ends with four M2 x 8 thread-forming screws.

The carrier's USB-C comes out through the bottom wall at the right; the three
edge LEDs show through three 2 x 4 mm slots beside it. The P4's own USB ports
are reached through the carrier's window only with the shell off.

Previews: `previews/KINO_CARRIER_DAY_*.png` and `NIGHT_FRONT.png` are the
colour views from `render-parts.py` (each part's STL in its filament's colour,
triangles split to 5 mm so the painter's order holds); the `*_PRINT.png` views
are each part in print orientation from `render-stl.py`.

## Gates

`node generate-carrier-body.mjs` writes `.candidate/` and runs 123 gates,
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

`node promote.mjs` validates the candidates, copies the seven parts into
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
- `pinShellD` / `pinFaceD`: the press fits, on the pillar coupon.
- `activeCentred`: the active area centred on the PCB is still an assumption; the window has 1.0 mm a side.
- `camFovDeg` 78: the OV3660's real field is `MEASURE_REQUIRED`.
