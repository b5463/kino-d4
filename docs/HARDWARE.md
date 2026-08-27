# KINO D4 V1 hardware

KINO D4 is a five-controller camera: one ESP32-P4 main unit and four ESP32-S3 camera nodes. The main unit owns the display, storage, controls, flash, power supervision, USB connection, and coordination. Each camera node owns one image sensor and its local capture work.

This page is a build snapshot. It separates verified component facts from measurements the finished enclosure still needs.

## Confidence labels

| Label | Meaning |
|---|---|
| `MEASURED` | Taken from the exact physical part with calipers or test equipment |
| `OFFICIAL_CAD` | Taken from a manufacturer CAD file |
| `OFFICIAL_SPEC` | Taken from a manufacturer drawing or data table |
| `SELLER_SPEC` | Supplied for the exact purchased part or listing |
| `PROVISIONAL` | A design estimate that still needs measurement |
| `CONFLICT` | Trustworthy sources disagree |

For enclosure work, prefer `MEASURED`, then `OFFICIAL_CAD`, `OFFICIAL_SPEC`, and `SELLER_SPEC`. Treat every `PROVISIONAL` or `CONFLICT` value as unfinished.

## Electrical shape

```mermaid
flowchart TD
    BAT["505573 LiPo\n1S, 3000 mAh"] --> FUSE["F3A fuse"]
    FUSE --> BMS["1S protection board"]
    BMS --> BOOST["SW6106 charger / boost"]
    BOOST --> RAIL["5 V main rail"]
    RAIL --> P4["ESP32-P4 display module"]
    RAIL --> FLASH["constant-current flash driver"]
    RAIL --> SW["4-channel camera power switch bank"]
    SW --> C1["XIAO S3 + OV3660\nCAM1"]
    SW --> C2["XIAO S3 + OV3660\nCAM2"]
    SW --> C3["XIAO S3 + OV3660\nCAM3"]
    SW --> C4["XIAO S3 + OV3660\nCAM4"]
    P4 <-->|"UART + shared sync"| C1
    P4 <-->|"UART + shared sync"| C2
    P4 <-->|"UART + shared sync"| C3
    P4 <-->|"UART + shared sync"| C4
```

## Main controller and display

The current main module is the Guition `JC4880P443C-I-W`.

| Property | Value | Confidence |
|---|---:|---|
| Processors | ESP32-P4 + ESP32-C6 | `OFFICIAL_SPEC` |
| P4 clock | Up to 360 MHz, dual core | `OFFICIAL_SPEC` |
| Display | 4.3-inch IPS capacitive touch | `OFFICIAL_SPEC` |
| Resolution | 480 × 800 | `OFFICIAL_SPEC` |
| PSRAM | 32 MB | `OFFICIAL_SPEC` |
| Flash | 16 MB | `OFFICIAL_SPEC` |
| Active display area | 93.60 × 56.16 mm | `OFFICIAL_SPEC` |
| Supply | 5 V | `OFFICIAL_SPEC` |
| Reported module draw | About 320 mA | `OFFICIAL_SPEC` |
| Module envelope | 117.01 × 69.41 mm | `CONFLICT` |
| Alternate board envelope | About 114.40 × 66.80 mm | `CONFLICT` |

Measure the purchased board before locking the rear enclosure. Preserve access to both USB-C ports, the TF/microSD slot, speaker and battery connectors, the 2×13 header, and the UART/I2C connectors.

## Camera row

D4 uses four Seeed Studio XIAO ESP32-S3 Sense boards with their Sense expansion boards.

| Property | Per camera node |
|---|---|
| Board envelope | 21.0 × 17.8 × 15.0 mm, `OFFICIAL_SPEC` |
| Processor | ESP32-S3, up to 240 MHz |
| Memory | 8 MB PSRAM, 8 MB flash |
| Sensor | OV3660 (current prototype) |
| Maximum resolution | 2048 × 1536, about 3 MP |
| Planned sensor upgrade | OV5640 with VCM autofocus, 2592 × 1944, 24-pin DVP, MJY5OAF-F3M-V1-compatible module, AFVDD 2.8 V — `PROVISIONAL` until modules are benched |
| Shutter | Rolling, free-running |
| Link to main controller | Full-duplex UART |
| Sync | One separate shared trigger wire |

The four lenses sit on one rigid camera bar. Current pitch is adjustable from 20 to 24 mm with a 22 mm default. At 22 mm, provisional lens-center positions are `-33`, `-11`, `+11`, and `+33 mm` from the body center.

The field of view is still `MEASURE_REQUIRED`. OV3660 names the sensor. The lens and module determine the field of view.

## P4 header and provisional pin assignments

The 2×13 header, top to bottom. `PROVISIONAL` throughout: every KINO assignment below must be electrically validated on the physical board before firmware locks it (GitHub issue #2).

| Left | Right | KINO assignment |
|---|---|---|
| 3V3 | 5V | — |
| 3V3 | 5V | — |
| GND | GND | — |
| GPIO52 | GPIO33 | CAM1 TX · CAM3 RX |
| GPIO51 | GPIO31 | CAM1 RX · CAM_PWR_EN |
| GPIO50 | GPIO30 | CAM2 TX · CAM4 TX |
| GPIO49 | GPIO29 | CAM2 RX · CAM4 RX |
| GPIO35 | GND | unused (spare) |
| GPIO34 | ESP_3V3 | CAM3 TX · reserved |
| GPIO32 | C6_U0RXD | SYNC_TRIGGER · reserved |
| GPIO28 | C6_U0TXD | FLASH_EN · reserved |
| I2C_SDA | C6_IO9 | — · reserved |
| I2C_SCL | C6_CHIP_PU | — · reserved |

`ESP_3V3`, `C6_U0RXD`, `C6_U0TXD`, `C6_IO9`, and `C6_CHIP_PU` belong to the C6 and must not be repurposed. The per-camera power-switch control pins are unassigned; §Camera power switching describes the channel hardware, and whether channels hang off `CAM_PWR_EN` alone or get individual pins is `NEEDS_HARDWARE_VALIDATION`. Button and mode-slide pins are unassigned. The same map lives machine-readable in `packages/hardware-profiles/src/profiles/d4-v1.json` (`gpio`, `header2x13`).

The four `C6_*` pins on that header are the C6's **console and programming** path, not its data transport. They are how a C6 gets flashed and recovered; the transport is a separate SDIO bus that does not appear on the header at all. See below.

## The two SDMMC buses

The P4 has one SDMMC controller with two slots (`SOC_SDMMC_NUM_SLOTS 2`). Both are in use, and they carry different things:

```text
SD CARD BUS        GPIO39  GPIO40  GPIO41  GPIO42  GPIO43  GPIO44
                   D0      D1      D2      D3      CLK     CMD
                   -> SDMMC slot 0, IOMUX-fixed pads, 4-bit

C6 RADIO BUS       GPIO14  GPIO15  GPIO16  GPIO17  GPIO18  GPIO19   + GPIO54
                   D0      D1      D2      D3      CLK     CMD        EN
                   -> SDMMC slot 1, GPIO-matrix routed, 4-bit
```

No pin is shared, and the slot allocation matters as much as the pins: slot 0's pads are fixed in silicon to exactly the six the card uses (`soc/esp32p4/include/soc/sdmmc_pins.h`), and slot 1 has no IOMUX path at all, which is why the radio takes the matrix-routed slot. Espressif ship this exact arrangement as `esp_hosted`'s `mcu_hosted_sdio_sdmmc_combined` example.

| Group | Status |
|---|---|
| SD card, GPIO39–44 | **VALIDATED** — 29820 MB mounted 4-bit on our unit, 2026-08-26. These are the chip's dedicated SD pads, so the map is confirmed by the silicon as well as by the mount |
| C6 radio, GPIO14–19 + GPIO54 | `PROVISIONAL` — identified from Guition documentation for this carrier and corroborated pin-for-pin by Espressif's own ESP-Hosted defaults for a P4 host with a C6 coprocessor. **No pin has been driven.** Polarity of `GPIO54` (the C6's `CHIP_PU` enable) is unconfirmed |

`GPIO54` is an **enable**, not a reset request: LOW holds the C6 off, HIGH releases it. Firmware names it `BOARD_C6_EN` for that reason.

Transport: ESP-Hosted with `esp_wifi_remote` over 4-bit SDIO. Full evidence chain, what is still unknown, and the bring-up order: [`firmware/C6_HARDWARE_MAP.md`](../firmware/C6_HARDWARE_MAP.md) and [`firmware/C6_BRINGUP.md`](../firmware/C6_BRINGUP.md).

## XIAO camera interface

The XIAO ESP32-S3 Sense DVP camera pins, `OFFICIAL_SPEC` from the Seeed wiki. The planned OV5640 autofocus module (MJY5OAF-F3M-V1-compatible, 24-pin DVP) must match this interface; its AFVDD rail is 2.8 V, not 3.3 V.

| Signal | Pin | Signal | Pin |
|---|---|---|---|
| XMCLK | GPIO10 | DVP_Y5 | GPIO16 |
| DVP_Y8 | GPIO11 | DVP_Y3 | GPIO17 |
| DVP_Y7 | GPIO12 | DVP_Y4 | GPIO18 |
| PCLK | GPIO13 | VSYNC | GPIO38 |
| DVP_Y6 | GPIO14 | CAM_SCL | GPIO39 |
| DVP_Y2 | GPIO15 | CAM_SDA | GPIO40 |
| HREF | GPIO47 | DVP_Y9 | GPIO48 |

## Timing and synchronization

The sensors run freely and expose with a rolling shutter. The shared trigger improves coordination but cannot certify exposure alignment by itself.

KDP keeps three values separate:

1. `gpioTriggerSkewUs`: distribution and handling of the shared edge.
2. `vsyncPhaseSkewUs`: sensor frame-phase separation.
3. `effectiveExposureSkewUs`: the best measurement or estimate of scene exposure separation.

The 100 to 400 µs figure is a trigger-distribution target. It is not a guaranteed exposure result. Firmware returns `null` and a reason when a timing value cannot be measured. Studio must preserve that uncertainty.

Host-side grading for effective exposure spread uses these bands:

| Spread | Grade |
|---:|---|
| Under 0.5 ms | Excellent |
| 0.5 to 1 ms | Very good |
| 1 to 2 ms | Good target |
| 2 to 5 ms | Warning |
| 5 to 10 ms | Poor for moving subjects |
| Over 10 ms | Fails the intended synchronized use |

## Battery and power

The current battery is a `505573` 1S LiPo rated at 3.7 V, 3000 mAh, and 11.1 Wh. The size-code proxy is roughly 5 × 55 × 73 mm. Measure the actual pouch, folds, lead exit, and foam clearance.

Seller-supplied limits for the fitted harness:

- 24 AWG power leads with a PH2.0-3P connector
- no more than 3 A sustained
- up to 6 A for a very short pulse
- 600 mA preferred charge current
- 1500 mA maximum charge current
- 26 to 28 AWG NTC lead

The 1S protection board is sold as 10 A. That number does not raise the camera's system rating. The battery harness remains the tighter sustained-current limit.

An F3A fast axial fuse sits near battery positive. The SW6106 carrier supplies the 5 V rail and supports an 18 W-class power-bank design. The exact purchased carrier is roughly 28 × 28 mm and about 11.36 mm high according to seller data. Measure it before final CAD.

## Camera power switching

Each camera has an independent high-side switch channel:

```text
P4 CAM_PWR GPIO high
  → 2N3904 on
  → P-channel MOSFET gate low
  → camera 5 V on
```

Current parts per channel:

- AO4407 or AO4407A P-channel MOSFET on a SOP8-to-DIP8 adapter
- 2N3904 NPN transistor
- 4.7 kΩ base resistor
- 100 kΩ gate pull-up
- 100 kΩ base-to-ground resistor recommended
- 1N5819 series Schottky diode

Bulk and local decoupling use 1000 µF 10 V low-ESR electrolytics and 100 nF 50 V ceramics.

## Flash, sound, storage, and controls

| Assembly | Current part |
|---|---|
| Flash emitter | 3 W CRI90 natural-white LED star, roughly 3.0 to 3.6 V forward voltage |
| Flash drive | Adjustable constant-current driver, 350 mA initial target |
| Flash thermal path | 20 × 20 × 7 mm copper pin-fin heatsink, 0.5 mm thermal pad |
| Flash diffuser | 1 mm opal acrylic |
| Speaker | 8 Ω, 2 W, about 25 × 35 mm face, 1.25 mm 2-pin plug |
| Central storage | SanDisk Ultra microSD, 32 GB |
| Buttons | 6 × 6 × 4.3 mm tactile switches |
| Mode control | MSK-22D14 SPDT slide switch, logic only |

The LED driver may advertise more current. D4 begins at 350 mA. A later 500 mA test depends on measured rail sag and thermal behavior.

## Harnesses

Each camera uses one detachable PH2.0 4-pin harness:

```text
+5 V
GND
P4 TX → XIAO RX
P4 RX ← XIAO TX
```

One separate 28 AWG wire carries shared sync to each node. Main power uses 20 AWG silicone wire. Logic and signal wiring uses 28 AWG. Keep high current off thin perfboard traces.

The main controller connects to its carrier through a 26-pin, 2×13, 2.54 mm female-to-female IDC ribbon about 10 cm long. Keep pin 1 and red-stripe orientation visible. Respect the ribbon bend radius.

## Mechanical snapshot

The provisional enclosure is 126 × 80 × 36 mm. The intended construction uses a black PETG structural skeleton with 2 to 3 mm clear acrylic outer panels, M2 heat-set inserts, and exposed screws. Acrylic acts as skin and window material. It does not carry the camera bar.

The flash sits above the lens row and centers between CAM2 and CAM3. The 4.3-inch display faces out through the rear.

These values guide the digital twin. Physical measurement still decides the enclosure.

## Source trail

- [Twin source notes](../kino_twin_spec/SOURCES.md)
- [Twin component manifest](../kino_twin_spec/component-manifest.json)
- [Full Twin specification](../kino_twin_spec/KINO_TWIN_SIMULATOR_SPEC.md)
- [KDP command contract](../firmware-contract/commands.md)
- [Portable schema contract](../firmware-contract/schemas.md)
- [Platform overview](../kino_dev_spec_pack/01_PLATFORM_OVERVIEW.md)
