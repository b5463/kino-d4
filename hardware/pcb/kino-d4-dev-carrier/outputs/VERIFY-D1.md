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
| shutter: switch and remote both pull SHUTTER_N to GND | pass |  |
| Qwiic pinout GND 3V3 SDA SCL | pass |  |
| Qwiic pull-ups are DNP | pass |  |
| J100 matches the measured JP1 table (26 pins) | pass | 26 pins agree |
| XIAO socket J200: D1 sync, D6 TX, D7 RX, 3V3/GND/5V | pass |  |
| XIAO socket J300: D1 sync, D6 TX, D7 RX, 3V3/GND/5V | pass |  |
| XIAO socket J400: D1 sync, D6 TX, D7 RX, 3V3/GND/5V | pass |  |
| XIAO socket J500: D1 sync, D6 TX, D7 RX, 3V3/GND/5V | pass |  |
| bus-net vias doubled (3 A path) | pass | 15 vias, all paired or on a test-pad branch |
| node-net single vias carry one node only | pass | 5 single: CAM2_5VJ (57.0,24.8); CAM1_LINK (23.5,30.7); CAM4_5V (96.1,28.5); VBUS (114.7,54.7); VBUS (110.2,55.3) |
| 5V_IN at 1.0 mm end to end | pass | 262 mm, 132.2 mohm |
| P4_5V at 1.0 mm end to end | pass | 70 mm, 37.2 mohm |
| VBUS_F at 1.0 mm end to end | pass | 31 mm, 15.1 mohm |
| VBUS at 0.6 mm end to end | pass | 28 mm, 23.0 mohm |
| CAM1_SW5V at 0.6 mm end to end | pass | 4 mm, 3.4 mohm |
| CAM1_LINK at 0.6 mm end to end | pass | 21 mm, 16.8 mohm |
| CAM1_5VJ at 0.6 mm end to end | pass | 47 mm, 38.6 mohm |
| CAM1_5V at 0.6 mm end to end | pass | 55 mm, 44.8 mohm |
| CAM2_SW5V at 0.6 mm end to end | pass | 4 mm, 3.4 mohm |
| CAM2_LINK at 0.6 mm end to end | pass | 24 mm, 19.8 mohm |
| CAM2_5VJ at 0.6 mm end to end | pass | 44 mm, 35.8 mohm |
| CAM2_5V at 0.6 mm end to end | pass | 35 mm, 29.0 mohm |
| CAM3_SW5V at 0.6 mm end to end | pass | 4 mm, 3.4 mohm |
| CAM3_LINK at 0.6 mm end to end | pass | 24 mm, 19.6 mohm |
| CAM3_5VJ at 0.6 mm end to end | pass | 48 mm, 39.6 mohm |
| CAM3_5V at 0.6 mm end to end | pass | 49 mm, 39.7 mohm |
| CAM4_SW5V at 0.6 mm end to end | pass | 4 mm, 3.4 mohm |
| CAM4_LINK at 0.6 mm end to end | pass | 21 mm, 17.2 mohm |
| CAM4_5VJ at 0.6 mm end to end | pass | 43 mm, 34.8 mohm |
| CAM4_5V at 0.6 mm end to end | pass | 35 mm, 28.3 mohm |
| nothing but silk inside the 7 mm fastener allowance | pass | 4 holes clear |
| tallest part on the P4 face recorded | pass | J100 shroud 9.1 mm; a mated IDC plug adds about 6 mm |
| C10758 SMAJ5.0A | pass | expand, stock 12272, recorded extended |
| C14663 100n | pass | base, stock 34012427, recorded basic |
| C15849 1u | pass | base, stock 12931330, recorded basic |
| C160404 QWIIC 3V3 I2C | pass | expand, stock 55369, recorded extended |
| C21189 0R | pass | base, stock 19074914, recorded basic |
| C21190 1k | pass | base, stock 27004177, recorded basic |
| C2286 LED red | pass | base, stock 6579177, recorded basic |
| C2297 LED green | pass | base, stock 1946154, recorded basic |
| C23162 4.7k | pass | base, stock 15972826, recorded basic |
| C23179 470R | pass | base, stock 4118472, recorded basic |
| C23186 5.1k | pass | base, stock 20324158, recorded basic |
| C23352 24k | pass | base, stock 587554, recorded basic |
| C2869734 LM66100DCKR | pass | expand, stock 6857, recorded extended |
| C3020560 USB-C 5V | pass | expand, stock 19112, recorded extended |
| C4190 2.2k | pass | base, stock 5080497, recorded basic |
| C45783 22u | pass | base, stock 3545251, recorded basic |
| C55266 TPS2553DBVR | pass | expand, stock 57725, recorded extended |
| C7519 USBLC6-2SC6 | pass | expand, stock 40770, recorded extended |
| C8678 SS34 | pass | base, stock 3042603, recorded basic |
| gerber layers and drill present | pass | .csv, .drl, .gbl, .gbo, .gbp, .gbr, .gbrjob, .gbs, .gm1, .gtl, .gto, .gtp, .gts, .txt |
| CPL lists every SMT part once and nothing else | pass | 61 rows |
| BOM designators equal the CPL | pass | 61 designators |
| all SMT on the bottom face | pass |  |

## Copper per power net

| Net | Track length | Resistance (1 oz) |
|---|---:|---:|
| 5V_IN | 262 mm | 132.2 mohm |
| P4_5V | 70 mm | 37.2 mohm |
| VBUS_F | 31 mm | 15.1 mohm |
| VBUS | 28 mm | 23.0 mohm |
| CAM1_SW5V | 4 mm | 3.4 mohm |
| CAM1_LINK | 21 mm | 16.8 mohm |
| CAM1_5VJ | 47 mm | 38.6 mohm |
| CAM1_5V | 55 mm | 44.8 mohm |
| CAM2_SW5V | 4 mm | 3.4 mohm |
| CAM2_LINK | 24 mm | 19.8 mohm |
| CAM2_5VJ | 44 mm | 35.8 mohm |
| CAM2_5V | 35 mm | 29.0 mohm |
| CAM3_SW5V | 4 mm | 3.4 mohm |
| CAM3_LINK | 24 mm | 19.6 mohm |
| CAM3_5VJ | 48 mm | 39.6 mohm |
| CAM3_5V | 49 mm | 39.7 mohm |
| CAM4_SW5V | 4 mm | 3.4 mohm |
| CAM4_LINK | 21 mm | 17.2 mohm |
| CAM4_5VJ | 43 mm | 34.8 mohm |
| CAM4_5V | 35 mm | 28.3 mohm |
