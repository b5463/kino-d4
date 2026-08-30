# Milestone 1B plan — single-camera physical bring-up

Continues issue #66 on top of the Milestone 1 tree. Goal: prove the whole real single-camera path
(Studio → USB/KDP → P4 → UART/node_link → XIAO → sensor → JPEG → P4 PSRAM → microSD) on our
physical Guition board and XIAO, replacing community-derived assumptions with measurements.
Explicitly out of scope: CAM2–4, sync, flash, autofocus, Wi-Fi, Roll, OTA, UI polish.

## Re-audit result (2026-08-21)

- kdp_core host tests: 40 checks pass.
- `p4` and `camnode` build clean under `espressif/idf:v5.5.1`.
- `license:check` passes. `version:check` fails only on a database-journal drift belonging to
  unrelated in-flight backend work in the shared working tree; every firmware check passes.
- Command ids in `firmware/components/kdp_core/include/kdp/protocol.h` match
  `packages/kdp/src/protocol/commands.ts` at HEAD; `0x47`–`0x4b` are unallocated.
- Unsupported commands NACK `UNSUPPORTED_COMMAND`; sensor detect is runtime SCCB PID;
  CAM2–4 report `offline`.

## New KDP surface (compatible additions, PROTOCOL_VERSION stays 1)

All five gated by one new optional capability flag, `benchDiagnostics`. Values are the next free
slots in the diagnostics block:

| Command | Value | Payload |
|---|---:|---|
| `STORAGE_SELF_TEST` | `0x47` | → `{}` ← `StorageSelfTestResult` — mount → write → fsync → read-back → CRC verify → delete; reports the exact failing phase |
| `CAMERA_LINK_STATS` | `0x48` | → `{cam}` ← `CameraLinkStats` |
| `CAMERA_LINK_STATS_RESET` | `0x49` | → `{cam}` ← `{ok}` |
| `CAMERA_SOAK_TEST` | `0x4a` | → `SoakTestRequest` ← `JobStartResponse`, then `JOB_PROGRESS`/`JOB_COMPLETE` with `SoakTestSummary` |
| `GET_HW_VALIDATION` | `0x4b` | → `{}` ← `HwValidationReport` — runtime hardware-validation registry + P4 reset reason |

`GET_STORAGE_STATUS` gains optional fields (`mounted`, `filesystem`, `capacityBytes`,
`freeBytes`, `lastError`, `mountAttempts`, `writeTestStatus`). `CAMERA_TEST` keeps `ok`/`jpegKB`/
`durationMs` and adds capture UUID, per-stage bench timing, three checksums, and memory stats.
Bench timing is never called skew; the `kino.capture` `timing` block stays absent.

## Files to change

Host contracts and reference device:
- `packages/kdp/src/protocol/commands.ts` — five ids.
- `packages/kdp/src/protocol/types.ts` — `benchDiagnostics?` flag, `StorageStatus` optional
  fields, `StorageSelfTestResult`, `CameraLinkStats`, `CaptureTiming`, `CaptureChecksums`,
  `MemoryStats`, `CameraTestResult`, `SoakTestRequest`, `SoakTestSummary`,
  `HwValidationStatus/Item/Report`.
- `packages/test-fixtures/src/MockKinoDevice.ts` — implement all five + extended
  `CAMERA_TEST`/`GET_STORAGE_STATUS`; honor existing faults (`sensor-missing`, `crc-noise`,
  `slow-uart`, `offline`, `sdMissing`, `sdFull`, reboot); new `memoryLeak` scenario.
- `packages/test-fixtures/src/scenarios.ts` — `memoryLeak` key.
- `packages/test-fixtures/tests/benchDiagnostics.test.ts` — new suite over MockTransport +
  KinoProtocolClient.
- `firmware-contract/commands.md` — document the additions as repo-normative.

Firmware:
- `components/kdp_core` — streaming CRC (`kdp_crc32_begin/update/final`) + host tests.
- `components/node_link` — HELLO gains reset reason, chip revision, heap/PSRAM, baud,
  sensor PID + autofocus; CAPTURE response gains JPEG CRC32 and node memory; STATUS gains
  heap/PSRAM and decoder counters.
- `camnode/main/*` — implement the above.
- `p4/main/hardware_validation.[ch]` — new runtime registry (below).
- `p4/main/storage.c/.h` — mount attempts + last error, self-test, `/KINO/CAPTURES/<uuid>/`
  layout, stored-file CRC read-back, capture delete (soak cleanup).
- `p4/main/cam_link.c/.h` — full link counters (frames/bytes both ways, timeouts, duplicates,
  last sequence), node identity cache, stats reset.
- `p4/main/kdp_server.c` — capture core with stage timings/checksums/memory, five new handlers,
  soak job task with `JOB_PROGRESS`/`JOB_COMPLETE`, `benchDiagnostics: true`, per-stage error
  codes (§14 of the brief), boot/USB transport logging.

Docs: `HARDWARE_VALIDATION.md`, `BENCH_M1B.md`, `MILESTONE_1B_REPORT.md`, updates to
`FIRMWARE_START_PLAN.md` and `firmware/README.md`. Studio: minimal diagnostics exposure of the
new commands, capability-gated. Twin: parity comes through MockKinoDevice.

## Hardware validation registry

`hardware_validation.[ch]`: fixed item table (`USB_SERIAL_JTAG`, `SD_CLK_GPIO43` … `SD_LDO_CH4`,
`CAM1_TX_GPIO52`, `CAM1_RX_GPIO51` (the measured JP1 7/9 pair; an intermediate revision of this plan
had them the other way round, as `CAM1_TX_GPIO1`/`CAM1_RX_GPIO2` from a different carrier's map),
`CAM1_BAUD_921600`, `CAM1_NODE_LINK`, `CAM1_SENSOR_DETECT`,
`CAM1_CAPTURE`, `CAM1_JPEG_TRANSFER`, `CAM1_SD_WRITE`), status
`UNVALIDATED | VALIDATED | FAILED | NOT_APPLICABLE`, persisted in NVS per unit. Compile-time
configuration is never validation: an item flips to `VALIDATED` only when the corresponding real
event happens on the device (a decoded host frame arrived over USB, the card mounted, the node
answered HELLO, a checksum-verified capture landed on SD). Firmware never marks `FAILED` on its
own — that verdict is the bench operator's, recorded by hand (see
`firmware/HARDWARE_VALIDATION.md`, which is the human bench record; the registry is the live
per-unit evidence behind it).

## Expected telemetry

Per diagnostic capture: `requestToNodeMs`, `captureCommandToJpegReadyMs`, `jpegTransferMs`,
`sdWriteMs`, `totalMs`; `NODE_JPEG_CHECKSUM` = `TRANSFER_CHECKSUM` = `STORED_FILE_CHECKSUM`
(CRC-32); P4 heap/PSRAM before/after; node heap/PSRAM; JPEG byte count. Soak summary:
attempted/successful/failed, error counters by class, min/max/avg for JPEG size and each timing
bucket, heap/PSRAM delta, node resets (session-change detection). No VSYNC or exposure figures
exist in this milestone; they are reported as absent, never fabricated.

## Blocking hardware assumptions (all UNVALIDATED until the bench)

1. USB-Serial-JTAG is reachable through a Guition USB-C port.
2. SD: CLK 43 / CMD 44 / D0–D3 39–42, on-chip LDO channel 4.
3. CAM1 UART pins reach the harness — `CAM1_TX` GPIO52 (JP1 pin 7), `CAM1_RX` GPIO51 (JP1 pin 9);
   921600 clean. (This item originally read GPIO52/51. Those pins are not on the header; the
   correction is in `docs/HARDWARE.md` §P4 header JP1.)
4. XIAO link pins GPIO43/44; ROM boot spew is survivable (decoder contract says yes).
5. Console on UART0 (GPIO37/38) does not collide with any of the above.

## Bench sequence

`firmware/BENCH_M1B.md` — P4-only → SD → CAM1 safe bring-up → single capture ×10 → soak 100,
then 500. Each stage records into `HARDWARE_VALIDATION.md`.

## Pass/fail

Pass only when, on our hardware: USB/KDP HELLO + reconnect ×10 clean; SD mount reliable across
10 reboots and `STORAGE_SELF_TEST` passes without touching user data; CAM1 boots, sensor PID
read, capture + transfer + store with three agreeing checksums, JPEG opens; ≥100 consecutive
clean soak captures (target 500) with no memory downtrend and no unexplained resets. Anything
less: the failing item goes to `FAILED` in `HARDWARE_VALIDATION.md` with the measured
replacement, and the milestone stays open.
