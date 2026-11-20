// The one list of what this package ships, where it goes, and in how many
// pieces. validate-stl.mjs and promote.mjs both read it.
//
// `parts` is the connected-component count: the cheapest check that a Boolean
// did what it was told.
export const RELEASE_SET = [
  { file: "KINO_CARRIER_SHELL.stl", dir: "print", parts: 1 },
  { file: "KINO_CARRIER_REAR_FRAME.stl", dir: "print", parts: 1 },
];
export const RELEASE_DIRS = ["print"];
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
};
