// The one list of what this package ships, where it goes, and in how many
// pieces. validate-stl.mjs and promote.mjs both read it.
//
// `parts` is the connected-component count: the cheapest check that a Boolean
// did what it was told.
export const RELEASE_SET = [
  { file: "KINO_CARRIER_SHELL.stl", dir: "print", parts: 1 },
  { file: "KINO_CARRIER_REAR_FRAME.stl", dir: "print", parts: 1 },
  { file: "KINO_CARRIER_FACE.stl", dir: "print", parts: 1 },
  { file: "KINO_CARRIER_LENS_COVER.stl", dir: "print", parts: 1 },
  { file: "KINO_CARRIER_SHUTTER_BUTTON.stl", dir: "print", parts: 2 },
  // Coupons: pieces of the real parts cut out with boxes. Print these first.
  { file: "KINO_COUPON_PILLAR.stl", dir: "coupons", parts: 1 },
  { file: "KINO_COUPON_POCKET.stl", dir: "coupons", parts: 1 },
  { file: "KINO_COUPON_DECK.stl", dir: "coupons", parts: 1 },
  { file: "KINO_COUPON_STRAP_SHELL.stl", dir: "coupons", parts: 1 },
  { file: "KINO_COUPON_SHRINK_BAR.stl", dir: "coupons", parts: 1 },
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
  "KINO_CARRIER_SHELL.stl": "FDM, PETG, 0.20 mm, front plate on the bed, no support; the first 1.0 mm (five layers) in the face's filament, then charcoal",
  "KINO_CARRIER_REAR_FRAME.stl": "FDM, PETG, 0.10 mm, rear face UP (the gasket groove on the bed), no support",
  "KINO_CARRIER_FACE.stl": "FDM, PETG, 0.20 mm, back down, no support",
  "KINO_CARRIER_LENS_COVER.stl": "FDM, PETG, 0.08 mm, back down, no support; filament change to cream at Z 2.00, minimum layer time 10 s for the lip",
  "KINO_COUPON_PILLAR.stl": "FDM, PETG, 0.20 mm, plate down: one pillar with its head pocket and a face pin hole",
  "KINO_COUPON_POCKET.stl": "FDM, PETG, 0.20 mm, plate down: one camera pocket with its ribs, reliefs and bore",
  "KINO_COUPON_DECK.stl": "FDM, PETG, 0.20 mm, cut face down: the deck with the pod, the collar and the guide ribs",
  "KINO_COUPON_STRAP_SHELL.stl": "FDM, PETG, 0.20 mm, cut face down: a wall end with its tunnel, slots and the first frame pilot; pulled to 100 N on a 2.5 mm cord, the pilot driven ten times",
  "KINO_COUPON_SHRINK_BAR.stl": "FDM, PETG, 0.20 mm: a 100 x 10 x 3 bar; measure it, set the slicer's shrink compensation, never scale the shell",
  "KINO_CARRIER_SHUTTER_BUTTON.stl": "FDM, PETG, 0.08 mm, flange down, no support",
};
