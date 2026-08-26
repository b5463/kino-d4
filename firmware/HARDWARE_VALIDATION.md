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

## Status — updated 2026-08-25, firmware 0.1.0

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
