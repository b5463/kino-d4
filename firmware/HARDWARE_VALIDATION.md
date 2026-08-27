# D4-V1 hardware validation record

The source of truth for what has actually been bench-proven on physical D4-V1
hardware. The firmware keeps a live per-unit registry of the same items
(`p4/main/hardware_validation.[ch]`, readable over KDP with
`GET_HW_VALIDATION`); this file is the human record across units and time.

Rules:

- `VALIDATED` means the operation ran on our physical board and was observed.
  A datasheet, a community field note, or a compiling `#define` is never
  validation.
- Firmware auto-marks only `UNVALIDATED → VALIDATED`, from real events. It
  never auto-marks `FAILED` — software cannot tell a wrong pin from an empty
  SD slot or an unplugged harness. A failure is diagnosed at the bench and
  recorded here with the measured replacement.
- Do not rewrite history. A failed assumption keeps its row, marked `FAILED`,
  with the replacement in a new row.

## Status — updated 2026-08-27, firmware 0.3.0

**Nothing below was inferred from code.** A row moves on an observed event on a
physical unit, and the firmware auto-marks only `UNVALIDATED → VALIDATED`. The
registry grew from 23 to 41 items in 0.3.0 (CAM2–4, sync trigger, `FLASH_EN`,
shutter) so the four-camera bring-up has somewhere to record its answers; all
18 new rows are `UNVALIDATED` and will stay so until the harness exists.

### The one thing to read first

**No camera node has ever been connected to a P4.** Everything in the camera
column below is either standalone-module evidence or unvalidated. The entire
capture pipeline — four-camera coordination, CRC verification, card write,
thumbnails, gallery, `EVT_CAPTURE`, `MEDIA_READ` — is `CODE DONE` and has never
photographed anything.

### Firmware 0.2.0 / 0.3.0 evidence, recorded late

The 0.1.0 sections below were written at the time. The display and touch runs
were recorded only in commit messages and are transcribed here now; that gap
was itself a process failure, since this file is the declared source of truth
and it sat two minor versions behind the firmware.

| Subsystem | Evidence | Source | Status |
|---|---|---|---|
| ST7701S panel over MIPI-DSI | *"First light… five colour bands on the screen, confirmed on hardware"* — after three faults each hiding the next: PSRAM at 20 MHz (DPI underrun), 800 async draw calls, and a panel-specific init table | commit `b8dff7a` | **VALIDATED** |
| Backlight GPIO23 | Driven with the panel; plain GPIO, not LEDC | commit `b8dff7a` | **VALIDATED** |
| GT911 touch | *"GT911 touch and a first on-screen UI, both verified on hardware"* | commit `8b4ddf3` | **VALIDATED** |
| Shared I²C bus | Scan reported 0x14, 0x18, 0x5d; codec must be brought up before the touch poll or every transaction NACKs | commit `8b4ddf3` | **VALIDATED** |
| ES8311 codec + NS4150 amp | Answered at 0x18; amp enable GPIO11 drives a speaker. Shutter/tick levels chosen from measured output | 0.2.0 audio work | **VALIDATED** |
| MSM381 microphone | reg 0x44 `ADCDAT_SEL` = 5 is a digital DAC loopback, not the mic; a volume sweep produced bit-identical output. Analog front end unconfigured | 0.2.0 audio work | **FAILED — not usable** |
| `CAM_PWR_EN` GPIO31 | Pin driven both ways for the camera bank. Whether the AO4407 channels downstream follow it is still a scope job | 0.2.0 power work | **VALIDATED (pin only)** |
| Config persistence | A setting survived a real power cycle over the live link | 0.2.0 | **VALIDATED** |
| UI on the panel | 8 screens render on hardware; boot dissolve measured at 26 frames in 452 ms (≈57 fps) via the PPA | 0.2.0/0.3.0 | **VALIDATED** |
| Icon expansion | 575 ms for six icons, streamed; icons ready at t=2984 ms against a boot dissolve at t=4974 | commit `5768d3c` | **VALIDATED** |

### Not validated, and not inferable from code

Every one of these has firmware written for it and no hardware evidence
whatsoever. Listed explicitly so nobody reads working code as a working
subsystem.

| Item | State |
|---|---|
| CAM1 UART through the P4 (`TX 52` / `RX 51`) | **UNVALIDATED** — pin map PROVISIONAL, issue #2 |
| CAM1 baud 921600 over the harness | **UNVALIDATED** |
| CAM1 node link (`node_link` over KDP framing) | **UNVALIDATED** |
| CAM1 sensor detected *through the P4* | **UNVALIDATED** — the standalone run below is a different unit and a different path |
| CAM1 JPEG transfer over the link | **UNVALIDATED** |
| CAM1 SD write of a transferred frame | **UNVALIDATED** |
| CAM2 / CAM3 / CAM4 — every row | **UNVALIDATED** — no harness has ever existed |
| Four-camera concurrent capture | **UNVALIDATED** — Gate B |
| Exposure synchronization / inter-camera skew | **UNVALIDATED and UNMEASURED** — Gate C. Frame period derived at ~112 ms from driver source; no hardware confirmation |
| Stale-frame lifecycle | **PREDICTED FROM SOURCE, UNCONFIRMED** — see the M1 runbook's Phase 15 gate |
| `SYNC_TRIGGER` GPIO32 | **UNVALIDATED** — driven by `capture.c`; no node reads the edge, so nothing has seen it |
| `FLASH_EN` GPIO28 / flash hardware | **UNVALIDATED** — no flash board exists; `flashHardware: false` |
| Physical shutter / Fn button | **UNVALIDATED** — pins deliberately `BOARD_BTN_NONE`; no switch fitted |
| Battery voltage / percentage / low-battery shutdown | **NOT APPLICABLE on this board** — no sense divider reaches the P4 (deviation D10). Needs a hardware revision |
| Backlight brightness / dim stage | **NOT APPLICABLE** — plain GPIO, not PWM (deviation D11) |
| Wi-Fi / BLE / ESP32-C6 | **NOT IMPLEMENTED** — no SDIO bring-up, no slave image |
| Networking / KINO Roll from the camera | **NOT IMPLEMENTED** — issue #133 |
| OTA / `FW_*` / firmware update over KDP | **NOT IMPLEMENTED** — single `factory` partition, no OTA slots |
| Light/deep sleep | **NOT IMPLEMENTED** — backlight and camera bank only |
| Thermal response | **NOT IMPLEMENTED** — die temperature readable, nothing acts on it |
| `STORAGE_BENCH` throughput on a real card | **CODE DONE, UNVALIDATED** — implemented in 0.3.0, never run on hardware |
| Per-task stack high-water figures | **CODE DONE, UNVALIDATED** — exposed in `GET_RUNTIME_STATS`, never read from a board |

## Status — 2026-08-25, firmware 0.1.0

The first physical hardware has been run: one XIAO ESP32-S3 Sense camera
module, standalone over USB-C with `firmware/uvc-preview`. **No P4 and no
harness were involved**, so only the two rows that describe the sensor and its
capture path can move. Everything about the link, the pin map and the baud
stays `UNVALIDATED` — nothing tonight exercised them, and a row that changes
on anything less than the operation itself makes this file worthless.

### P4 host board, 2026-08-26

Guition JC4880P443C-I-W, MAC `80:F1:B2:D1:21:BC`, serial `KD4-D121BC`,
firmware 0.1.0. USB only — no camera harness, no battery. Eight rows moved,
auto-marked by the firmware from real events and read back over
`GET_HW_VALIDATION`.

| Observation | Value |
|---|---|
| Chip | ESP32-P4 rev v1.3, 360 MHz, 16 MB Boya flash |
| PSRAM | 32 MB AP Memory, 256 Mbit, X16, memory test **OK**, 32722 KB free at idle |
| SD card | mounted 29820 MB, FAT, 4-bit high-speed, on-chip LDO ch4 |
| `STORAGE_SELF_TEST` | **ok**, 65536 bytes, 125 ms, no failed phase |
| KDP | all 17 M1B commands answered over USB-Serial-JTAG |
| Capabilities | every flag `false` except `benchDiagnostics` — matches the `d4-m1b` profile exactly |
| P4 die temperature | 27 °C at idle |
| Reset reason | `usb` |
| CAM1 with nothing attached | `txFrames 3, rxBytes 0, timeouts 3, lastError TIMEOUT` |

The camera rows stay `UNVALIDATED` in the device's own registry, correctly: no
node has ever answered this P4. Note that `CAM1_SENSOR_DETECT` and
`CAM1_CAPTURE` are `VALIDATED` in the table below on the strength of the
standalone module bench, which is a different unit and a different path. The
device registry and this file are both right in their own frame — the P4 has
not seen a sensor, and a sensor has been seen.

Not established: anything about the camera UARTs, the node link, or the
harness. Nothing tonight connected a camera to this board.

### Camera module 1, MAC `7C:4F:AD:20:87:8C` (ESP32-S3 QFN56 rev v0.2, 8 MB octal PSRAM,
8 MB GD flash):

| Observation | Value |
|---|---|
| Sensor identity | `PID=0x3660`, driver reports "Detected OV3660", SCCB address `0x3c` |
| Sensor registers | every setter `uvc-preview` uses is implemented, denoise included |
| Capture | 210 consecutive JPEGs, none truncated (SOI/EOI checked on the device) |
| JPEG size, VGA q12 | 7.7–30.4 KB |
| PCLK | 8 MHz, from XCLK 16 MHz (`VCO 128 MHz, SYSCLK 32 MHz`) |
| Frame corruption | 48% of frames at XCLK 20 MHz, 0.5% at 16 MHz — see the changelog and issue |
| Colour | G +5.2% against neutral on a lit white wall, with Espressif's OV3660 tuning applied |

**Not** established by this run: that the frames are free of mid-stream
corruption. The device-side check reads two bytes at each end of the JPEG and
catches truncation only.

| Item | Assumption source | Status |
|---|---|---|
| `USB_SERIAL_JTAG` | Observed 2026-08-26: host frame decoded over USB-Serial-JTAG | VALIDATED |
| `SD_CLK_GPIO43` | Observed 2026-08-26: card mounted 29820 MB, 4-bit | VALIDATED |
| `SD_CMD_GPIO44` | Observed 2026-08-26: card mounted 29820 MB, 4-bit | VALIDATED |
| `SD_D0_GPIO39` | Observed 2026-08-26: card mounted 29820 MB, 4-bit | VALIDATED |
| `SD_D1_GPIO40` | Observed 2026-08-26: card mounted 29820 MB, 4-bit | VALIDATED |
| `SD_D2_GPIO41` | Observed 2026-08-26: card mounted 29820 MB, 4-bit | VALIDATED |
| `SD_D3_GPIO42` | Observed 2026-08-26: card mounted 29820 MB, 4-bit | VALIDATED |
| `SD_LDO_CH4` | Observed 2026-08-26: card powered and mounted 29820 MB | VALIDATED |
| `CAM1_TX_GPIO52` | Provisional header map (d4-v1.json, issue #2) | UNVALIDATED |
| `CAM1_RX_GPIO51` | Provisional header map (d4-v1.json, issue #2) | UNVALIDATED |
| `CAM1_BAUD_921600` | M1B baseline; escalation is milestone 2 bench work | UNVALIDATED |
| `CAM1_NODE_LINK` | node_link over KDP framing | UNVALIDATED |
| `CAM1_SENSOR_DETECT` | Observed 2026-08-25 on module 1: `PID=0x3660` at SCCB `0x3c`, standalone over USB | VALIDATED |
| `CAM1_CAPTURE` | Observed 2026-08-25 on module 1: 210 JPEGs into node PSRAM, standalone over USB | VALIDATED |
| `CAM1_JPEG_TRANSFER` | Chunked UART read-out, CRC-verified | UNVALIDATED |
| `CAM1_SD_WRITE` | /KINO/CAPTURES/<uuid>/ write + read-back CRC | UNVALIDATED |

Field-note source: <https://github.com/ultramcu/guition-jc4880p443c-i-w> —
useful, but not our unit.

## How a row changes

A row may also change from a standalone module bench with
[`uvc-preview`](uvc-preview/README.md), which is how `CAM1_SENSOR_DETECT` and
`CAM1_CAPTURE` moved — but only those two. A module answering over USB says
nothing about the pin map it will hang off, the baud it will run, or whether
the P4 can reach it.

Run the procedure in [`BENCH_M1B.md`](BENCH_M1B.md). After each stage, read
`GET_HW_VALIDATION` (Studio → Developer → Bench Diagnostics) and copy the
device's verdicts here with the date, firmware version, wiring revision, and
failure notes. Issue #66 carries the running record; issue #3 consumes it.
