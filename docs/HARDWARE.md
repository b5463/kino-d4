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

Measure the purchased board before locking the rear enclosure. Preserve access to both USB-C ports, the TF/microSD slot, speaker and battery connectors, the 2×13 `JP1` header, and the UART/I2C connectors.

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

## P4 header JP1

The carrier's expansion header is `JP1`: 26 pins, 2×13, 2.54 mm pitch. Odd pins are the left column, even pins the right column, pin 1 at the top. This table is the manufacturer PIN DEFINITIONS drawing for the `JC4880P443C-I-W`, **confirmed electrically on our own board** (ECN-0002).

| Pin | Left | Right | Pin |
|---:|---|---|---:|
| 1 | 3V3 | 5V | 2 |
| 3 | 3V3 | 5V | 4 |
| 5 | GND | GND | 6 |
| 7 | GPIO52 | GPIO33 | 8 |
| 9 | GPIO51 | GPIO31 | 10 |
| 11 | GPIO50 | GPIO30 | 12 |
| 13 | GPIO49 | GPIO29 | 14 |
| 15 | GPIO35 | GND | 16 |
| 17 | GPIO34 | ESP_3V3 | 18 |
| 19 | GPIO32 | C6_U0RXD | 20 |
| 21 | GPIO28 | C6_U0TXD | 22 |
| 23 | I2C_SDA | C6_IO9 | 24 |
| 25 | I2C_SCL | C6_CHIP_PU | 26 |

JP1 exposes twelve P4 GPIOs: 52, 51, 50, 49, 35, 34, 32, 28 on the left and 33, 31, 30, 29 on the right. No other P4 GPIO reaches the header — in particular GPIO1, 2, 3, 4, 5, 20, 45, 46 and 47 do not, and any note that puts camera signals on them belongs to a different carrier (see §How the map was got wrong twice).

Pins 20, 22, 24 and 26 (`C6_U0RXD`, `C6_U0TXD`, `C6_IO9`, `C6_CHIP_PU`) are the C6's **console and programming** path, not its data transport. They are how a C6 gets flashed and recovered; the transport is a separate SDIO bus that does not appear on the header at all. See §The two SDMMC buses. Pins 23 and 25 are the carrier's external I²C, and pin 18 is the C6's own supply.

### Two strapping pins reach this header

`GPIO34` and `GPIO35` are ESP32-P4 strapping pins, and the carrier routes both to JP1. A twelve-pin header carrying eleven signals cannot avoid them, so the rule is:

- **`GPIO35` (pin 15) stays spare, and must stay unconnected.** It is the serial-bootloader strap: held low at reset the chip enters the ROM downloader instead of running the application, and the combination `GPIO36`=0 with `GPIO35`=0 is documented as invalid. It idles high on an internal pullup, so an unwired pin is safe — a pin wired to ground is a board that will not boot, which at the bench reads as dead firmware rather than as a wiring mistake.
- **`GPIO34` (pin 17) carries `CAM3_TX`, an output.** We drive it, and the far end is a node's UART RX, which is high impedance and cannot hold it through our reset. A camera's TX is an *input* to us and must never land on `GPIO34` or `GPIO35`.

### KINO D4 V1 assignment on JP1

Source of truth in code is `firmware/p4/main/board_d4v1.h`; the same map lives machine-readable in `packages/hardware-profiles/src/profiles/d4-v1.json` (`gpio`, `header2x13`, and `jp1`). `board_d4v1_checks.h` proves the map against itself with `_Static_assert`, `firmware/p4/host_tests/test_board_pins.c` repeats those checks at runtime and emits `--dump`, and a vitest parses the C header and fails if the two ever drift.

Electrically `UNVALIDATED` per signal until a node answers on it (GitHub issue #2) — but the header positions themselves are now measured, not transcribed.

| Pin | Left | KINO use | KINO use | Right | Pin |
|---:|---|---|---|---|---:|
| 1 | 3V3 | — | — | 5V | 2 |
| 3 | 3V3 | — | — | 5V | 4 |
| 5 | GND | common GND | common GND | GND | 6 |
| 7 | GPIO52 | `CAM1_TX` (UART1) | `CAM3_RX` (UART3) | GPIO33 | 8 |
| 9 | GPIO51 | `CAM1_RX` (UART1) | `CAM_PWR_EN` | GPIO31 | 10 |
| 11 | GPIO50 | `CAM2_TX` (UART2) | `CAM4_TX` (UART4) | GPIO30 | 12 |
| 13 | GPIO49 | `CAM2_RX` (UART2) | `CAM4_RX` (UART4) | GPIO29 | 14 |
| 15 | GPIO35 | **spare — bootloader strap, leave unconnected** | — | GND | 16 |
| 17 | GPIO34 | `CAM3_TX` (UART3), strapping pin driven as an output | reserved: C6 supply | ESP_3V3 | 18 |
| 19 | GPIO32 | `SYNC_OUT` to all four XIAO `SYNC_IN` | reserved: C6 console RX | C6_U0RXD | 20 |
| 21 | GPIO28 | `BTN_SHUTTER`, switch to GND on pin 6 or 16 | reserved: C6 console TX | C6_U0TXD | 22 |
| 23 | I2C_SDA | carrier I²C | reserved: C6 download strap | C6_IO9 | 24 |
| 25 | I2C_SCL | carrier I²C | reserved: C6 enable | C6_CHIP_PU | 26 |

Per signal, with the XIAO end:

| Function | P4 GPIO | JP1 pin | Direction | Connected device |
|---|---:|---:|---|---|
| `CAM1_TX` | 52 | 7 | P4 out | XIAO 1 RX GPIO44 (D7) |
| `CAM1_RX` | 51 | 9 | P4 in | XIAO 1 TX GPIO43 (D6) |
| `CAM2_TX` | 50 | 11 | P4 out | XIAO 2 RX GPIO44 |
| `CAM2_RX` | 49 | 13 | P4 in | XIAO 2 TX GPIO43 |
| `CAM3_TX` | 34 | 17 | P4 out | XIAO 3 RX GPIO44 |
| `CAM3_RX` | 33 | 8 | P4 in | XIAO 3 TX GPIO43 |
| `CAM4_TX` | 30 | 12 | P4 out | XIAO 4 RX GPIO44 |
| `CAM4_RX` | 29 | 14 | P4 in | XIAO 4 TX GPIO43 |
| `SYNC_OUT` | 32 | 19 | P4 out | all four XIAO `SYNC_IN`, fan-out |
| `BTN_SHUTTER` | 28 | 21 | P4 in, switch to GND, pull-up on | 6 × 6 × 4.3 mm tactile switch to JP1 6 or 16 |
| `CAM_PWR_EN` | 31 | 10 | P4 out | camera bank high-side switch |
| — | 35 | 15 | — | spare, leave unconnected |

Accounting: 12 exposed GPIOs, 11 signals. The eleven are `CAM1_TX`/`CAM1_RX`, `CAM2_TX`/`CAM2_RX`, `CAM3_TX`/`CAM3_RX`, `CAM4_TX`/`CAM4_RX`, `SYNC_OUT`, `CAM_PWR_EN` and `BTN_SHUTTER`. `GPIO35` is the one spare. The shutter pin is assigned since ECN-0003, which took `GPIO28` from `FLASH_EN`; D4-V1 has no built-in flash and drives no flash enable line. Still unassigned, with no header pin left for them: `BTN_FN`, the mode slide, and the per-camera power-switch control pins — §Camera power switching describes that channel hardware.

None of the eleven touches an occupied peripheral: SD slot 0 is GPIO39–44, the C6 SDIO slot 1 is GPIO14–19 with `EN` on GPIO54, I²S is 9–13 and 48, the internal I²C is 7/8, backlight is 23, USB is 24–27, and the console is 37/38. All five P4 UARTs route TX/RX through the GPIO matrix, so there is no IOMUX constraint on these choices. Baud stays 921600, UART numbers stay 1–4.

### How the map was got wrong twice

Both errors were the same mistake: a table copied from somewhere instead of measured.

`1bc8a7e` (2026-08-21) added the first header table from an assumed third-party expansion list. Rows 1–3 and the `C6_*` block matched the real header, so it passed review. As it happens **its GPIO rows were right** — but nobody could have known that, because nothing had been checked against the board.

`944b68e` and `ac1e57c` (2026-08-27/28) then "corrected" it to the manufacturer pinout for the **`JC-ESP32P4-M3-DEV`** — a different carrier that shares the P4 module and nothing else. That map moved `CAM1` to GPIO1/GPIO2, which reach no connector here, and ECN-0001 recorded it as accepted. The bench found it the hard way the next day: a node that never answered, and then a TX-to-RX loopback across JP1 7–9 that received **zero bytes** with the node removed from the circuit entirely.

It was settled electrically (ECN-0002). The P4 drove every one of its 47 usable GPIOs in turn, each announcing its own index in binary, while a camera node watched a single wire and reported what it saw:

- JP1 pin 13 → **GPIO49**
- JP1 pin 7 → **GPIO52** (predicted before the run, from the manufacturer drawing)

Both agree with the `JC4880P443C-I-W` drawing, which is the board we actually have. The rule that follows is in `board_d4v1.h`: do not edit these numbers from a datasheet, a photo of another board, or a vendor page. Measure the pin.

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
| Flash | Not fitted in D4-V1. The constant-current direct-flash assembly below was dropped by ECN-0003; an external module will replace it and is not chosen. |
| Flash emitter (dropped) | 3 W CRI90 natural-white LED star, roughly 3.0 to 3.6 V forward voltage |
| Flash drive (dropped) | Adjustable constant-current driver, 350 mA initial target |
| Flash thermal path (dropped) | 20 × 20 × 7 mm copper pin-fin heatsink, 0.5 mm thermal pad |
| Flash diffuser (dropped) | 1 mm opal acrylic |
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

The space above the lens row, centred between CAM2 and CAM3, was the flash position. D4-V1 fits nothing there; the external module has no envelope yet. The 4.3-inch display faces out through the rear.

These values guide the digital twin. Physical measurement still decides the enclosure.

## Source trail

- [Twin source notes](../kino_twin_spec/SOURCES.md)
- [Twin component manifest](../kino_twin_spec/component-manifest.json)
- [Full Twin specification](../kino_twin_spec/KINO_TWIN_SIMULATOR_SPEC.md)
- [KDP command contract](../firmware-contract/commands.md)
- [Portable schema contract](../firmware-contract/schemas.md)
- [Platform overview](../kino_dev_spec_pack/01_PLATFORM_OVERVIEW.md)
