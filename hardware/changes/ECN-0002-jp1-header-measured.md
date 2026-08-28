# ECN-0002: JP1 header map measured on the board, reverting ECN-0001

| Field | Value |
|---|---|
| Status | Accepted |
| Author | KINO contributors |
| Date | 2026-08-28 |
| Hardware revision | D4-V1 |
| Design version before | 0.1.1 |
| Design version after | 0.1.2 |
| Supersedes | [`ECN-0001`](ECN-0001-jp1-header-correction.md) |
| Affected units | No released units. One bench P4 carrier and one camera node. |

## Problem

[`ECN-0001`](ECN-0001-jp1-header-correction.md) replaced the recorded JP1 map with the manufacturer pinout for the **`JC-ESP32P4-M3-DEV`**. That is a different carrier. It shares the ESP32-P4 module with our board and nothing else, including not the expansion header.

Our board is the **`JC4880P443C-I-W`**, and the silkscreen says so. Under ECN-0001 the firmware opened `CAM1` on GPIO1/GPIO2, which reach no connector on this carrier, so the camera link could not work and its failure looked exactly like a wiring or ground fault.

ECN-0001 was not careless — it replaced an unsourced table with a manufacturer document, which is normally the right move. It was wrong because nobody checked which product the document described, and because the check that would have caught it (put a meter or a signal on the pin) was never done. The table it replaced happened to be correct, which nobody could have known either.

## Evidence

Three sources, in increasing order of authority.

**1. The manufacturer PIN DEFINITIONS drawing for the `JC4880P443C-I-W`.** Silkscreen `JC4880P443` and the Guition logo are visible on the board in the drawing.

**2. Bench failure of ECN-0001's map.** With a node wired to JP1 7/9 per ECN-0001 and known good in isolation — `camnode 0.4.1`, OV3660 detected at SCCB `0x3c`, PSRAM test OK, listening on its UART1 at 921600 — the P4 sent 113 HELLO frames and received **0 bytes**, with 0 CRC errors and 0 resyncs. A diagnostic node image logging every byte on its link UART recorded **no bytes at all** across two minutes. A TX-to-RX loopback across JP1 7–9, node removed from the circuit entirely, transmitted 33 frames and received **0 bytes**. A continuity check then proved the wire and the receiving pad good by reading a steady logic 1 with the same jumper on JP1 pin 1.

**3. Direct measurement of the header.** The P4 was flashed with a diagnostic that drives every one of its 47 usable GPIOs — all of GPIO0–54 except the console pair 37/38 and the mounted card's 39–44 — each announcing its own index in binary: a six-pulse sync, then six bit windows, one pulse for a 0 bit and three for a 1. A camera node watched a single wire on GPIO44 and reported the pulse counts.

| JP1 pin | Bursts | Index | GPIO |
|---:|---|---:|---|
| 13 | `6 \| 3 1 1 3 1 3` | 41 | **GPIO49** |
| 7 | `6 \| 1 1 3 3 1 3` | 44 | **GPIO52** |

Four identical frames were captured at each pin. The second was predicted from the drawing before the run and matched.

## Change

JP1 as measured, pin 1 top-left, odd pins left, even pins right:

| Pin | Left | Right | Pin |
|---:|---|---|---:|
| 1 | 3V3 | 5V | 2 |
| 3 | 3V3 | 5V | 4 |
| 5 | GND | GND | 6 |
| 7 | GPIO52 | GPIO33 | 8 |
| 9 | GPIO51 | GPIO31 | 10 |
| 11 | GPIO50 | GPIO30 | 12 |
| 13 | GPIO49 | GPIO29 | 14 |
| 15 | GPIO35 | GND | 16 |
| 17 | GPIO34 | ESP_3V3 | 18 |
| 19 | GPIO32 | C6_U0RXD | 20 |
| 21 | GPIO28 | C6_U0TXD | 22 |
| 23 | I2C_SDA | C6_IO9 | 24 |
| 25 | I2C_SCL | C6_CHIP_PU | 26 |

Twelve P4 GPIOs reach the header against eleven signals wanted, so every V1 signal is routed and one pin is spare:

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
| FLASH_EN | 28 | 21 | out |
| CAM_PWR_EN | 31 | 10 | out |
| — | 35 | 15 | spare |

`FLASH_EN` and `CAM_PWR_EN` regain the header pins ECN-0001 took from them, so the I²C GPIO expander that ECN-0001 proposed for M2 is not needed. The camera bank can be switched from the P4 again, which §37 of the M1 runbook depends on.

## Strapping pins on the header

`GPIO34` and `GPIO35` are ESP32-P4 strapping pins and the carrier routes both to JP1. Twelve pins carrying eleven signals cannot avoid them, so:

- **`GPIO35` (pin 15) is the spare and must stay unconnected.** It is the serial-bootloader strap: held low at reset the chip enters the ROM downloader instead of the application, and `GPIO36`=0 with `GPIO35`=0 is documented as invalid. It idles high on an internal pullup, so an unwired pin is safe. A pin wired to ground is a board that will not boot — and at a bench that reads as dead firmware, not as a wiring mistake.
- **`GPIO34` (pin 17) carries `CAM3_TX`, an output.** We drive it and the far end is a node's UART RX, high impedance, which cannot hold it through our reset.

A camera's TX is an input to us and must never land on either. `packages/hardware-profiles/tests/pinmap.test.ts` and `firmware/p4/main/board_d4v1_checks.h` both encode that rule.

## Compatibility

No released units, so no field impact. `finalGpioMap` stays `false` and `GPIO_TBD` stays in `WIRING.md`: the header positions are now measured, but no camera node has yet answered on any of them, so the assignment stays electrically `UNVALIDATED` per GitHub issue #2.

## Verification

- `firmware/p4/host_tests/test_board_pins.c` — 348 checks, 0 failures. Includes the two measured pins by name.
- `board_d4v1_checks.h` — `_Static_assert` set extended to all eleven routed signals; the firmware does not compile with an inconsistent map.
- `packages/hardware-profiles` — 41 tests, including a vitest that parses `board_d4v1.h` and fails if the C header and the JSON profile disagree.
- `./test_board_pins --dump` is the generator for the profile's `gpio` and `jp1` blocks, so the two cannot drift by hand.

## Rule adopted

From `board_d4v1.h`:

> Do not edit these numbers from a datasheet, a photo of another board, or a vendor page. Measure the pin.

A manufacturer document is evidence about *a* board. Only the bench is evidence about *this* board.
