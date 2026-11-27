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
- **23** (2026-11-21) `assets/making-of/carrier-body/23-0a342c2-twenty-first-cut-the-button-simplified/`: "A manufacturing and assembly nightmare": the pinned plate could not even be assembled, and rear entry fails on the wall. The button becomes one part and the switch, loaded through a hole in the plate that the face covers. The face is the door.
- **24** (2026-11-21) `assets/making-of/carrier-body/24-3cf5198-the-switch-held-the-order-of-operations-/`: "Will the switch not slide?" It would have. A detent rib in each leg channel holds it, and the order of assembly (plunger, switch, face) is now proved by the generator sweeping each part along its path.
- **25** (2026-11-21) `assets/making-of/carrier-body/25-635f697-the-second-coupon-round-read-the-shutter/`: The second plate read: the head fits the 8.1 pocket, the bar is 99.9, the carrier's corner sits flat on the ledge. The button took neither part: its 0.2 mm of headroom was arithmetic, not tolerance. So the guide becomes a slot open toward the face, the button moves to the deck's front edge, and the switch goes in first into a pocket in the floor, the plunger over it, the face last.
- **26** (2026-11-21) `assets/making-of/carrier-body/26-b364898-the-cap-dished-for-the-finger/`: "A slight indent to give it a tactile feel": the cap's top dished 0.4 mm over 11 mm inside a flat rim, as the coupon went to the bed.
- **27** (2026-11-21) `assets/making-of/carrier-body/27-5a32954-m2-inserts-and-screws-for-the-joints-lea/`: "The button mechanism now works perfectly." Then the joints: the filament pins out, M2 brass inserts and screws in, the face screwed from inside where no head shows, the frame from the back where the concept draws its screws; the walls 6.0 for the inserts. And the slide: the cover's detents become leaf springs in the window's walls, two bumps each, placed to meet the cover's corners exactly at both stops.
- **28** (2026-11-21) `assets/making-of/carrier-body/28-3cbbe66-t07-the-slide-s-coupon/`: "Gimme the coupons for the slide too": T07, the face's whole window band, for the real cover.
- **29** (2026-11-22) `assets/making-of/carrier-body/29-fa85166-the-slide-after-its-first-print/`: The slide printed: it stuck, went sideways, popped out and fell when closed. The 2.0 cover had a 0.1 mm flank on its right side, so nothing held it there. Now a 3.0 cover in a 5.2 face, detents that seat in a notch cut in each flank, two leaf springs a side, the thumb lip on the bar's axis.
- **30** (2026-11-22) `assets/making-of/carrier-body/30-96e42d7-the-slide-sprung-the-whole-way-the-lip-t/`: "Way better", but one side stuck mid-travel one time in two, where the cover ran free between the two bump pairs, and the shove snapped the lip. A tapered ridge behind each bump keeps the cover sprung and centred at every position; the lip 2.5 thick.
- **31** (2026-11-23) `assets/making-of/carrier-body/31-623b8c1-the-slide-on-a-rail/`: The ridges did not cure the yaw and made the slide tight and scraping. A bar 87 wide cannot be guided on its two short ends: a rail down the tray, in a groove in the cover's back, guides it over its whole height under the thumb. The one visible piece of mechanism on the front, and the cover's key.
- **32** (2026-11-24) `assets/making-of/carrier-body/32-cf10859-the-slide-s-stops-springs-and-lips/`: After a day with the fourth T07: the PLA wore, the slide got "looser and looser", never fully closed, and shaken hard the cover flew off. Neither rim had been a stop. Now the rims are the stops, the springs are PETG arms in the cover's own ends, and the face only carries fixed teeth: wear takes press, not position.
- **33** (2026-11-24) `assets/making-of/carrier-body/33-17d6278-the-rail-down-the-middle-of-the-cells/`: The rail "a bit to the right" bothered the owner. It runs down the middle of the four cells; the lip and the wordmark say which way up.
- **34** (2026-11-24) `assets/making-of/carrier-body/34-f171946-loading-the-hold-s-tolerance-and-the-cli/`: "Run all the fixes": the cover loads at a position between the stops where the arms can fold under the lips; T08 and T09, softer and firmer arms, print beside B01 on the plate P3 so a thumb picks the click.
- **35** (2026-11-24) `assets/making-of/carrier-body/35-1335694-the-slide-through-its-real-world-cases/`: "Not shortcuts like changing the filament": a pocket lining, grit, fatigue, heat and wear each get a gate; the face stays PLA.
- **36** (2026-11-24) `assets/making-of/carrier-body/36-01f6543-the-clicks-from-the-tooth-s-shape-and-a-/`: An animation of the slide found the click half what the gates said. The generator now rolls the bump's real outline over the wall's profile; the bump is asymmetric so closed is the firmer stop; every small feature measured in lines of a 0.4 mm nozzle.
- **37** (2026-11-25) `assets/making-of/carrier-body/37-093b29a-the-button-clear-of-the-face-and-room-fo/`: The face "will make it impossible to click the button": the plunger's flange had been clamped inside it. A round pocket in the face's back, the cap 2.6 proud for a soft fingertip, T10 for the corner.
- **38** (2026-11-25) `assets/making-of/carrier-body/38-cfc5bac-the-shutter-self-contained-in-the-shell/`: "A more technical solution": the shutter lives whole in the shell, a closed ribbed bore, the switch held by crush ribs; the face is only a cover.
- **39** (2026-11-25) `assets/making-of/carrier-body/39-cf4258f-the-card-door-over-the-p4-s-microsd-slot/`: The photographs live on the P4's microSD card and the body had no way to it. The slot placed from Guition's drawing, a recess in the top wall, B03 a flush snap-in door with a nail notch, T11 the wall round it.
- **40** (2026-11-27) `assets/making-of/carrier-body/40-5a1c62d-the-hold-at-the-stops-after-the-fifth-t0/`: The rail printed: "a good route", the click right, but loose at the stops until the arms were bent out by hand. The 0.2 rest press had not survived the print's error. Taller teeth, 0.35 and 0.25 of press, softer arms so the click stays near 5 N; a brim for the arms that curled off the bed.
- **41** (2026-11-27) `assets/making-of/carrier-body/41-6c5de2b-the-bump-s-foot-for-the-printer/`: "The printing issue might come from the stub on the arms": the bump's foot was a 0.95 chamfer that left a 0.05 sliver on the first layer, where the arms curled. The channel floor drops below the tray, the foot is the bed chamfer, every height a whole 0.20 layer. The click unchanged.

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
