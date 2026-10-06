# KINO D4 carrier A0.2

**Release candidate, 3 October 2026: READY FOR FABRICATION WITH SPECIFIC MANUAL CHECKS.** Fully routed; DRC, ERC and schematic parity clean. Do the checks listed in the [release review](A02-RELEASE.md) before ordering.

Open [KINO_D4_Carrier_A0_2.kicad_pcb](KINO_D4_Carrier_A0_2.kicad_pcb) with its matching project settings. This is the current working board. The supplied [ODD JOBS standard](ODD-JOBS-STANDARD.txt) governs release. The [release review](A02-RELEASE.md) holds the release matrix, the manual checks and the bring-up tests; the 30 September [engineering review](A02-REVIEW.md) is superseded history.

The board has 256 footprints: 80 on the front and 176 on the back, six of them board-only fiducials (three per face). The front carries the four XIAO sockets, the J600 pogo field, the TP100 and TP600-TP602 probe lands, J1100, J1000 and low SMD parts only, so the socketed XIAOs are the tallest parts on it; every cable connector and pin header (J100, J101, J102, J201-J501, J601, J800, J900-J904, J1300) is on the back, the P4 side. The four XIAO sockets keep 22 mm pitch and a 66 mm outer span, with 15.24 mm row centres and 2.54 mm pin pitch. The outline is 117.01 × 69.41 mm. Four 2.2 mm holes target the P4 inner inserts on 61.9 × 54.8 mm centres, with a drawing-derived absolute offset. These XY checks do not validate the assembled enclosure or connector stack.

The [14-sheet schematic](KINO_D4_Carrier_A0.kicad_sch) is the current electrical capture. Historical A0 and A0.1 boards are preserved but no longer match it. Do not use them for fabrication or combine their reports with A0.2.

## Current review files

| File | Purpose |
|---|---|
| [Release review](A02-RELEASE.md) | Release matrix (PASS / FAIL / MANUAL), resolved findings, manual checks before ordering, bring-up tests |
| [Fab package](outputs/fab-a02/) | `fab_a02.py`: Gerbers with job file, Excellon drill, `KINO_D4_Carrier_A0_2-gerbers.zip`, placement file and grouped fab BOM |
| [Assembly front](outputs/A02-ASSEMBLY-FRONT.svg) / [back](outputs/A02-ASSEMBLY-BACK.svg) | References, courtyards and outline; rear view mirrored |
| [Front power detail](outputs/A02-POWER-FRONT.png) / [back power detail](outputs/A02-POWER-BACK.png) | Pack entry, charger and boost region |
| [A0.2 verification](outputs/VERIFICATION-A02.json) / [routing audit](outputs/A02-ROUTING-AUDIT.json) | Counts, geometry and capture-transfer evidence, with board digest |
| [Native DRC](outputs/DRC-A02.json) / [ERC](outputs/ERC-DRAFT.json) | Checker results; no implied manufacturing acceptance |
| [Schematic PDF](outputs/SCHEMATIC-DRAFT.pdf) | 14-sheet capture |
| [BOM](outputs/BOM-DRAFT.csv) / [part selection](design/part_selection.json) / [pin matrix](outputs/PIN_NET_MATRIX.csv) | Manufacturer parts checked against datasheets; battery pack still open |
| [Mounting template](outputs/P4-MOUNTING-TEMPLATE-1TO1.pdf) / [mechanical evidence](MECHANICAL.md) | Print at 100 %; stack and enclosure still unqualified |
| [Printed labels](outputs/A02-PRINTED-LABELS.json) / [assembly references](outputs/A02-ASSEMBLY-LABELS.json) / [unplaced references](outputs/A02-ASSEMBLY-LABELS-UNFINISHED.json) | Label positions; parts without a clear, unambiguous silk position beside the part |
| [Silk text check](outputs/A02-SILK-TEXT.json) | `check_silk_text.py`: text over text, pads, part bodies or silk graphics, crowded or ambiguous references, reading direction |

**Routing status, 3 October 2026 (release pass):** every connection is routed. Native DRC (zones refilled, schematic parity on) reports no violations and no unconnected items; ERC reports none; `verify.py --a02` passes against a freshly exported netlist. 573 vias; 2385 track segments (F 786, In2 414, B 1185). The SYS_RAW battery-to-boost path is now a 3.4-3.9 mm back pour and a 4.6-5.2 mm In2 pour with 19 vias between them and six into L1200 (`power_a02_sys_raw.py`). Five 0.1 mm right-angle wobbles remain inside 0.5-0.8 mm copper (no exposed corner). CAM2_3V3 still takes the long route south of U300 (0.25 mm, light load); CAM_GLOBAL_EN and BOOST_ENABLE are long In2 runs, BOOST_ENABLE now held by R1204 (100k) at the boost end.

Prototype references are on silkscreen (ODD JOBS rule 177) beside their own part: 0.15 mm clear of part outlines, 0.5 mm from other silk text, horizontal text left to right and vertical text bottom to top from its own side (rule 91), 1.0 mm text or 0.8 mm in dense areas, 0.15 mm stroke. A spot more than 0.5 mm nearer another part is not used. After the release pass, 202 of 250 references are on silk; no text overlaps another text, a pad, a part body or a silk graphic (`check_silk_text.py`: 0 findings). The four camera circuits share one offset per role, or the whole group of four goes to Fab. 48 references in the camera, charger and boost clusters (and the DNP R1110) stay on Fab at the part centre and are listed in the unplaced file; they need part spacing, not smaller text. The fiducials keep their references on Fab. Connector, camera and product labels use 1.0 mm text with a 0.15 mm stroke.

## Circuitry

- **Cameras:** four socketed XIAO ESP32-S3 Sense boards with UART/sync isolation buffers, individual current-limited supplies, current monitoring and 0 ohm USB-service power links (JP200-JP500, Vishay CRCW12060000Z0EAHP, desolder before node USB). D8/D9/D10 are shared with the Sense SD interface, and D2 is strap-sensitive.
- **I2C buffer:** U100 (TCA9517) has the carrier bus on its A side, which drives a hard low; the B side's 0.45-0.6 V buffered low faces the P4 bus (P4 VIL 0.825 V). The STUSB4500 (VIL 0.35 V), BQ25798 (0.4 V) and DRV2605L (0.5 V) could not be guaranteed to read the buffered low. Keep the whole bus at 100 kHz (4.7k pull-ups, about 95-150 pF). R100/R101 (2.2k/22k) hold the buffer enable low when JP1 pin 1 is open.
- **P4 link:** the 26-pin P4 connection is a keyed IDC **cable** interface, kept until Guition supplies a JP1 datum for a board-to-board mate. The UART/sync/shutter header map is unchanged; GPIO35/JP1-15 stays unconnected.
- **Power:** USB-C PD sink (STUSB4500), 1S charger (BQ25798), fuel gauge (BQ27441-G1), 5 V boost (TPS61288), 3.3 V buck and a hardware power controller.
  - The USB input survives an unprogrammed STUSB4500, which takes 20 V from a PD charger: D1001 is an SMF22A (22 V standoff), the PD switch FETs are AO4409 (-30 V), R1004 is 10k. Program the NVM for 9 V / 2 A with the 5 V fallback for normal use.
  - The LTC2955-1 EN output is a 2 uA current source; R1204 (100k to SYS_RAW) is the pull-up ADI asks for, so the TPS61288 enable and the PMV16UN load-switch driver (Q1202) see a full logic high.
  - The charger charges whenever VBUS is valid (CE low), inside a 1-60 °C window set by the pack's 103AT-2 thermistor.
  - The gauge shunt is high side, with SRP on the pack side and SRN on the system side.
  - Input current is clamped to 0.15-0.41 A until firmware reads the PD contract, so the board needs its battery to run the P4 and cameras from USB.
  - Off, the board draws 28-46 uA through R1204 plus the controllers' quiescent current.
  - The charger's STAT pin is left open and there is no charge LED (STAT has no layout path out of the charger's power copper). Firmware reads the charge state from the BQ25798 status registers over I2C. The green power LED D1300 stays.
- **Pack entry:** J1100 (JST VH, `- NTC +`) sits on the bottom edge beside the charger. From the pack, F1100 (7 A) and RS700 (5 mΩ) form a 12 mm chain on the front.
- **Sensors and controls:** IMU, backed-up RTC, board-temperature sensor, remote shutter, cover sensor, function button (ESD clamp D903), haptic driver and expansion/service connectors. R105 holds SYNC_MASTER low through the P4's reset.
- **Power links:** JP200-JP500 and JP1200 are 0 ohm links on the front (CRCW1206-HP, 10 A), replacing the 2.54 mm headers and shunts: flat, reachable with the carrier on the P4, rated for the current. Desolder to open.
- **Test field:** J600 is an asymmetric 12-pad **sense/test** field, not a power-injection connector. Do not drive the enable nodes against the expander. Pads 9-11 are unconnected: CAM2_EN, CAM3_EN and CAM4_EN are probed at front lands TP600-TP602 beside their lines at the top of the board (CAM1_EN stays on pad 8). TP100 (P4 3V3 test) is a front land beside J100 pin 1.
- **Expander map:** U600 (TCA9539) port 1, P1.0-P1.7 (pins 13-20): IMU_INT, RTC_INT_N, SOFT_KILL, unused, POWER_INT_N, FN_N, HAPTIC_EN, COVER_N. P1.3 is not connected; configure it as an input. Firmware must follow this map.
- **Flash provision:** J601/R605 are DNP provisions for an **external flash driver**. There is no FLASH_EN GPIO or flash-energy supply.

I2C addresses: PAC1954 0x10, STUSB4500 0x28, TMP117 0x48, RV-3028 0x52, BQ27441 0x55, DRV2605L 0x5A, LSM6DSOX 0x6A, BQ25798 0x6B, TCA9539 0x74. P4 touch at 0x5D stays on the host side of the buffer. [`firmware/p4/main/kino_carrier_a02.h`](../../../firmware/p4/main/kino_carrier_a02.h) holds these addresses, the expander map, the PAC1954 channel map and the charger status field as constants. Existing firmware does not start the carrier's power controls, charger policy or gauge calibration.

## Manufacturing and assembly status

Process: four layers, 1.6 mm, **1 oz copper on all four layers** (set in the board stackup and the Gerber job file; inner 1 oz is not JLCPCB's default), black mask, white silk, ENIG, JLCPCB-class. `design/fab_a02.py` writes the [fab package](outputs/fab-a02/): Gerbers (silk clipped at mask openings) with the job file, Excellon drill (plated and non-plated apart) with maps, one zip for upload, the placement file (both sides, DNP and board-only items left out) and a fab BOM grouped by part number. Fab and assembly notes, the via-in-pad list and the order options are in the [release review](A02-RELEASE.md). Both faces are assembled: the bottom (P4 side) carries most SMD parts including the heavy XAL7070 boost inductor, the XIAO sockets and J1100 are through-hole on the front, the pin headers and J100 through-hole on the back.

Battery selection, retention and the assembled body are not built or verified. The XAL7070 boost inductor (7.0 mm) and the JST VH connector set the tallest parts on their faces. The XIAOs use external antennas; their antenna and cable clearance must be defined in the enclosure. Keep the P4 battery connector unused. USB/P4/carrier source coexistence still needs measurement; the removable power links are service provisions, not automatic backfeed protection.

## Editing and regeneration

The native A0.2 PCB is authoritative for placement and routing. `design/circuit.py` defines the capture and `design/mechanical.py` the envelope and datums. **Do not run the full build or placement seed against current work**: they reset placement and routing.

Change scripts, in the order they were applied:
- **Earlier A0.2 changes:** `rework.py`, `route_a02.py`, `spread_a02_*.py`, `refine_a02_placement.py`, `add_a02_interfaces.py`, `finish_a02.py`.
- **Charger, thermistor and inductors (0.1.8):** `a02_power_rev.py`.
- **Gauge, fuse and CC protection:** `a02_gauge_rev.py`.
- **Pack entry:** `pack_placement.py`, then `route_pack_entry.py`.
- **USB VBUS:** `route_usb_vbus.py`.
- **PMID capacitors:** `route_pmid.py`.
- **Boost supply:** `route_boost_input.py`.
- **Inductor keepouts:** `switch_keepouts.py`.
- **Residual DRC items:** `a02_drc_fixes.py`.
- **Labels:** `pack_labels.py`, `assembly_labels.py --prototype-silk`, then `check_silk_text.py` (exits 1 on any finding). KiCad's silk_overlap check does not compare one footprint's reference with another's.
- **Routing pass, 2 October 2026:**
  1. `route_a02_gaps.py` (charger VBUS corner, U800 supply, boost sense tap), `gnd_stitch.py`.
  2. `grid_router.py` pass, `apply_routes.py`.
  3. `route_a02_charger_escapes.py`: BQ25798 left-column escapes; moves C1119, C1103, C1100, R1104, R1105.
  4. `tidy_a02_dangling.py`, `a02_pad_connections.py`.
  5. `route_a02_sync_bus.py`: SYNC bus from y 19.4 to y 41.05 at the buffers.
  6. `rip_camera_row.py`, then `grid_router.py` with `GR_ORDER=argv` (FAULT_N, EN, REQ, SHUNT_OUT, SYS_5V).
  7. `route_a02_camera_bus.py remove`, `add`, `verify`: In2 control lanes north of the headers.
  8. `place_a02_u600.py place`, `rip`: U600 turned 180 degrees, C601 beside pin 24; `drop_dangling.py`; router.
  9. `place_a02_brand.py`: maker mark moved onto clear pour below J901.
  10. `tidy_routes.py`, run last.
- **External connections to the back, 2 October 2026:**
  1. `place_a02_j100.py place`, `rip`, `add`: J100 on the back in its outline; P4_5V redrawn at 1.2 mm.
  2. `place_a02_backside.py flip`, then `free_spot.py` for J902 and J904, `tofront`, `rip`: headers and JST connectors to the back; the haptic driver cluster, Q1300, R1300, R1301 and R1304 to the front in their place.
  3. `fp_a02_link_1206.py`, `circuit.py` change, `regenerate_capture.py`, netlist / ERC / PDF, `place_a02_links.py`: JP links become 0 ohm links on the front.
  4. `route_a02_p4_feed.py rip`, `add`: P4_5V_ISO as a 2.0 mm In2 run with three vias per layer change.
  5. `clear_a02_backside.py move`, `rip`; `drop_dangling.py`: courtyard and copper conflicts cleared, J601 0.65 mm north.
  6. `place_a02_labels.py`, `assembly_labels.py --prototype-silk`, `check_silk_text.py`: connector labels on the back silkscreen, references beside their parts, silk text check.
- **SYS_5V, 3 October 2026:**
  1. `route_a02_sys5v.py rip`, `add`, `link-rip`, `link-add`: trunk, drops, riser and feed; camera 1 SHUNT_OUT via, IMU_INT middle and the U700 SENSE+ tie removed for it.
  2. `grid_router.py SYS_5V` with `GR_SKIP_REF=U700`, `apply_routes.py`, `tidy_routes.py`: U1201 and J600 branches.
  3. `straighten_a02_j600.py`: the J600 branch as one straight run.
- **Signal pass, 3 October 2026:** `grid_router.py` over every open net except the camera header-socket GPIO, `GR_SKIP_REF=U700`; `apply_routes.py`; `tidy_routes.py`. 195 -> 114 unconnected; six routes at minimum clearance (RTC_BACKUP, P4_SCL, CHARGE_LED_A, CAM3_REQ, MOTOR_N, CAM1_EN) for review. Through-hole pads now also allow 45-degree exits in the router.
- **Camera GPIO, 3 October 2026:** `route_a02_cam_gpio.py clear <k>` for k = 4, 3, 2, 1, DRC and `drop_dangling.py` until stable, then `add <k>`: the eight header-to-socket GPIO lines of each camera as one identical In2 fan-out (eight 1.27 mm lanes, 45-degree fans, no crossings). `plan <k>` reports what is in the way. The nets it opens (camera EN, SYNC, SHUNT_OUT, P4_BUS_EN, MB_3V3 pieces) go back to the grid router.
- **Second router pass, 3 October 2026:** `grid_router.py` over all open nets (`GR_SKIP_REF=U700`), `apply_routes.py`, `tidy_routes.py`: 101 -> 75. P4_BUS_EN is at minimum clearance (review).
- **Ground fixes, 3 October 2026:** five GND pins reached no ground (U900.4/.8 after the haptic driver moved to the front, U701.3, C1101.2, U1201.1). `gnd_stitch.py`; `gnd_pad_vias.py U701.3 'U1201.1>U1201.9'` (U1201 pin 1 to its exposed pad, as in TI's layout); `rip_box.py CHG_REGN 92.5 56.5 97.0 61.0` (a route that circled C1101) then `gnd_pad_vias.py C1101.2` and the router for CHG_REGN; `rip_box.py` for REMOTE_ACTIVE and HAPTIC_REG under U900, `route_a02_u900_gnd.py`, the router for both nets, `gnd_stitch.py`. GND has no open connection; `gnd_islands.py` still lists the U701.3 and U1201.1 fragments because it looks only for a via inside a fragment, not for a track out of it.

- **U700 and Kelvin pairs, 3 October 2026:**
  1. `place_a02_u700.py rip`, `place`: the PAC1954 U700 moves to the front between the camera 2 and 3 headers, centre (58.75, 15.5), with C700 and R700 beside it and C701 on the back; copper on their pads and three runs in the way removed.
  2. `route_a02_kelvin.py clear`, then DRC and `drop_dangling.py --keep <nets with deliberate stubs>` until stable, then `add`: eight 0.15 mm sense lines at 0.32 mm pitch from the inner pad corners of RS200-RS500 to U700, plus U700's GND, MB_3V3 and PAC_ADDR copper. The CAM2_5V and CAM3_5V_ISO vias move. `add` sets the moved vias' nets back, because a save in between can give a via with nothing of its own net attached the pour's net.
  3. `check_a02_kelvin.py`: each sense line touches only its shunt pad and its U700 pin.
  4. `fp_a02_pac1954.py`, `circuit.py` change, `regenerate_capture.py`, netlist / ERC / PDF, `place_a02_u700.py place`: U700 on a project copy of the VQFN-16 land whose pin 1 triangle sits beside the pin 1 corner (the stock one lay on C700's pad).
- **Bus slot, edges and expanders, 3 October 2026** (hand scripts on `handroute.py`; each runs `rip`, `place` where it has one, then `add`, as separate processes):
  1. `route_a02_local_fixes.py`: USB_CC2 out of U1000 (a VBUS via moved), CHG_REGN's missing piece and an In2 link that frees R1107, CHG_TS, POWER_KILL_N under U802 / C803, a straight PACK_FUSED sense exit.
  2. `route_a02_p4_rx4.py`: P4_RX4 back in its F bus lane (y 20.6) with its J100 tap; POWER_INT_N, CAM2_5V and CAM2_5V_ISO cross the band on In2 in one piece; camera 3's 3V3 runs as camera 1's and shares the header row gap with CAM3_FAULT_N at 0.15 mm; TX3, TX1 and RX2 no longer run past their taps.
  3. `place_a02_remote.py dry` / `rip` / `place`, `route_a02_remote.py`: the remote dry-contact chain (D900, R903, R904, C904, U901, C905, R905, Q900) beside J903 and D902 beside J902 (ESD at the connector, ODD JOBS 24).
  4. `route_a02_left_edge.py`: the four C6 service lines up the left edge and along the top edge into J101; SHUTTER_N from Q900 down the left edge on B into J100 pin 21.
  5. `route_a02_u601.py`: C602 beside U601's VCC pin, CAM_GLOBAL_EN tied once under the package, CAM1_EN, CAM3_EN, CAM3_REQ and CAM4_EN out of U601 (CAM3_EN down the In2 column between the SYS_5V riser and camera 3's fan).
  6. `route_a02_test_legs.py`: J600 test legs (CAM1_EN's leg to U201's EN node).
  7. `grid_router.py` (`GR_OUT` names an output; `apply_routes.py` takes the same variable) between the steps for the short links.
  8. `route_a02_mb3v3.py` (3.3 V to the moved remote chain), `route_a02_top_lanes.py` (U600 port 1 lines along the top edge), `route_a02_u900.py` (MOTOR_P out of the haptic driver).
  9. `circuit.py` change, `regenerate_capture.py`, netlist / ERC / PDF, `route_a02_u600.py`, `route_a02_bundle_ends.py`: U600 port 1 in layout order and the camera 1/2 channel bundle (F rows, In2 down between the sockets).
  10. `circuit.py` change (R700 ADDRSEL strap dropped, pin 6 to the exposed pad), `place_a02_u700.py place`, `route_a02_u700_i2c.py`: I2C into U700.
- **I2C and power side, 3 October 2026** (same hand-script pattern):
  1. `route_a02_u801.py` (RTC pins out west, R800 moved), `route_a02_i2c.py` (SCL/SDA between the west cluster, U801, U800 and the power side), `route_a02_u1100.py` (charger pocket: BAT_PROTECTED strap to F, CE / SCL / SDA out south, R1110 and R1102 moved), `route_a02_u701.py` (gauge I2C, C702 between the USB-C shield pins, U1000 PD_DISCH / SDA), `route_a02_u900_sda.py`.
  2. `route_a02_gauge.py` (R701 and R702 beside U701), `route_a02_u1000_top.py` (R1004 above pin 16, C1000 moved), `route_a02_stat.py` and `circuit.py` (U600 P1.3 unused), `route_a02_pb_corner.py` (U1300 PB / EN escapes; D1300 and R1303 moved; D1301, R1304, R1109 and TP1100 removed with the charge LED).
  3. `circuit.py` change, `add_a02_enable_tps.py`, `route_a02_enable_tps.py`: TP600-TP602 for CAM2-CAM4_EN in place of J600 pads 9-11. `route_a02_u1200_en.py`: U1200 EN to a via (MB_3V3 spur and SYS_RAW riser shifted).
- **Last opens and finish, 3 October 2026:**
  1. `route_a02_j100.py` (TP100 to the front beside J100), `route_a02_p4_sense.py` (P4_3V3_SENSE down the west edge on B), `route_a02_p4_bus_en.py` (U100 EN and the R100/R101 divider onto the buffer chain on In2), `route_a02_cam_global_en.py` (J100 pin 10 to U601 on In2 along the top), `grid_router.py CAM2_3V3` + `apply_routes.py`, `route_a02_boost_en.py` (U1200 EN on In2 round SYS_RAW to Q1202), `route_a02_cam2_fault.py` (U301 FAULT to U600 pin 9 on B, In2 under U600; R603's GND pad linked to C701), `route_a02_gnd_u600.py` (U600 pin 21 via).
  2. `gnd_stitch.py`, `tidy_routes.py`, `chamfer_a02_corners.py` (right-angle bends on locked copper).
  3. `place_a02_c904.py`: C904 out of H1's fastener square (verify.py), vertical below R904.
  4. `assembly_labels.py --prototype-silk`, `check_silk_text.py`; DRC; netlist / ERC / PDF re-exported; `verify.py --a02`, `routing_audit.py --a02`.
  CAM2_FAULT_N had no route the grid router could find within its budget; `GR_DEBUG` masks showed one corridor, which the hand script follows.

- **Release pass, 3 October 2026** (hand scripts on `handroute.py` run `rip`, `place` where they have one, then `add`, as separate processes):
  1. `place_a02_r603_c701.py` (CAM2_FAULT_N no longer passes between passive pads), `gnd_stitch.py` (no stitching via in or touching a GND pad), `fix_a02_via_in_pad.py`, `silk_a02_camera_labels.py`.
  2. `add_a02_fiducials.py`: three fiducials per face, board-only, 1.0 mm pad clearance.
  3. `circuit.py` changes, `regenerate_capture.py`, `release_a02_usb_pd.py` (TP1001 removed, U1000 pin 20 open), `sync_a02_values.py` (board values from the capture): D1001 SMF22A, R1004 10k, AO4409, PMV16UN, R100/R101, BOM text.
  4. `route_a02_scl_l1200.py`: I2C_SCL out from under the L1200 corner on In2.
  5. `fix_a02_socket_mask.py`: mask openings on the XIAO socket pads (the footprint generator had dropped them; `build.py` and the library are fixed too).
  6. `fix_a02_via_webs.py`: vias out of and away from pads (CAM1_EN at U201, C901, CHG_PMID, CHG_BTST1, U701, a dead CAM3_5V_ISO via).
  7. `swap_a02_u100.py`: the TCA9517 sides swapped, its four I2C connections redrawn; `gnd_stitch.py`.
  8. `add_a02_release_parts.py`, `release_a02_parts_route.py`: R105, R1204, D903.
  9. `power_a02_sys_raw.py` (`rip`, `add`, `pour`): SYS_RAW pours and stitching.
  10. `fix_a02_u1200_marks.py`: U1200 body outline and pin-1 dot.
  11. `mark_a02_release.py`: CARRIER A0.2 / 2026-10 lines, P4 JP1 label, S/N box.
  12. Final review fixes: `fix_a02_peg_via.py` (GAUGE_1V8 via 0.52 mm from the J1000 peg), `assembly_test_pads.py` (outlines of removed test lands dropped), `sync_a02_values.py`, `silk_a02_widths.py` (legend lines and strokes to 0.15 mm), `fp_a02_pac1954.py` then `silk_a02_u700_mark.py` (U700 pin-1 triangle clear of C700), `assembly_labels.py --prototype-silk` (ambiguous camera groups and R1003/R1110 to Fab, C1105 above its part, 1 mm silk-free ring round the fiducials), `check_silk_text.py`.
  13. DRC, netlist / ERC / PDF, `resistor_selection.py`, `verify.py --a02`, `routing_audit.py --a02`, `fab_a02.py`.
  14. After release, same day: `place_a02_connector_row.py` (`rip`, `place`, `add`, `labels`) puts J1300, J102 and J800 on one row on the back (origins at y 63.0, pins on one line at y 64.95), redraws their AUX_3V3, I2C_SCL, I2C_SDA and RTC_BACKUP routes and centres the POWER / 3V3 I2C / RTC BACKUP labels on one line; `assembly_labels.py --prototype-silk` (U1201 under its part, J102 and J800 centred above their connectors), `check_silk_text.py`, DRC, `verify.py --a02`, `routing_audit.py --a02`, `fab_a02.py`.
  `design/release.py` holds the release state the output scripts print. `rework.py` and `route_a02.py seed` now refuse to run without `--rebuild`: both rebuild the board from earlier seeds.

Each routing script removes and redraws only the copper it owns. `tidy_routes.py` reshapes unlocked copper, so a hand script re-run after it no longer recognises its own routes: re-run hand scripts from a board saved before the tidy. In this KiCad build a `Remove()` leaves the Python bindings unreliable for the rest of the process, so the newer scripts remove, add and verify in separate runs. Helpers:
- `free_spot.py`: collision-checked placement of one part.
- `gnd_pad_vias.py`: a GND via beside a named pad (straight or 45-degree stub), or `A>B` to tie a GND pin to a grounded pad of the same part.
- `rip_box.py NET x0 y0 x1 y1`: removes a net's unlocked copper inside a box for re-routing.
- `handroute.py`: shared rip / place / add phases for the hand-route scripts (locked copper, 45-degree check).
- `clean_dangling.py`: removes track stubs.
- `drop_dangling.py`: removes exactly the items DRC reports as dangling; `--keep` spares named nets.
- `gnd_islands.py` / `gnd_stitch.py`: list and stitch GND pour fragments with no via. `gnd_islands.py` also lists fragments tied in only by a track or a pad's thermal spokes; DRC's unconnected count is the authority.
- `chamfer_a02_corners.py`: 45-degree chamfers on the right-angle bends `routing_audit.py` counts, locked copper included; run after `tidy_routes.py`.
- `grid_router.py`: `GR_ORDER=argv` routes the named nets in order, `GR_LIMIT` sets the search budget, `GR_DEBUG=<dir>` writes clear-cell masks, `GR_OUT` names the output, `GR_SKIP_REF=U700,...` leaves those parts' pads for designed routes.
- `regenerate_capture.py`: rebuilds schematic and BOM without touching the board.
- `route_secondary.py`: Freerouting export/import with existing copper fixed.

Never import a router session exported from different component positions or nets.

After circuit changes, regenerate the schematic, XML netlist, ERC and PDF. After board changes:
1. Run DRC with `--refill-zones --save-board`.
2. Run `verify.py --a02` and `routing_audit.py --a02`.
3. Inspect the copper and silk visually.

A passing checker does not validate power, thermal behaviour or physical fit.

Implementation stays in [issue #232](https://github.com/b5463/kino-d4/issues/232) and [ECN-0007](../../changes/ECN-0007-four-xiao-carrier-proposal.md), design package 0.1.8. The system power documents (`docs/audit/POWER_MODEL.md`, `docs/audit/HARDWARE_CONTRACT.md`) still describe the d4-v1 power path (SW6106 bank, 3 A harness); they change if this carrier is adopted.

The supplied ODD JOBS symbol and its traced contour remain reserved artwork, separate from CERN-OHL-S-2.0 hardware source. Stock KiCad footprints use the library electronic-design exception. Vendor design files are consulted, not redistributed. [Sources](SOURCES.md) records provenance. [A0.1 review](RELEASE-REVIEW.md) is kept as historical rejection evidence.
