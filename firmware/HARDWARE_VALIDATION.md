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

## Status — updated 2026-08-21, firmware 0.1.0

No physical bench run has happened yet. Every item is the community-derived
or profile-derived assumption it started as.

| Item | Assumption source | Status |
|---|---|---|
| `USB_SERIAL_JTAG` | Guition field notes: FS USB port is USB-Serial-JTAG | UNVALIDATED |
| `SD_CLK_GPIO43` | Guition field notes | UNVALIDATED |
| `SD_CMD_GPIO44` | Guition field notes | UNVALIDATED |
| `SD_D0_GPIO39` | Guition field notes | UNVALIDATED |
| `SD_D1_GPIO40` | Guition field notes | UNVALIDATED |
| `SD_D2_GPIO41` | Guition field notes | UNVALIDATED |
| `SD_D3_GPIO42` | Guition field notes | UNVALIDATED |
| `SD_LDO_CH4` | Guition field notes: on-chip LDO channel 4, 3.3 V | UNVALIDATED |
| `CAM1_TX_GPIO52` | Provisional header map (d4-v1.json, issue #2) | UNVALIDATED |
| `CAM1_RX_GPIO51` | Provisional header map (d4-v1.json, issue #2) | UNVALIDATED |
| `CAM1_BAUD_921600` | M1B baseline; escalation is milestone 2 bench work | UNVALIDATED |
| `CAM1_NODE_LINK` | node_link over KDP framing | UNVALIDATED |
| `CAM1_SENSOR_DETECT` | Runtime SCCB PID detect (OV3660 expected) | UNVALIDATED |
| `CAM1_CAPTURE` | esp32-camera JPEG capture into node PSRAM | UNVALIDATED |
| `CAM1_JPEG_TRANSFER` | Chunked UART read-out, CRC-verified | UNVALIDATED |
| `CAM1_SD_WRITE` | /KINO/CAPTURES/<uuid>/ write + read-back CRC | UNVALIDATED |

Field-note source: <https://github.com/ultramcu/guition-jc4880p443c-i-w> —
useful, but not our unit.

## How a row changes

Run the procedure in [`BENCH_M1B.md`](BENCH_M1B.md). After each stage, read
`GET_HW_VALIDATION` (Studio → Developer → Bench Diagnostics) and copy the
device's verdicts here with the date, firmware version, wiring revision, and
failure notes. Issue #66 carries the running record; issue #3 consumes it.
