# Making of KINO D4

Everything the hardware went through to get here, with the pictures, for
the ODD JOBS website's page. Boards, bodies, prints, failures, wiring. The
renders are from the repository's own history; the photographs are the
owner's and go in as they come (see the last section).

## The boards

- **Mainboard rev 1**, the first idea: one board for everything.
  `../hardware/pcb/kino-d4-mainboard-rev1/outputs/KINO_D4_Mainboard_Rev1-envelope.png`,
  the placement in `KINO_D4_Mainboard_Rev1-placement.svg`. Its ECN:
  `../hardware/changes/ECN-0000-initial-baseline.md`.
- **The JP1 header**, corrected twice against the P4's drawing and then the
  meter: ECN-0001 and ECN-0002. The pin-1 check photo:
  `../hardware/pcb/kino-d4-dev-carrier/outputs/P4-JP1-pin1-check.png`.
- **Carrier A0**, the four-XIAO carrier proposal (ECN-0007): the assembly
  renders `A02-ASSEMBLY-FRONT.png` and `-BACK.png`, the power pages, the
  placement draft and the review views, all in
  `../hardware/pcb/kino-d4-carrier-a0/outputs/`; the P4 mounting template
  `P4-MOUNTING-TEMPLATE.png`.
- **Dev carrier D1** (ECN-0008), the board that was ordered: `D1-front.png`
  and `D1-back-mirrored.png` in `../hardware/pcb/kino-d4-dev-carrier/outputs/`.

## The bodies

### Field body

The first printed body: loose XIAOs on pads, a Dupont loom, the P4 on
posts behind foam, a sliding lens cover whose track every later body
reuses. Its previews are in `../hardware/cad/KINO_FIELD_BODY/previews/`:
the assembled body (`KINO_FIELD_ASSEMBLED_PREVIEW.png`), the front and
rear (`KINO_FIELD_BODY_FRONT_PREVIEW.png`, `_REAR_PREVIEW.png`), the face,
the slider, the keeper, the XIAO clamps, the shutter button, and the
coupons that set the fits (`KINO_SLIDER_TRACK_COUPON_PREVIEW.png`,
`KINO_CAM_FIT_COUPON_PREVIEW.png`, `KINO_INSERT_PILOT_COUPON_PREVIEW.png`,
`KINO_XIAO_STACK_COUPON_PREVIEW.png`). ECN-0003 and ECN-0004.

### Resin body

The skeleton-and-shell attempt for resin printing (ECN-0005), in
`../hardware/cad/KINO_RESIN_BODY/`; it has files and a README but no
pictures were kept. Not continued.

### Carrier body

The body around the D1 stack, cut by cut. Each folder holds the front,
the open and the rear view of that commit, and from the third cut the face
and shell print views; the index with the exact file names is
`assets/making-of/carrier-body/INDEX.md`. Oldest first:

- **01** (2026-11-20) `assets/making-of/carrier-body/01-fc0d0b7-a-shell-around-the-d1-stack-first-cut/`: A shell around the D1 stack, the first cut: the carrier is the chassis, four pillars from the plate stand on it, the heads in pinch pockets. A box with a window.
- **02** (2026-11-20) `assets/making-of/carrier-body/02-fb23755-the-battery-bay-between-the-p4-and-the-c/`: The battery bay found between the P4 and the carrier, in the spacer layer; no module, no lead leaves the shell.
- **03** (2026-11-20) `assets/making-of/carrier-body/03-4167f66-the-face-cover-shutter-and-strap-lug-in-/`: The brand arrives: charcoal ribs, a cream or cobalt face, a pink button, the sliding cover as the bar, a strap lug.
- **04** (2026-11-20) `assets/making-of/carrier-body/04-db18f15-not-a-box/`: "Too boxy": R10 corners, a pillow face, a domed cap, a rounded frame. Not a box.
- **05** (2026-11-20) `assets/making-of/carrier-body/05-a9150b7-trimmed-to-the-stack/`: Trimmed to the stack: thinner frame, face and band.
- **06** (2026-11-20) `assets/making-of/carrier-body/06-aae015f-after-two-cold-reviews/`: After two cold reviews, an engineer and a customer: an apron over the stow zone, filament pins instead of rivets, a grip pad, contrast lettering.
- **07** (2026-11-20) `assets/making-of/carrier-body/07-b5b9733-the-horizon-after-a-design-award-jury-re/`: After a design-award juror: one groove across the face, the horizon, with the bar in it and the grip as its deeper end. The apron gone; the face is the door.
- **08** (2026-11-20) `assets/making-of/carrier-body/08-d194b9e-seventh-cut-the-print-technician-s-numbe/`: The print technician's numbers: clearances, countersinks, bed chamfers, the deck bare, the signature engraved inside.
- **09** (2026-11-21) `assets/making-of/carrier-body/09-7621b3e-eighth-cut-what-the-award-cameras-taught/`: What the award cameras taught: the deck grooved whole, rounds in plan and chamfers in Z, a flat cap, the lip visible.
- **10** (2026-11-21) `assets/making-of/carrier-body/10-94e866b-ninth-cut-the-whole-field-of-design-awar/`: The whole field of design awards: no glue anywhere, a captive keeper, pins that retain, nine coupons, a list of what ships.
- **11** (2026-11-21) `assets/making-of/carrier-body/11-7d33e71-tenth-cut-supports/`: The supports audit: the roof over the stow zone was two cantilevers, not a bridge. Five breakaway blades, the floor relief fixed.
- **12** (2026-11-21) `assets/making-of/carrier-body/12-71531a5-eleventh-cut-the-p4-held/`: The P4 held by a foam gasket in the rear frame's groove, 0.4 off the glass.
- **13** (2026-11-21) `assets/making-of/carrier-body/13-24660b5-twelfth-cut-the-stow-zone-opened/`: Simplified at the owner's call: the stow zone opened into a window, the roof, slot, gap, keeper and blades gone.
- **14** (2026-11-21) `assets/making-of/carrier-body/14-f9871da-thirteenth-cut-the-reviews-on-the-simpli/`: Four reviews on the simplified body, a builder among them: the tray floor in the face's colour, the screw ports chamfered, pins deeper, a stock gasket, the README rewritten in build order.
- **15** (2026-11-21) `assets/making-of/carrier-body/15-8472f43-fourteenth-cut-no-screw-into-either-boar/`: No screw into either board: the stack clamped on foam against the pillar feet; the driver shafts gone.
- **16** (2026-11-21) `assets/making-of/carrier-body/16-5a36501-fifteenth-cut-as-thin-as-possible/`: As thin as possible: frame 2.0, plate 1.0, face 3.2. The body's share 6.6 mm.
- **17** (2026-11-21) `assets/making-of/carrier-body/17-520a2a8-exploded-previews/`: The exploded views, every part pulled apart along the depth axis.
- **18** (2026-11-21) `assets/making-of/carrier-body/18-a8edd0c-sixteenth-cut-the-stack-measured/`: The stack measured on the bench: 17.5 mm from glass to carrier front, not 26.7. Nine millimetres gone in one number; 50.1 deep.
- **19** (2026-11-21) `assets/making-of/carrier-body/19-157f571-seventeenth-cut-two-materials-ids-keys/`: Two materials, one per part: black PETG shell, frame and cover, dark blue PLA face and button; the face's own track floor back; the cover keyed by its bevels; part IDs embossed in every part and in every file name; the labelled exploded view.
- **20** (2026-11-21) `assets/making-of/carrier-body/20-9b333d2-eighteenth-cut-cleaned-and-the-coupons/`: Cleaned: dead parameters and stale words gone, the history moved out of the README; the five coupons with their IDs and the two bed plates, ready to print.
- **21** (2026-11-21) `assets/making-of/carrier-body/21-96fcaa1-nineteenth-cut-after-the-first-prints/`: The first coupons off the bed, and what they said: the bar 99.8 (shrink 0.2 %), the pocket loose, the screw-head feet and the frame pilots refused, the bed-face pixel codes unreadable. The answer: a ledge the carrier rests on by its own edge, the rear frame on six filament pins, no M2 anywhere, a three-pocket gauge, and IDs in a real font on faces that are up in print.
- **22** (2026-11-21) `assets/making-of/carrier-body/22-29cb40d-twentieth-cut-the-button-after-its-first/`: The button after its first print: it stopped 0.5 mm above the switch, the retainer had nothing to hold it, the leads had no way out, the teardrops were for the printer. Now a round guide, a step, a pocket, and a floor plate on one pin; the LED slots and the USB gable off the bottom wall.

Later cuts append here as they are committed; the archive script
(`../hardware/cad/KINO_CARRIER_BODY/archive-previews.py`) adds the folder,
and the caption is written by hand.

## Prints, failures, wiring

The photographs. Put each under `assets/making-of/bench/` as
`YYYY-MM-DD-<slug>.jpg` and add a line here; keep the failures, they are
the story.

| Date | File | What it shows |
|---|---|---|
| | `assets/making-of/bench/....jpg` | the first field body print |
| | | the Dupont loom before the carrier |
| | | the coupon that rattled at 0.3 / 0.4 clearance |
| | | the P4 on posts behind foam |
| | | the dev carrier D1 as delivered |
| | | the first carrier body prints and what failed |

## How this page is kept

Every cut of the carrier body commits its renders; the archive script
walks the git history and copies a representative set per commit into
`assets/making-of/carrier-body/`, so nothing is lost when the previews are
regenerated. Run it after each commit from anywhere:

```
python hardware/cad/KINO_CARRIER_BODY/archive-previews.py
```
