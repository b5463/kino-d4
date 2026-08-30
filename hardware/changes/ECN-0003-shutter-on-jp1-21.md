# ECN-0003: the shutter button takes JP1 pin 21, and the built-in flash leaves D4-V1

| Field | Value |
|---|---|
| Status | Accepted |
| Author | KINO contributors |
| Date | 2026-08-30 |
| Hardware revision | D4-V1 |
| Design version before | 0.1.2 |
| Design version after | 0.1.3 |
| Supersedes | Amends the `FLASH_EN` row of [`ECN-0002`](ECN-0002-jp1-header-measured.md); the rest of that map stands. |
| Affected units | No released units. One bench P4 carrier and one camera node. |

## Problem

The body needs a shutter button and the button needs a P4 GPIO. JP1 carries twelve P4 GPIOs and [`ECN-0002`](ECN-0002-jp1-header-measured.md) spent eleven of them on the four camera UART pairs, `SYNC_OUT`, `FLASH_EN` and `CAM_PWR_EN`. The twelfth, `GPIO35` on pin 15, is the one that must not be used.

`BOARD_BTN_SHUTTER` has been `BOARD_BTN_NONE` since the first firmware. The touch screen fires captures instead, which works at a bench and is not a camera.

## Options considered

**`GPIO35`, JP1 pin 15 — rejected.** It is the free pin, and it is free because it is the ESP32-P4 serial-bootloader strap. A switch to ground on it is a switch that puts the chip into the ROM downloader whenever it is held through a reset, and at a bench that reads as dead firmware rather than as a button. `GPIO36`=0 with `GPIO35`=0 is documented as invalid on top of that. The pin stays unconnected.

**`GPIO31`, JP1 pin 10 (`CAM_PWR_EN`) — rejected.** Lending the button the camera-bank enable would cost the P4 its ability to cut the four camera channels: no idle power-down, and no way to power-cycle a node that has stopped answering. M1 §37 is exactly that test. `CAM_PWR_EN` keeps `GPIO31`.

**`GPIO28`, JP1 pin 21 (`FLASH_EN`) — chosen.** `GPIO28` is not a strapping pin — 34 to 38 are — so a switch to ground on it is electrically ordinary. The line drives nothing today: no flash board exists, `capture.c` holds the pin low, and `HWV_FLASH_EN_GPIO28` has never been validated. A button on a live pin costs a real function; a button on this pin costs a function that has never run.

**An I²C GPIO expander on JP1 23/25 — deferred to M2.** It is the right answer for the second row of controls (`BTN_FN`, `SLIDE_MODE`, the four per-camera power-switch lines) and it is a part, a driver and a bring-up. One button does not justify it.

## Decision

`BTN_SHUTTER` takes **`GPIO28`, JP1 pin 21**.

The built-in constant-current direct-flash assembly is **dropped from D4-V1**. A separate external flash module will be used instead. It has no P4 pin in this revision and its interface is not chosen.

`CAM_PWR_EN` stays on `GPIO31`, JP1 pin 10. `GPIO35` on pin 15 stays the spare and stays unconnected. `BTN_FN` and `SLIDE_MODE` stay unassigned.

Twelve header GPIOs still carry eleven signals:

| Signal | P4 GPIO | JP1 pin | Direction |
|---|---:|---:|---|
| CAM1_TX | 52 | 7 | out |
| CAM1_RX | 51 | 9 | in |
| CAM2_TX | 50 | 11 | out |
| CAM2_RX | 49 | 13 | in |
| CAM3_TX | 34 | 17 | out |
| CAM3_RX | 33 | 8 | in |
| CAM4_TX | 30 | 12 | out |
| CAM4_RX | 29 | 14 | in |
| SYNC_OUT | 32 | 19 | out |
| CAM_PWR_EN | 31 | 10 | out |
| BTN_SHUTTER | 28 | 21 | in |
| — | 35 | 15 | spare |

## Reasoning

The camera bank is fed from the Guition's own 5 V header pins, JP1 2 and 4, with the AO4407 channels inline, so `CAM_PWR_EN` still cuts the bank. That is what makes `GPIO31` worth more than a button pin: it is idle power-down for four nodes and the only way the P4 can restart a hung one. The flash is the opposite case. It is one output that has never been asserted, feeding a board that has never been built, and moving it off the header changes nothing that runs today.

## Wiring

- Switch: 6 × 6 × 4.3 mm tactile, through-hole.
- One leg to **JP1 pin 21** (`GPIO28`). The other leg to **GND**: JP1 pin 6 or JP1 pin 16, whichever is nearer the button on the carrier.
- **No external resistor.** `buttons.c` configures the pin with the P4's internal pull-up enabled and the pull-down disabled. The input is active low: open reads 1, pressed reads 0.
- No debounce capacitor. Debounce is 25 ms in firmware.

## Firmware

`firmware/p4/main/board_d4v1.h`:

- `BOARD_BTN_SHUTTER` 28, `BOARD_BTN_SHUTTER_JP1` 21.
- `BOARD_FLASH_EN` becomes `BOARD_GPIO_NONE`.
- The `_Static_assert` set in `board_d4v1_checks.h` follows: the eleven routed signals are the same count with `BTN_SHUTTER` in place of `FLASH_EN`, and `GPIO28` is checked as a non-strapping pin carrying an input.

`buttons.c` marks `HWV_BTN_SHUTTER` on the first debounced press. Debounce is 25 ms, the long-press threshold 600 ms; both are firmware constants and neither needs a part on the board.

`GET_CAPABILITIES` is unchanged: `flashControl` stays `true` (the command surface exists), `flashHardware` stays `false` (no flash board is fitted). No KDP surface changes, so the firmware fixture profile for 0.4.7 is the same `d4-roll-0-4`.

## Compatibility

No released units, so no field impact.

One case is worth writing down. A unit wired per ECN-0002, with a flash driver's enable input on JP1 pin 21, running firmware 0.4.7: the P4 now configures that pin as an input with its internal pull-up on, so the enable line is pulled to 3.3 V through the internal pull-up instead of being held low. A driver with an active-high enable and a high input impedance would read that as **on** and the LED would light and stay lit until the pin is pulled down. There is no such unit. Do not build one: an external flash module for D4-V1 does not connect to pin 21.

## Validation

- `HWV_BTN_SHUTTER` in `firmware/p4/main/hardware_validation.h` is earned on the first debounced press on the physical switch. Until that press it stays `UNVALIDATED`, and `hardware/WIRING.md` keeps `bench validation required` on the `BTN_SHUTTER` row.
- `HWV_FLASH_EN_GPIO28` stays in the registry as an append-only `UNVALIDATED` row. It can no longer flip: nothing drives `GPIO28` as an output any more. It records that the line was assigned and never proven, which is the true history.
- With a meter on JP1 pin 21 against JP1 pin 6, firmware running: **3.3 V idle, 0 V while the button is held.** Anything else is the switch, the ground leg, or the wrong pin.
- `finalGpioMap` stays `false` in `hardware/manifest.json`. The header position is measured; the button has not been pressed on a board yet.

## Open items

- The external flash module: part, drive current, enable interface, and where its control comes from. The I²C expander on JP1 23/25 is the standing candidate, since the same expander would carry `BTN_FN`, `SLIDE_MODE` and the four per-camera power-switch lines. Nothing is chosen.
- `BTN_FN` has no pin. There is no free P4 GPIO on JP1 for it and there will not be one in this revision.
