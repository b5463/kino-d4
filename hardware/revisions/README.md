# Hardware revisions

A hardware revision identifies physical compatibility. It is separate from the design-package version in [`../manifest.json`](../manifest.json).

`D4-V1` means the first D4 electrical and mechanical architecture. The design package can move from `0.1.0` to `0.2.0` while it remains D4 V1. A change becomes D4 V2 when an existing V1 unit cannot accept it without electrical, mechanical, harness, or firmware-pin changes.

Each revision record must state:

- lifecycle status;
- physical interfaces;
- protocol compatibility;
- unresolved measurements;
- accepted engineering change notices;
- first and last design-package versions;
- migration or service implications.

The current record is [`D4-V1.md`](D4-V1.md).
