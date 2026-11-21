// The one list of what this package ships, where it goes, and in how many
// pieces. validate-stl.mjs and promote.mjs both read it.
//
// Part IDs: A = enclosure, B = moving and interaction parts, C = the
// consumables that are not printed (pins, foam), T = test coupons, P = the
// coupon plates. The same ID is engraved in the part (A01 to A03 and the
// coupons; the B parts have no face for it), in its file name, in the
// register in the README and on the bin.
//
// `parts` is the connected-component count: the cheapest check that a Boolean
// did what it was told.
export const RELEASE_SET = [
  { file: "A01-KINO_CARRIER_SHELL.stl", dir: "print", parts: 1 },
  { file: "A02-KINO_CARRIER_FACE.stl", dir: "print", parts: 1 },
  { file: "A03-KINO_CARRIER_REAR_FRAME.stl", dir: "print", parts: 1 },
  { file: "B01-KINO_CARRIER_LENS_COVER.stl", dir: "print", parts: 1 },
  { file: "B02-KINO_CARRIER_SHUTTER_BUTTON.stl", dir: "print", parts: 1 },
  // Coupons: pieces of the real parts cut out with boxes. Print these first.
  { file: "T01-KINO_COUPON_SHRINK_BAR.stl", dir: "coupons", parts: 1 },
  { file: "T02-KINO_COUPON_POCKET_GAUGE.stl", dir: "coupons", parts: 1 },
  { file: "T03-KINO_COUPON_LEDGE_CORNER.stl", dir: "coupons", parts: 1 },
  { file: "T04-KINO_COUPON_STRAP_SHELL.stl", dir: "coupons", parts: 1 },
  { file: "T05-KINO_COUPON_DECK.stl", dir: "coupons", parts: 1 },
  // Bed plates: the coupons that print together, in one file each.
  { file: "P1-COUPON_PLATE_T01_T02.stl", dir: "coupons", parts: 2 },
  { file: "P2-COUPON_PLATE_T03_T04.stl", dir: "coupons", parts: 2 },
];
export const RELEASE_DIRS = ["print", "coupons"];
// Non-mesh outputs of a build and where they go.
export const RELEASE_FILES = [
  { file: "carrier-body-release-report.json", dir: "reports" },
];
// Extensions promote.mjs sweeps out of the release folders when they are not
// in the set above.
export const SWEEP_EXT = [".stl", ".pdf", ".svg", ".3mf"];
// The stack dummy and the assembled preview stay in .candidate/: they are
// pictures and gates, not parts.
export const RELEASE_PROCESS = {
  "A01-KINO_CARRIER_SHELL.stl": "FDM, black PETG, 0.20 mm, front plate on the bed, no support; slicer shrink compensation 0.2 % from T01",
  "A02-KINO_CARRIER_FACE.stl": "FDM, dark blue PLA, 0.20 mm, back down, no support",
  "A03-KINO_CARRIER_REAR_FRAME.stl": "FDM, black PETG, 0.10 mm, rear face UP (the gasket groove on the bed), no support",
  "B01-KINO_CARRIER_LENS_COVER.stl": "FDM, black PETG, 0.08 mm, back down, no support; minimum layer time 10 s for the lip",
  "B02-KINO_CARRIER_SHUTTER_BUTTON.stl": "FDM, dark blue PLA, 0.08 mm, flange down, no support; the plunger alone",
  "T01-KINO_COUPON_SHRINK_BAR.stl": "FDM, black PETG, 0.20 mm: a 100 x 10 x 3 bar; measure it, set the slicer's shrink compensation, never scale the shell",
  "T02-KINO_COUPON_POCKET_GAUGE.stl": "FDM, black PETG, 0.20 mm, plate down: three real camera pockets of 7.8, 8.1 and 8.4 mm with their ribs, reliefs and bores, each labelled; the one that holds the head is the number",
  "T03-KINO_COUPON_LEDGE_CORNER.stl": "FDM, black PETG, 0.20 mm, plate down: the cavity's lower-left corner with 24 mm of ledge on two walls and the face pin hole at X 5; the carrier's corner lands on the ledge",
  "T04-KINO_COUPON_STRAP_SHELL.stl": "FDM, black PETG, 0.20 mm, cut face down: the bottom wall's rear end with its tunnel, two strap slots and the frame pin hole at X 40; pulled to 100 N on a 2.5 mm cord, 500 g hung on the pin",
  "T05-KINO_COUPON_DECK.stl": "FDM, black PETG, 0.20 mm, plate down like the shell: the whole pod with the deck over it, the wall corner it joins and the plate with the mouth; the slot open to the front and its four ribs, the step, the chamber, the switch's pocket and the leg channels. The switch goes in first, then the B02 plunger; a thumb over the mouth stands in for the face",
  "P1-COUPON_PLATE_T01_T02.stl": "FDM, black PETG, 0.20 mm: T01 and T02 on one bed; set the slicer's shrink compensation from T01 (0.2 % measured), find the pocket width on T02",
  "P2-COUPON_PLATE_T03_T04.stl": "FDM, black PETG, 0.20 mm: T03 and T04 on one bed; the ledge under the carrier's corner, a face pin hole, the strap tunnel and a frame pin hole",
};
