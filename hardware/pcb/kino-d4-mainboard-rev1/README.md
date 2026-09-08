# KINO D4 Mainboard Rev 1.0

Status: **Phase 1 architecture baseline — NOT FOR FABRICATION**

This directory is the KiCad 10 design workspace for the custom KINO D4
mainboard. Phase 1 establishes the system partitioning, measured Guition JP1
mapping, power budget, candidate power architecture, interface contracts and
mechanical placement constraints. It deliberately does not pretend that the
unresolved battery, load and enclosure measurements are complete.

## Open in KiCad 10

Open `KINO_D4_Mainboard_Rev1.kicad_pro`. The root schematic contains the
functional sheet plan. The PCB contains a provisional 117 mm × 70 mm,
four-layer outline and placement-review zones only.

Do not generate fabrication data from this baseline. The board has no released
mounting holes, connector coordinates, routed copper or production footprints.

## Phase 1 records

| File | Purpose |
|---|---|
| `docs/PHASE_1_ARCHITECTURE.md` | Architecture, decisions, power analysis and mechanical plan |
| `docs/INTERFACE_MATRIX.csv` | Pin-level interface contract |
| `docs/POWER_BUDGET.csv` | Machine-readable load and source budget |
| `docs/MAJOR_COMPONENTS.csv` | Preferred parts and unresolved selections |
| `docs/RELEASE_CHECKLIST.md` | Evidence required before schematic and manufacturing release |

## Authority and change control

The measured JP1 map in `hardware/changes/ECN-0002-jp1-header-measured.md`, as
amended by `hardware/changes/ECN-0003-shutter-on-jp1-21.md`, is the source for
the controller connector. Firmware constants in
`firmware/p4/main/board_d4v1.h` and the hardware profile must continue to match
the schematic.

Any change that modifies the externally visible pin map, power behavior,
camera harness or enclosure interface requires an ECN before release.
