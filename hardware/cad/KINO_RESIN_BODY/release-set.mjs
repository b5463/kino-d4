// The one list of what this package ships, where it goes, and in how many
// pieces. `validate-stl.mjs` and `promote.mjs` both read it, so a file that is
// not listed here cannot sit in a release folder and a file that is listed
// cannot go missing quietly.
//
// `parts` is the connected-component count. It is the cheapest possible check
// that a Boolean did what it was told: a skeleton that arrives in five pieces
// has lost its optical datum, and a resin part in two pieces is two line items
// in the bureau's quote.
export const RELEASE_SET = [
  { file: "KINO_RESIN_SKELETON.stl", dir: "print", parts: 1 },
  { file: "KINO_RESIN_SHELL.stl", dir: "print", parts: 1 },
  { file: "KINO_RESIN_FACE.stl", dir: "print", parts: 1 },
];
export const RELEASE_DIRS = ["print"];
// Non-mesh outputs of a build and where they go.
export const RELEASE_FILES = [
  { file: "resin-body-release-report.json", dir: "reports" },
];
// Extensions promote.mjs sweeps out of the release folders when they are not in
// the set above. The field body learned this the hard way: sweeping only
// ".stl" meant a change of FORMAT left the old file behind in a folder that
// still reported itself as the released set.
export const SWEEP_EXT = [".stl", ".pdf", ".svg", ".3mf"];

// Which process and material each part is quoted in. Kept here rather than in
// prose because it is part of the release: the same STL in the wrong material
// is a different part. See the README for why each one is what it is.
export const RELEASE_PROCESS = {
  "KINO_RESIN_SHELL.stl": "SLA, transparent resin, clear - JLCPCB 8001-class",
  "KINO_RESIN_FACE.stl": "SLA, tough resin, BLACK - JLCPCB 8228-class",
  "KINO_RESIN_SKELETON.stl": "MJF, nylon PA12, black - not resin: it is the part that gets dropped",
};
