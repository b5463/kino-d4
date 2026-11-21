# Keep every revision's renders. Walks the git log for the commits that touched
# this package's previews and copies a representative set from each commit
# into docs/assets/making-of/carrier-body/NN-<sha>-<slug>/, oldest first.
# Re-runnable: a commit already archived is skipped. The index for the website
# page is docs/MAKING_OF.md; this script only appends a stub line per new
# commit to docs/assets/making-of/carrier-body/INDEX.md.
#
#   python archive-previews.py            (from anywhere; paths are resolved here)
#
# What is kept per commit: the front, open, rear and exploded colour views in
# whatever names that cut used (NIGHT_ first, then DAY_, then plain), the
# face and shell print views, and one coupon view if any. Three to seven files.
import pathlib, re, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[2]
PREVIEWS = "hardware/cad/KINO_CARRIER_BODY/previews"
OUT = REPO / "docs" / "assets" / "making-of" / "carrier-body"
INDEX = OUT / "INDEX.md"
WANT = [
    ["KINO_CARRIER_NIGHT_FRONT.png", "KINO_CARRIER_DAY_FRONT.png", "KINO_CARRIER_FRONT.png", "KINO_CARRIER_ASSEMBLED_FRONT.png"],
    ["KINO_CARRIER_NIGHT_OPEN.png", "KINO_CARRIER_DAY_OPEN.png", "KINO_CARRIER_OPEN.png"],
    ["KINO_CARRIER_NIGHT_REAR.png", "KINO_CARRIER_DAY_REAR.png", "KINO_CARRIER_REAR.png", "KINO_CARRIER_ASSEMBLED_REAR.png"],
    ["KINO_CARRIER_EXPLODED.png"],
    ["A02-KINO_CARRIER_FACE_PRINT.png", "KINO_CARRIER_FACE_PRINT.png"],
    ["A01-KINO_CARRIER_SHELL_PRINT.png", "KINO_CARRIER_SHELL_PRINT.png"],
    ["T03-KINO_COUPON_PILLAR.png", "KINO_COUPON_PILLAR.png", "KINO_COUPON_TRACK_FACE.png"],
]

def git(*args):
    return subprocess.run(["git", "-C", str(REPO), *args], check=True, capture_output=True).stdout

log = git("log", "--reverse", "--format=%h%x09%ad%x09%s", "--date=short", "--", PREVIEWS).decode("utf-8", "replace").splitlines()
OUT.mkdir(parents=True, exist_ok=True)
done = {p.name.split("-")[1] for p in OUT.iterdir() if p.is_dir() and "-" in p.name}
lines = INDEX.read_text(encoding="utf-8").splitlines() if INDEX.exists() else ["# Carrier body: every revision's renders", "", "Oldest first. One folder per commit that changed the previews.", ""]
new = 0
for n, row in enumerate(log, 1):
    sha, date, subject = row.split("\t", 2)
    if sha in done:
        continue
    slug = re.sub(r"[^a-z0-9]+", "-", subject.lower().replace("carrier body:", "").split("(#")[0]).strip("-")[:40]
    folder = OUT / f"{n:02d}-{sha}-{slug}"
    folder.mkdir(parents=True, exist_ok=True)
    present = set(git("ls-tree", "--name-only", sha, PREVIEWS + "/").decode().split())
    kept = []
    for choices in WANT:
        for name in choices:
            path = f"{PREVIEWS}/{name}"
            if path in present:
                (folder / name).write_bytes(git("show", f"{sha}:{path}"))
                kept.append(name)
                break
    lines.append(f"- `{folder.name}/` {date}: {subject.replace('Carrier body: ', '')}; kept {', '.join(kept)}")
    new += 1
INDEX.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"{new} new commits archived under {OUT}")
