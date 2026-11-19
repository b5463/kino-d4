# Dev carrier D1 pre-build verification

88 of 88 checks pass.

| Check | Result | Detail |
|---|---|---|
| every net reaches two pads | pass | 69 nets |
| ideal diode U201: switch in, link out, CE on VOUT | pass |  |
| TPS2553 U200 wiring | pass |  |
| node 1 link, measure link and socket 5 V in series | pass |  |
| node 1 UART crossed and series-protected | pass |  |
| ideal diode U301: switch in, link out, CE on VOUT | pass |  |
| TPS2553 U300 wiring | pass |  |
| node 2 link, measure link and socket 5 V in series | pass |  |
| node 2 UART crossed and series-protected | pass |  |
| ideal diode U401: switch in, link out, CE on VOUT | pass |  |
| TPS2553 U400 wiring | pass |  |
| node 3 link, measure link and socket 5 V in series | pass |  |
| node 3 UART crossed and series-protected | pass |  |
| ideal diode U501: switch in, link out, CE on VOUT | pass |  |
| TPS2553 U500 wiring | pass |  |
| node 4 link, measure link and socket 5 V in series | pass |  |
| node 4 UART crossed and series-protected | pass |  |
| LED D1000 polarity | pass | K=GND A=5V_IN_LED |
| LED D1001 polarity | pass | K=CAM_EN_LED A=CAM_PWR_EN |
| LED D1002 polarity | pass | K=FAULT_N A=FAULT_LED |
| TVS D1003 polarity: cathode (pin 1) on the rail, anode on GND | pass | K=5V_IN A=GND |
| FAULT_N has exactly one pull-up (the FLT LED chain) | pass |  |
| ideal diode U1001: rail in, P4 5 V out, CE on VOUT | pass |  |
| no other path from the rail to P4_5V | pass | C1004.1, J100.2, J100.4, TP111.1, U1001.3, U1001.6 |
| USB-C VBUS: clamp, fuse, then the bridge and the module connector | pass |  |
| VBUS ideal diode toward the module: LM74700 anode on VBUS_F, cathode on J1001, EN on anode, N-FET S/D/G | pass |  |
| Q1000 gate rating covers the LM74700 drive (13.9 V max): a 20 V-gate part | pass |  |
| CC pull-downs 5.1k and clamped | pass |  |
| camera bank held off from reset, against the 45k internal pull-up | pass |  |
| sync held low from reset | pass |  |
| shutter socket pulls SHUTTER_N to GND | pass |  |
| Qwiic pinout GND 3V3 SDA SCL | pass |  |
| Qwiic pull-ups are DNP | pass |  |
| J100 matches the measured JP1 table (26 pins) | pass | 26 pins agree |
| J100 socket on the back draws JP1 pin for pin (1 on the datum, 2 right, 3 down) | pass | pin 1 at (101.38, 19.47) on the P4 face, pin 2 at +2.54 x, pin 26 at +2.54 x +30.48 y |
| XIAO socket J200: D1 sync, D6 TX, D7 RX, 3V3/GND/5V | pass |  |
| XIAO socket J300: D1 sync, D6 TX, D7 RX, 3V3/GND/5V | pass |  |
| XIAO socket J400: D1 sync, D6 TX, D7 RX, 3V3/GND/5V | pass |  |
| XIAO socket J500: D1 sync, D6 TX, D7 RX, 3V3/GND/5V | pass |  |
| bus-net vias doubled (3 A path) | pass | 26 vias, all paired or on a test-pad or clamp branch |
| node-net single vias carry one node only | pass | 2 single: CAM2_5V (41.1,36.6); CAM1_5VJ (18.3,34.0) |
| 5V_IN at 1.0 mm end to end | pass | 321 mm, 162.8 mohm |
| P4_5V at 1.0 mm end to end | pass | 42 mm, 22.4 mohm |
| VBUS_F at 1.0 mm end to end | pass | 42 mm, 26.9 mohm |
| VBUS_M at 1.0 mm end to end | pass | 58 mm, 40.8 mohm |
| VBUS at 0.6 mm end to end | pass | 24 mm, 19.6 mohm |
| CAM1_SW5V at 0.6 mm end to end | pass | 8 mm, 7.9 mohm |
| CAM1_LINK at 0.6 mm end to end | pass | 26 mm, 22.4 mohm |
| CAM1_5VJ at 0.6 mm end to end | pass | 41 mm, 33.1 mohm |
| CAM1_5V at 0.6 mm end to end | pass | 37 mm, 29.9 mohm |
| CAM2_SW5V at 0.6 mm end to end | pass | 8 mm, 7.9 mohm |
| CAM2_LINK at 0.6 mm end to end | pass | 29 mm, 24.7 mohm |
| CAM2_5VJ at 0.6 mm end to end | pass | 50 mm, 40.4 mohm |
| CAM2_5V at 0.6 mm end to end | pass | 44 mm, 36.0 mohm |
| CAM3_SW5V at 0.6 mm end to end | pass | 8 mm, 7.9 mohm |
| CAM3_LINK at 0.6 mm end to end | pass | 26 mm, 22.4 mohm |
| CAM3_5VJ at 0.6 mm end to end | pass | 43 mm, 35.1 mohm |
| CAM3_5V at 0.6 mm end to end | pass | 37 mm, 29.9 mohm |
| CAM4_SW5V at 0.6 mm end to end | pass | 8 mm, 7.9 mohm |
| CAM4_LINK at 0.6 mm end to end | pass | 27 mm, 23.0 mohm |
| CAM4_5VJ at 0.6 mm end to end | pass | 42 mm, 34.6 mohm |
| CAM4_5V at 0.6 mm end to end | pass | 36 mm, 29.8 mohm |
| nothing but silk inside the 7 mm fastener allowance | pass | 4 holes clear |
| tallest part on the P4 face recorded | pass | 8.5 mm (J100 socket: it sets the 11.0 mm stack with the header base); next J102 at 4.3 mm |
| C10758 SMAJ5.0A | pass | expand, stock 11585, recorded extended |
| C14663 100n | pass | base, stock 53996787, recorded basic |
| C15849 1u | pass | base, stock 12070074, recorded basic |
| C160404 QWIIC 3V3 I2C | pass | expand, stock 9299, recorded extended |
| C21189 0R | pass | base, stock 15892661, recorded basic |
| C21190 1k | pass | base, stock 30430701, recorded basic |
| C2286 LED red | pass | base, stock 8585080, recorded basic |
| C2297 LED green | pass | base, stock 3067462, recorded basic |
| C23162 4.7k | pass | base, stock 15764677, recorded basic |
| C23179 470R | pass | base, stock 4182947, recorded basic |
| C23186 5.1k | pass | base, stock 18623883, recorded basic |
| C23352 24k | pass | base, stock 669317, recorded basic |
| C2869734 LM66100DCKR | pass | expand, stock 27638, recorded extended |
| C2941042 LM74700QDBVRQ1 | pass | expand, stock 9514, recorded extended |
| C3020560 USB-C 5V | pass | expand, stock 13345, recorded extended |
| C4190 2.2k | pass | base, stock 4225613, recorded basic |
| C45783 22u | pass | base, stock 3632851, recorded basic |
| C55266 TPS2553DBVR | pass | expand, stock 44384, recorded extended |
| C67272 IRLML0030TRPBF | pass | expand, stock 59977, recorded extended |
| C7519 USBLC6-2SC6 | pass | expand, stock 29992, recorded extended |
| gerber layers and drill present | pass | .csv, .drl, .gbl, .gbo, .gbp, .gbr, .gbrjob, .gbs, .gm1, .gtl, .gto, .gtp, .gts, .txt |
| CPL lists every SMT part once and nothing else | pass | 70 rows |
| BOM designators equal the CPL | pass | 70 designators |
| all SMT on the bottom face | pass |  |

## Copper per power net

| Net | Track length | Resistance (1 oz) |
|---|---:|---:|
| 5V_IN | 321 mm | 162.8 mohm |
| P4_5V | 42 mm | 22.4 mohm |
| VBUS_F | 42 mm | 26.9 mohm |
| VBUS_M | 58 mm | 40.8 mohm |
| VBUS | 24 mm | 19.6 mohm |
| CAM1_SW5V | 8 mm | 7.9 mohm |
| CAM1_LINK | 26 mm | 22.4 mohm |
| CAM1_5VJ | 41 mm | 33.1 mohm |
| CAM1_5V | 37 mm | 29.9 mohm |
| CAM2_SW5V | 8 mm | 7.9 mohm |
| CAM2_LINK | 29 mm | 24.7 mohm |
| CAM2_5VJ | 50 mm | 40.4 mohm |
| CAM2_5V | 44 mm | 36.0 mohm |
| CAM3_SW5V | 8 mm | 7.9 mohm |
| CAM3_LINK | 26 mm | 22.4 mohm |
| CAM3_5VJ | 43 mm | 35.1 mohm |
| CAM3_5V | 37 mm | 29.9 mohm |
| CAM4_SW5V | 8 mm | 7.9 mohm |
| CAM4_LINK | 27 mm | 23.0 mohm |
| CAM4_5VJ | 42 mm | 34.6 mohm |
| CAM4_5V | 36 mm | 29.8 mohm |
