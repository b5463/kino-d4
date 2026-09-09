# KINO D4 Mainboard Rev 1.0

Status: **Phase 1 architecture baseline — NOT FOR FABRICATION**

The KiCad 10 workspace for the custom KINO D4 mainboard.

Phase 1 settles the questions that can be settled on paper: how the system
divides into sheets, what the measured Guition JP1 header actually carries,
what the loads add up to, which power architecture is the candidate, and where
parts have to sit. The battery, load and enclosure measurements are still
missing, and nothing here claims otherwise.

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
