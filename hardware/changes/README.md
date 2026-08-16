# Engineering change notices

Every accepted change to the BOM, wiring, mechanical interfaces, power limits, GPIO assignments, CAD, PCB, or physical acceptance criteria gets a numbered ECN.

Use [`../ECN_TEMPLATE.md`](../ECN_TEMPLATE.md). Name files `ECN-NNNN-short-name.md`. Numbers never move or get reused. Rejected and superseded notices stay in history with their final status.

An ECN states the design-package bump:

- patch for clarified source or a compatible production correction;
- minor for a backward-compatible physical capability or new artifact;
- major for a compatibility break inside a stable hardware line.

Before design version `1.0.0`, the package is still a prototype. A breaking prototype change may use a minor bump, but the ECN must describe the break.
