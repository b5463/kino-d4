# ECN-0008: dev carrier D1, four sockets on the P4 header, single-sided assembly

| Field | Value |
|---|---|
| Status | Design released for ordering after the manual checks; nothing fabricated |
| Date | 2026-11-05 |
| Hardware revision | D4-V1 reference; the dev carrier is a bench board, not a product revision |
| Design version before | 0.1.8 |
| Design version after | 0.1.9 |
| Affected units | None; no board exists yet |

## Problem

The A0.2 carrier was quoted at about 500 EUR for two assembled boards and 600 EUR for five. The marginal board costs about 33 EUR; about 430 EUR is fixed. The fixed part comes from double-sided assembly (176 of 256 parts on the back), 42 of 85 BOM lines with no LCSC number, and an extended-library fee on nearly every IC. The firmware drives none of the A0.2 power, charger, gauge, haptic or sensor parts, so the money buys nothing the bench can use yet.

## Proposed change

A new board, `hardware/pcb/kino-d4-dev-carrier/`, alongside A0.2 (which stays as the product carrier design):

- A0.2's outline, M2 insert holes, camera centres and J100 position, so it mounts and cables the same way.
- Only the nets the firmware uses: four UARTs, SYNC_OUT, CAM_PWR_EN, SHUTTER_N, the P4 I2C, the C6 service lines.
- Four TPS2553 camera switches with a shared enable (CAM_PWR_EN) and a fault LED each; link headers for node USB service; 2.2k series resistors in place of the TXU0304 buffers.
- USB-C 5 V input with 5.1k CC pull-downs. No charger, battery, PD, haptic, IMU, RTC, temperature, current monitor, expander or power controller.
- Qwiic I2C port for breakouts while the feature firmware is written.
- 2 layers, SMT on the bottom face only, 14 BOM lines (11 JLC basic), 12 hand-fit through-hole parts.

## Evidence

- Generated from `design/circuit.py` and `design/placement.py`; routed with Freerouting 2.4.1 (0 unrouted after 7 passes); GND poured on both faces.
- KiCad 10.0.6: DRC 0 violations, 0 unconnected; ERC 0. Reports in `outputs/`.
- LCSC numbers and library class checked against the JLC parts API on 2026-11-05 (`design/circuit.py`).
- No measurements: nothing has been built.

## Compatibility

Mounts on the P4 inserts and takes the same 26-pin ribbon as A0.2. Firmware runs unchanged: the pin map is `board_d4v1.h`. The enclosure is not considered; this is a bench board. A0.2's flash provision, remote jack chain, cover sensor and function button are absent.

## Safety and recovery

5 V only, no battery. Each node is current-limited at 1.0-1.2 A; a short on one node drops that node and lights its red LED. The bank cannot power up before firmware drives GPIO31. JP1000 is open by default so the carrier's USB-C and the P4's own USB never meet unless closed on purpose. GPIO35 (JP1 pin 15) is left open and marked NC.

## Files changed

- `hardware/pcb/kino-d4-dev-carrier/` (new)
- `hardware/pcb/README.md`
- `hardware/manifest.json`, `hardware/CHANGELOG.md`, `versions.json`

## Verification

- [x] BOM and manifest agree.
- [x] Wiring and GPIO records agree (`board_d4v1.h`, JP1 map).
- [ ] Assembly and acceptance procedures: bring-up steps in the board README; `hardware/TESTING.md` unchanged until a board exists.
- [ ] Affected firmware and KDP assumptions were tested: none change.
- [ ] Closed-enclosure checks: not applicable.
- [x] `npm run version:check` passes.

## Decision

Design released for ordering once the three manual checks in the board README are done. Issue #250.
