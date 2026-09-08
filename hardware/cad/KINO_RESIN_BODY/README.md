# KINO resin body — a clear shell over a printed skeleton

Second body for the D4, printed entirely through JLCPCB. A **clear SLA shell**
and a **black SLA face** over a **black MJF nylon skeleton** that carries every
piece of electronics in the camera. Design version 0.1.4,
[`ECN-0005`](../../changes/ECN-0005-resin-body-skeleton-and-shell.md).

It is **not** [`KINO_FIELD_BODY`](../KINO_FIELD_BODY/README.md) with different
numbers. The field body is one program's answer to one question — *print a
camera with no support material on an FDM machine* — and almost everything in it
exists because of that: the 50° rule, the wall flutes, the gabled hole roofs,
the split at the bay floor, the two bed jobs, the bed reliefs. Printed at a
bureau none of those constraints apply and none of that machinery is worth
carrying. What **is** worth carrying is the measured inputs and the mechanisms,
and those are restated here by hand, on purpose — the same way
`verify-release.mjs` restates its datums over there. An independent statement of
the same measurement is worth more than a shared constant.

## The split, which is the point

| | Part | Process and material | Carries |
|---|---|---|---|
| **Skeleton** | `KINO_RESIN_SKELETON.stl` | **MJF, nylon PA12, black** | Everything. Four camera modules on the 22.00 mm optical datum, four XIAOs, the P4 module on its measured standoff pattern, the loom. The only part with a thread. |
| **Shell** | `KINO_RESIN_SHELL.stl` | **SLA, transparent resin, clear** | Four walls and the rear frame. No electronics touch it and no tolerance depends on it. |
| **Face** | `KINO_RESIN_FACE.stl` | **SLA, tough resin, black** | The four lens cells, and the camera's entire light baffle. |

Nothing electrical touches the shell, so it can be reprinted in another colour
without re-qualifying a single optical dimension.

## Why the face is black and the shell is clear

This is the whole optical argument and it is not cosmetic. Light entering a
transparent wall travels inside it and reaches whatever the interior can see. If
the lens cells were clear, the sensors would see that light — and the firmware's
cover-closed test, *all four cameras dark means the cover is down*, would never
read dark. An **opaque face makes the cells the baffle**, and an **opaque
skeleton blocks the path from inside**. The clear shell then lights up around a
dark interior, which is the look, and none of it reaches a sensor.

Two gates hold it: a light path 1.0 mm outside each cell's widest radius must be
solid through the face, and one 0.4 mm outside each lens bore must be solid
through the skeleton's seal.

## Why the skeleton is nylon and not resin

It is the part that gets dropped. Four camera modules, a display module and a
strap load all hang off it, and standard SLA resin is brittle. It costs accuracy
— MJF holds about **±0.3 %**, so the 66 mm span across the four cameras can be
out by 0.2 mm where SLA would hold 0.1 — and that is the right trade, because
the camera baseline is calibrated in software anyway and a cracked camera mount
is not calibrated out of anything.

Nylon also **takes heat-set inserts**, because it is a thermoplastic and cured
resin is not. That is what makes the fastening work: **four M2.5 countersunk
screws pass through the face into brass inserts in the skeleton**, trapping the
shell's front rim between them. No glue anywhere, no thread in any resin part,
and the face comes off again — which the field body's permanently glued shell
cannot do, and which is exactly what created its *fit the sensor first or never*
assembly trap.

MJF also **removes the support-free rule entirely**: a powder bed has no
supports to be free of, so this part could carry undercuts and overhangs no FDM
version of it could. There is deliberately **no support-free gate** on it. What
it needs instead is powder escape and features coarse enough to resolve, which
is why the camera pinch ribs are **0.5 mm** proud here against the field body's
0.20 — at 0.20 they simply would not have appeared.

## Size

**125 × 82 × 65.5 mm**, against the field body's 131 × 90 × 65.5. The saving is
entirely in the walls: **2.0 mm of resin where PETG needed 6.0**. Depth does not
move relative to the field body, and it is worth being clear about why — depth
is set by the electronics stack, not by any wall:

| Term | mm |
|---|---:|
| face | 2.5 |
| skeleton plate | 2.5 |
| camera module + XIAO stack | 11.5 |
| XIAO header pins + Dupont loop | 14.0 |
| XIAO-to-module margin | 1.4 |
| component bay | 14.6 |
| P4 module | 13.8 |
| foam shim gap | 1.2 |
| door plate | 4.0 |
| **body depth** | **65.5** |

A gate re-adds that every build, and checks that the module's PCB back lands on
the same plane as the field body's, so the P4 post and socket geometry transfers
unchanged. Both bodies were 64.6 mm deep with the PCB back at Z 45.6 until the
camera's stand-off stopped being chosen: the camera hangs off its board by the
vendor's assembled 15.0 mm — XIAO back face to lens front face, over a 7 mm
ribbon whose connector is on the boards' outer face — so the stand-off is
derived, not declared, and it came out 0.9 mm larger than either body had
assumed. On the field body's printed rig a **chosen** 7.0 mm left the lens about
2 mm short of its pocket, which is the fault that found this. Here the stand-off
is 3.9 mm and the camera's head passes through the 2.5 mm skeleton plate and
1.0 mm on into the face's lens cell, which is open air behind its bore.

## Ordering it

| File | Process | Material | Colour |
|---|---|---|---|
| `KINO_RESIN_SHELL.stl` | SLA | transparent resin (8001-class) | clear |
| `KINO_RESIN_FACE.stl` | SLA | tough resin (8228-class) | **black** |
| `KINO_RESIN_SKELETON.stl` | MJF | nylon PA12 | black |

Confirm the exact product names against the bureau's current list — the material
*classes* are what matter here, not the catalogue numbers. Two notes on the
clear part: transparent SLA is translucent rather than optically clear, so ask
for polishing if clarity matters, and it **yellows under UV** over time.

Plus, from stock: 4 × M2.5 brass heat-set inserts and 4 × M2.5 countersunk
screws for the face; 4 × M2 inserts and screws for the XIAO clamps. The field
body's released `KINO_FIELD_XIAO_CLAMPS.stl` fits this skeleton unchanged — same
boss diameter, same insert, same board-back plane.

## How it is verified, and how far to trust it

`node generate-resin-body.mjs` writes `.candidate/` and runs **24 gates**,
throwing on the first failure. `node promote.mjs` then validates the candidates
with `validate-stl.mjs`, copies them into `print/`, sweeps anything stale, and
validates again.

**There is no independent scan on this package yet**, and that is a real
difference from the field body. Over there, `verify-release.mjs` re-imports the
shipped STLs and measures them against each other, and when it was first written
— after 262 gates already existed — it immediately found an 870 mm² overhang and
a gate blind spot that every one of those gates had walked past. `promote.mjs`
prints that absence every time it runs rather than skipping silently. Treat a
pass here as **weaker evidence** than the field body's, and print a coupon
before trusting a fit.

Four defects the gates caught while this package was being written, recorded
because each one is a class of mistake rather than a one-off:

- a **XIAO pad placed under the camera module** — and straight across the lens
  axis. The field body puts its pads *above* the module's top edge
  (`camModTopY + 2.3`); copying the board's centreline instead put 3 mm of
  nylon in the light path;
- **four insert pilots closed at both ends**, started 1 mm inside the boss
  instead of opening at its face: four internal voids, reported as four loose
  components of **minus** 56.6 mm³, and four pockets of unsintered powder with
  no way out;
- **pinch ribs unioned before the pocket was cut**, so the cut took the half of
  each rib that was inside the pocket and left nothing standing;
- **bosses abutting the plate on a shared plane** rather than embedded in it,
  which left the union as five separate shells.

## Staged, not done

The sliding lens cover and its track, the rear door, the shutter pod and button,
and bench coupons. The door zone at **Z 60.6–64.6** is reserved and a gate holds
it empty across the cavity, so the door has somewhere to land. The lens cover
wants the same black tough resin as the face, for the same reason plus wear.

## Shared with the field body, and shared risk

The standoff pattern is **61.9 × 54.8 centre pitch, of Ø3.5 × 3.3 brass**,
which puts 65.4 × 58.3 across the standoffs' outside edges — the figure the
caliper reads. A gate here requires those two to agree within 0.5 mm, because
the first bench print's posts splayed on an edge span entered as a pitch —
but its **9.3 mm offset from module centre is PROVISIONAL**: the one figure of
that group never measured. It is the same figure the field body uses, so
`KINO_FIELD_BODY/coupons/KINO_P4_1TO1_HOLE_TEMPLATE.pdf` printed at 100 % checks
it for both bodies at once. If it is wrong, it is wrong here too, and all four
posts miss the brass.

The OV3660's real field of view is `MEASURE_REQUIRED` in `docs/HARDWARE.md`. The
cells are cut from a 78° design figure plus 2°, and a gate measures the
**assembled** face and skeleton rather than trusting the parameters that drew
them.
