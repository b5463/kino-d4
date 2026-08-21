# KINO D4 firmware

Production firmware for the KINO D4 camera: one ESP32-P4 main controller
(`p4/`) and one ESP32-S3 binary shared by all four camera nodes (`camnode/`).
Both implement the contract in [`firmware-contract/`](../firmware-contract/README.md).
The plan and audit behind this tree is [`FIRMWARE_START_PLAN.md`](FIRMWARE_START_PLAN.md);
the current milestone is [`MILESTONE_1B_PLAN.md`](MILESTONE_1B_PLAN.md), its bench
procedure [`BENCH_M1B.md`](BENCH_M1B.md), and the bench record
[`HARDWARE_VALIDATION.md`](HARDWARE_VALIDATION.md).

## Layout

| Path | Contents |
|---|---|
| `components/kdp_core/` | Portable C99 KDP framing: CRC-32, encoder, stream decoder. No ESP-IDF dependency |
| `components/kdp_core/host_tests/` | Contract-fixture tests, run under plain gcc |
| `components/node_link/` | P4↔XIAO command namespace on the same framing |
| `p4/` | ESP-IDF app, target `esp32p4` — Guition JC4880P443C-I-W |
| `camnode/` | ESP-IDF app, target `esp32s3` — XIAO ESP32-S3 Sense |
| `VERSION` | The firmware version, checked by `npm run version:check` |

Pin maps live in exactly two files: `p4/main/board_d4v1.h` and
`camnode/main/board_xiao_s3.h`. Assignments are PROVISIONAL until issue #2
locks them electrically.

## Build

Toolchain: ESP-IDF v5.5.1. No local install needed — the Docker image is the
canonical build environment:

```
docker run --rm -v <repo>:/project -w /project/firmware/p4      espressif/idf:v5.5.1 idf.py build
docker run --rm -v <repo>:/project -w /project/firmware/camnode espressif/idf:v5.5.1 idf.py build
```

`camnode` pulls `espressif/esp32-camera` from the component registry on first
build (network required once; `managed_components/` is git-ignored).

Flash from a machine with the board attached:

```
idf.py -p <port> flash monitor
```

## Protocol tests

```
make -C components/kdp_core/host_tests test
```

Runs the framing contract fixtures (HELLO CRC `0x149bdd86`, minimum-frame CRC
`0x82d816e4`), split/coalesced frames, boot spew, CRC corruption, oversized
length, and trailing-magic resync cases under plain gcc.

## Milestone state

Milestone 1B (issue #66): P4 serves HELLO, GET_DEVICE_INFO, GET_CAPABILITIES,
GET_STORAGE_STATUS, GET_CAMERA_INFO, CAMERA_STATUS, REBOOT, plus the bench
diagnostics group gated by the `benchDiagnostics` capability:
`CAMERA_TEST` (measured stages, three agreeing CRC-32 checksums, memory
stats), `STORAGE_SELF_TEST`, `CAMERA_LINK_STATS(_RESET)`,
`CAMERA_SOAK_TEST` (async job), `GET_HW_VALIDATION` (per-unit runtime
registry, persisted in NVS). Everything else answers `UNSUPPORTED_COMMAND`;
every other capability flag is `false`. CAM1 is the only wired node;
CAM2–CAM4 report `offline`. Captures land in `/KINO/CAPTURES/<uuid>/` with a
`kino.capture` META.JSON. Nothing is bench-validated yet — see
`HARDWARE_VALIDATION.md`.
