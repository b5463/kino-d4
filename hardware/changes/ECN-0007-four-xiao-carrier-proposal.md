# ECN-0007: four socketed XIAOs and integrated battery power

| Field | Value |
|---|---|
| Status | In progress — A0.2 power rework; routing incomplete; not for fabrication |
| Date | 2026-09-30 |
| Hardware revision | D4-V1 reference; new carrier compatibility not released |
| Design version before | 0.1.4 |
| Design version after | 0.1.8 — additive A0.2 draft package, no physical release |
| Affected units | None; no fabrication output |

## Request and proposed change

The user requests four XIAO boards directly on a carrier, a matching 26-pin P4 header, integrated charging and battery retention. Body and battery changes are permitted. The proposal uses replaceable sockets, a 2×13 2.54 mm IDC interface, independent protected camera supplies, battery monitoring, service access and expansion connections.

The detailed proposal is [FOUR_XIAO_CARRIER_PROPOSAL.md](../pcb/kino-d4-mainboard-rev1/docs/FOUR_XIAO_CARRIER_PROPOSAL.md). It replaces neither the existing cabled Phase 1 architecture nor the released body dimensions until implementation and review.

## Evidence and compatibility

Follow-ups on 2026-09-28: the user confirmed the gyroscope and then all six additional features. The first-board scope now requires a combined gyro/accelerometer, backed-up clock, serviceable cover sensor connection, per-camera current monitoring, remote shutter, board-temperature sensing and a haptic driver/motor connection. The motor and cover sensor/magnet are included in the enclosure assembly requirements. A provisional expander allocation and acceptance checks are recorded in the proposal. The A0 now captures candidate circuitry for these features; physical operation, firmware and assembly are not implemented or validated.

The P4 assignments are checked against the current firmware header and ECN-0002/0003. Manufacturer documentation was consulted for XIAO pin sharing and candidate power/control parts. No new hardware measurements or tests were performed.

The logical UART/sync/shutter map is retained. Sockets, connector family, battery retention and power behaviour introduce mechanical/service changes. Existing enclosure compatibility is not claimed. New charger, gauge and expander firmware is required.

## Power and recovery

Resolve USB backfeed, powered-off signal isolation, hardware load disconnect and charger defaults in the schematic. The existing 3 A battery harness does not support the prior 13 W planning load at low cell voltage. Final cell, protection, fuse, wiring and connector selection must follow measured demand and temperature testing.

## Decision

Update, design package 0.1.8: the A0.2 power stages were reworked against the manufacturer data and the ODD JOBS standard, as recorded in the [A0.2 review](../pcb/kino-d4-carrier-a0/A02-REVIEW.md).
- **Charging:** the charger now charges with the camera off and has a fitted thermistor window.
- **Fuel gauge:** it is wired high side as TI specifies.
- **Pack path:** the pack connector sits beside the charger, and the fuse and shunt form a 12 mm chain.
- **Boost:** its inductor meets TI's saturation rule, with compensation calculated for the actual parts.
- **Routing:** the PMID capacitors, USB VBUS and the boost supply are routed.
- **BOM:** every line carries a verified manufacturer part, except the battery pack.
- **Checks:** ERC, DRC and schematic parity each pass with zero violations. 182 connections remain unrouted.

The board remains rejected for ordering. Open items are routing, the battery pack selection, the input-current firmware policy, carrier firmware, and physical qualification.

Update, design package 0.1.7: [A0.2 review](../pcb/kino-d4-carrier-a0/A02-REVIEW.md) supersedes A0.1 as the working design. 250 footprints use both faces (75 front / 175 back); power blocks and manual critical routes were reworked while In1 remains a ground-only reference. Reference fields are outside component footprints and bank labels are aligned. Printed functional labels clear the component bodies and use 1.0 mm text / 0.15 mm stroke. Added an asymmetric sense/test pogo area and optional I2C/sync flash-driver logic connection, and corrected BQ25798 VAC2 to the input rail following TI table 7-5. The four camera datums and P4 envelope remain unchanged. This is still rejected for ordering: routing, input-current policy, autonomous charging, final BOM, firmware and physical qualification remain open. See the current A02 verification reports for counts; A0.1 reports below are historical.

Update, design package 0.1.6: the separate A0.1 working PCB places components on both faces, matches the 22 mm wigglegram pitch, carries the user-supplied ODD JOBS symbol and has partial routing with black-mask manufacturing intent. The [strict review](../pcb/kino-d4-carrier-a0/RELEASE-REVIEW.md) applies the supplied ODD JOBS standard and rejects the current layout for ordering: charger startup/input limiting, switching loops, the ground reference, unfinished routing, final BOM, firmware and physical stack need resolution. DRC has six violations and 67 unconnected items. This is not a released EVT board.

Feature scope is confirmed. The [A0 engineering package](../pcb/kino-d4-carrier-a0/README.md) adds an editable 14-page schematic and 247-footprint, unrouted PCB under design-package version 0.1.5. This does not change the physical hardware revision or supersede existing CAD releases. ERC passes with intended supply declarations; 878 schematic/PCB pads and the firmware header map agree. DRC and physical acceptance do not pass.

The user subsequently required the carrier to stay within the P4 envelope and mount to the onboard inserts. The A0 uses 117.01 x 69.41 mm and four 2.2 mm M2 clearance holes on 61.9 x 54.8 mm centres, with the existing drawing-derived -9.3 mm pattern offset. Mechanical sources, remaining uncertainty and a full-size template are recorded in the package. The former 125 mm study layouts are superseded. Body/battery changes remain allowed within this carrier constraint.

Power qualification, battery retention, exact stack height, circuit-aware placement, routing and carrier firmware remain open in [issue #232](https://github.com/b5463/kino-d4/issues/232). No fabrication outputs are released.
