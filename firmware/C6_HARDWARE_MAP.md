# ESP32-C6 hardware map — KINO D4 V1

The P4 ↔ ESP32-C6 connection on the Guition `JC4880P443C-I-W`
(module `JC-ESP32P4-M3-C6`), what is now established, and what still needs a
board to confirm it.

**Status: routing IDENTIFIED and internally CONSISTENT. Not yet bench-proven.**

The earlier revision of this file recorded the routing as unknown and blocked
the work. That was correct at the time — the repository contained no C6
transport pin. It has been superseded by an external identification of the
carrier's mapping, which this file reconciles against primary sources below.
No pin has been driven yet.

## The mapping

| Signal | P4 | C6 | Purpose | Evidence |
|---|---|---|---|---|
| SDIO `D0` | `GPIO14` | `GPIO20` | hosted data 0 | E2, E3 |
| SDIO `D1` | `GPIO15` | `GPIO21` | hosted data 1 | E2, E3 |
| SDIO `D2` | `GPIO16` | `GPIO22` | hosted data 2 | E2, E3 |
| SDIO `D3` | `GPIO17` | `GPIO23` | hosted data 3 | E2, E3 |
| SDIO `CLK` | `GPIO18` | `GPIO19` | hosted clock | E2, E3 |
| SDIO `CMD` | `GPIO19` | `GPIO18` | hosted command | E2, E3 |
| `EN` / reset | `GPIO54` | `CHIP_PU` | hold the C6 in reset / release it | E2, E4 |
| `ESP_3V3` | — | supply | C6 rail from the carrier | E1 |
| `C6_U0RXD` | unknown | `U0RXD` | C6 console / serial flash | E1 |
| `C6_U0TXD` | unknown | `U0TXD` | C6 console / serial flash | E1 |
| `C6_IO9` | unknown | `GPIO9` | C6 download-mode strap | E1 |

The C6-side column is silicon, not a board choice: the ESP32-C6's SDIO **slave**
pads are not routable through its GPIO matrix.

Note `CLK`/`CMD` cross over — P4 `GPIO18` (clock out) meets C6 `GPIO19` (clock
in), P4 `GPIO19` (command) meets C6 `GPIO18`. That is not a transcription
error; the two chips number these functions in opposite order.

## Evidence chain

**E1 — the carrier header, from this repository.** Five C6-facing pins are
recorded as reserved: `ESP_3V3`, `C6_U0RXD`, `C6_U0TXD`, `C6_IO9`,
`C6_CHIP_PU` (`packages/hardware-profiles/src/profiles/d4-v1.json`,
`docs/HARDWARE.md`). These are the programming and console path. **They are
not the transport**, and the repo never mapped them to P4 GPIOs. That gap is
what previously blocked this work.

**E2 — external identification (vendor-derived), 2026-08-27.** The mapping in
the table above was established against Guition documentation for the
`JC4880P443C_I_W` / `JC-ESP32P4-M3-C6` carrier, outside this repository. It is
recorded here as an input, attributed, and reconciled against E3 and E4 rather
than trusted on its own. **The schematic itself is not in this repository and
must not be copied into it** — the pin facts are recorded as facts with
attribution; the drawing is Guition's.

**E3 — Espressif's own ESP-Hosted configuration for a P4 host with a C6
coprocessor.** `espressif/esp_hosted` 3.0.6, file
`host/mcu/eh_host_mcu_transport/Kconfig.host.sdio`, for
`ESP_HOSTED_P4_DEV_BOARD_FUNC_BOARD && ESP_HOSTED_CP_TARGET_ESP32C6`:

| Symbol | Default |
|---|---|
| `ESP_HOSTED_SDIO_D0_GPIO_RANGE_MIN/MAX` | `14` / `14` |
| `ESP_HOSTED_SDIO_D1_GPIO_RANGE_MIN/MAX` | `15` / `15` |
| `ESP_HOSTED_SDIO_D2_GPIO_RANGE_MIN/MAX` | `16` / `16` |
| `ESP_HOSTED_SDIO_D3_GPIO_RANGE_MIN/MAX` | `17` / `17` |
| `ESP_HOSTED_SDIO_CLK_GPIO_RANGE_MIN/MAX` | `18` / `18` |
| `ESP_HOSTED_SDIO_CMD_GPIO_RANGE_MIN/MAX` | `19` / `19` |

Min equals max, so Espressif pins these to exactly one value for that board.
All six agree with E2. This is corroboration, not proof for *our* carrier: it
says the Guition module follows Espressif's ESP32-P4-Function-EV-Board
reference for the C6 link, which is also what the SD block does (see E5).

**E4 — the reset line, and its polarity.** Same file:

```
config ESP_HOSTED_HOST_RESET_GPIO
    int "Slave reset GPIO (RST/EN line)"
    default 54 if IDF_TARGET_ESP32P4
```

`54` is the default for **every** P4 target, not one board — so E2's `GPIO54`
agrees with Espressif's generic P4 assumption. Polarity, verbatim from the
component:

```
# ESP modules' EN / RST pin is active-low by convention (pull
# LOW to assert reset, HIGH to run).  Default reflects that.
# Boards with a transistor-buffered EN that inverts polarity
# need the explicit "Active high" override here.
default ESP_HOSTED_SDIO_RESET_ACTIVE_LOW
```

See "GPIO54 semantics" below. The polarity is a **board** property and the
override exists because boards get it wrong; ours is unconfirmed.

**E5 — the SD block, from IDF's SoC tables.**
`components/soc/esp32p4/include/soc/sdmmc_pins.h`:

```
SDMMC_SLOT0_IOMUX_PIN_NUM_CLK  43
SDMMC_SLOT0_IOMUX_PIN_NUM_CMD  44
SDMMC_SLOT0_IOMUX_PIN_NUM_D0   39
SDMMC_SLOT0_IOMUX_PIN_NUM_D1   40
SDMMC_SLOT0_IOMUX_PIN_NUM_D2   41
SDMMC_SLOT0_IOMUX_PIN_NUM_D3   42
// SLOT1 doesn't go through IOMUX
```

The D4's microSD pins are **exactly** the P4's slot-0 IOMUX pads, and that set
is already VALIDATED on our unit by a real 29820 MB 4-bit mount
(`HARDWARE_VALIDATION.md`, 2026-08-26). So the card is wired to the chip's
dedicated SD pads, which is the strongest possible confirmation of that half of
the map and independent evidence that this carrier follows the reference
pinout.

**E6 — the header map was found to be wrong, and this survived it.** While this
reconciliation was being written, the 2×13 header was checked against the
physical board's silkscreen and most of it did not match: the eight camera UART
pins this repository recorded (`GPIO52`/`51`/`50`/`49`/`34`/`33`/`30`/`29`) are
**not brought out anywhere**, so CAM1 had been opening UART1 on pins that route
to nothing. That is the most expensive possible way to be told a pin map is
fiction, and it is a standing caution about every `PROVISIONAL` row in this
tree.

Two things about it matter here:

- **The `C6_*` block matched.** JP1 pins 20, 22, 24, 26 (right column, rows
  10–13) are `C6_U0RXD`, `C6_U0TXD`, `C6_IO9`, `C6_CHIP_PU` on the silkscreen,
  exactly as recorded. So the part of the repo's map that describes the C6 is
  the part that survived checking.
- **None of GPIO14–19 or GPIO54 is a header pin**, and they should not be: the
  transport is an internal trace between the two dies on the module, not
  something brought out to a connector. Checked mechanically — the C6 bus
  overlaps neither the SD bus nor any of the eleven header GPIOs the silkscreen
  actually exposes (`1, 2, 3, 4, 5, 20, 32, 33, 45, 46, 47`; GPIO3 and GPIO5
  are already the touch and LCD resets, leaving nine free), and
  `board_d4v1.h` has no GPIO assigned twice. The corrected map — CAM1–4 on
  GPIO52/51, 50/49, 34/33, 30/29 and `SYNC_OUT` on GPIO32, each with its JP1 pin
  — is in `docs/HARDWARE.md` §P4 header JP1.

This is corroboration, not proof. It says the header error does not reach these
pins and that the C6-facing half of the old map was accurate. It does not
measure GPIO14–19, and E2's source is still documentation rather than a probe —
which, given what happened to the camera UARTs, is exactly why the radio is a
build-time opt-in that is off by default.

## The two buses are separate

```
SD CARD BUS        GPIO39  GPIO40  GPIO41  GPIO42  GPIO43  GPIO44
                   D0      D1      D2      D3      CLK     CMD
                   -> SDMMC slot 0, IOMUX-fixed pads

C6 RADIO BUS       GPIO14  GPIO15  GPIO16  GPIO17  GPIO18  GPIO19   + GPIO54
                   D0      D1      D2      D3      CLK     CMD        EN
                   -> SDMMC slot 1, GPIO-matrix routed
```

No pin is shared. The previous blocker — "unknown whether a slot remains" — is
resolved, and **not** by the pin separation alone. See the next section, which
is where the real constraint was.

## SDMMC host / slot allocation — this is the part that needed care

Separate pins do not imply separate driver resources. The P4 has **one** SDMMC
controller with **two slots** (`SOC_SDMMC_NUM_SLOTS 2`,
`SOC_SDMMC_USE_GPIO_MATRIX 1`), and both slots share that controller, its clock
tree and its DMA.

```
microSD host/slot:   SDMMC host, slot 0  — IOMUX pads 39-44, 4-bit
C6 SDIO host/slot:   SDMMC host, slot 1  — GPIO matrix 14-19, 4-bit
DMA/resource:        one controller, shared. Slots are independent chip
                     selects on it, not independent peripherals.
```

**A conflict existed and has been fixed.** `storage.c` took
`SDMMC_HOST_DEFAULT()`, and that macro sets `.slot = SDMMC_HOST_SLOT_1`
(`components/esp_driver_sdmmc/include/driver/sdmmc_default_configs.h`) — it
never assigned `.slot` itself, so the card was on **slot 1**, which is the slot
ESP-Hosted needs for the C6. It worked because slot 1 is matrix-routable and
pins 39-44 were given explicitly, but it occupied the radio's slot and pushed
the card's dedicated pads through the matrix for nothing.

The card is now explicitly on **slot 0**, where those six pins are the IOMUX
pads the board actually wires. `slot 0` is also the correct home for a card on
this hardware independently of the C6: IOMUX avoids the matrix entirely.

ESP-Hosted does **not** bypass the ordinary driver. Its SDIO host goes through
`esp_driver_sdmmc` (`sdmmc_host_t`, `sdmmc_host_init`, `sdmmc_host_init_slot`)
and selects its slot with `ESP_HOSTED_HOST_SDIO_SLOT`, whose choice prompts are
literally "Slot 0 (IOMUX-fixed pins)" and "Slot 1 (configurable pins)". So both
users are the same driver and the allocation above is the whole of the
arbitration.

Espressif ship this exact combination as an example —
`esp_hosted/examples/mcu_hosted_sdio_sdmmc_combined` — whose README states the
allocation in the same terms:

> Demonstrates running ESP-Hosted's SDIO transport on the same SDMMC controller
> that also hosts an external SD card — the two share the bus driver but live on
> different slots. The host brings up Wi-Fi through ESP-Hosted on SDMMC slot 1
> (on-board ESP32-C6), mounts a FAT-formatted SD card on SDMMC slot 0

and, for boards: "ESP32-P4 (slot 0 for SD + slot 1 for CP)". That example also
scans Wi-Fi before *and* after filesystem I/O specifically to prove the radio
survives card init — which is the coexistence check to run at the bench.

Remaining unknown in this area: on-chip LDO interaction. The card is powered
from LDO channel 4 and the DSI PHY from channel 3, deliberately not shared.
ESP-Hosted exposes `ESP_HOSTED_SD_PWR_CTRL_LDO_INTERNAL_IO`, gated on
`SOC_SDMMC_IO_POWER_EXTERNAL`. Whether the C6's SDIO IO rail needs a channel of
its own on this carrier is not established.

## GPIO54 semantics — do not guess

`GPIO54` is the P4's line to the C6's `CHIP_PU`. `CHIP_PU` is an **enable**,
not a reset-request:

```
CHIP_PU LOW   -> C6 held off / in reset
CHIP_PU HIGH  -> C6 released and running
```

ESP-Hosted's default is `ACTIVE_LOW`, meaning "pull LOW to assert reset, HIGH
to run", which is the same thing said from the host's side. **But the component
carries an explicit "Active high" override for boards whose EN is buffered
through an inverting transistor, and we have not confirmed which the Guition
carrier is.** Until a board says otherwise, the firmware treats it as the
convention above and names it for the physical signal.

Firmware therefore uses `BOARD_C6_EN` and helpers named
`board_c6_enable()` / `board_c6_hold_reset()`. There is deliberately no
`C6_RESET_HIGH()`: on an active-low enable that name asserts the opposite of
what it reads like, and this is the one signal where being wrong costs a board
that will not boot.

## Flashing and recovery — establish before writing C6 flash

The C6's own `U0RXD`, `U0TXD`, `IO9` (download strap) and `CHIP_PU` are all on
the 2×13 header, so an external USB-serial adapter is a complete and
independent recovery path. That must be confirmed working **before** the first
C6 flash write, not after.

Whether the P4 can drive those four pins — the flashing proxy that would make
this a one-cable operation — depends on P4-side GPIO numbers for them, which E2
did not supply and the repo does not record. Until it does, C6 flashing is an
external-adapter operation.

Do not flash the C6 before reading what it is already running: a factory image
that answers a version handshake is information, and this board is publicly
reported to ship C6 firmware older than current hosts expect. See
`C6_BRINGUP.md`.

## What is still unknown

| Item | State |
|---|---|
| Guition schematic in-repo | **Absent, and must stay absent** — third-party drawing. Pin facts recorded above with attribution |
| `GPIO54` polarity on this carrier | **UNCONFIRMED** — convention assumed, override exists |
| P4 GPIOs behind `C6_U0RXD`/`C6_U0TXD`/`C6_IO9` | **UNKNOWN** — blocks a P4-driven flashing proxy |
| C6 SDIO IO power rail / LDO channel | **UNKNOWN** |
| C6 module flash size | **UNKNOWN** — the official coprocessor image wants 4 MB |
| Factory C6 image version | **UNREAD** |
| Antenna path / RF switch | **NOT RECORDED** |
| Any of it on hardware | **NOTHING. No pin has been driven toward the C6.** |

## Registry rows

Thirteen rows are in the firmware's own registry now (`hwv_item_t`, readable
over `GET_HW_VALIDATION`), appended rather than inserted because the enum
ordinal is the NVS key. **None is earned.** They exist before the bench run so
that a registry which grows during a bench session — the kind nobody trusts
afterwards — is not what records the answers.

Ordered the way `C6_BRINGUP.md` proceeds, so a run that stops halfway leaves an
obvious high-water mark.

| Row | Evidence needed | State |
|---|---|---|
| `SD_SLOT0` | Card mounts from slot 0, not slot 1 | **UNVALIDATED** — the only one that can flip in the default build |
| `C6_EN_GPIO54` | Measured `CHIP_PU` behaviour *and* polarity | **UNVALIDATED** |
| `C6_SDIO_PINS` | Enumeration succeeds on GPIO14-19, slot 1 | **UNVALIDATED** |
| `C6_LINK_HANDSHAKE` | ESP-Hosted handshake completes | **UNVALIDATED** |
| `C6_SLAVE_VERSION` | Coprocessor version read back and compatible | **UNVALIDATED** |
| `C6_WIFI_SCAN` | Scan returns a known AP | **UNVALIDATED** |
| `C6_WIFI_ASSOCIATE` | WPA2 association | **UNVALIDATED** |
| `C6_DHCP` | Lease obtained — `IP_READY`, not association | **UNVALIDATED** |
| `C6_DNS` | Name resolved | **UNVALIDATED** |
| `C6_SNTP` | Trustworthy wall time from the network | **UNVALIDATED** |
| `C6_TLS` | Certificate-**verified** HTTPS response | **UNVALIDATED** |
| `SD_C6_COEXIST` | Scan works before *and* after card I/O, both up | **UNVALIDATED** |
| `C6_ROLL_UPLOAD` | A capture reaches a Roll from the camera | **UNVALIDATED** |

`SD_SLOT0` is first because it is a regression risk rather than a new feature:
the mount that validated GPIO39-44 was on slot 1, and moving the card to slot 0
changed an already-validated path. Same pins, and they are the chip's own SD
pads, so it should be a no-op — but "should" is why it has a row.
