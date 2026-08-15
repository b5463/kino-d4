# Sources and verification notes

## Guition JC4880P443C-I-W
Manufacturer: https://www.guition.com/esp32p4-display-module/esp32p4-display

Public manufacturer specifications used: 4.3-inch IPS, 480×800, ESP32-P4 + ESP32-C6, 32 MB PSRAM, 16 MB flash, active area 93.60×56.16 mm, module envelope 117.01×69.41 mm, 5 V, approx. 320 mA.

A separate public manual reports a board envelope around 114.40×66.80 mm. The spec intentionally treats this as a conflict and requires physical measurement before final CAD.

## Seeed Studio XIAO ESP32-S3 Sense
Official wiki: https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/

Used specifications: 21×17.8×15 mm with Sense expansion board, ESP32-S3 up to 240 MHz, 8 MB PSRAM, 8 MB flash, OV3660, OV5640 compatibility, official mechanical CAD/DXF resources.

## SW6106
Chip datasheet: https://files.waveshare.com/wiki/common/SW6106%20Datasheet.pdf

SW6106 supports an 18 W class bidirectional power-bank architecture. Exact PCB dimensions/configuration depend on the purchased carrier and must be measured.

## Owner/seller supplied battery data
505573 3000 mAh 1S LiPo seller response supplied in this project:
- stock 24 AWG + PH2.0-3P harness safe sustained current ≤3 A;
- very short peak up to 6 A;
- recommended charging current 600 mA;
- maximum charging current 1500 mA;
- NTC lead 26–28 AWG.

These battery values supersede earlier assumptions.
