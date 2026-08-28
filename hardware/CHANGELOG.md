# D4 hardware changelog

This log tracks released design-package versions inside the physical revision named in [`REVISION`](REVISION). Numbered engineering change notices carry the reason, evidence, and compatibility decision for each change.

## 0.1.2 - 2026-08-28

Status: prototype. No physical unit has passed the acceptance sheet.

- Measured the JP1 expansion header on the board instead of transcribing a table, and reverted the map to GPIO52/51/50/49/35/34/32/28 on the left and GPIO33/31/30/29 on the right. 0.1.1 had adopted the manufacturer pinout for the `JC-ESP32P4-M3-DEV`, a different carrier sharing only the P4 module; under it CAM1 sat on GPIO1/GPIO2, which reach no connector here. A TX-to-RX loopback across JP1 7-9, with the node removed, received zero bytes.
- Twelve header GPIOs against eleven signals, so `FLASH_EN` (GPIO28, pin 21) and `CAM_PWR_EN` (GPIO31, pin 10) are routed again and the I2C expander 0.1.1 proposed for M2 is unnecessary. `GPIO35` on pin 15 is the spare.
- Recorded that `GPIO34` and `GPIO35` are ESP32-P4 strapping pins that reach this header. `GPIO35` is the serial-bootloader strap and must stay unconnected; `GPIO34` carries `CAM3_TX` as an output only.
- `GPIO_TBD` stays in WIRING.md and `finalGpioMap` stays false: the positions are measured, but no node has answered on them yet.

Engineering change notice: [`ECN-0002`](changes/ECN-0002-jp1-header-measured.md).

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
