// The one list of what this package ships, where it goes, and in how many
// pieces. validate-stl.mjs and promote.mjs both read it.
//
// Part IDs: A = enclosure, B = moving and interaction parts, C = the
// consumables that are not printed (pins, foam, screws), T = test coupons.
// The same ID is embossed in the part, in its file name, in the register in
// the README and on the bin.
//
// `parts` is the connected-component count: the cheapest check that a Boolean
// did what it was told.
export const RELEASE_SET = [
  { file: "A01-KINO_CARRIER_SHELL.stl", dir: "print", parts: 1 },
  { file: "A02-KINO_CARRIER_FACE.stl", dir: "print", parts: 1 },
  { file: "A03-KINO_CARRIER_REAR_FRAME.stl", dir: "print", parts: 1 },
  { file: "B01-KINO_CARRIER_LENS_COVER.stl", dir: "print", parts: 1 },
  { file: "B02-KINO_CARRIER_SHUTTER_BUTTON.stl", dir: "print", parts: 2 },
  // Coupons: pieces of the real parts cut out with boxes. Print these first.
  { file: "T01-KINO_COUPON_SHRINK_BAR.stl", dir: "coupons", parts: 1 },
  { file: "T02-KINO_COUPON_POCKET.stl", dir: "coupons", parts: 1 },
  { file: "T03-KINO_COUPON_PILLAR.stl", dir: "coupons", parts: 1 },
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
  "A01-KINO_CARRIER_SHELL.stl": "FDM, black PETG, 0.20 mm, front plate on the bed, no support",
  "A02-KINO_CARRIER_FACE.stl": "FDM, dark blue PLA, 0.20 mm, back down, no support",
  "A03-KINO_CARRIER_REAR_FRAME.stl": "FDM, black PETG, 0.10 mm, rear face UP (the gasket groove on the bed), no support",
  "B01-KINO_CARRIER_LENS_COVER.stl": "FDM, black PETG, 0.08 mm, back down, no support; minimum layer time 10 s for the lip",
  "B02-KINO_CARRIER_SHUTTER_BUTTON.stl": "FDM, dark blue PLA, 0.08 mm, flange down, no support; B02 the plunger and B03 the retainer in one file",
  "T01-KINO_COUPON_SHRINK_BAR.stl": "FDM, black PETG, 0.20 mm: a 100 x 10 x 3 bar; measure it, set the slicer's shrink compensation, never scale the shell",
  "T02-KINO_COUPON_POCKET.stl": "FDM, black PETG, 0.20 mm, plate down: one camera pocket with its ribs, reliefs and bore",
  "T03-KINO_COUPON_PILLAR.stl": "FDM, black PETG, 0.20 mm, plate down: one pillar with its head pocket and a face pin hole",
  "T04-KINO_COUPON_STRAP_SHELL.stl": "FDM, black PETG, 0.20 mm, cut face down: a wall end with its tunnel, slots and the first frame pilot; pulled to 100 N on a 2.5 mm cord, the pilot driven ten times",
  "T05-KINO_COUPON_DECK.stl": "FDM, black PETG, 0.20 mm, cut face down: the deck with the pod, the collar and the guide ribs",
  "P1-COUPON_PLATE_T01_T02.stl": "FDM, black PETG, 0.20 mm: T01 and T02 on one bed, the first print; set the shrink compensation from T01, check the pocket on T02",
  "P2-COUPON_PLATE_T03_T04.stl": "FDM, black PETG, 0.20 mm: T03 and T04 on one bed, the second print; the head pocket, a pin hole, the strap tunnel and a frame pilot",
};
