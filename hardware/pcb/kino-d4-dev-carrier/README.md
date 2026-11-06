# KINO D4 dev carrier D1

A bench carrier for the four XIAO ESP32-S3 Sense camera nodes on the Guition P4. It carries exactly what the firmware drives today (`firmware/p4/main/board_d4v1.h`) and nothing from the A0.2 feature set: no charger, gauge, PD sink, haptics, IMU, RTC, current monitor or power controller. Those come back one at a time, as breakouts on the Qwiic port first, when their firmware exists.

Why it exists: the A0.2 quote was about 500 EUR for two assembled boards and 600 EUR for five. Roughly 430 EUR of that was fixed cost (double-sided assembly, 42 BOM lines without an LCSC number, extended-part fees). D1 is 2 layers, SMT on one face, 14 BOM lines of which 11 are JLC basic parts. Tracking: [issue #250](https://github.com/b5463/kino-d4/issues/250), [ECN-0008](../../changes/ECN-0008-dev-carrier-d1.md).

Status: design package 0.1.9, DRC 0, ERC 0, 0 unconnected, fab package in `outputs/fab-d1/`. Not yet ordered. Order after the [checks before ordering](#checks-before-ordering).

## What is on it

| Block | Parts | Notes |
|---|---|---|
| Outline and mounting | 117.01 x 69.41 mm, four 2.2 mm NPTH for M2 | A0.2's outline and the P4 inner-insert pattern (61.9 x 54.8 mm, offset -9.3 mm). Holes H1-H4 at the coordinates in `kino-d4-carrier-a0/MECHANICAL.md`. 7 mm fastener allowance kept clear. |
| P4 ribbon | J100, 2x13 keyed box header, bottom face | 1:1 to P4 JP1. Pin 15 (GPIO35, the boot strap) is open and marked NC. |
| Camera sockets | J200-J500, two 1x07 sockets each, 22 mm pitch | Same centres as A0.2. Only D1 (sync), D6 (TX), D7 (RX), 3V3, GND and 5V are wired. |
| Camera power | U200-U500 TPS2553, 24k ILIM | One switch per node, 1.0-1.2 A limit, all four enabled by CAM_PWR_EN (GPIO31, JP1 pin 10). R100 holds the bank off until firmware drives the pin. The four FAULT_N open drains share one net. SS34 blocks a node's own USB from feeding the bus. |
| Indicators | D1000 PWR (5 V in, green), D1001 CAM (bank enabled, green, from GPIO31 through 1k), D1002 FLT (any channel in fault, red; its 1k is the FAULT_N pull-up) | Board status only, no per-node LEDs. Bottom face, bottom edge left of the USB-C, so they show through the spacer gap with the carrier on the P4. Named on both faces. |
| Link headers | JP200-JP500, 1x02 + shunt, top face | Pull the shunt before plugging a node's USB; refit after. |
| Signals | 2.2k series on every P4-to-node and node-to-P4 line and on the four sync lines | Stops a powered P4 pin feeding an unpowered node through its protection diodes. No isolation buffers. |
| 5 V input | J1000 USB-C, 5.1k on CC1/CC2, 2 x 22 uF | 5 V at up to 3 A from a Type-C source. No PD, no battery. JP1000 (solder bridge, open) joins 5V_IN to the P4's 5 V pins; close it only when one cable is meant to power the whole stack. |
| Controls | SW100 6 mm tactile shutter, J103 remote dry contact | Both pull SHUTTER_N (GPIO28, JP1 pin 21) to GND. |
| Service | J101 1x06: GND, C6 3V3 (sense only), RX, TX, IO9, EN | The C6 lines from JP1 pins 18-26. |
| Expansion | J102 JST SH 1x04, Qwiic/STEMMA QT pinout | P4 I2C (JP1 pins 23/25) at 3.3 V. The bus already carries the touch controller at 0x5D. |
| Test pads | TP100-TP106, TP200-TP504, 1.5 mm, bottom | P4 3V3, 5V, SYNC, CAM_PWR_EN, SHUTTER, GND; per camera TX, RX, SYNC, 3V3, 5V. Named on the silk. |

Current budget: the 1.0 mm 5 V bus on 1 oz copper carries about 3 A for a 10 degC rise. Four XIAO S3 Sense modules with cameras draw about 2 A together; flash is not on this board.

## Legend

Drawn by `design/silk.py`. Arial Bold throughout (an outline face every KiCad install resolves; the file is patched after save because the Python API has no font setter), nothing under 1.0 mm, every legend piece a separate silk item so DRC checks the gaps. Every item is a designator, a pin, a limit, a procedure or an identity field.

Type scale, three sizes only: 2.4 mm for the board name and the side marker, 1.4 mm for section names (`REV D1`, `CAM n`, `5V IN`, the column headers), 1.0 mm for every label, designator, pin and note. Layout: one left margin (x 3.6) and one right margin (x 114) for the top band, the identity line and the power block; the identity line on one baseline with a rule under it, part number and date right-aligned; text is left-aligned on its block's margin or centred on the part it names, never mixed in one block; every bottom-row label on one baseline (y 64.6).

Front ("SIDE A"), the face the XIAOs stand on: the ODD JOBS mark top left; the subtitle `4x XIAO ESP32-S3 SENSE ON ESP32-P4 JP1` between the inserts; `SIDE A`; the identity line `KINO D4 / REV D1 / DEV CARRIER ... KINO-D4-DC-D1 / 2026-11`; per node `CAM n`, `Jn00`, `LINK JPn00`, `XIAO ESP32-S3`, pin 1 and the six wired socket pins named inside the rows (visible when the module is out); the column right of CAM 4, left-aligned on x 102.5: `NODE USB / PULL LINK / SHUNT FIRST` and `CAM 5V / 1.2A LIMIT / SHARED EN`; `J100 P4 JP1` with pin 1 and `NC` on pin 15; the GPIO map in two columns (`CAM EN GPIO31`, `SYNC GPIO32`, `SHUTTER GPIO28`); `SW100 SHUTTER`, `J103 REMOTE` and `J101 C6 SERVICE` with their pins named; `5V IN` over `J1000 USB-C 3A MAX` against the right margin; `PWR CAM FLT` over the edge LEDs.

Back ("SIDE B"), the assembled face: `SIDE B` and the identity line in the same reading order, S/N box, the `JLCJLCJLCJLC` anchor for the order number, the licence line, `JP1000 5V LINK` at the solder bridge, `CAM 1-4`, every test pad named, `J102 QWIIC`, the LED names.

## Files

| File | Content |
|---|---|
| `design/circuit.py` | Every part, net and pin, with the LCSC number and JLC library class checked on 2026-11-05 |
| `design/placement.py` | Outline, holes, camera centres, every part position and face |
| `design/build.py` | Writes the schematic (`*.kicad_sch`, `KINO_DEV.kicad_sym`), footprint library, project file and placed board |
| `design/route.py` | `export` writes the DSN with the power classes; `import` reads the Freerouting session, fixes the USB-C stubs, pours GND on both faces |
| `design/silk.py` | The legend on both faces |
| `design/release.py` | Gerbers, drill, BOM, CPL, hand-fit list, DRC/ERC reports, `outputs/BUILD_STATUS.json` |
| `KINO_D4_Dev_Carrier_D1.kicad_pcb` | The routed board |
| `outputs/fab-d1/` | The order package |
| `KINO_DEV.pretty/` | The XIAO socket and USB-C lands, copied from `kino-d4-carrier-a0/KINO_A0.pretty/` |

Rebuild from scratch, with KiCad 10's bundled `python.exe` and the Freerouting jar:

```
python design/build.py
python design/route.py export WORK
java -jar freerouting.jar -de WORK/d1.dsn -do WORK/d1.ses -mp 80 -mt 4 -l en
python design/route.py import WORK
python design/silk.py
python design/release.py
```

The ODD JOBS symbol is read from `kino-d4-carrier-a0/brand/odd-jobs-symbol.json` at build time; it is not copied into this directory.

## Ordering

JLCPCB, 2 layers, 1.6 mm, 1 oz, any finish. Economic assembly, bottom side only, 52 placements. Upload `outputs/fab-d1/` as the Gerber zip, `BOM-D1-JLC.csv` and `CPL-D1-JLC.csv`. Check the rotations of U200-U500, the four SS34 and the three LEDs in the assembler's preview before confirming: the CPL carries KiCad's angles. Hand-fit the parts in `BOM-D1-HANDFIT.csv` after delivery: eight 1x07 sockets, the box header, the C6 and remote headers, four 1x02 link headers with shunts, one 6 mm switch.

## Checks before ordering

- [ ] Print the 1:1 mounting template from `kino-d4-carrier-a0/outputs/` and lay it on the P4: the inner-insert offset is drawing-derived (MECHANICAL.md).
- [ ] Confirm the P4 JP1 pin 1 position against the ribbon key on J100 with the carrier flipped under the P4.
- [ ] Spacer height: the box header and the 22 uF capacitors on the bottom face must clear the P4.

## Bring-up

1. No XIAOs, no P4: 5 V in on J1000. PWR on, CAM and FLT off. CAM_PWR_EN low: all camera 5 V pads 0 V.
2. P4 on the ribbon, firmware up: `CAM_PWR_EN` high, CAM on, each CAMn_5V pad at 5 V.
3. One XIAO at a time in each socket: the node answers on its UART (issue #148's single-node proof).
4. Four nodes: all visible at once; SYNC on every TP*02 pad.
5. Short a camera 5 V pad to GND through 1 ohm: FLT on, that channel's 5 V pad at 0 V, the other three nodes still answering.
