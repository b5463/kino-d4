# Milestone 1B report

Status: **implementation complete, physical bench pending.** Everything a
machine can verify without the hardware is verified; every number that needs
the bench is marked pending, not estimated. Issue #66 carries the running
record.

## Implementation summary

- **KDP surface**: five new diagnostics commands (`STORAGE_SELF_TEST` 0x47,
  `CAMERA_LINK_STATS` 0x48, `CAMERA_LINK_STATS_RESET` 0x49,
  `CAMERA_SOAK_TEST` 0x4a as an async job, `GET_HW_VALIDATION` 0x4b), one new
  optional capability flag `benchDiagnostics` gating all of them, extended
  `GET_STORAGE_STATUS` and `CAMERA_TEST` payloads. Allocated in
  `packages/kdp/src/protocol/commands.ts`, typed in `types.ts`, documented in
  `firmware-contract/commands.md`, mirrored in
  `firmware/components/kdp_core/include/kdp/protocol.h`. `PROTOCOL_VERSION`
  stays 1 — all additions are compatible.
- **Measured capture pipeline (P4)**: ping → node capture → chunked transfer
  into PSRAM with streaming CRC-32 → SD write → stored-file read-back CRC.
  Three checksums must agree (`nodeJpegCrc32` = `transferCrc32` =
  `storedFileCrc32`); a mismatch is a NACK, never a "successful" capture.
  Per-stage wall-clock buckets; no bucket is exposure timing and the
  `kino.capture` skew block stays absent.
- **Storage**: `/KINO/CAPTURES/<capture-uuid>/C1.JPG + META.JSON` (FAT LFN
  enabled), NVS capture sequence in metadata, mount-attempt/last-error
  tracking, non-destructive 64 KB self-test reporting the exact failing phase.
- **Node (XIAO)**: HELLO now reports reset reason, chip revision, heap/PSRAM,
  baud, sensor PID, and sensor-model AF capability; CAPTURE returns the JPEG
  CRC-32 and post-capture memory; STATUS returns decoder counters. JPEG
  quality is a per-capture parameter.
- **Link stats (P4)**: frames/bytes both directions, CRC errors, resyncs,
  timeouts, duplicates, last sequence, last node boot reason, last error;
  resettable.
- **Hardware-validation registry**: 16 items, NVS-persisted per unit,
  auto-marked `VALIDATED` only by real events (first decoded USB frame, real
  mount, node HELLO, checksum-verified capture). Never auto-`FAILED`.
- **Soak job**: 1–1000 captures, batched `JOB_PROGRESS`, summary with per-
  bucket min/max/avg, error counts by code, node-reset detection via session
  change, heap/PSRAM delta. `keepAll:false` keeps first and last capture.
- **Reference device**: MockKinoDevice implements the whole group, honoring
  `sensor-missing`, `crc-noise`, `slow-uart`, `offline`, `sdMissing`,
  `sdFull`, reboot, and the new `memoryLeak` scenario. Twin gets all of it
  for free through its byte-pipe transport.
- **Studio**: `KinoDevice` facade methods, a capability-gated Bench
  Diagnostics panel on the Developer page (self-test, link stats, test
  capture, soak with progress + JSON export, hardware-validation table), and
  the storage panel now renders the 1B fields with "NOT REPORTED" on pre-1B
  firmware.

## Build results

| Artifact | Result |
|---|---|
| `kdp_core` host tests (WSL gcc 9.4) | **42 checks pass** — contract CRC fixtures, streaming-CRC equivalence, split/coalesced/boot-spew/resync cases |
| `firmware/p4` (espressif/idf:v5.5.1, esp32p4) | **builds clean** |
| `firmware/camnode` (espressif/idf:v5.5.1, esp32s3) | **builds clean** |
| `@kino/kdp`, `@kino/test-fixtures` tests | **114 pass**, including the new `benchDiagnostics.test.ts` suite |
| `@kino/studio` tests + `tsc` | **pass / clean** |
| `@kino/simulator-engine` tests, `@kino/twin` tsc | **43 pass / clean** |

## Bench procedure

[`BENCH_M1B.md`](BENCH_M1B.md): P4-only → SD → CAM1 safe bring-up → capture
×10 → soak 100 → soak 500. Each stage records into
[`HARDWARE_VALIDATION.md`](HARDWARE_VALIDATION.md).

## Hardware validation status

All 16 items **UNVALIDATED** — no physical run has happened. The USB port
identity, the SD pin/LDO map (CLK43/CMD44/D39-42/LDO ch4), and the CAM1 UART
pins (GPIO52/51) remain community/profile assumptions until the bench says
otherwise.

## Measured results — pending the bench

Timings, JPEG size statistics, SD write performance, reset reasons, and
memory behavior over a soak run are exactly what `CAMERA_TEST`,
`CAMERA_SOAK_TEST`, and `GET_HW_VALIDATION` exist to measure. No numbers are
reported here until they come from the physical unit; the mock's figures are
simulations for UI and contract testing, not measurements.

## Known failures / limitations

- Nothing runs on hardware yet; every risk in `MILESTONE_1B_PLAN.md`
  §Blocking assumptions is open.
- The 921600 baseline puts a 300–500 KB JPEG transfer at ~3.2–5.4 s. The
  `CAMERA_TEST` host timeout was raised to 8 s to keep the diagnostic honest;
  baud escalation is milestone 2 bench work.
- `GET_RUNTIME_STATS` still NACKs on firmware: its typed shape demands
  per-camera temperatures no sensor provides. P4 reset reason travels in
  `GET_HW_VALIDATION`, node reset reason in `CAMERA_LINK_STATS`.
- Code-string drift, recorded in the contract: mock's legacy CAMERA_TEST
  guards say `CAM_OFFLINE`/`SENSOR_MISSING` where firmware says
  `CAMERA_OFFLINE`/`SENSOR_NOT_DETECTED`.
- Soak failure artifacts are not retained (failed captures clean up their
  partial files); the log line is the record.

## Recommendation for Milestone 2

Do not start it. Run the bench first. When `HARDWARE_VALIDATION.md` is all
VALIDATED and a 100-capture (target 500) soak is clean with flat memory,
milestone 2 is: CAM2–CAM4 UART drivers behind the same `cam_link` interface,
per-channel link stats, parallel transfer into PSRAM, and `LINK_BENCH`/
`SET_LINK_BAUD` for the 1.5/2/3 Mbaud escalation — still no sync claims.
