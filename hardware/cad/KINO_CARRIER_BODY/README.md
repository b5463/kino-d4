# KINO carrier body: a shell around the dev carrier D1 stack

Third body for the D4, and the first one that does not carry the electronics
itself. The dev carrier D1 ([`hardware/pcb/kino-d4-dev-carrier/`](../../pcb/kino-d4-dev-carrier/README.md),
issue #250) stacks on the P4's own inserts through 8 mm spacers, the four XIAOs
stand in sockets on it, and each camera module hangs off its XIAO on a short
soft ribbon. The carrier is the chassis. The body holds the carrier by the same
four M2 screws that hold the stack and captures each camera head in a pocket
with pinch ribs, so the picture does not shake on its ribbon. Everything else
is a wall. Issue #252; the first cut, nothing printed yet.

Not a variant of [`KINO_FIELD_BODY`](../KINO_FIELD_BODY/README.md) (loose XIAOs
on pads, a Dupont loom, a component bay, the P4 on posts behind foam) or of
[`KINO_RESIN_BODY`](../KINO_RESIN_BODY/README.md). Both stay as released. The
measured inputs and the camera-capture mechanism are restated here by hand.

## The stack, which sets the depth

Z = 0 is the back face of the P4's PCB. The display is at negative Z, the
lenses at positive Z. The chain is re-added by a gate every build.

| Term | mm | Z after | Source |
|---|---:|---:|---|
| rear frame | 3.0 | -16.8 | chosen |
| P4 module, glass front to PCB back | 13.8 | 0.0 | OFFICIAL_CAD |
| P4 inserts | 3.3 | 3.3 | MEASURED |
| M2 spacers | 8.0 | 11.3 | the bench set; the J100 socket floats 0.3 mm off home |
| carrier PCB | 1.6 | 12.9 | |
| XIAO socket insulator | 8.5 | 21.4 | Wurth 61300711821 |
| XIAO male header insulator | 2.5 | 23.9 | **PROVISIONAL**: the headers soldered to the owner's XIAOs; the carrier's assembly print left this out |
| XIAO back face to the lens front | 15.0 | 38.9 | Seeed's assembled Sense stack |
| plate ahead of the lens | 1.5 | 40.4 | chosen |
| **body** | **57.2** | | |

The module's PCB face is the Z datum for the camera, as in the field body: it
lands on the plate's inner face at Z 35.4 (the Sense board's top is at 31.5, so
the 3.5 mm module PCB has 0.4 mm of fold behind it), the 8.5 mm head sits in a
3.5 mm pocket with 0.2 mm pinch ribs on two walls pushing it onto the other two,
and the lens front is the pocket floor. If the real header insulator is not
2.5 mm, every Z above the socket moves by the difference and the plate must
move with it; `xiaoHeaderInsulator` in `params.mjs` is the one number to change.

Plan: the carrier's 118.40 x 70.80 outline plus 0.3 mm a side of cavity plus
4.5 mm walls, 128.0 x 80.4 mm, R6 corners. The lens row is 28.45 mm above the
carrier's bottom edge (the heads sit 6.95 mm below the socket centres, toward
the pin-7 end), at X 17.2, 39.2, 61.2, 83.2 from the carrier's left edge. The
block is 9 mm left of centre; the right side carries the USB window and the
power connector.

## The two prints

| File | What | Print |
|---|---|---|
| `print/KINO_CARRIER_SHELL.stl` | front plate with the four pockets and bores, all four walls to the display plane, four screw pillars, the LED slots, the USB-C opening, the frame pilots | face down, PETG, 0.20 mm, no support (gated) |
| `print/KINO_CARRIER_REAR_FRAME.stl` | the frame around the display, 95.6 x 58.2 window, four counterbored M2 holes | rear face down, no support |

Assembly: stack the P4, spacers, carrier and nodes outside the body. Slide the
stack into the shell from the rear, carrier first, until the carrier meets the
four pillar feet. Drive the four M2 screws through the 4 mm shafts in the front
face, through the pillar feet and the carrier, into the spacers. Screw the
frame onto the wall ends with four M2 x 8 thread-forming screws (1.7 mm
pilots). The screws that hold the stack hold the body; nothing is glued and
nothing is preloaded by foam.

The carrier's USB-C comes out through the bottom wall at the right; the three
edge LEDs show through three 2 x 4 mm slots beside it. The P4's own USB ports
are reached through the carrier's window only with the shell off: a plug
through the window would meet the plate.

## Gates

`node generate-carrier-body.mjs` writes `.candidate/` and runs 63 gates,
throwing on the first failure (`KINO_SOFT_GATES=1` collects them): the depth
chain re-added, the lens front on the pocket floor, the module PCB with the
plate to land on, each part one solid, the electronics dummy clear of both
parts with only the pinch ribs inside the nominal heads, every pocket open with
its ribs standing, every bore open through the plate and wide enough for the
field cone (78 + 2 degrees from a pupil 1.1 mm behind the lens), the driver
shaft and screw bore at every pillar, every pillar foot standing on the carrier
inside its 7 mm fastener keep-out, the carrier's sweep from the rear clear up
to the feet, the USB plug and the LED slots through the bottom wall, the frame
window over the whole active area with 3 mm of module border under the frame,
the frame pilots and holes aligned, both prints support-free (bed excluded;
the three LED bridges and the four 0.8 mm screw-foot shoulders are the only
faces steeper than 45 degrees, listed in the gate), and both on a 250 x 210 bed.

`node promote.mjs` validates the candidates, copies the two parts into
`print/` and the report into `reports/`, sweeps stale files and validates
again. There is no independent scan yet; promote says so every run. Previews:
`python render-stl.py .candidate/KINO_CARRIER_ASSEMBLED_PREVIEW.stl previews/KINO_CARRIER_ASSEMBLED_FRONT.png -38 23`
(the rear at yaw 142; the shell print at pitch 35).

## Not in this cut

- A cosmetic face shell. The plate's front is a flat 5 mm face with four
  bores and four 4 mm screw shafts; it prints on the bed and can carry no
  relief. Form, marks and the lens cones for the field beyond the plate go on
  a face shell that prints back-face down, as the field body's does.
- The battery. The 505573 pouch and the SW6106 module fit neither under the
  carrier nor in the front cavity; the proposal in #252 is a grip on the right
  side. The J1001 lead has no way out of this shell yet.
- The sliding lens cover and keeper, the shutter button (J103 lead), the
  strap lug, the P4's TF slot opening (position unmeasured), the C6 service
  header access.
- An interference gate against the carrier's own part model
  (`outputs/D1-print.stl`): the dummy here carries the sockets, modules, the
  carrier's USB-C and the window, not the LINK headers, the XH housings or the
  test pads.
- Coupons: one pillar with its screw stack, one pocket, before the full print.

## Open inputs

Each one is a number in `params.mjs` and nothing else moves when it changes.

- `xiaoHeaderInsulator` 2.5: measure a soldered XIAO, socket top to board back.
- `spacer` 8.0 with the socket home: the carrier README's bench step says 7.7 expected.
- `camStackH` 15.0 and the head size 8.5: the field body's `KINO_CAM_FIT_COUPON` and a caliper on a seated node.
- `activeCentred`: the active area centred on the PCB is still an assumption; the window has 1.0 mm a side.
- `camFovDeg` 78: the OV3660's real field is `MEASURE_REQUIRED`.
