# Dev carrier D1 pre-build verification

82 of 82 checks pass.

| Check | Result | Detail |
|---|---|---|
| every net reaches two pads | pass | 66 nets |
| SS34 D200 blocks node USB from the bank | pass | K=CAM1_LINK A=CAM1_SW5V |
| TPS2553 U200 wiring | pass |  |
| node 1 link, measure link and socket 5 V in series | pass |  |
| node 1 UART crossed and series-protected | pass |  |
| SS34 D300 blocks node USB from the bank | pass | K=CAM2_LINK A=CAM2_SW5V |
| TPS2553 U300 wiring | pass |  |
| node 2 link, measure link and socket 5 V in series | pass |  |
| node 2 UART crossed and series-protected | pass |  |
| SS34 D400 blocks node USB from the bank | pass | K=CAM3_LINK A=CAM3_SW5V |
| TPS2553 U400 wiring | pass |  |
| node 3 link, measure link and socket 5 V in series | pass |  |
| node 3 UART crossed and series-protected | pass |  |
| SS34 D500 blocks node USB from the bank | pass | K=CAM4_LINK A=CAM4_SW5V |
| TPS2553 U500 wiring | pass |  |
| node 4 link, measure link and socket 5 V in series | pass |  |
| node 4 UART crossed and series-protected | pass |  |
| LED D1000 polarity | pass | K=GND A=5V_IN_LED |
| LED D1001 polarity | pass | K=CAM_EN_LED A=CAM_PWR_EN |
| LED D1002 polarity | pass | K=FAULT_N A=FAULT_LED |
| FAULT_N has exactly one pull-up (the FLT LED chain) | pass |  |
| ideal diode U1001: rail in, P4 5 V out, CE on VOUT | pass |  |
| no other path from the rail to P4_5V | pass | C1004.1, J100.2, J100.4, TP101.1, U1001.3, U1001.6 |
| USB-C VBUS: clamp, fuse, then the bridge and the module connector | pass |  |
| CC pull-downs 5.1k and clamped | pass |  |
| camera bank held off from reset, against the 45k internal pull-up | pass |  |
| sync held low from reset | pass |  |
| shutter socket pulls SHUTTER_N to GND | pass |  |
| Qwiic pinout GND 3V3 SDA SCL | pass |  |
| Qwiic pull-ups are DNP | pass |  |
| J100 matches the measured JP1 table (26 pins) | pass | 26 pins agree |
| XIAO socket J200: D1 sync, D6 TX, D7 RX, 3V3/GND/5V | pass |  |
| XIAO socket J300: D1 sync, D6 TX, D7 RX, 3V3/GND/5V | pass |  |
| XIAO socket J400: D1 sync, D6 TX, D7 RX, 3V3/GND/5V | pass |  |
| XIAO socket J500: D1 sync, D6 TX, D7 RX, 3V3/GND/5V | pass |  |
| bus-net vias doubled (3 A path) | pass | 16 vias, all paired or on a test-pad or clamp branch |
| node-net single vias carry one node only | pass | 9 single: CAM3_5V (71.1,36.4); CAM4_LINK (96.3,26.8); CAM4_LINK (90.9,30.2); CAM4_5VJ (94.7,45.8); CAM3_LINK (69.6,30.1); CAM3_LINK (72.0,27.2); CAM1_LINK (23.5,30.8); CAM1_5VJ (30.4,44.4); VBUS (110.2,55.3) |
| 5V_IN at 1.0 mm end to end | pass | 224 mm, 116.1 mohm |
| P4_5V at 1.0 mm end to end | pass | 72 mm, 36.1 mohm |
| VBUS_F at 1.0 mm end to end | pass | 31 mm, 15.1 mohm |
| VBUS at 0.6 mm end to end | pass | 28 mm, 23.0 mohm |
| CAM1_SW5V at 0.6 mm end to end | pass | 4 mm, 3.4 mohm |
| CAM1_LINK at 0.6 mm end to end | pass | 23 mm, 18.7 mohm |
| CAM1_5VJ at 0.6 mm end to end | pass | 45 mm, 36.4 mohm |
| CAM1_5V at 0.6 mm end to end | pass | 34 mm, 28.1 mohm |
| CAM2_SW5V at 0.6 mm end to end | pass | 4 mm, 3.4 mohm |
| CAM2_LINK at 0.6 mm end to end | pass | 25 mm, 20.8 mohm |
| CAM2_5VJ at 0.6 mm end to end | pass | 43 mm, 34.7 mohm |
| CAM2_5V at 0.6 mm end to end | pass | 38 mm, 31.3 mohm |
| CAM3_SW5V at 0.6 mm end to end | pass | 4 mm, 3.4 mohm |
| CAM3_LINK at 0.6 mm end to end | pass | 19 mm, 15.6 mohm |
| CAM3_5VJ at 0.6 mm end to end | pass | 40 mm, 32.3 mohm |
| CAM3_5V at 0.6 mm end to end | pass | 35 mm, 28.3 mohm |
| CAM4_SW5V at 0.6 mm end to end | pass | 4 mm, 3.4 mohm |
| CAM4_LINK at 0.6 mm end to end | pass | 19 mm, 15.7 mohm |
| CAM4_5VJ at 0.6 mm end to end | pass | 37 mm, 30.6 mohm |
| CAM4_5V at 0.6 mm end to end | pass | 53 mm, 43.4 mohm |
| nothing but silk inside the 7 mm fastener allowance | pass | 4 holes clear |
| tallest part on the P4 face recorded | pass | 4.3 mm (J102 Qwiic); J100 is on the top face, only the P4-side ribbon plug is in the gap |
| C10758 SMAJ5.0A | pass | expand, stock 12272, recorded extended |
| C14663 100n | pass | base, stock 34009617, recorded basic |
| C15849 1u | pass | base, stock 12930812, recorded basic |
| C160404 QWIIC 3V3 I2C | pass | expand, stock 55364, recorded extended |
| C21189 0R | pass | base, stock 19074692, recorded basic |
| C21190 1k | pass | base, stock 27003448, recorded basic |
| C2286 LED red | pass | base, stock 6578671, recorded basic |
| C2297 LED green | pass | base, stock 1946103, recorded basic |
| C23162 4.7k | pass | base, stock 15972490, recorded basic |
| C23179 470R | pass | base, stock 4118487, recorded basic |
| C23186 5.1k | pass | base, stock 20323618, recorded basic |
| C23352 24k | pass | base, stock 587574, recorded basic |
| C2869734 LM66100DCKR | pass | expand, stock 6857, recorded extended |
| C3020560 USB-C 5V | pass | expand, stock 19112, recorded extended |
| C4190 2.2k | pass | base, stock 5080252, recorded basic |
| C45783 22u | pass | base, stock 3545378, recorded basic |
| C55266 TPS2553DBVR | pass | expand, stock 57688, recorded extended |
| C7519 USBLC6-2SC6 | pass | expand, stock 40739, recorded extended |
| C8678 SS34 | pass | base, stock 3042542, recorded basic |
| gerber layers and drill present | pass | .csv, .drl, .gbl, .gbo, .gbp, .gbr, .gbrjob, .gbs, .gm1, .gtl, .gto, .gtp, .gts, .txt |
| CPL lists every SMT part once and nothing else | pass | 61 rows |
| BOM designators equal the CPL | pass | 61 designators |
| all SMT on the bottom face | pass |  |

## Copper per power net

| Net | Track length | Resistance (1 oz) |
|---|---:|---:|
| 5V_IN | 224 mm | 116.1 mohm |
| P4_5V | 72 mm | 36.1 mohm |
| VBUS_F | 31 mm | 15.1 mohm |
| VBUS | 28 mm | 23.0 mohm |
| CAM1_SW5V | 4 mm | 3.4 mohm |
| CAM1_LINK | 23 mm | 18.7 mohm |
| CAM1_5VJ | 45 mm | 36.4 mohm |
| CAM1_5V | 34 mm | 28.1 mohm |
| CAM2_SW5V | 4 mm | 3.4 mohm |
| CAM2_LINK | 25 mm | 20.8 mohm |
| CAM2_5VJ | 43 mm | 34.7 mohm |
| CAM2_5V | 38 mm | 31.3 mohm |
| CAM3_SW5V | 4 mm | 3.4 mohm |
| CAM3_LINK | 19 mm | 15.6 mohm |
| CAM3_5VJ | 40 mm | 32.3 mohm |
| CAM3_5V | 35 mm | 28.3 mohm |
| CAM4_SW5V | 4 mm | 3.4 mohm |
| CAM4_LINK | 19 mm | 15.7 mohm |
| CAM4_5VJ | 37 mm | 30.6 mohm |
| CAM4_5V | 53 mm | 43.4 mohm |
