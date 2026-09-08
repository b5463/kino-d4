// Promote a build from .candidate/ into the release folders - the one command
// that replaces a hand-run sequence of validate, copy, verify.
//
//   node generate-field-body.mjs      writes .candidate/ (gates must pass)
//   node promote.mjs                  this file
//
// Steps, each of which stops the run if it fails:
//   1. validate-stl.mjs on every candidate STL in the released set;
//   2. copy each into print/, plates/ or coupons/ per release-set.mjs, the
//      report into reports/ and the paper template into coupons/;
//   3. delete any STL in those folders that is not in the set (stale);
//   4. validate-stl.mjs on the release folders as they now stand;
//   5. verify-release.mjs, the independent scan of the shipped files.
// Previews are not promoted here: render them from the release folders with
// render-stl.py, they are pictures and not evidence.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { RELEASE_SET, RELEASE_DIRS, RELEASE_FILES, SWEEP_EXT } from "./release-set.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cand = path.join(here, ".candidate");
const run = (script, args = []) => {
  const r = spawnSync(process.execPath, [path.join(here, script), ...args], { stdio: "inherit" });
  return r.status === 0;
};
const step = (n, text) => console.log(`\n== ${n}. ${text}`);

step(1, "validate the candidates");
const missing = RELEASE_SET.filter((e) => !fs.existsSync(path.join(cand, e.file))).map((e) => e.file);
if (missing.length) { console.error(`no candidate for: ${missing.join(", ")} - run the generator first`); process.exit(1); }
if (!run("validate-stl.mjs", RELEASE_SET.map((e) => path.join(cand, e.file)))) { console.error("candidates failed validation; nothing promoted"); process.exit(1); }

step(2, "copy into the release folders");
for (const d of [...RELEASE_DIRS, "reports"]) fs.mkdirSync(path.join(here, d), { recursive: true });
for (const e of RELEASE_SET) fs.copyFileSync(path.join(cand, e.file), path.join(here, e.dir, e.file));
for (const e of RELEASE_FILES) {
  const src = path.join(cand, e.file);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(here, e.dir, e.file));
  else console.warn(`  (no ${e.file} in .candidate - skipped)`);
}
console.log(`  ${RELEASE_SET.length} meshes and ${RELEASE_FILES.length} files copied`);

step(3, "remove stale artefacts");
// Every artefact of a build, not just the meshes. Sweeping only ".stl" meant a
// change of FORMAT left the old file in place: the two 1:1 templates became
// PDFs and their SVGs stayed behind in coupons/, promoted, validated and
// reported ALL CLEAR beside them. The wanted map now carries the non-mesh
// outputs too, so a template cannot be swept as stale by the step that copied
// it in.
const wanted = new Map([...RELEASE_SET, ...RELEASE_FILES].map((e) => [e.file, e.dir]));
let removed = 0;
for (const d of [...RELEASE_DIRS, "."]) {
  const dir = path.join(here, d);
  for (const f of fs.readdirSync(dir)) {
    if (!SWEEP_EXT.includes(path.extname(f).toLowerCase())) continue;
    if (wanted.get(f) === d) continue;
    fs.unlinkSync(path.join(dir, f));
    console.log(`  removed ${path.join(d, f)}`);
    removed++;
  }
}
console.log(`  ${removed} stale file(s) removed, sweeping ${SWEEP_EXT.join(" ")}`);

step(4, "validate the release folders");
if (!run("validate-stl.mjs")) { console.error("release folders failed validation"); process.exit(1); }

step(5, "independent scan of the shipped files");
if (!run("verify-release.mjs")) { console.error("verify-release found problems"); process.exit(1); }

console.log("\nPROMOTED - release folders match .candidate, validated and verified");
