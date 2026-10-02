# A0.2 engineering review - DO NOT ORDER

30 September 2026, design package 0.1.8, reviewed against the [ODD JOBS standard](ODD-JOBS-STANDARD.txt). Pre-EVT. No manufacturing release or first-build success is claimed. [A0.1 review](RELEASE-REVIEW.md) is historical.

## Current checker evidence

| Check | Result | Source |
|---|---|---|
| ERC | 0 violations | [ERC-DRAFT.json](outputs/ERC-DRAFT.json) |
| DRC | 0 violations, 0 warnings | [DRC-A02.json](outputs/DRC-A02.json) |
| Schematic parity | 0 differences | [DRC-A02.json](outputs/DRC-A02.json) |
| Schematic vs PCB pads | 896 compared, all match | [VERIFICATION-A02.json](outputs/VERIFICATION-A02.json) |
| Unrouted connections | 182 | [A02-ROUTING-AUDIT.json](outputs/A02-ROUTING-AUDIT.json) |
| Footprints | 250: 78 front, 172 back | [VERIFICATION-A02.json](outputs/VERIFICATION-A02.json) |
| In1 (ground reference) | 0 signal segments | [A02-ROUTING-AUDIT.json](outputs/A02-ROUTING-AUDIT.json) |

The verification records the board and netlist SHA-256. A report whose digest does not match the board file describes an older board.

## Power-stage changes in 0.1.8

Each change cites the manufacturer data it follows. These are design corrections, not measured results.

**Charging with the camera off.** BQ25798 CE (pin 13) must be driven high or low (TI pin table). It was pulled high and only a transistor driven from the switched 3.3 V expander could enable charging, so an off camera never charged. CE is now pulled low through R1102. Firmware inhibits charging with EN_CHG. R1110 (10k to REGN, DNP) is a bring-up hardware inhibit. Expander P1.3 now reads charger STAT.

**Battery temperature.** R1106 5.23k / R1107 30.1k with a 103AT-2 pack thermistor. TI specifies 5.24k / 30.31k. The E96 values give T1 0.97 °C and T5 59.9 °C, within 0.7 °C across 1 % corners. An open thermistor reads 85 % of REGN (cold) and a short reads 0 % (hot); both suspend charging.

**Fuel gauge.** TI BQ27441-G1 SLUSBH1C expects a high-side 10 mΩ shunt: SRP (pin 8) Kelvin to the pack side, SRN (pin 7) to the system side, BAT (pin 6) Kelvin to pack positive. A0.2 had it in the pack return. The chain is now J1100.1 → F1100 → PACK_FUSED → RS700 → BAT_PROTECTED. RS700 is 5 mΩ (Vishay WSLP1206R0050FEA) because the gauge input range is ±25 mV. 4.4 A gives 22 mV, and 5 A gives the full 25 mV. The gauge is factory-calibrated for 10 mΩ, so **firmware must write CC Gain for 5 mΩ**. GPOUT (pin 12) had been left floating against TI's instruction; R702 now pulls it to the gauge VDD. C703 on BAT is 1 µF, as TI specifies.

**Pack entry.** J1100 moved from the top edge to the bottom edge beside the charger. F1100 and RS700 stand on the front to its right. The 5 A path from connector to charger BAT pins is now about 12 mm; it was about 70 mm. Pin 3 is plain GND with a solid pad connection. J1100 keeps 0.08 mm outside the H4 7 mm fastener exclusion. Pack polarity is printed as `- NTC +` in pin order. The battery location is still open. A harness reaches the connector from wherever the enclosure puts the cell.

**Boost inductor.** TI TPS61288 9.2.2.2 requires inductor Isat above the switch current limit, which is 17.1 A maximum. The placeholder was an unnamed 6.5 mm part. L1200 is now Coilcraft XAL7070-222MEC: 2.2 µH, 6.33 mΩ maximum, Isat 19.6 A at -30 %, Irms 13.2 A at +20 °C. Worst operating peak is 6.1 A at 3.0 V in and 2.6 A out. TI's own table 9-2 parts (XAL1060 class, about 11 × 12 mm) do not fit the board. The XAL7070 is 7.0 mm tall on the back face; add it to the stack-height budget. The stock KiCad footprint matches Coilcraft's land (1.92 × 6.50 mm pads, 4.82 mm pitch).

**Boost compensation.** RC 20.5k and CC 3.3 nF, per TI equations 12-13 at fc 8 kHz, Co_eff 72 µF and Vin 3.0 V. CP stays DNP. A model sweep over Co 50-110 µF, L ±20 % and Vin 3.0-4.3 V gives crossover 5.5-16.5 kHz, phase margin 68-86° and crossover below a third of the RHP zero. **Measure the loop on the bench.**

**Charger inductor footprint.** L1100 (TDK SPM6530T-1R0M120, TI's characterization part) had a draft footprint with 2 × 6 mm pads and a 3.0 mm gap, reaching under the body. It now uses the TDK catalogue land: 1.85 × 3.4 mm pads with a 3.7 mm gap.

**PMID bulk capacitors.** C1107-C1109 sat 13 mm from PMID pin 29, past the pack connector, and were not connected. TI 8.4.1 allows bulk PMID capacitors on another layer through multiple low-impedance vias; the 0.1 µF C1110 stays beside the pin. They now stand on the front over the charger. Two vias tie them down west of the In2 SW1 crossover, keeping 0.95 mm from its centreline.

**Missing power paths added.**
- **USB VBUS:** routed from J1000 to the Q1000 drain row, with a 0.5 mm escape per VBUS pad and a 1.0 mm back trunk. The CC escapes had blocked both VBUS pads and now route via a back hop.
- **Boost feed:** the charger SYS bank now reaches the L1200 input on In2, 3.0 mm wide. **This requires 1 oz inner copper**, which is not JLCPCB's default.
- **BAT escape:** the BQ25798 BAT pins leave between a GND via and the BTST2 via at 0.5 × 4 mm, about 76 mW at 4.4 A. Check this thermally on the bench.

**Protection and parts.**
- **CC protection:** CC1/CC2 use PESD24VL1BA (24 V standoff). The 5 V parts would conduct if a damaged cable put 9 V PD VBUS on CC.
- **Pack fuse:** F1100 is Bourns SF-1206F700-2, 7 A fast, so 5 A is 71 % of rating. Its 50 A interrupt rating relies on the pack protection clearing a hard short first.
- **Other values:** C1202 is 4.7 µF, because TI needs more than 1 µF effective on VCC. U1300 is LTC2955ITS8-1 (I grade). C1301 is 1.5 µF because no 1.8 µF 0603 is stocked. The long-press time constant is still to be confirmed from ADI.

**BOM.** Every line names a manufacturer part checked against its datasheet or product page ([part_selection.json](design/part_selection.json), [resistor selection](outputs/A02-RESISTOR-SELECTION.json)). The only exception is the battery pack. ICs carry their full ordering codes. The custom TPS61288 footprint matches TI RQQ0011A land pattern 4225610/A to 0.0125 mm, with the difference on reference dimensions only.

## Input-current policy

The ILIM_HIZ divider (30.1k / 10k) clamps input to 0.15-0.41 A at every plug-in. TI samples the pin once, at power-on or at good-source detection, so a hardware switch on the pin after PD negotiation would not take effect. The policy is therefore firmware:
1. Read the STUSB4500 contract.
2. Set EN_EXTILIM = 0 and IINDPM to the contract current.
3. Restore both on VBUS removal.

Neither register is reset by the charger watchdog. The input-voltage regulation (VINDPM) still protects a weak source while firmware is hung. This is a firmware requirement, not yet implemented.

## Rejecting findings

| Priority | Finding | Required resolution |
|---|---|---|
| P0 | 182 connections unrouted, including the SYS_5V camera trunk. A Freerouting pass stalled at 212 unrouted and 309 violations and was not imported. | Route by explicit script per net class, then manually review every class (rule 191). |
| P0 | Battery pack not selected. The design needs a protected 1S pack with a 103AT-2 NTC, at least 5 A discharge and a harness to J1100. | Choose the pack with the enclosure. Check protection, NTC and cable path (rules 49-52). |
| P0 | Carrier firmware missing: expander, charger input policy, gauge CC Gain, camera enables. | Implement and test. The 3 Mbaud UART qualification is included. |
| P0 | P4/USB/XIAO source coexistence unqualified. | Measure every powered and unpowered combination and each backfeed path. |
| P0 | No assembled carrier/P4/socket/battery/enclosure fit. The XAL7070 (7.0 mm) and J1100 heights are not yet in a stack budget. | Build the height map (rule 75), then fit-check. |
| P1 | Silk references: 14 parts have no clear position within 8 mm. Eight are in the USB-PD corner; the four sockets, J1000 and J1100 carry functional labels. See [A02-ASSEMBLY-LABELS-UNFINISHED.json](outputs/A02-ASSEMBLY-LABELS-UNFINISHED.json). | Place by hand after routing. |
| P1 | PAC1954 camera shunt sense lines not yet routed as Kelvin pairs. | Route explicitly from the shunt pads, as done for the gauge. |
| P1 | Boost loop, BAT pin escape and inner-layer feed temperatures are calculated only. | Bench measurement. |

## Fabrication intent

Four layers, 1.6 mm, 1 oz outer **and 1 oz inner** copper, black mask, white silk, ENIG. Minimum 0.13 mm black-mask dams and 1.0 mm text with a 0.15 mm stroke. The J1000 outer GND lands are the documented 0.05 mm local deviation, now the named project footprint `KINO_A0:USB_C_GCT_USB4105_KINO_GND0.05`. No Gerber, drill or placement files are produced.

The five ODD JOBS release questions (boot, flash, recover, measure, fit) remain unproven. Tracking: [issue #232](https://github.com/b5463/kino-d4/issues/232).
