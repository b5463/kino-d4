# D4 hardware changelog

This log tracks released design-package versions inside the physical revision named in [`REVISION`](REVISION). Numbered engineering change notices carry the reason, evidence, and compatibility decision for each change.

## 0.1.1 - 2026-08-28

Status: prototype. No physical unit has passed the acceptance sheet.

- Corrected the JP1 expansion-header record to the manufacturer JC-ESP32P4-M3-DEV pinout. The header exposes P4 GPIO1, 2, 3, 4, 5, 20, 32, 33, 45, 46, 47; the previously recorded GPIO52/51/50/49/35/34/31/30/29/28 are not on any connector.
- Re-assigned the four camera UARTs and SYNC_OUT to header pins that exist (PROVISIONAL). FLASH_EN and CAM_PWR_EN have no header pin on this carrier.
- `GPIO_TBD` stays in WIRING.md; `finalGpioMap` stays false.

Engineering change notice: [`ECN-0001`](changes/ECN-0001-jp1-header-correction.md).

## 0.1.0 - 2026-08-17

Status: prototype documentation baseline. No physical unit has passed the acceptance sheet.

- Added the initial 24-row BOM.
- Recorded the protected 1S power path, four switched camera channels, UART harnesses, and shared sync topology.
- Added staged assembly and physical acceptance procedures.
- Kept the GPIO map, final enclosure envelope, CAD, and PCB source visibly unresolved.
- Applied CERN-OHL-S-2.0 to the hardware source.

Engineering change notice: [`ECN-0000`](changes/ECN-0000-initial-baseline.md).
