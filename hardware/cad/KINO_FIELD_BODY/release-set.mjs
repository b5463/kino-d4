// The released file set: every STL this folder ships, the sub-folder it lives
// in, and how many separate parts it must contain. validate-stl.mjs reads it to
// fail any file that is missing, misplaced, stale or merged; promote.mjs reads
// it to know where each candidate goes.
//
//   print/    the eight camera parts, one file each, in print orientation
//   plates/   the same eight parts pre-arranged as the two bed jobs
//   coupons/  bench coupons, the glue-up tool and the two working rigs
//
// An STL without an entry fails outright, so a file from an earlier generation
// cannot sit beside the released set and silently PASS.
export const RELEASE_SET = [
  // The chassis is two prints, cut at the bay floor. Each must be one part.
  { file: "KINO_FIELD_BODY_FRONT_PRINT.stl", dir: "print", parts: 1 },
  { file: "KINO_FIELD_BODY_REAR_PRINT.stl", dir: "print", parts: 1 },
  { file: "KINO_FIELD_FACE_PRINT.stl", dir: "print", parts: 1 },
  { file: "KINO_FIELD_LENS_SLIDER.stl", dir: "print", parts: 1 },   // the sliding lens cover
  { file: "KINO_FIELD_SLIDER_KEEPER.stl", dir: "print", parts: 1 }, // glued into the track's entry gap behind it
  { file: "KINO_FIELD_BEZEL_PRINT.stl", dir: "print", parts: 1 },   // the rear door
  { file: "KINO_FIELD_XIAO_CLAMPS.stl", dir: "print", parts: 4 },   // two straight, two kinked
  { file: "KINO_FIELD_SHUTTER_BUTTON.stl", dir: "print", parts: 2 }, // actuator + retainer
  // Bed jobs: the parts above placed as the README's two plates.
  { file: "KINO_PLATE_1_CHASSIS.stl", dir: "plates", parts: 2 },
  { file: "KINO_PLATE_2_FACE_DOOR_COVER.stl", dir: "plates", parts: 10 },
  // Bench coupons. Each is a chunk of a released solid, so a change to the
  // parent changes the coupon too and cannot be tested against a stale copy.
  { file: "KINO_FACE_ALIGN_TOOL.stl", dir: "coupons", parts: 1 },   // the glue-up jig
  { file: "KINO_P4_POST_SCREW_TEST.stl", dir: "coupons", parts: 1 },
  { file: "KINO_CAM_FIT_COUPON.stl", dir: "coupons", parts: 1 },
  { file: "KINO_XIAO_STACK_COUPON.stl", dir: "coupons", parts: 1 },
  { file: "KINO_DOOR_JOINT_COUPON.stl", dir: "coupons", parts: 2 },   // wall rails + the door length
  { file: "KINO_SLIDER_TRACK_COUPON.stl", dir: "coupons", parts: 3 }, // track + cover + keeper
  { file: "KINO_SPLIT_JOINT_COUPON.stl", dir: "coupons", parts: 2 },  // one bolt station from each half
  { file: "KINO_INSERT_PILOT_COUPON.stl", dir: "coupons", parts: 1 },
  { file: "KINO_WIGGLE_TEST_RIG.stl", dir: "coupons", parts: 6 },     // rig plate + retainer bar + its four short clamps
  { file: "KINO_WIGGLE_RIG_SKELETAL.stl", dir: "coupons", parts: 5 }, // truss + its four short clamps
  // Wall chunk + actuator + retainer: the whole shutter mechanism, which is the
  // only thing a user operates that had never been printed.
  { file: "KINO_SHUTTER_COUPON.stl", dir: "coupons", parts: 3 },
  // KINO Twin: the shells in their ASSEMBLED positions, in body coordinates,
  // the lens cover open. Not printable - the face sits at negative Z and the
  // rear half carries its split face - but manifold, and validated as such.
  // apps/twin loads them straight from this folder (see twin/ in the README).
  { file: "KINO_TWIN_CHASSIS_FRONT.stl", dir: "twin", parts: 1 },
  { file: "KINO_TWIN_CHASSIS_REAR.stl", dir: "twin", parts: 1 },
  { file: "KINO_TWIN_FACE.stl", dir: "twin", parts: 1 },
  { file: "KINO_TWIN_LENS_COVER.stl", dir: "twin", parts: 1 },
  { file: "KINO_TWIN_SLIDER_KEEPER.stl", dir: "twin", parts: 1 },
  { file: "KINO_TWIN_DOOR.stl", dir: "twin", parts: 1 },
];
export const RELEASE_DIRS = ["print", "plates", "coupons", "twin"];
// Non-mesh outputs of a build and where they go.
export const RELEASE_FILES = [
  { file: "field-body-release-report.json", dir: "reports" },
  // PDF, not SVG: an SVG has no page, so there is no "print at 100%" for a
  // viewer to obey, and a 1:1 sheet that has been silently scaled still reads
  // as evidence. Both carry a 100 mm calibration line as the backstop.
  { file: "KINO_P4_1TO1_HOLE_TEMPLATE.pdf", dir: "coupons" },
  { file: "KINO_DOOR_FOAM_TEMPLATE.pdf", dir: "coupons" },
  // The datums the Twin places the electronics from: camera axes, XIAO seats,
  // the module bay, the hub board's box, the shutter, every part's bounding
  // box. JSON, so a reader outside this folder needs no Manifold.
  { file: "field-body-twin-datums.json", dir: "twin" },
];
// Extensions promote.mjs sweeps out of the release folders when they are not in
// the set above. It used to sweep only ".stl", which meant a change of FORMAT
// left the old file sitting in a folder that still reported itself as "the
// released set" - the two 1:1 templates became PDFs and their SVGs stayed
// behind, promoted, validated and ALL CLEAR beside them. ".svg" stays on this
// list precisely because nothing emits one any more: that is the case the sweep
// has to catch.
export const SWEEP_EXT = [".stl", ".pdf", ".svg", ".json"];
