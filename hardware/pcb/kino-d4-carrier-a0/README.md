# KINO D4 carrier A0.2

**Engineering rework. Fully routed (DRC clean, no open connections); not yet reviewed for release. DO NOT ORDER.**

Open [KINO_D4_Carrier_A0_2.kicad_pcb](KINO_D4_Carrier_A0_2.kicad_pcb) with its matching project settings. This is the current working board. The supplied [ODD JOBS standard](ODD-JOBS-STANDARD.txt) governs release; the [current review](A02-REVIEW.md) still rejects ordering.

The board has 248 footprints: 77 on the front and 171 on the back. The front carries the four XIAO sockets, the J600 pogo field, the TP100 and TP600-TP602 probe lands, J1100, J1000 and low SMD parts only, so the socketed XIAOs are the tallest parts on it; every cable connector and pin header (J100, J101, J102, J201-J501, J601, J800, J900-J904, J1300) is on the back, the P4 side. The four XIAO sockets keep 22 mm pitch and a 66 mm outer span, with 15.24 mm row centres and 2.54 mm pin pitch. The outline is 117.01 × 69.41 mm. Four 2.2 mm holes target the P4 inner inserts on 61.9 × 54.8 mm centres, with a drawing-derived absolute offset. These XY checks do not validate the assembled enclosure or connector stack.

The [14-sheet schematic](KINO_D4_Carrier_A0.kicad_sch) is the current electrical capture. Historical A0 and A0.1 boards are preserved but no longer match it. Do not use them for fabrication or combine their reports with A0.2.

## Current review files

| File | Purpose |
|---|---|
| [Assembly front](outputs/A02-ASSEMBLY-FRONT.svg) / [back](outputs/A02-ASSEMBLY-BACK.svg) | References, courtyards and outline; rear view mirrored |
| [Front power detail](outputs/A02-POWER-FRONT.png) / [back power detail](outputs/A02-POWER-BACK.png) | Pack entry, charger and boost region |
| [A0.2 verification](outputs/VERIFICATION-A02.json) / [routing audit](outputs/A02-ROUTING-AUDIT.json) | Counts, geometry and capture-transfer evidence, with board digest |
| [Native DRC](outputs/DRC-A02.json) / [ERC](outputs/ERC-DRAFT.json) | Checker results; no implied manufacturing acceptance |
| [Schematic PDF](outputs/SCHEMATIC-DRAFT.pdf) | 14-sheet capture |
| [BOM](outputs/BOM-DRAFT.csv) / [part selection](design/part_selection.json) / [pin matrix](outputs/PIN_NET_MATRIX.csv) | Manufacturer parts checked against datasheets; battery pack still open |
| [Mounting template](outputs/P4-MOUNTING-TEMPLATE-1TO1.pdf) / [mechanical evidence](MECHANICAL.md) | Print at 100 %; stack and enclosure still unqualified |
| [Printed labels](outputs/A02-PRINTED-LABELS.json) / [assembly references](outputs/A02-ASSEMBLY-LABELS.json) / [unplaced references](outputs/A02-ASSEMBLY-LABELS-UNFINISHED.json) | Label positions; parts without a clear, unambiguous silk position beside the part |
| [Silk text check](outputs/A02-SILK-TEXT.json) | `check_silk_text.py`: text over text, pads, part bodies or silk graphics, crowded or ambiguous references, reading direction |

**Routing status, 3 October 2026:** every connection is routed. Native DRC (zones refilled, schematic parity on) reports no violations of any kind and no unconnected items; ERC reports none; `verify.py --a02` passes against a freshly exported netlist. The count fell from 182 open at the 30 September review, through 75 after the camera GPIO template and 41 after the expander and I2C work, to 0. 553 vias; 2314 track segments (F 773, In2 395, B 1146). `chamfer_a02_corners.py` took the right-angle bends the audit counts from 59 to 5; the five left are 0.1 mm wobbles inside 0.5-0.8 mm wide copper (SYS_5V and CHG_VBUS beside their vias, three Kelvin tap blobs on CAM1/CAM2_SHUNT_OUT) with no exposed corner. For review: CAM2_FAULT_N passes between the pads of R603 and of C701 (0603, 0.27 and 0.18 mm clear), CAM2_3V3 takes a long detour south of U300 (0.25 mm, router), and CAM_GLOBAL_EN and BOOST_ENABLE are long In2 runs (slow enables). The SYNC bus now runs at the buffers (In2, y 41.05) instead of across the top of the camera row, camera EN/FAULT_N use In2 lanes north of the headers, and U600 is turned 180 degrees. SYS_5V (3 October 2026) is routed as a tree: a 0.7 mm F trunk along y 19.4 over the four shunts (F, because the P4 bus already walls that band on F; In2 stays free for the header-to-socket GPIO to cross it), a 2.0 mm In2 riser between cameras 2 and 3 fed from Q1201 and, through a 1.4 mm In2 link, from D1200, three vias at every layer change, and branches to U1201 and J600. U700 (PAC1954) now sits on the front between the camera 2 and 3 headers, with Kelvin pairs from all four shunts. Figures in [A02-REVIEW.md](A02-REVIEW.md) predate this pass.

Prototype references are on silkscreen (ODD JOBS rule 177) beside their own part: 0.15 mm clear of part outlines, 0.5 mm from other silk text, horizontal text left to right and vertical text bottom to top from its own side (rule 91), 1.0 mm text or 0.8 mm in dense areas. A spot more than 0.5 mm nearer another part is not used. On 3 October 2026, 220 of 248 references are on silk; no text overlaps another text, a pad, a part body or a silk graphic, and 12 labels sit marginally (at most 0.46 mm) nearer a neighbour. The other 28, in the camera and charger clusters, stay on Fab at the part centre and are listed in the unplaced file; they need part spacing, not smaller text. Connector, camera and product labels use 1.0 mm text with a 0.15 mm stroke.

## Circuitry

- **Cameras:** four socketed XIAO ESP32-S3 Sense boards with UART/sync isolation buffers, individual current-limited supplies, current monitoring and 0 ohm USB-service power links (JP200-JP500, Vishay CRCW12060000Z0EAHP, desolder before node USB). D8/D9/D10 are shared with the Sense SD interface, and D2 is strap-sensitive.
- **P4 link:** the 26-pin P4 connection is a keyed IDC **cable** interface, kept until Guition supplies a JP1 datum for a board-to-board mate. The UART/sync/shutter header map is unchanged; GPIO35/JP1-15 stays unconnected.
- **Power:** USB-C PD sink (STUSB4500), 1S charger (BQ25798), fuel gauge (BQ27441-G1), 5 V boost (TPS61288), 3.3 V buck and a hardware power controller.
  - The charger charges whenever VBUS is valid (CE low), inside a 1-60 °C window set by the pack's 103AT-2 thermistor.
  - The gauge shunt is high side, with SRP on the pack side and SRN on the system side.
  - Input current is clamped to 0.15-0.41 A until firmware reads the PD contract.
  - The charger's STAT pin is left open and there is no charge LED (STAT has no layout path out of the charger's power copper). Firmware reads the charge state from the BQ25798 status registers over I2C. The green power LED D1300 stays.
- **Pack entry:** J1100 (JST VH, `- NTC +`) sits on the bottom edge beside the charger. From the pack, F1100 (7 A) and RS700 (5 mΩ) form a 12 mm chain on the front.
- **Sensors and controls:** IMU, backed-up RTC, board-temperature sensor, remote shutter, cover sensor, function button, haptic driver and expansion/service connectors.
- **Power links:** JP200-JP500 and JP1200 are 0 ohm links on the front (CRCW1206-HP, 10 A), replacing the 2.54 mm headers and shunts: flat, reachable with the carrier on the P4, rated for the current. Desolder to open.
- **Test field:** J600 is an asymmetric 12-pad **sense/test** field, not a power-injection connector. Do not drive the enable nodes against the expander. Pads 9-11 are unconnected: CAM2_EN, CAM3_EN and CAM4_EN are probed at front lands TP600-TP602 beside their lines at the top of the board (CAM1_EN stays on pad 8). TP100 (P4 3V3 test) is a front land beside J100 pin 1.
- **Expander map:** U600 (TCA9539) port 1, P1.0-P1.7 (pins 13-20): IMU_INT, RTC_INT_N, SOFT_KILL, unused, POWER_INT_N, FN_N, HAPTIC_EN, COVER_N. P1.3 is not connected; configure it as an input. Firmware must follow this map.
- **Flash provision:** J601/R605 are DNP provisions for an **external flash driver**. There is no FLASH_EN GPIO or flash-energy supply.

I2C addresses: PAC1954 0x10, STUSB4500 0x28, TMP117 0x48, RV-3028 0x52, BQ27441 0x55, DRV2605L 0x5A, LSM6DSOX 0x6A, BQ25798 0x6B, TCA9539 0x74. P4 touch at 0x5D stays on the host side of the buffer. Existing firmware does not start the carrier's power controls, charger policy or gauge calibration.

## Manufacturing and assembly status

Provisional process: four layers, 1.6 mm, **1 oz outer and 1 oz inner copper** (the In2 boost feed needs it), black mask, white silk, ENIG, JLCPCB target. No Gerber, drill or placement files are released. Battery selection, retention and the assembled body are not built or verified. The XAL7070 boost inductor (7.0 mm) and the JST VH connector set the tallest parts; the stack-height map is open.

The XIAOs use external antennas. Their antenna and cable clearance must be defined in the enclosure. Keep the P4 battery connector unused. USB/P4/carrier source coexistence still needs measurement; the removable power links are service provisions, not automatic backfeed protection.

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

Implementation stays in [issue #232](https://github.com/b5463/kino-d4/issues/232) and [ECN-0007](../../changes/ECN-0007-four-xiao-carrier-proposal.md), design package 0.1.8. It is not a new physical release.

The supplied ODD JOBS symbol and its traced contour remain reserved artwork, separate from CERN-OHL-S-2.0 hardware source. Stock KiCad footprints use the library electronic-design exception. Vendor design files are consulted, not redistributed. [Sources](SOURCES.md) records provenance. [A0.1 review](RELEASE-REVIEW.md) is kept as historical rejection evidence.
