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
  { file: "KINO_CARRIER_KEEPER.stl", dir: "print", parts: 1 },
  { file: "KINO_CARRIER_SHUTTER_BUTTON.stl", dir: "print", parts: 2 },
  // Coupons: pieces of the real parts cut out with boxes. Print these first.
  { file: "KINO_COUPON_PILLAR.stl", dir: "coupons", parts: 1 },
  { file: "KINO_COUPON_POCKET.stl", dir: "coupons", parts: 1 },
  { file: "KINO_COUPON_DECK.stl", dir: "coupons", parts: 1 },
  { file: "KINO_COUPON_STRAP_SHELL.stl", dir: "coupons", parts: 1 },
  { file: "KINO_COUPON_STRAP_FRAME.stl", dir: "coupons", parts: 1 },
  { file: "KINO_COUPON_TRACK_FACE.stl", dir: "coupons", parts: 1 },
  { file: "KINO_COUPON_TRACK_COVER.stl", dir: "coupons", parts: 1 },
  { file: "KINO_COUPON_TRACK_KEEPER.stl", dir: "coupons", parts: 1 },
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
  "KINO_CARRIER_SHELL.stl": "FDM, PETG, 0.20 mm, face down, no support",
  "KINO_CARRIER_REAR_FRAME.stl": "FDM, PETG, 0.20 mm, rear face down, no support",
  "KINO_CARRIER_FACE.stl": "FDM, PETG, 0.20 mm, back down, slicer supports off: five breakaway blades under the roof are in the file; snap them out through the entry gap before the keeper goes in",
  "KINO_CARRIER_LENS_COVER.stl": "FDM, PETG, 0.20 mm, back down, no support",
  "KINO_CARRIER_KEEPER.stl": "FDM, PETG in the face's filament, 0.20 mm, front down (the foot up); captive in the shell's plate under the face, no glue",
  "KINO_COUPON_PILLAR.stl": "FDM, PETG, 0.20 mm, plate down: one pillar with its screw stack and a face pin hole",
  "KINO_COUPON_POCKET.stl": "FDM, PETG, 0.20 mm, plate down: one camera pocket with its ribs, reliefs and bore",
  "KINO_COUPON_DECK.stl": "FDM, PETG, 0.20 mm, cut face down: the deck with the pod, the collar and the guide ribs",
  "KINO_COUPON_STRAP_SHELL.stl": "FDM, PETG, 0.20 mm, cut face down: a wall end with its tunnel and slots, pulled to 100 N on a 2.5 mm cord",
  "KINO_COUPON_STRAP_FRAME.stl": "FDM, PETG, 0.12 mm, rear face up: the frame corner with its two slots",
  "KINO_COUPON_TRACK_FACE.stl": "FDM, PETG, 0.20 mm, back down, slicer supports off: 74 mm of the face with the track, the roof on three of its blades, the lip slot and three cells",
  "KINO_COUPON_TRACK_COVER.stl": "FDM, PETG, 0.08 mm, back down: the cover's left 70 mm with its lip; the flush to cream at 2.00",
  "KINO_COUPON_TRACK_KEEPER.stl": "FDM, PETG, 0.20 mm, front down: the keeper's left 70 mm with its foot",
  "KINO_COUPON_SHRINK_BAR.stl": "FDM, PETG, 0.20 mm: a 100 x 10 x 3 bar; measure it, set the slicer's shrink compensation, never scale the shell",
  "KINO_CARRIER_SHUTTER_BUTTON.stl": "FDM, PETG, 0.20 mm, flange down",
};
