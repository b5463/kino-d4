# KINO D4 hardware package

This directory holds the files needed to turn the D4 V1 parts list into a repeatable physical build.

## Build files

| File | Purpose |
|---|---|
| [`BOM.csv`](BOM.csv) | Parts, quantities, confidence, and unresolved purchasing details |
| [`WIRING.md`](WIRING.md) | Power topology, camera harnesses, signal directions, and the open GPIO map |
| [`ASSEMBLY.md`](ASSEMBLY.md) | Mechanical and electrical build order with checkpoints |
| [`TESTING.md`](TESTING.md) | Bring-up, load, sync, thermal, and final acceptance record |
| [`cad/`](cad/) | Mechanical source and exports once dimensions are measured |
| [`pcb/`](pcb/) | Carrier-board source if D4 moves beyond perfboard |

The maintained narrative reference remains [`docs/HARDWARE.md`](../docs/HARDWARE.md). The structured component list in [`kino_twin_spec/component-manifest.json`](../kino_twin_spec/component-manifest.json) feeds the digital twin. Keep all three aligned.

## Revision and license

[`REVISION`](REVISION) names the physical compatibility line. [`manifest.json`](manifest.json) gives the independently moving design-package version and artifact revisions. Every design change needs an [engineering change notice](changes/README.md) and a matching entry in [`CHANGELOG.md`](CHANGELOG.md).

This hardware source is licensed under CERN-OHL-S-2.0. The source location is <https://github.com/b5463/kino-d4>. See the root [`LICENSE`](../LICENSE), the unmodified [license text](../LICENSES/CERN-OHL-S-2.0.txt), and the machine-readable [`REUSE.toml`](../REUSE.toml).

## Confidence

A row in the BOM is not proof that a dimension fits. Dimensions and limits must carry one of the confidence labels from the hardware reference. `PROVISIONAL`, `CONFLICT`, and `MEASURE_REQUIRED` block final CAD.

## Revision rule

These files describe D4 V1. A change that breaks enclosure, wiring, firmware pin mapping, or replacement-part compatibility needs a new hardware revision. Do not edit V1 into a different camera while keeping the same name.

## Missing physical records

The repository still needs measured photographs, caliper records, final GPIO assignments, a locked carrier layout, and electrical test sheets from the assembled camera. The checklists here make those gaps visible. They do not claim the tests have been run.
