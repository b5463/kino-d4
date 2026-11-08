# Dev carrier D1 pre-build verification

85 of 85 checks pass.

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
| FAULT_N has exactly one pull-up (the FLT LED chain) | pass |  |
| ideal diode U1001: rail in, P4 5 V out, CE on VOUT | pass |  |
| no other path from the rail to P4_5V | pass | C1004.1, J100.2, J100.4, TP101.1, TP111.1, U1001.3, U1001.6 |
| USB-C VBUS: clamp, fuse, then the bridge and the module connector | pass |  |
| VBUS ideal diode toward the module: LM74700 anode on VBUS_F, cathode on J1001, EN on anode, N-FET S/D/G | pass |  |
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
| bus-net vias doubled (3 A path) | pass | 33 vias, all paired or on a test-pad or clamp branch |
| node-net single vias carry one node only | pass | 3 single: CAM1_5VJ (30.0,44.7); CAM1_5VJ (35.4,47.3); CAM4_5VJ (96.3,44.5) |
| 5V_IN at 1.0 mm end to end | pass | 309 mm, 158.5 mohm |
| P4_5V at 1.0 mm end to end | pass | 90 mm, 46.9 mohm |
| VBUS_F at 1.0 mm end to end | pass | 43 mm, 23.0 mohm |
| VBUS_M at 1.0 mm end to end | pass | 43 mm, 22.4 mohm |
| VBUS at 0.6 mm end to end | pass | 33 mm, 26.6 mohm |
| CAM1_SW5V at 0.6 mm end to end | pass | 8 mm, 6.9 mohm |
| CAM1_LINK at 0.6 mm end to end | pass | 20 mm, 17.3 mohm |
| CAM1_5VJ at 0.6 mm end to end | pass | 44 mm, 35.9 mohm |
| CAM1_5V at 0.6 mm end to end | pass | 34 mm, 28.1 mohm |
| CAM2_SW5V at 0.6 mm end to end | pass | 8 mm, 6.9 mohm |
| CAM2_LINK at 0.6 mm end to end | pass | 23 mm, 19.4 mohm |
| CAM2_5VJ at 0.6 mm end to end | pass | 44 mm, 36.3 mohm |
| CAM2_5V at 0.6 mm end to end | pass | 35 mm, 28.7 mohm |
| CAM3_SW5V at 0.6 mm end to end | pass | 8 mm, 6.9 mohm |
| CAM3_LINK at 0.6 mm end to end | pass | 25 mm, 21.5 mohm |
| CAM3_5VJ at 0.6 mm end to end | pass | 46 mm, 37.8 mohm |
| CAM3_5V at 0.6 mm end to end | pass | 35 mm, 28.7 mohm |
| CAM4_SW5V at 0.6 mm end to end | pass | 8 mm, 6.9 mohm |
| CAM4_LINK at 0.6 mm end to end | pass | 21 mm, 18.0 mohm |
| CAM4_5VJ at 0.6 mm end to end | pass | 36 mm, 29.8 mohm |
| CAM4_5V at 0.6 mm end to end | pass | 40 mm, 32.4 mohm |
| nothing but silk inside the 7 mm fastener allowance | pass | 4 holes clear |
| tallest part on the P4 face recorded | pass | 4.3 mm (J102 Qwiic); J100 is on the top face, only the P4-side ribbon plug is in the gap |
| C10758 SMAJ5.0A | pass | expand, stock 12272, recorded extended |
| C14663 100n | pass | base, stock 34008217, recorded basic |
| C15849 1u | pass | base, stock 12929696, recorded basic |
| C160404 QWIIC 3V3 I2C | pass | expand, stock 55354, recorded extended |
| C20917 AO3400A | pass | base, stock 1061386, recorded basic |
| C21189 0R | pass | base, stock 19074172, recorded basic |
| C21190 1k | pass | base, stock 27002921, recorded basic |
| C2286 LED red | pass | base, stock 6578475, recorded basic |
| C2297 LED green | pass | base, stock 1946063, recorded basic |
| C23162 4.7k | pass | base, stock 15972429, recorded basic |
| C23179 470R | pass | base, stock 4118262, recorded basic |
| C23186 5.1k | pass | base, stock 20323878, recorded basic |
| C23352 24k | pass | base, stock 587574, recorded basic |
| C2869734 LM66100DCKR | pass | expand, stock 6852, recorded extended |
| C2941042 LM74700QDBVRQ1 | pass | expand, stock 22071, recorded extended |
| C3020560 USB-C 5V | pass | expand, stock 19102, recorded extended |
| C4190 2.2k | pass | base, stock 5080160, recorded basic |
| C45783 22u | pass | base, stock 3544587, recorded basic |
| C55266 TPS2553DBVR | pass | expand, stock 57730, recorded extended |
| C7519 USBLC6-2SC6 | pass | expand, stock 40662, recorded extended |
| gerber layers and drill present | pass | .csv, .drl, .gbl, .gbo, .gbp, .gbr, .gbrjob, .gbs, .gm1, .gtl, .gto, .gtp, .gts, .txt |
| CPL lists every SMT part once and nothing else | pass | 68 rows |
| BOM designators equal the CPL | pass | 68 designators |
| all SMT on the bottom face | pass |  |

## Copper per power net

| Net | Track length | Resistance (1 oz) |
|---|---:|---:|
| 5V_IN | 309 mm | 158.5 mohm |
| P4_5V | 90 mm | 46.9 mohm |
| VBUS_F | 43 mm | 23.0 mohm |
| VBUS_M | 43 mm | 22.4 mohm |
| VBUS | 33 mm | 26.6 mohm |
| CAM1_SW5V | 8 mm | 6.9 mohm |
| CAM1_LINK | 20 mm | 17.3 mohm |
| CAM1_5VJ | 44 mm | 35.9 mohm |
| CAM1_5V | 34 mm | 28.1 mohm |
| CAM2_SW5V | 8 mm | 6.9 mohm |
| CAM2_LINK | 23 mm | 19.4 mohm |
| CAM2_5VJ | 44 mm | 36.3 mohm |
| CAM2_5V | 35 mm | 28.7 mohm |
| CAM3_SW5V | 8 mm | 6.9 mohm |
| CAM3_LINK | 25 mm | 21.5 mohm |
| CAM3_5VJ | 46 mm | 37.8 mohm |
| CAM3_5V | 35 mm | 28.7 mohm |
| CAM4_SW5V | 8 mm | 6.9 mohm |
| CAM4_LINK | 21 mm | 18.0 mohm |
| CAM4_5VJ | 36 mm | 29.8 mohm |
| CAM4_5V | 40 mm | 32.4 mohm |
