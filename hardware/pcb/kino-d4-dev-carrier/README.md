# KINO D4 dev carrier D1

A bench carrier for the four XIAO ESP32-S3 Sense camera nodes on the Guition P4. It carries exactly what the firmware drives today (`firmware/p4/main/board_d4v1.h`) and nothing from the A0.2 feature set: no charger, gauge, PD sink, haptics, IMU, RTC, current monitor or power controller. Those come back one at a time, as breakouts on the Qwiic port first, when their firmware exists.

Why it exists: the A0.2 quote was about 500 EUR for two assembled boards and 600 EUR for five. Roughly 430 EUR of that was fixed cost (double-sided assembly, 42 BOM lines without an LCSC number, extended-part fees). D1 is 2 layers, SMT on one face, 17 BOM lines of which 12 are JLC basic parts. Tracking: [issue #250](https://github.com/b5463/kino-d4/issues/250), [ECN-0008](../../changes/ECN-0008-dev-carrier-d1.md).

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
| 5 V input | J1000 USB-C, U1000 USBLC6-2SC6, F1000 3 A PPTC, 5.1k on CC1/CC2, 2 x 22 uF | 5 V at up to 3 A from a Type-C source. No PD. U1000 clamps VBUS and both CC pins. F1000 (1812 polyfuse, hand-fit: the JLC polyfuses are extended-library parts) protects the board and the source if the rail shorts. |
| Power module | J1001 JST XH 2.5 mm 6-way, keyed: `VBUS VBUS GND GND RAIL RAIL`; JP1001 solder bridge, closed as shipped | Two 3 A contacts per rail, 20 AWG to the module. The fused USB VBUS leaves on 1-2 to the SW6106 charger/boost input, so the battery charges from the carrier's USB-C; the 5 V rail comes back on 5-6 from the SW6106 output and feeds the cameras and, through U1001, the P4. JP1001 closed: no module, USB is the rail (bench). Open JP1001 when the module is wired, or USB back-feeds the boost output. |
| P4 supply | U1001 LM66100 ideal diode, 1 uF either side | Rail to the P4's 5 V pins (JP1 2/4, two ribbon conductors, about 1 A each). CE tied to VOUT: the rail feeds the P4; the moment the P4's own USB lifts its side 35 mV above the rail the switch opens, so the P4 USB can never feed the rail or the cameras, and with both present the higher source carries the P4 with no current between them. 79 mOhm, about 0.1 V drop at 1 A; 1.5 A continuous, enough for the module alone. |
| Current-measure links | R206/R306/R406/R506, 0 ohm 0603 | In each node's 5 V between the link header and the socket. Lift one, meter between TPn05 (5VJ) and TPn04 (5V): that node's current. |
| Qwiic pull-ups | R102/R103, 4.7k 0603, DNP | Pads only. The P4 bus has the touch controller's pull-ups; fit these for a breakout that brings none. |
| Fiducials | FID1-FID3, 1 mm copper, 2 mm mask, bottom face | For the assembler's placement. |
| Scope grounds | GL1-GL3, wire loops, hand-fit | GND at the controls, at the power block and right of CAM 4. |
| Controls | SW100 6 mm tactile shutter, J103 remote dry contact | Both pull SHUTTER_N (GPIO28, JP1 pin 21) to GND. |
| Service | J101 1x06: GND, C6 3V3 (sense only), RX, TX, IO9, EN | The C6 lines from JP1 pins 18-26. |
| Expansion | J102 JST SH 1x04, Qwiic/STEMMA QT pinout | P4 I2C (JP1 pins 23/25) at 3.3 V. The bus already carries the touch controller at 0x5D. |
| Test pads | TP100-TP107, TP200-TP505, 1.5 mm, bottom | P4 3V3, 5V, SYNC, CAM_PWR_EN, SHUTTER, GND, FAULT_N; per camera TX, RX, SYNC, 3V3, 5V, 5VJ. Named on the silk. |

Battery operation: LiPo -> F3A -> 1S protection -> SW6106 -> J1001 RAIL -> 5 V bus -> four TPS2553 (1.2 A each) and the P4 over U1001. What protects what: the pouch fuse and the BMS cover the pack; the SW6106 limits its output (18 W class, about 3 A) and is the only charger; F1000 covers the USB input; each node has its own current limit and fault flag, so one shorted camera drops that channel, not the rail; the SS34s keep a node's USB off the bank. The rail itself has no fuse of its own on the carrier: the SW6106 limit is it. Current budget: the 1.0 mm 5 V bus on 1 oz copper carries about 3 A for a 10 degC rise. Four XIAO S3 Sense modules with cameras draw about 2 A together; flash is not on this board. Bulk capacitance is 2 x 22 uF at the input and 22 uF per node; if PWR flickers or a node resets under a camera-plus-WiFi burst, add 100 uF or more across TP101 (5V) and TP105 (GND) before changing anything else.

## Flashing and test

- Nodes: pull that channel's LINK shunt, plug the XIAO's own USB-C, flash, unplug, refit the shunt. The SS34 keeps the node's USB off the bank either way; the shunt keeps the bank off the node's USB.
- P4: its own USB-C, as without the carrier, at any time: U1001 keeps the two 5 V sources apart.
- C6: J101 (GND, 3V3 sense, RX, TX, IO9, EN) carries the C6 lines from JP1 pins 18-26.
- Test: every firmware GPIO has a pad (TP100-TP107), every node has TX/RX/SYNC/3V3/5V/5VJ pads and a 0 ohm current link, GL1-GL3 are scope grounds, FAULT_N is on TP107.

## Legend

Drawn by `design/silk.py`. Arial Bold throughout (an outline face every KiCad install resolves; the file is patched after save because the Python API has no font setter), nothing under 1.0 mm, every legend piece a separate silk item so DRC checks the gaps. Every item is a designator, a pin, a limit, a procedure or an identity field.

The top of the hierarchy (`KINO D4`, `SIDE A/B`, `CAM 1-4`, `PROTOTYPE`, `5V IN`) is reversed out of solid silk blocks (KiCad knockout text); nothing else is boxed. Type scale, three sizes only: 3.2 mm for the board name and the side marker, 1.8 mm for section names (`DEV CARRIER`, `REV D1`, `PROTOTYPE`, `CAM n`, `5V IN`, the column headers), 1.0 mm for every label, designator, pin and note. Layout: one left margin (x 3.6) and one right margin (x 114) for the top band, the identity line and the power block; the identity line on one baseline, two sizes (name 2.4, the rest of the group 1.4), part number and date 1.0 right-aligned; text is left-aligned on its block's margin or centred on the part it names, never mixed in one block; every bottom-row label on one baseline (y 64.6).

Front ("SIDE A"), the face the XIAOs stand on: the ODD JOBS mark top left; between the inserts the subtitle `4x XIAO ESP32-S3 SENSE ON ESP32-P4 JP1` with the two bench facts under it (`LINK: PULL THE SHUNT BEFORE NODE USB`, `CAM 5V: 1.2A LIMIT PER NODE, SHARED ENABLE`); `SIDE A`; the identity line `KINO D4 / DEV CARRIER / REV D1 / PROTOTYPE ... KINO-D4-DC-D1 / 2026-11` (the prototype marking is on both faces); per node `CAM n`, `Jn00`, `LINK JPn00`, `XIAO ESP32-S3`, pin 1 and the six wired socket pins named inside the rows (visible when the module is out); `J1001 POWER` with `VBUS GND RAIL` beside the connector in the column right of CAM 4; `J100 P4 JP1` with pin 1 and `NC` on pin 15; the GPIO map in two columns (`CAM EN GPIO31`, `SYNC GPIO32`, `SHUTTER GPIO28`); `SW100 SHUTTER`, `J103 REMOTE` and `J101 C6 SERVICE` with their pins named; `5V IN` over `J1000 USB-C 3A MAX` against the right margin; `PWR CAM FLT` over the edge LEDs.

Back ("SIDE B"), the assembled face: `SIDE B` and the identity line in the same reading order, S/N box, the `JLCJLCJLCJLC` anchor for the order number, the licence line, `JP1000 5V LINK` at the solder bridge, `CAM 1-4`, every test pad named, `J102 QWIIC`, `I2C PU DNP` at the pull-up pads, `F1000`, `JP1001`, `U1001 RAIL > P4 5V` at the ideal diode, `FAULT` at the FAULT_N pad, the LED names, the repository URL under the licence line; on the front `GND` at the three wire loops and `J1001 POWER MODULE` with `VBUS GND RAIL`.

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

JLCPCB, 2 layers, 1.6 mm, 1 oz, any finish. Economic assembly, bottom side only, 52 placements. Upload `outputs/fab-d1/` as the Gerber zip, `BOM-D1-JLC.csv` and `CPL-D1-JLC.csv`. Check the rotations of U200-U500, the four SS34 and the three LEDs in the assembler's preview before confirming: the CPL carries KiCad's angles. Hand-fit the parts in `BOM-D1-HANDFIT.csv` after delivery: eight 1x07 sockets, the box header, the C6 and remote headers, four 1x02 link headers with shunts, one 6 mm switch, the 1812 polyfuse, the JST XH power connector, three wire loops.

## Checks before ordering

- [ ] Print the 1:1 mounting template from `kino-d4-carrier-a0/outputs/` and lay it on the P4: the inner-insert offset is drawing-derived (MECHANICAL.md).
- [ ] Confirm the P4 JP1 pin 1 position against the ribbon key on J100 with the carrier flipped under the P4.
- [ ] Spacer height: the box header and the 22 uF capacitors on the bottom face must clear the P4.

## Bring-up

1. No XIAOs, no P4: 5 V in on J1000. PWR on, CAM and FLT off. CAM_PWR_EN low: all camera 5 V pads 0 V.
2. P4 on the ribbon, firmware up: `CAM_PWR_EN` high, CAM on, each CAMn_5V pad at 5 V.
3. One XIAO at a time in each socket: the node answers on its UART (issue #148's single-node proof).
4. Four nodes: all visible at once; SYNC on every TP*02 pad.
5. Short a camera 5 V pad to GND through 1 ohm: FLT on, TP107 (FAULT_N) low, that channel's 5 V pad at 0 V, the other three nodes still answering.
6. Lift R206, meter between TP205 and TP204: node 1's current while idle, streaming and with the flash command. Refit.
7. Charging path: open JP1001, wire J1001 1-2/3-4 to the SW6106 input and 5-6/3-4 from its output. USB-C on the carrier: the SW6106 charge LED on, the rail at 5 V, the P4 up. Pull the USB: the stack keeps running from the battery. Plug the P4's own USB with the rail live: TP101 (P4 5V) rises to the USB level, the rail does not move, no current on the RAIL pair.
8. Measure whether JP1 pin 2 is tied to the Guition module's own USB VBUS (meter, module USB unplugged, carrier powered). If it is, the module's onboard battery connector also charges from the carrier; if there is a diode drop, it does not, and the SW6106 path is the only charger. Record the result in `docs/HARDWARE.md`.
