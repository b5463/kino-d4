# KINO D4 carrier A0.2 — release review, 3 October 2026

**Final status: READY FOR FABRICATION WITH SPECIFIC MANUAL CHECKS**

The board files are complete and checked: every connection routed, DRC, ERC and the board-to-netlist comparison clean, Gerbers regenerated from the board byte-identical. Order only after the [manual checks before ordering](#11-release-matrix-and-manual-checks). The bench tests in the same section come after the first boards arrive. Board revision CARRIER A0.2, date code 2026-10, design package 0.1.8. The [30 September review](A02-REVIEW.md) is superseded.

## 1. Scope and evidence

The release pass followed a read-only audit of the routed board (problem list C-1, H-1 to H-7, M-1 to M-12, L-1 to L-10, U-1 to U-7). It changed the board where an audit finding or a datasheet check required it, and kept the listed architecture: J100 to P4 JP1 map, GPIO35 open, C6 passthrough, TXU0304 isolation with 33 Ω, TCA9517 I2C buffer, I2C map, AND-gated camera enables, TPS2553 with FAULT, diode directions, Kelvin routing, F1100 → RS700, charger PROG/NTC/ILIM with R1110 DNP, back-to-back P-FETs, CC protection, power-only USB, TPS61288 + XAL7070 + compensation, LTC2955 load disconnect, In1 plane, stitched GND, face assignment, 22 mm pitch, mounting keep-outs, remote chain, ESD at J901-J903, ODD JOBS mark.

Independent reviews ran in parallel on manufacturer data and on frozen copies of the board: power datasheets, logic and module datasheets, schematic redundancy, four-camera consistency, BOM / footprint / placement, mechanics and DFM, then, on the final board, an electrical walk with short test and power-up scenarios, a Gerber and manufacturing pass, a silkscreen review and an adversarial review. Their findings and the fixes are below; every board edit is a script in `design/` with a docstring that gives the reason.

| Evidence | Result |
|---|---|
| DRC (KiCad 10.0.6, zones refilled, all severities) | 0 violations, 0 unconnected items |
| ERC | 0 violations |
| Board vs netlist (`verify.py --a02`, pad by pad) | match; KiCad's own parity on a copy named after the project: only benign items (NC-pin naming, BOM-exclude flags on test lands, H1-H4 board-only) |
| Gerbers, drill, placement | regenerated from the board by `fab_a02.py`; independent re-export byte-identical |
| Board | 117.01 × 69.41 mm, 4 layers, 256 footprints (80 front, 176 back, 6 fiducials), 573 vias, 2385 track segments |

## 2. Changes in the release pass

| Area | Change | Why |
|---|---|---|
| USB-C input (C-1) | D1001 SMF12A → **SMF22A**; R1004 1k → **10k** | An unprogrammed STUSB4500 asks for 20 V (factory PDOs 5/15/20 V, highest first); the SMF12A breaks down at 13.3 V. 22 V standoff, 24.4-27 V breakdown; 10k keeps the VBUS_EN_SNK current (1.2 mA at 22 V) inside its 3 mA characterisation. |
| Boost enable (U-1) | **R1204** 100k BOOST_ENABLE → SYS_RAW; Q1202 2N7002 → **PMV16UN** | LTC2955-1 EN is a 1.2-2.8 µA current source; the TPS61288 EN pull-down (850 k-1.1 MΩ) held it at 1.02 V worst case, under the 1.2 V threshold: the system might never turn on. A 2N7002 threshold reaches 2.5 V; PMV16UN ≤ 1.0 V. |
| I2C buffer | **U100 sides swapped**: local bus on the TCA9517 A side, P4 bus on B; R100/R101 10k/1M → **2.2k/22k** | The B side's 0.45-0.6 V buffered low was above the guaranteed VIL of the STUSB4500 (0.35 V), BQ25798 (0.4 V) and DRV2605L (0.5 V). The P4 reads it (VIL 0.825 V). The new divider keeps EN low with JP1 pin 1 open despite the TCA9517 EN pull-up. |
| Reset states (M-4) | **R105** 100k SYNC_MASTER → GND | P4 GPIO32 is Hi-Z from reset until firmware drives it; spurious sync edges, and the J601 flash option would fire. |
| ESD (M-5) | **D903** PESD5V0S1BA on FN_N beside J904 | Cased button, same class as the shutter input. J1300 (LTC2955 PB rated ±25 kV HBM), J900 (internal motor) and J102 (internal) need none. |
| Battery path (H-2) | SYS_RAW **pours**: 3.4-3.9 mm on B along the charger capacitor row, 4.6-5.2 mm on In2 to L1200; **19 vias** between them, **6** into L1200; **1 oz inner copper** in the stackup | The 1.2 mm back track rose about 55 °C at 5 A (IPC-2152 chart); three vias per layer change carried up to 2.8 A each; the board declared 0.5 oz inner copper. |
| Fiducials (H-6) | **FID1-FID6**, three per face, asymmetric, ≥ 4 mm from the edge, 1.5 mm clear of copper, silk and courtyards | Double-sided assembly with 0.4 mm-pitch parts. |
| XIAO sockets | **Mask openings** on the 56 socket pads (board, library, generator) | The footprint generator had dropped the mask layers: the sockets could not be soldered. |
| Via in pad (M-2) | CAM1_EN via out of U201 pin 3 (with a 1.8 mm In2 jog of CAM1_D2_STRAP); C901 GND via dogboned; CHG_PMID via removed; CHG_BTST1 via moved; U701 extra via removed; dead CAM3_5V_ISO via and stub removed; GAUGE_1V8 via moved 0.52 mm from the J1000 peg | ODD JOBS 82; vias are tented with no mask expansion; fab hole-to-hole minimum. |
| CAM2_FAULT_N (M-8) | R603 to U601 pin 10, C701 under U700 | The line no longer passes between passive pads. |
| Switch node | I2C_SCL out from under the L1200 corner on In2 | In2 is the layer under the back-side inductors; only the boost's own power feed stays there. |
| U1200 footprint | Body outline 3.0 × 2.5 mm with pin-1 chamfer; silk pin-1 dot | The outline was turned 90°; there was no pin-1 mark. |
| Leftovers | TP1001 removed (open-drain PD_9V_OK_N without pull-up); stale Fab outlines of removed test lands; stale part-selection entries; net-class pattern PACK_MINUS → PACK_FUSED; `missing_courtyard` → error; stale notes in the capture | Redundancy review. |
| BOM | Q1000/Q1001/Q1200/Q1201 AO4407A → **AO4409** (R<sub>DS(on)</sub> specified at -4.5 V); RS700 MPN WSLP12065L000FEA (5 mΩ); RS200-RS500 rated 1 W; capacitor voltage texts match their parts; XIAO sockets 2 × 61300711821 each, hand-fit; test lands and holes marked as PCB features | BOM review. |
| Silkscreen | One reference beside each part (202 on silk, 48 on Fab), camera groups by role, ambiguous groups to Fab; legend lines and strokes ≥ 0.15 mm; CARRIER A0.2 / 2026-10, S/N box; P4 JP1 label | Silk review; fab legend minimum; ODD JOBS 97-101. |
| Firmware | [`firmware/p4/main/kino_carrier_a02.h`](../../../firmware/p4/main/kino_carrier_a02.h): I2C addresses, TCA9539 map, PAC1954 channel map, BQ25798 CHG_STAT field, 100 kHz bus limit | Firmware follows the U600 port-1 map and reads the charge state over I2C. |

## 3. Audit findings

| ID | Finding | Resolution |
|---|---|---|
| C-1 | 20 V from an unprogrammed STUSB4500 against a 12 V TVS | **Fixed in hardware** (section 2). Every part on USB_VBUS / CHG_VBUS is rated for a 20 V contract: STUSB4500 28 V, BQ25798 30 V, AO4409 -30 V, C1000 50 V. NVM programming to 9 V stays as policy. |
| H-1 | Battery current about 4.8 A at 3.0 V | MANUAL: pack and harness spec (section 11). BQ25798 discharge 6 A continuous, 10 A ≤ 1 s; F1100 7 A; IBAT_OCP inactive without a ship FET, so the pack PCM is the over-current protection. Firmware sheds load near 3.3 V open-circuit. |
| H-2 | Boost input copper | **Fixed** (pours, vias, 1 oz inner). The charger's own SYS-pin escape (0.2 then 0.4 mm, 2.6 mm long, between QFN pins) is unchanged: thermal check at full load. |
| H-3 | Supply margin to modules | Adequate at ≤ 0.5 A per XIAO (worst 4.15 V vs about 3.98 V needed) and for the P4 (≥ 4.16 V). Marginal only at the 1 A current limit. Measure. |
| H-4 | USB backfeed relies on removing the JP links | MANUAL: service procedure (README). |
| H-5 | No pack reverse-polarity protection | MANUAL: keyed JST VH and a checked harness; polarity printed `- NTC +`. |
| H-6 | No fiducials | **Fixed.** |
| H-7 | Physical stack unverified | MANUAL: spacer ≥ 10.7 mm (J100 + IDC socket); **check that the P4's JP1 is not under J100** (two IDC sockets would stack to about 26 mm). |
| M-1 | Test access | Front: TP100, TP600-TP602, J600 pogo field, JP link and THT joints. Back test lands are for bring-up before mounting on the P4. |
| M-2 | Via in pad | **Fixed** except by design: U700 exposed-pad via and the U701/U1201 footprint thermal vias (fab note), and five same-net vias 0.09-0.10 mm from pad openings (R203/R303/R403 pad 2, U300.1, U1300.5). |
| M-3 | Silkscreen | **Fixed** (section 7). |
| M-4 | Undefined states at P4 boot | **Fixed** (R105). CAM_GLOBAL_EN has R104, REQ lines R601-R604, TPS2553 EN R205-R505; the TXU outputs are Hi-Z unpowered. |
| M-5 | ESD on user connectors | **Fixed** for J904; not needed for J1300, J900, J102 (section 2). |
| M-6 | I2C loading | 95-150 pF with 4.7k: standard mode only. Firmware constant `CARRIER_I2C_MAX_HZ` 100 kHz for the whole P4 bus (U100 forwards it). |
| M-7 | Long enable routes | BOOST_ENABLE now held by R1204 (100k) at the boost end; CAM_GLOBAL_EN is a static enable with R104. Accepted. |
| M-8 | CAM2_FAULT_N under passives | **Fixed.** |
| M-9 | 3D models missing | Open (XIAO sockets/modules, J600, L1100, U1200); does not affect fabrication. |
| M-10 | BOM open items | Closed: RS200-RS500, F100, AO4409, RS700. Off-board parts specified in section 11. 41 BOM lines have no LCSC number (order by MPN). |
| M-11 | Charge on plug | Safe with a 4.2 V Li-ion / LiPo pack ≥ 2 Ah with PCM and a 103AT-2 NTC on P-: 1 A at 4.2 V, JEITA 0/10/45/60 °C, 12 h timer. R1110 inhibits charging when fitted. |
| M-12 | Switchers beside the camera row | MANUAL: image noise and RF with the cameras running. |
| L-1 | Five 0.1 mm wobbles | Accepted (inside 0.5-0.8 mm copper). |
| L-2 | CAM2_3V3 detour | Accepted (light load). |
| L-3 | Status by I2C polling | By design (no spare P4 pin). |
| L-4 | PD_9V_OK_N floating | **Fixed** (TP1001 removed). |
| L-5 | MECHANICAL.md socket centres | **Fixed.** |
| L-6 | Revision naming | **Fixed**: CARRIER A0.2 / 2026-10 / S/N box. |
| L-7 | Solid SMD GND connections | Accepted; four THT pins solid by design are in the fab notes. |
| L-8 / L-9 | Unprotected GPIO and C6 breakouts | Accepted: bring-up headers. |
| L-10 | Sharp outline corners | MANUAL: enclosure check. |
| U-1 | LTC2955 EN drive | **Resolved** (R1204, PMV16UN). |
| U-2 | P4 input | JP1 5V feeds the Guition VCC5V (TLV62569 buck, MP3202 backlight, audio through R22 "1A"); no switch between USB VBUS and JP1 (IP5306 output). MANUAL: check the P4's USB VBUS with only JP1 feeding; keep CN4 (P4 battery) empty. |
| U-3 | XIAO details | 5V pin is VBUS, then a Schottky into an SGM6029 buck; U.FL at the end opposite USB-C; camera faces away from the carrier. MANUAL: U.FL cable clearance under the Sense board. |
| U-4 | Battery on carrier vs P4 | Carrier owns battery and charging; P4 battery connector unused. |
| U-5 | BQ25798 D+/D- | Left open (OK; detection ends as SDP or unknown, ILIM_HIZ clamps until firmware). |
| U-6 | Loads | MANUAL: measure P4 and XIAO currents; 2.6 A boost design point is an estimate. |
| U-7 | Ioff on EN/OE | TCA9517 I/O and EN are over-voltage tolerant unpowered; TXU0304 OE has no positive clamp; R100 limits the current. |

## 4. Datasheet and pinout verification

Pin maps checked against manufacturer tables: BQ25798, TPS61288 (custom land matches TI RQQ0011A within 0.025 mm), PAC1954 (ADDRSEL to GND = 0x10; channel n = camera n), BQ27441-G1 (high-side shunt: SRP pin 8 pack side, SRN pin 7 system side), LSM6DSOX, RV-3028-C7, TMP117, STUSB4500 (dead-battery CCxDB ties, ADDR = 0x28), LTC2955-1 (TSOT-23-8; 1.5 µF timer ≈ 7.9 s), TCA9517A (after the swap: 2 SCLA, 3 SDAA local; 7 SCLB, 6 SDAB P4), TXU0304, TPS2553 (25.5k: 0.94-1.09 A), TCA9539 (0x74), 74LVC08, DRV2605L, 74LVC1G14, TPS62162, AO4409 (S 1-3, G 4, D 5-8), PMV16UN and 2N7002 (G 1, S 2, D 3), SMF22A (cathode = USB_VBUS). All diode polarities are correct. The BQ25798 CHG_STAT field is REG0x1C bits 7:5 (SLUSDV2C 7.5.1.24).

## 5. Four-camera comparison

No copy-and-paste error. All 26 parts per camera have the same side, rotation and offset from the socket centre (to 0.001 mm), the same values, footprints and part numbers; every per-camera net connects the same pads; UART and sync directions are correct in all four; each Kelvin pair ends only on its own shunt's inner pad corners. Intentional differences: P4 UART lengths grow from CAM1 to CAM4 (J100 at the left edge); EN, FAULT_N and REQ lengths follow the shared U600/U601; CAM1 and CAM4 Kelvin pairs are long (U700 sits between cameras 2 and 3); CAM1_EN has its J600 leg (CAM2-4 use TP600-TP602); CAM3_3V3 and CAM3_FAULT_N share the J401 row gap at 0.15 mm; CAM1_D2_STRAP jogs 0.26 mm for 1.8 mm around the CAM1_EN via.

## 6. BOM, footprints and placement

The board footprints have exactly their library pads (checked on the 248 parts before the release-pass additions; R105, R1204, D903 and the fiducials are stock footprints); values, footprints, part numbers and DNP flags agree across board, schematic, netlist and BOM. The fab BOM (`BOM-A02-FAB.csv`) groups by part number and gives an LCSC number only where the selection is that same part number; the XIAO sockets are a separate hand-fit list. The placement file has one row per placed part, positions and sides equal to the board; fiducials, test lands, holes, the pogo field and DNP parts are excluded. Rotations are KiCad's and must be checked in the assembler's preview.

## 7. Silkscreen and fiducials

No silk on pads, mask openings or fiducial openings; every text ≥ 0.8 mm with a 0.15 mm stroke, legend lines ≥ 0.15 mm, back text mirrored. 202 references on silk beside their own parts; each camera role uses one offset in all four cameras, and roles that fit only ambiguously go to Fab as a group of four (U201-U501 among them). 48 references stay on Fab in the camera, charger and boost clusters (listed in `outputs/A02-ASSEMBLY-LABELS-UNFINISHED.json`). XIAO socket references sit outside the module bodies; no silk text lies under a fitted XIAO. Polarity and pin-1 marks are present on every diode, IC and connector. Identity: ODD JOBS mark, KINO D4 / CARRIER A0.2 / 2026-10, S/N box, connector function labels. Fiducials have no silk within 1 mm of their 2 mm openings.

## 8. Virtual electrical test, short test and power-up

**Connectivity.** All 185 named nets form one copper body each, checked by pcbnew connectivity and by an independent geometric union of every track, via, pad, plated barrel and zone-fill island on the four layers (the checker was validated on a deliberately broken copy). No dangling copper, no isolated zone islands, no single-pad nets, no copper on any of the 47 no-connect pins. Board pads, `circuit.py`, the schematic and a freshly exported netlist agree pin for pin.

**Shorts.** No copper of two different nets touches on any layer, including vias against inner zones and pads against zones; KiCad DRC agrees with stored and refilled zones. Minimum clearances in the dense areas: U100 0.151 mm, U1100 0.151 mm, U700 0.151 mm (In2), U1000 0.173 mm, Q1000/Q1001 0.163-0.178 mm, U1200 0.178 mm (In2), the new parts ≥ 0.199 mm, SYS_RAW pours 0.175 mm (B) and 0.200 mm (In2); the rule is 0.15 mm.

**Power-up scenarios.**

| # | Scenario | Result |
|---|---|---|
| 1 | Battery only, button press | PASS: EN at SYS_RAW, BOOST_5V 4.90-5.10 V, load switch on (VGS -5 V), MB_3V3 3.3 V, P4_5V about 4.5 V, cameras off |
| 2 | Soft-kill through U600 P1.2 | PASS: Q1300 pulls KILL below 0.8 V, rails collapse, lockout, stays off until the next press |
| 3 | USB 5 V, no battery | RISK: dead-battery attach works, but ILIM_HIZ caps the input at 184-371 mA until firmware clears EN_EXTILIM: a battery is needed to run the P4 |
| 4 | PD 9 V (programmed NVM) | PASS: VGS -8.2 V, zener off, all parts in range |
| 5 | PD 20 V (factory NVM) | PASS: zener holds VGS at -9.4 to -10.6 V (AO4409 ±20 V), 1.2 mA into VBUS_EN_SNK, SMF22A off, BQ25798 below its 26 V OVP |
| 6 | Low battery, 3.0 V and 2.8 V | PASS: BOOST_ENABLE 2.61-2.93 V (TPS61288 VIH 1.2 V), PMV16UN fully on; off-state EN low 0.175 V |
| 7 | Ribbon unplugged, carrier on | PASS: P4_BUS_EN ≤ 0.66 V, buffers disabled, TXU lines pulled low, cameras off |
| 8 | P4 on, carrier off | PASS: TCA9517 inputs tolerant unpowered, TXU0304 Ioff ±2 µA, D1200 blocks backfeed (remove JP1200 for P4 USB service) |
| 9 | XIAO on USB service | PASS with its JP link removed; with the link fitted the XIAO VBUS can feed the carrier rail (silk: remove for node USB) |
| 10 | Camera over-current | PASS: 0.94-1.09 A limit, FAULT_N on its own U600 line, firmware polls |
| 11 | P4 reset period | PASS: R105, R104 and the TXU pull-downs hold SYNC, CAM_GLOBAL_EN and the TX lines low; U601 outputs low |
| 12 | Charger without pack / NTC open | PASS: TS at 85 % of REGN (cold), charging suspended, SYS regulated |
| 13 | Hard plug into a source already at 20 V | RISK: a compliant source starts at 5 V; a hard 20 V step relies on the SMF22A (35.5 V at 5.6 A, above the STUSB4500 28 V limit at full surge): bench check |
| 14 | I2C levels after the U100 swap | PASS: A side hard low ≤ 0.2 V to the local devices; B side ≤ 0.6 V to the P4 (VIL 0.825 V); the P4-side pull-ups are on the Guition board |
| 15 | Cold start, expander in reset | PASS: TCA9539 pins inputs, R601-R604, R900, R1301, R104 hold REQ, haptic, SOFT_KILL and global enable low |

**Firmware constants.** I2C addresses match their address straps; the TCA9539 port map, the PAC1954 channel map (CHn = CAMn, 20 mΩ) and the BQ25798 CHG_STAT field match the board and datasheets. U600 P1.3 (no copper) is now configured as a low output (CONFIG1 0xB3); U600 keeps its state across a P4-only reset, so firmware writes it on every P4 boot. R1204 costs 28-46 µA of off-state battery drain (about 1 mAh per day).

## 9. Manufacturing pass

The Gerber set has every layer with X2 attributes; the job file gives 4 layers, 1.6 mm, 35 µm on every copper layer. Outline closed, no copper outside it, In1 one solid GND polygon. Drill: 573 vias 0.3/0.6 mm, seven 0.2 mm thermal vias, 1.0 mm and 1.7 mm THT, four plated slots for the USB-C shell, NPTH 0.65 mm (USB-C pegs) and 2.2 mm (mounting). Minimum track 0.15 mm, clearance 0.15 mm, annular ring 0.15 mm, mask web ≥ 0.13 mm, no mask opening shared by two nets, every soldered pad opened (checked on the Gerbers). Paste covers 62-81 % of the exposed pads. `outputs/fab-a02/FAB-NOTES.txt` carries the order options and assembly notes with the files.

## 10. Adversarial review

The final adversarial review found the copper releasable and the release-pass changes sound (U100 swap, R1204, SYS_RAW pours, mask fix, R105, D903, via moves). Its blockers were in the order package and are fixed: LCSC numbers that would have fitted the 5 V TVS on the CC lines and 100 nF in place of C703, and the XIAO socket count. Its remaining findings are the manual checks below: the TPS61288 output loop (no small output capacitor at the IC; the loop closes through In1 — measure, A0.3 adds a 100 nF + 22 µF at VOUT/PGND), a ribbon reversed at the P4 end (5 V onto the P4 I2C pins), the R1204 fail-on behaviour if U1300 pin 7 is open, and the single via to the PMID bulk capacitors.

## 11. Release matrix and manual checks

| Check | Result |
|---|---|
| Every connection routed (DRC unconnected) | PASS |
| DRC, all severities, zones refilled | PASS |
| ERC | PASS |
| Board vs netlist, pad by pad | PASS |
| Preserved architecture (section 1) | PASS |
| USB-C 20 V with unprogrammed PD controller | PASS |
| Power-on enable level (LTC2955 → TPS61288 / Q1202) | PASS |
| I2C logic levels across U100 | PASS |
| Defined states during P4 reset | PASS |
| SYS_RAW copper and vias at 5 A | PASS (pin-25 escape: MANUAL thermal check) |
| Via in pad | PASS (intentional cases in fab notes) |
| Solder mask on all soldered pads | PASS |
| Fiducials | PASS |
| Four-camera consistency | PASS |
| Pinouts vs datasheets | PASS |
| BOM / placement / board agreement | PASS |
| LCSC numbers | MANUAL (41 lines by MPN) |
| Placement rotations | MANUAL (assembler preview) |
| Silkscreen legibility and association | PASS |
| Gerber / drill / job file | PASS |
| Physical stack, P4 JP1 position vs J100, spacers | MANUAL |
| Ribbon orientation at the P4 end | MANUAL |
| Battery pack, PCM, harness | MANUAL |
| Boost output loop ringing | MANUAL (bench) |
| USB-only operation (no battery) | MANUAL: not supported until firmware raises the input limit |
| PMID ripple, R1001 pulse, hot-plug at 20 V | MANUAL (bench) |
| Thermal at full load | MANUAL (bench) |
| P4 backfeed with JP1 feeding (IP5306) | MANUAL (bench) |
| Enclosure, antennas, outline corners | MANUAL |

### Before ordering

1. Confirm from the Guition board that **JP1 does not sit under J100** when the carrier is mounted, and that the spacer stack (≥ 10.7 mm) clears the IDC socket with strain relief, the JST GH plugs and L1200 (7.0 mm).
2. Order with **1 oz inner copper**, ENIG, 1.6 mm, tented vias; accept or plug the U700 / U701 / U1201 exposed-pad vias (FAB-NOTES.txt).
3. In the assembler's preview, check **every rotation and pin 1** (bottom side mirrored, through-hole origins at pin 1), and match the 41 BOM lines without an LCSC number by part number or consign them.
4. Order the **XIAO sockets separately** (8 × Wurth 61300711821, hand-fit) and the off-board parts: 1S 4.2 V Li-ion/LiPo pack ≥ 3 Ah, ≥ 6 A continuous, PCM (over-current 7.5-9 A, short-circuit ≤ 500 µs), 103AT-2 NTC referenced to P-; JST VHR-3N with SVH-41T-P1.1 on AWG 16, ≤ 150 mm; 26-way IDC ribbon with keyed sockets (or a polarised cable); M2 screws and spacers; XIAO male headers (Wurth 61300711121, two per XIAO).

### Bring-up (first boards)

1. Inspect U1300 pin 7 (an open joint leaves the boost enabled through R1204 whenever a pack is connected) and the J1100 joints. Power J1100 from a current-limited supply (3.7 V, 0.2 A) with no XIAOs and no P4: off-state current about 44 µA plus quiescents; press the button: 5.0 V on BOOST_5V and SYS_5V; test soft-kill through U600 P1.2.
2. Scope SW and VOUT at U1200 with a short ground spring at 3.0 V in and 2.6 A out. If the ring exceeds about 15 V, fit a 100 nF-1 µF capacitor from the VOUT track (y 54.8) to the GND via at (62.38, 53.23).
3. USB-C: first a 5 V-only source, then a PD charger; check PD_GATE VGS. Program the STUSB4500 NVM for 9 V / 2 A with the 5 V fallback.
4. Before attaching the P4: measure its I2C pull-ups on JP1 23/25 to 3V3, beep the ribbon (1↔1, 2/4↔2/4, 23/25), confirm orientation. With JP1 feeding the P4, check its USB VBUS pin (IP5306 output path). Keep the P4 battery connector empty.
5. Charge at 1 A with the real pack: PMID ripple, U1100 SYS-pin and SYS_RAW copper temperature at full boost load; R1001 during a PD step-down.
6. Fit the XIAOs one at a time: 5V-pin voltage under capture load, TPS2553 FAULT on a short, image noise with the boost running.
