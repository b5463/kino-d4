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

- A0.2's M2 insert holes and camera pitch. The outline is the bare P4 module (114.40 x 66.80, the SKU without shell) plus 2 mm a side (118.40 x 70.80 mm) with a window over the P4's two USB-C ports. No ribbon: J100 is a 2x13 female socket on the P4 face that mates JP1 directly, 11.0 mm board to board, on 8 mm spacers from the inserts. The JP1 datum is provisional (`placement.P4_JP1`, read off the vendor's back photo, +-1.5 mm); the slab print on the real P4 settles it before ordering. The camera block sits 9 mm left of A0.2's so CAM 4 clears the window.
- Only the nets the firmware uses: four UARTs, SYNC_OUT, CAM_PWR_EN, SHUTTER_N, the P4 I2C, the C6 service lines.
- Four TPS2553 camera switches with a shared enable (CAM_PWR_EN) and a shared fault line (the four FAULT_N open drains wired-OR); link headers for node USB service; 2.2k series resistors in place of the TXU0304 buffers.
- USB-C 5 V input with 5.1k CC pull-downs. No charger, battery, PD, haptic, IMU, RTC, temperature, current monitor, expander or power controller.
- Three board-status LEDs at the bottom edge, visible through the spacer gap: 5 V in (PWR), camera bank enabled (CAM, from GPIO31), any channel in fault (FLT). No per-node LEDs.
- Power module connector J1001, JST XH 6-way keyed, two 3 A contacts per rail (fused USB VBUS out to the SW6106 charger/boost input, 5 V rail back from its output) with JP1001 (USB > rail, closed as shipped): the battery charges from the carrier's USB-C and the stack runs from the rail. USBLC6-2SC6 on VBUS and CC. LM66100 ideal diode from the rail to the P4 5 V pins in place of the JP1000 bridge: the P4's own USB can never feed the rail. SMAJ5.0A rail clamp at J1001 (three extended lines). Power-net layer changes use paired vias; the bank and sync pull-downs are 4.7k against the P4's 45k internal pull-up.
- The SS34 per node is replaced by an LM66100 ideal diode (0.1 V instead of 0.4 V at the limit, reverse blocking built in); an LM74700-Q1 + IRLML0030 (20 V gate, after the second inspection found the AO3400A's 12 V gate under the controller's 13.9 V drive) ideal diode with 1 uF on anode and cathode in the VBUS path toward J1001 stops a charger on the module's own port from back-driving the carrier's USB-C while JP1001 is open; the P4 signals, the rail and FAULT are repeated as test pads on the top face.
- Independent inspection (2026-11-08) before the quote: no wiring, pinout or polarity error; its findings on power vias, rail clamp, LINK header position and pull-down values are in; J100 was then moved to the top face for a folded ribbon, and on 2026-11-16 replaced by the direct-mating socket on the P4 face, which removes the ribbon and the fold. The socket and the USB-C window are pixel-scaled from Guition's structure drawing (the only drawing that shows them): the vendor photo had put the header 2 mm off, and the drawing's back view turned out to be a see-through view, so the ports sit mirrored about the board's short-axis centre line; both found with prints on the real P4 (fit plate, then a 1:1 assembly print that mounts only one way). Which end of JP1 holds pin 1 the prints cannot tell; the meter check in the board README gates ordering. Corners rounded to 3 mm. Placement reworked on 2026-11-18: the four LINK headers in one row, each left of its module's USB plug; the P4-side parts (5 V ideal diode, 3V3 capacitor, pull-downs) out of the left margin, the diode and capacitors at the socket's top pins and the pull-downs at the end of CAM 1's resistor row; the top-face test pads as 3V3 and 5V beside the socket's top pins and one column of six under J1001; the six back-face copies of the P4 pads dropped (the socket's pin tails come through to the front).
- Bench additions at no BOM-line cost: a 0 ohm current-measure link per node with a test pad either side, a FAULT_N test pad, DNP Qwiic pull-up pads, three fiducials, three wire-loop scope grounds. A 1812 polyfuse footprint on the input, hand-fitted (JLC polyfuses are extended-library parts).
- Qwiic I2C port for breakouts while the feature firmware is written.
- 2 layers, SMT on the bottom face only, 14 BOM lines (11 JLC basic), 12 hand-fit through-hole parts.

## Evidence

- Generated from `design/circuit.py` and `design/placement.py`; routed with Freerouting 2.4.1 (0 unrouted); GND poured on both faces. The socket mates JP1 pin for pin, so its middle rows can only leave between neighbouring pads: J100 has 1.5 mm pads on the 1.0 mm drill (0.25 mm ring), the signal gap is JLC's 0.15 mm (power nets keep 0.2), the window is 0.3 mm from the plug overmold, and nothing else stands in the lanes beside the socket or the bands above and below the window. Each of those was found by a run that left socket nets unrouted.
- KiCad 10.0.6: DRC 0 violations, 0 unconnected; ERC 0. Reports in `outputs/`.
- LCSC numbers and library class checked against the JLC parts API on 2026-11-05 (`design/circuit.py`).
- Prints on the real P4 (PETG, drawn 0.5 % larger for shrink): the four inserts, the header and the USB-C window all land; the pin 1 end is unverified.

## Compatibility

Mounts on the P4 inserts and plugs straight onto JP1; A0.2's 26-pin ribbon is not used. Firmware runs unchanged: the pin map is `board_d4v1.h`. The enclosure is not considered; this is a bench board. A0.2's flash provision, remote jack chain, cover sensor and function button are absent.

## Safety and recovery

5 V only, no battery. Each node is current-limited at 1.0-1.2 A; a short on one node drops that node and lights the FLT LED; the TX/RX test pads say which node. The bank cannot power up before firmware drives GPIO31. An ideal diode (U1001) sits between the rail and the P4 5 V pins, so the carrier's rail and the P4's own USB never meet whichever is plugged. GPIO35 (JP1 pin 15) is left open and marked NC.

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
