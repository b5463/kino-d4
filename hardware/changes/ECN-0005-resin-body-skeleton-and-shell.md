# ECN-0005: a second body, printed at a bureau, that separates the camera from its case

| Field | Value |
|---|---|
| Status | Accepted |
| Author | KINO contributors |
| Date | 2026-09-08 |
| Hardware revision | D4-V1 |
| Design version before | 0.1.4 |
| Design version after | 0.1.4 (additive: a second CAD package, `cad` artifact revision 1 → 2) |
| Supersedes | Nothing. `KINO_FIELD_BODY` stays exactly as released. |
| Affected units | No released units. Neither body has passed the acceptance sheet. |

## Problem

The field body is a good answer to the question it was asked — print a camera
with no support material on an FDM machine — and it carries the cost of that
question everywhere: 6 mm walls, a 50° rule on every downward face, gabled hole
roofs, a split at the component-bay floor, two bed jobs, bed reliefs, and a
face shell that has to be **glued on permanently**. That last one is what
created its worst assembly trap: the Hall switch had to be seated before the
glue-up or never, which is one of the reasons the switch was removed.

It also mixes two jobs in one part. The chassis is simultaneously the thing that
holds the optical datum to ±0.03 mm and the thing you look at and drop. A change
to how the camera *looks* means re-qualifying how it *aims*.

Printing at a bureau removes the FDM constraints, which makes it worth asking
what the geometry would be if it had never had them.

## Proposed change

A second CAD package, `hardware/cad/KINO_RESIN_BODY/`, printed entirely through
JLCPCB. `KINO_FIELD_BODY` is untouched.

**Three parts, and the split is the change.**

- **Skeleton**, `KINO_RESIN_SKELETON.stl`, **MJF nylon PA12, black**. Carries
  everything: four camera modules on the 22.00 mm optical datum, four XIAOs on
  pads and fences with the field body's released clamps, the P4 module on the
  61.9 × 54.8 standoff pattern with the same conical sockets, and the
  loom. It is the only part with a thread.
- **Shell**, `KINO_RESIN_SHELL.stl`, **SLA transparent resin, clear**. Four
  walls and the rear frame, 2.0 mm. Nothing electrical touches it and no
  tolerance depends on it, so it can be reprinted in another colour without
  re-qualifying an optical dimension.
- **Face**, `KINO_RESIN_FACE.stl`, **SLA tough resin, black**. The four lens
  cells, and the camera's entire light baffle.

**The face is black and the shell is clear for an optical reason, not a
cosmetic one.** Light entering a transparent wall travels inside it and reaches
whatever the interior can see. Clear lens cells would put that light on the
sensors, and the firmware's cover-closed test — all four cameras dark means the
cover is down — would never read dark. An opaque face makes the cells the
baffle; an opaque skeleton blocks the path from inside. Two gates hold it: a
light path 1.0 mm outside each cell's widest radius must be solid through the
face, and one 0.4 mm outside each lens bore must be solid through the skeleton's
0.9 mm seal.

**The skeleton is nylon and not resin because it is the part that gets
dropped.** Four camera modules, a display module and a strap load hang off it,
and standard SLA resin is brittle. It costs accuracy — MJF holds about ±0.3 %,
so the 66 mm span across the four cameras can be out by 0.2 mm where SLA would
hold 0.1 — and that is the right trade, because the camera baseline is
calibrated in software and a cracked camera mount is not calibrated out of
anything. Nylon is also a thermoplastic, so it **takes heat-set inserts** where
cured resin cannot, and that is what makes the fastening work: four M2.5
countersunk screws pass through the face into brass inserts in the skeleton,
trapping the shell's front rim between them. **No glue anywhere, no thread in
any resin part, and the face comes off again.**

**MJF removes the support-free rule**, so there is deliberately no support-free
gate on the skeleton — a powder bed has no supports to be free of, and carrying
the field body's 45° rule here would forbid geometry this process prints
perfectly well. What it needs instead is powder escape and features coarse
enough to resolve, which is why the pinch ribs are 0.5 mm proud against the
field body's 0.20: at 0.20 they would not have appeared at all.

**Size.** 125 × 82 × 65.5 mm against 131 × 90 × 65.5 (both were 64.6 until the
camera's stand-off was derived rather than chosen — see ECN-0004). The saving is entirely in
the walls — 2.0 mm of resin where PETG needed 6.0 — and depth does not move,
because depth is set by the electronics stack and not by any wall. A gate
re-adds the stack every build and checks that the module's PCB back still lands
on the same plane as the field body's, so the P4 post and socket
geometry transfers unchanged.

## Gates

24 in `generate-resin-body.mjs`, throwing on the first failure: the depth stack
re-added, the envelope smaller in the walls and not the stack, module float on
every side, resin wall minimums, each part one solid, four lens bores open on
the measured 22.00 mm pitch and collinear, the design field measured on the
**assembled** face and skeleton rather than asserted from the parameters that
drew it, the light baffle on both parts, all four standoff sockets taking the
brass and gripping at the floor, the three parts assembling one way only, four
screws passing through resin into a thread in nylon, MJF feature minimums,
powder escape, and the door zone reserved and empty.

**There is no independent scan on this package**, and `promote.mjs` prints that
absence every time it runs rather than skipping it silently. The field body's
`verify-release.mjs` arrived after 262 gates already existed and immediately
found an 870 mm² overhang and a gate blind spot every one of them had walked
past; until the equivalent exists here, a pass on this package is weaker
evidence and a coupon should come before any trusted fit.

## Evidence

`reports/resin-body-release-report.json`: 24 gates, 0 failures. `validate-stl`:
3 files, all manifold, one part each, each in `print/`.

Measured: skeleton 120.5 × 77.5 × 42.7 mm, 34.54 cm³; shell 125 × 82 × 65.5,
49.42 cm³; face 123.7 × 80.7 × 5.5, 30.55 cm³.

Four defects the gates caught during the build, recorded because each is a class
of mistake rather than a one-off:

- a **XIAO pad placed under the camera module**, and straight across the lens
  axis. The field body puts its pads above the module's top edge; copying the
  board's centreline instead put 3 mm of nylon in the light path. Caught by the
  assembled-field gate reading 0.0°.
- **four insert pilots closed at both ends**, started 1 mm inside the boss
  rather than opening at its face: four internal voids, reported as four loose
  components of **minus** 56.6 mm³, and four pockets of unsintered powder with
  no way out.
- **pinch ribs unioned before the pocket was cut**, so the cut removed the half
  of each rib inside the pocket and left nothing standing.
- **bosses abutting the plate on a shared plane** instead of embedded in it,
  leaving the union as five separate shells.

Three of the four were found only because a gate reported *where* rather than
*how many* — the one-part gate now lists the loose pieces' own bounding boxes.

## Compatibility

Additive. The field body is unchanged and stays the released body. Both bodies
take the same P4 module, the same four camera modules and XIAOs, the same
firmware, and the field body's released `KINO_FIELD_XIAO_CLAMPS.stl` fits this
skeleton unchanged.

Shared risk: the standoff pattern's **9.3 mm offset from module centre is
PROVISIONAL** in both bodies — the one figure of that group never measured. One
paper check, `KINO_FIELD_BODY/coupons/KINO_P4_1TO1_HOLE_TEMPLATE.pdf` at 100 %,
settles it for both. If it is wrong it is wrong here too, and all four posts
miss the brass.

## Staged

The sliding lens cover and its track, the rear door, the shutter pod and button,
bench coupons, and the independent scan. The door zone at Z 60.6–64.6 is
reserved and gated empty.
