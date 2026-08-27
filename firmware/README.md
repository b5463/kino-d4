# KINO D4 firmware

Production firmware for the KINO D4 camera: one ESP32-P4 main controller
(`p4/`), one ESP32-S3 binary shared by all four camera nodes (`camnode/`), and
the ESP32-C6 radio coprocessor image (`c6/`).
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
| `c6/` | ESP-IDF app, target `esp32c6` — the radio coprocessor on the Guition carrier. Espressif's official ESP-Hosted coprocessor image, not KINO networking code: the C6 is a radio, not a second application brain. Never flashed to a board yet — read [`c6/README.md`](c6/README.md) before writing C6 flash |
| `uvc-preview/` | Bench tool, target `esp32s3` — makes one XIAO a USB webcam so a camera module can be judged before any harness exists. Never ships in a camera |
| `VERSION` | The firmware version, checked by `npm run version:check` |
| `C6_HARDWARE_MAP.md` | The P4↔C6 routing, its evidence chain, and what is still unmeasured |
| `C6_BRINGUP.md` | The order to bring the radio up in, and the recovery drills that get skipped |

Pin maps live in exactly two files: `p4/main/board_d4v1.h` and
`camnode/main/board_xiao_s3.h`. `c6/` declares none — the C6's SDIO slave pads
are fixed in silicon and its own transport config comes from the ESP-Hosted
component, so a second copy would only be somewhere to drift. `uvc-preview` includes the latter rather than
declaring pins of its own — a bench tool that disagreed with the product
firmware about a GPIO would be worse than no bench tool. Assignments are PROVISIONAL until issue #2
locks them electrically.

## Build

Toolchain: ESP-IDF v5.5.1. Building needs no local install — the Docker image
is the canonical build environment (run from the repo root):

```
docker run --rm -v "$PWD:/project" -w /project/firmware/p4      espressif/idf:v5.5.1 idf.py build
docker run --rm -v "$PWD:/project" -w /project/firmware/camnode espressif/idf:v5.5.1 idf.py build

# The radio coprocessor image. Builds today; has never been flashed. Read
# c6/README.md first — the C6 module's flash size is unknown and an oversized
# FLASHSIZE flashes and then fails to boot.
docker run --rm -v "$PWD:/project" -w /project/firmware/c6      espressif/idf:v5.5.1 idf.py build

# Bench tool, same container (see uvc-preview/README.md before flashing it: the
# USB-C port becomes a webcam, so reflashing needs BOOT + RESET).
docker run --rm -v "$PWD:/project" -w /project/firmware/uvc-preview espressif/idf:v5.5.1 idf.py build
```

On Linux add `--user "$(id -u):$(id -g)"` or `build/` ends up root-owned.
Studio can drive the same build through `npm run firmware:daemon`
(docs/FIRMWARE_BUILDER.md).

`camnode` pulls `espressif/esp32-camera` (pinned 2.1.7, resolved versions in
the committed `dependencies.lock`) from the component registry on first build
(network required once; `managed_components/` is git-ignored).

Flashing DOES need a local ESP-IDF (or esptool) install — the container
cannot reach the serial port on Windows/macOS. From a machine with the board
attached and IDF v5.5.1 installed:

```
idf.py -p <port> flash monitor
```

or with a standalone esptool: `esptool.py --chip esp32p4 -p <port> write_flash "@build/flash_args"` from `firmware/p4/build`.

## Protocol tests

Runs on the host with make + gcc (Windows: inside WSL), from the repo root:

```
make -C firmware/components/kdp_core/host_tests test
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
registry, persisted in NVS). `GET_RUNTIME_STATS` (real on-chip temperatures
or null, live protocol counters), `GET_LOGS`/`CLEAR_LOGS` + `LOG` events
(200-entry structured ring), and a six-check `SELF_TEST` with events are
also implemented. Everything else answers `UNSUPPORTED_COMMAND`;
every other capability flag is `false`. CAM1 is the only wired node;
CAM2–CAM4 report `offline`. Captures land in `/KINO/CAPTURES/<uuid>/` with a
`kino.capture` META.JSON. Nothing is bench-validated yet — see
`HARDWARE_VALIDATION.md`.
