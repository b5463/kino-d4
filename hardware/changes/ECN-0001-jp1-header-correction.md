# ECN-0001: JP1 header map corrected to the manufacturer pinout

| Field | Value |
|---|---|
| Status | **SUPERSEDED by [ECN-0002](ECN-0002-jp1-header-measured.md)** |
| Author | KINO contributors |
| Date | 2026-08-28 |
| Hardware revision | D4-V1 |
| Design version before | 0.1.0 |
| Design version after | 0.1.1 |
| Affected units | No released units. One bench P4 carrier, never wired to a camera node. |

> **Superseded 2026-08-28.** The pinout below is the manufacturer table for the
> `JC-ESP32P4-M3-DEV`, which is a different carrier. Our board is the
> `JC4880P443C-I-W`. Under this map `CAM1` sat on GPIO1/GPIO2, which reach no
> connector here, and a TX-to-RX loopback across JP1 7-9 received zero bytes.
> The header was then measured pin by pin; see
> [`ECN-0002`](ECN-0002-jp1-header-measured.md). Kept unedited as the record of
> a decision that was made and reversed.

## Problem

The repository recorded the Guition JC4880P443C-I-W expansion header (JP1, 2x13) as carrying P4 GPIO52/51/50/49/35/34/32/28 on the left and GPIO33/31/30/29 on the right, and assigned the four camera UARTs to GPIO52/51, 50/49, 34/33 and 30/29. The rows entered in commit `1bc8a7e` (2026-08-21) as "hardware data" without a manufacturer source and were copied into `board_d4v1.h` in `4cb19b3` the same day. Rows 1-3 (3V3, 5V, GND) and the C6 block (rows 10-13, right) matched the board, so the table passed review.

The manufacturer JC-ESP32P4-M3-DEV pinout and the board silkscreen disagree with almost every other row. The header exposes exactly eleven P4 GPIOs: 1, 2, 3, 4, 5, 20, 32, 33, 45, 46, 47. GPIO52, 51, 50, 49, 35, 34, 31, 30, 29 and 28 are not on any connector. Eight of the eight recorded camera UART pins routed to nothing. A camera node wired to the recorded pins could not have communicated, and the failure would have looked like a wiring or ground fault.

## Change

Manufacturer JP1 (pin 1 top-left, odd pins left, even pins right):

| Pin | Left | Right | Pin |
|---:|---|---|---:|
| 1 | 3V3 | 5V | 2 |
| 3 | 3V3 | 5V | 4 |
| 5 | GND | GND | 6 |
| 7 | GPIO1 | NC | 8 |
| 9 | GPIO2 | GPIO47 | 10 |
| 11 | GPIO3 | GPIO46 | 12 |
| 13 | GPIO4 | GPIO45 | 14 |
| 15 | GPIO5 | GND | 16 |
| 17 | GPIO20 | 3V3 | 18 |
| 19 | GPIO32 | C6_U0RXD | 20 |
| 21 | GPIO33 | C6_U0TXD | 22 |
| 23 | ESI2C_SDA | C6_IO9 | 24 |
| 25 | ESI2C_SCL | C6_CHIP_PU | 26 |

GPIO3 is the GT911 touch reset and GPIO5 is the ST7701S panel reset; both are validated on hardware and stay reserved. Nine header GPIOs remain for KINO signals. The design wants ten (8 UART, SYNC_OUT, FLASH_EN) plus CAM_PWR_EN.

PROVISIONAL assignment, recorded in `firmware/p4/main/board_d4v1.h` (source of truth) and `packages/hardware-profiles/src/profiles/d4-v1.json`:

| Signal | P4 GPIO | JP1 pin | Direction |
|---|---:|---:|---|
| CAM1_TX | 1 | 7 | out |
| CAM1_RX | 2 | 9 | in |
| CAM2_TX | 47 | 10 | out |
| CAM2_RX | 46 | 12 | in |
| CAM3_TX | 32 | 19 | out |
| CAM3_RX | 33 | 21 | in |
| CAM4_TX | 45 | 14 | out |
| CAM4_RX | 4 | 13 | in |
| SYNC_OUT | 20 | 17 | out |
| FLASH_EN | none | none | unassigned |
| CAM_PWR_EN | none | none | unassigned |

FLASH_EN and CAM_PWR_EN have no header pin. Candidate route for M2: an I2C GPIO expander on the ESI2C pins (23/25), which are the same bus as the touch controller and codec. That decision needs the schematic and is not made here.

## Evidence

- Manufacturer JC-ESP32P4-M3-DEV / Guition JP1 pinout table (2026-08-28).
- Board silkscreen check recorded in commit `944b68e` (2026-08-27).
- ESP32-P4 pin facts: strapping pins are GPIO34-38; USB is GPIO24-27; SD slot 0 IOMUX pads are GPIO39-44 (validated by a real mount on 2026-08-26); the C6 SDIO transport is GPIO14-19 with EN on GPIO54; I2C 7/8; I2S 9-13/48; backlight 23. None of the nine chosen GPIOs is in any of those sets. Every P4 UART routes TX and RX through the GPIO matrix.
- No electrical measurement of the nine pins exists yet. The map is PROVISIONAL until a node answers over each link.

## Compatibility

No harness has been built to the old map, so nothing physical is invalidated. The camera-node side (XIAO RX GPIO44, TX GPIO43) is unchanged. The firmware-visible hardware validation row names for the camera pins change with the pins. `hardware/WIRING.md` keeps `GPIO_TBD` for every line, because no line has bench evidence.

The `CAM_PWR_EN GPIO31 VALIDATED (pin only)` record in `firmware/HARDWARE_VALIDATION.md` is void: GPIO31 is not on the header, so driving it proved nothing about the camera bank.

## Safety and recovery

Do not wire a camera node using any document that names GPIO52/51 for CAM1. Flash and camera power cannot be controlled from the header on this carrier as drawn; the firmware leaves both unassigned and refuses to drive them. Affected units: none built.

## Files changed

- `hardware/changes/ECN-0001-jp1-header-correction.md`
- `hardware/CHANGELOG.md`, `hardware/manifest.json`, `hardware/revisions/D4-V1.md`, `versions.json`
- `hardware/WIRING.md` (row names and header capacity note)
- `firmware/p4/main/board_d4v1.h` and its users, `firmware/p4/host_tests/test_board_pins.c`
- `packages/hardware-profiles/src/profiles/d4-v1.json` and its tests
- `docs/HARDWARE.md`, `firmware/HARDWARE_VALIDATION.md`, M1 bring-up documents

## Verification

- [x] BOM and manifest agree (BOM unchanged).
- [x] Wiring and GPIO records agree: `hardware/WIRING.md` stays `GPIO_TBD`; the provisional map lives in the firmware header and the hardware profile, cross-checked by a host test.
- [ ] Assembly and acceptance procedures were updated (no step names a P4 GPIO).
- [x] Affected firmware and KDP assumptions were tested (host tests, IDF build).
- [ ] Closed-enclosure checks were repeated where needed (not applicable).
- [x] `npm run version:check` passes.

## Decision

Accepted. Patch bump 0.1.0 -> 0.1.1: the physical design is unchanged; the record of the carrier was wrong and is corrected. `finalGpioMap` stays `false`.
