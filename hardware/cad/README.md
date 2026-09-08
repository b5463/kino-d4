# Mechanical CAD

Two bodies, and they answer different questions.

- **`KINO_FIELD_BODY/`** — PETG, FDM, support-free on a 250 × 210 bed. The
  released body and the one to print if you have a printer.
- **`KINO_RESIN_BODY/`** — printed entirely through JLCPCB: a clear SLA shell
  and a black SLA face over a black MJF nylon skeleton that carries every piece
  of electronics. 125 × 82 × 65.5 mm, three parts, no glue and no thread in any
  resin part ([`ECN-0005`](../changes/ECN-0005-resin-body-skeleton-and-shell.md)).
  The face is black for an optical reason: a clear body would put stray light on
  the sensors and the firmware's cover-closed test would never read dark. It has
  **no independent scan yet**, so a pass there is weaker evidence than a pass
  here — its `promote.mjs` says so every run.

Both take the same P4 module, the same four camera modules and XIAOs, and the
same firmware, and both share one PROVISIONAL figure: the standoff pattern's
9.3 mm offset from module centre. One paper check settles it for both.

## The field body

The measured-fit field camera body is released under `KINO_FIELD_BODY/`. It is
a support-free printable test fixture for the JC4880P443C_I_W P4 board and four
XIAO ESP32-S3 Sense cameras at 22 mm pitch; it is not the production enclosure.
Design version 0.1.4 ([`ECN-0004`](../changes/ECN-0004-field-body-slab-split-and-cover.md)).

What is released there, in print orientation:

- the chassis as two prints, front and rear, cut at the component-bay floor;
- the face shell, the sliding lens cover with the keeper block that closes its
  track, and the rear door;
- the XIAO clamps, the shutter button, and the alignment tool for gluing the
  face shell on;
- bench coupons cut from the released solids, and two working four-camera rigs.

The folder is laid out by purpose: `print/` holds the eight camera parts,
`plates/` the same parts pre-arranged as the two bed jobs, `coupons/` the bench
coupons, the glue-up tool and the rigs, `previews/` the renders, `reports/` the
release report and the overhang audits, and `brand/` the wordmark trace. The
scripts sit at the root.

Every file is reproduced by `generate-field-body.mjs`, which writes to
`.candidate/` and gates the geometry (385 checks, throwing on the first
failure). `node promote.mjs` then validates the candidate set with
`validate-stl.mjs`, copies it into the release folders, removes anything stale,
validates again and runs `verify-release.mjs`, which must read ALL CLEAR. That
last program is deliberately independent of the generator: it re-imports the
shipped STLs and measures them against each other. The folder's README records
every assumption, every measured input and its confidence, and what the checks
do and do not prove.

The enclosure envelope is a prototype: `finalMechanicalEnvelope` is false in
`hardware/manifest.json` and stays false until a printed set has been assembled
around the real boards and passed the acceptance sheet.

Commit CAD only after the purchased display module, battery pouch, BMS, power
carrier, speaker depth, switches, connector exits, and camera bar have measured
records. The field body's inputs are listed in its README with their source;
two are still assumptions and are marked as such.

Each released mechanical revision should include:

- the native editable source;
- a neutral STEP export;
- printable STL or 3MF files where useful;
- a drawing with critical dimensions and tolerances;
- the hardware revision and source commit;
- material, insert, screw, and acrylic-thickness notes;
- a short change record from the previous revision.

Do not bake a seller dimension into geometry without keeping its confidence
visible. Name provisional exports with `PROVISIONAL`; never publish them as
production-ready parts.
