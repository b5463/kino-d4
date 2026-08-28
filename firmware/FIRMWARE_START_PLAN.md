# Firmware start plan

Repository audit result and Milestone 1 task list for the KINO D4 V1 firmware. Written against
issue #66. The contract this firmware implements is `firmware-contract/`; where this plan and that
contract disagree, the contract wins.

## Existing reusable code

The repository contains no embedded source. What it does contain constrains the firmware exactly:

| Asset | Path | Use to firmware |
|---|---|---|
| Byte-level framing contract | `firmware-contract/kdp-framing.md` | The C decoder is written to it. Two CRC fixtures (`0x149bdd86`, `0x82d816e4`) are the first test vectors; both verified against zlib CRC-32 before any C existed |
| Command/event surface | `firmware-contract/commands.md`, `packages/kdp/src/protocol/commands.ts` | Numeric ids copied verbatim into `kdp_core`. `commands.ts` carries the note "keep in sync with firmware protocol.h" — that header now exists |
| Wire payload shapes | `packages/kdp/src/protocol/types.ts` | JSON field names for every implemented response |
| Portable documents | `packages/schemas/src/*`, `firmware-contract/schemas.md` | `META.JSON` on the SD card is a `kino.capture` v1 document |
| Reference device | `packages/test-fixtures/src/MockKinoDevice.ts` | Behavioral reference: NACK codes, session-id scheme (`boot-N`), payload defaults |
| Hardware profile | `packages/hardware-profiles/src/profiles/d4-v1.json` | Provisional P4 GPIO map and the XIAO DVP pin map, copied into one board header per target |
| Host protocol client | `packages/kdp/src/protocol/KinoProtocolClient.ts` | Defines the timeouts firmware must answer within (HELLO 3×500 ms, default 3 s) |

Studio, Twin, and the mock device already exercise this contract end to end, so firmware
correctness is testable against Studio before hardware exists in quantity.

## Missing architecture

Everything device-side: there is no firmware tree, no toolchain choice on record, no C
implementation of KDP, no P4↔XIAO link protocol, no board pin header. This plan fixes each.

## Directory structure

```
firmware/
  FIRMWARE_START_PLAN.md    this file
  README.md                 build and flash instructions
  VERSION                   single firmware version, checked by scripts/check-versions.mjs
  components/
    kdp_core/               portable C99 KDP framing: CRC-32, encoder, stream decoder.
                            No ESP-IDF dependency; host tests run under plain gcc.
      host_tests/           make test — contract fixtures, split/coalesced/boot-spew/resync
    node_link/              P4↔XIAO command ids and payload conventions (KDP framing reused)
  p4/                       ESP-IDF app, target esp32p4 (Guition JC4880P443C-I-W)
    main/board_d4v1.h       every P4 pin assignment, single place, PROVISIONAL until issue #2
  camnode/                  ESP-IDF app, target esp32s3 (XIAO ESP32-S3 Sense), one binary for all four nodes
    main/board_xiao_s3.h    every XIAO pin assignment, single place
```

Node identity is physical: the P4 knows CAM1–CAM4 by which UART the node hangs off. Camera nodes
run identical binaries and carry no stored index.

## Toolchains

| Target | Toolchain | Why |
|---|---|---|
| P4 | ESP-IDF v5.5.1 | Only toolchain with ESP32-P4 support. Arduino core and PlatformIO have none |
| XIAO ESP32-S3 | ESP-IDF v5.5.1, same tree | One IDF version for both targets; `espressif/esp32-camera` managed component drives the OV3660/OV5640 DVP bus |

Build without a local IDF install:

```
docker run --rm -v <repo>:/project -w /project/firmware/p4 espressif/idf:v5.5.1 idf.py build
docker run --rm -v <repo>:/project -w /project/firmware/camnode espressif/idf:v5.5.1 idf.py build
```

`kdp_core` host tests need only gcc and make (`firmware/components/kdp_core/host_tests`).

## Shared protocol decisions

- **One framing, two links.** The P4↔XIAO UART link reuses the KDP frame layout, CRC, and decoder
  from `kdp_core` with its own command namespace (`node_link`). Boot-spew tolerance, resync, and
  CRC protection come free on the camera UARTs; ESP-IDF's `crc32_le()` is the contract CRC.
- **JSON payloads on both links** via IDF's bundled cJSON. Binary payloads (JPEG chunks) use the
  existing `BINARY` flag rule.
- **Capability honesty.** The M1 build advertises `cameraCount: 4` (the hardware) with CAM2–CAM4
  reported `offline`, and every capability flag `false` until the feature exists. Unimplemented
  commands answer `UNSUPPORTED_COMMAND` — never a silent timeout.
- **Session id** is `boot-<NVS boot counter>`, never repeated across boots. Capture ids use a
  persistent NVS counter and a real UUIDv4 in `captureUuid`, never reused after reboot.
- **SD layout** (superseded during implementation — issue #90): the shipped M1B firmware writes
  `/KINO/CAPTURES/<uuid>/C1.JPG` plus `META.JSON` per capture (`firmware/p4/main/storage.c`),
  with `mode: "single"` documents. The `/DCIM/<FOLDER>` reference-device layout arrives with the
  gallery milestone.
- **Idempotent reads.** The host retries the 20 `RETRYABLE_READS` commands once with a fresh
  sequence id — every implemented read handler must tolerate arriving twice.
- **Unspecified contract items, M1 decisions** (firmware-contract README §Unspecified): HELLO is
  not required before other commands (matches the reference device); sequence ids are echoed
  verbatim including a wrapped uint32; `STATUS`/`FW_PROGRESS` events stay unproduced. Each becomes
  source in `commands.ts`/`types.ts` when a later milestone touches it.
- **No fabricated telemetry.** M1 has no VSYNC or exposure measurement, so `kino.capture` omits the
  whole `timing` block (contract D6: omit the block, never fake keys). The RTC is unset at the
  bench; `capturedAt` carries the device clock plus a passthrough `clockUnset: true` marker.

## KDP transport on the P4

Studio's V1 transport is USB serial at 921600. The P4 serves KDP on the USB-Serial-JTAG port
exclusively; the IDF console stays on UART0 so log output can never interleave into a KDP frame
mid-session. Boot spew ahead of the first HELLO is tolerated by the host decoder per contract.

## First compile target

`firmware/p4` building clean under `espressif/idf:v5.5.1`, followed by `firmware/camnode`.
Both are Milestone 1 gates and CI jobs.

## First hardware test

On the Guition board alone, no XIAO attached:

1. Flash `kino-p4.bin` (the artifact `firmware/p4` actually builds), connect Studio over USB.
2. HELLO answers inside the 3×500 ms retry budget with echoed nonce and a fresh `boot-N` session id.
3. `GET_CAPABILITIES` reports the honest M1 surface; an unimplemented command (e.g. `GET_RECIPES`)
   NACKs `UNSUPPORTED_COMMAND`.
4. `GET_STORAGE_STATUS` reflects the real TF card: present/absent, real MB figures.

Then attach one XIAO on the CAM1 UART — P4 `CAM1_TX` GPIO52 (JP1 pin 7) → XIAO RX GPIO44, P4
`CAM1_RX` GPIO51 (JP1 pin 9) ← XIAO TX GPIO43, GND on JP1 pin 5/6; header positions measured
per ECN-0002, electrically unproven per issue #2; the
GPIO52/51 pair this plan first named is not on the header — and run `CAMERA_TEST {cam:"cam1"}`:
sensor detected, JPEG captured, transferred, `C1.JPG` + `META.JSON` on the card, `CAPTURE` event
emitted. That is Milestone 1 complete and feeds directly into issue #3's bench sequence.

## Risk register

| Risk | Impact | Handling |
|---|---|---|
| Guition SD/TF and USB wiring undocumented in-repo | `GET_STORAGE_STATUS` and the KDP port may need pin changes | SD pins live in `board_d4v1.h` only; storage reports `present: false` honestly on mount failure instead of failing boot. Locked by issue #2 |
| P4 GPIO map provisional | UART/sync/flash pins may move after electrical validation | Single board header; no raw GPIO numbers elsewhere. Locked by issue #2. This risk fired once: the first map used GPIO52/51/50/49/34/33/30/29 for the UARTs and none of them is on JP1 (`docs/HARDWARE.md` §How the wrong map got in) |
| 921600 baud vs `CAMERA_TEST` 5 s host timeout | A 2048×1536 JPEG (~300–500 KB) needs 3.2–5.4 s to transfer | M1 captures at 1600×1200 (~2–3 s). Baud escalation (1.5/2/3 Mbaud) is bench work under `SET_LINK_BAUD`/`LINK_BENCH`, issue #3 |
| SW6106 light-load shutdown | Bench P4 may lose power at idle | Out of M1 scope; power telemetry lands with the flash milestone. `GET_POWER_STATUS` NACKs until real sensing exists — no fabricated battery numbers |
| OV5640 AF needs a sensor-side firmware blob | Autofocus milestone, licensing unclear | Deferred to milestone 5; sensor abstraction keys off the detected PID so OV3660 and OV5640 coexist now |
| No local ESP-IDF on the dev machine | Builds must be reproducible anyway | Docker image + CI job are the canonical build; WSL gcc runs the protocol tests |
| Boot ROM prints on XIAO UART0 pins at 115200 | Garbage on the camera link at node reset | The link decoder's resync path is the mechanism; covered by a dedicated host test |

## Milestone 1 tasks

1. ~~Repository audit, this plan, issue #66 filed and started.~~
2. `kdp_core`: CRC-32, frame encoder, stream decoder with `frames/crcFailures/resyncs/discardedBytes`
   counters. Host tests: both contract fixtures, byte-at-a-time feed, coalesced frames, boot spew,
   oversized-length resync, CRC-corrupt resync, trailing `0x4b` retention.
3. `node_link`: command ids (`NL_HELLO`, `NL_STATUS`, `NL_CAPTURE`, `NL_READ`, `NL_REBOOT`),
   payload conventions, chunked JPEG read.
4. `camnode` app: esp32-camera init, sensor PID detect (OV3660/OV5640), node state machine
   (`BOOTING → INITIALIZING_SENSOR → READY → EXPOSING → JPEG_READY → TRANSFERRING`), link server
   on UART1 at 921600, single-frame capture into PSRAM, chunked read-out.
5. `p4` app: USB-Serial-JTAG KDP server; HELLO/version negotiation/nonce echo/NACK path;
   `GET_DEVICE_INFO`, `GET_CAPABILITIES`, `GET_STORAGE_STATUS`, `GET_CAMERA_INFO`, `CAMERA_STATUS`,
   `CAMERA_TEST`, `REBOOT`; SDMMC mount and `/DCIM/<folder>/` writer; CAM1 link client task.
   No `CAPTURE` event for test captures — the wire `kind` enum is `wiggle | quad` only; the event
   arrives with real capture modes in milestone 2.
6. Both apps build clean in the IDF Docker image; CI job added.
7. Repo governance: `firmware/**` in `REUSE.toml` (MIT), `firmware` block in `versions.json`
   checked by `check-versions.mjs` against `firmware/VERSION`, ESP-IDF build artifacts in
   `.gitignore`, doc pointer in `docs/README.md`.
8. Bench validation of the first hardware test above — recorded in issue #66, feeding issue #3.

Milestones 2–7 (four nodes, sync/skew bench, flash, autofocus, Roll upload, OTA) follow the
kickoff order and each gets its own issue when its milestone starts. Nothing in M1 hardcodes a
four-camera assumption a later milestone would have to undo.

## Milestone 1B

Milestone 1 grew a bench-validation stage before the four-node work:
[`MILESTONE_1B_PLAN.md`](MILESTONE_1B_PLAN.md) (tasks and pass criteria),
[`BENCH_M1B.md`](BENCH_M1B.md) (physical procedure),
[`HARDWARE_VALIDATION.md`](HARDWARE_VALIDATION.md) (what our unit has proven).
It adds the `benchDiagnostics` KDP group (`0x47`–`0x4b`), a measured
CAMERA_TEST with three-way checksum verification, the `/KINO/CAPTURES/<uuid>/`
layout, the soak loop, and the per-unit hardware-validation registry.
Milestone 2 does not start until one camera path is boringly reliable on the
physical bench.
