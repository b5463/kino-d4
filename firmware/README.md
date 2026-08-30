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
| `p4/host_tests/` | Nine host test binaries for P4 logic that needs no board: pure helpers, the Roll upload queue, the C6 state model, the radio report seam, the QR encoder, the META.JSON and UPLOAD.JSON mappings, `board_d4v1.h` against the measured JP1 header, and the hardware-validation predicates |
| `p4/host_preview/` | Renders the P4's UI screens to a file on the host, so layout and the QR can be looked at without a panel |
| `components/node_link/` | P4↔XIAO command namespace on the same framing |
| `p4/` | ESP-IDF app, target `esp32p4` — Guition JC4880P443C-I-W |
| `camnode/` | ESP-IDF app, target `esp32s3` — XIAO ESP32-S3 Sense |
| `c6/` | ESP-IDF app, target `esp32c6` — the radio coprocessor on the Guition carrier. Espressif's official ESP-Hosted coprocessor image, not KINO networking code: the C6 is a radio, not a second application brain. Flashed and running on `KD4-D121BC` since 2026-08-29 — read [`c6/README.md`](c6/README.md) before writing C6 flash on any other board |
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

`p4` and `camnode` build at `-O2` (`CONFIG_COMPILER_OPTIMIZATION_PERF`). For a
debugger-friendly `-Og` image add the overlay; nothing else differs:

```
idf.py -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.debug" build
```

A `sdkconfig` generated before firmware 0.4.2 keeps `-Og` until it is
regenerated (`idf.py fullclean`, or delete `sdkconfig`). Timing measured on a
debug build is not product timing; say which one a bench record came from.

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

## P4 host tests

The same shape, one level up: P4 logic that needs no board, nine binaries.

```
make -C firmware/p4/host_tests test-all
```

`test`, `test-queue`, `test-net`, `test-report`, `test-qr`, `test-pins` and
`test-hwv` need only a C compiler. `test-meta` and `test-store` compile against
ESP-IDF's own cJSON rather than a vendored copy that could drift from the one
the firmware links, so they want `IDF_PATH` set — run them inside the
`espressif/idf:v5.5.1` container, which is where CI builds the firmware anyway.
`make -C firmware/p4/host_tests test` is the subset that runs with nothing
installed. The Makefile header says what each target covers and why it is its
own target.

`firmware/p4/host_preview/` is next to them and is not a test: `make -C
firmware/p4/host_preview && ./preview out/` renders the camera's screens with
the firmware's own drawing code, so a layout or a join QR can be looked at
without a panel.

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
`kino.capture` META.JSON.

Much of this is bench-validated. [`HARDWARE_VALIDATION.md`](HARDWARE_VALIDATION.md)
is the record and the only authority on which row is which; as of 2026-08-29 it
carries the panel, touch, I²C bus and audio codec; the whole CAM1 path from
`CAM1_TX_GPIO52`/`CAM1_RX_GPIO51` at 921600 through sensor detect, capture,
JPEG transfer and SD write with matching CRCs; the SD card on slot 0; KDP over
USB-Serial-JTAG; and the C6 transport — SDIO enumeration, the `GPIO54` enable
line on the meter, the version gate at 3.0.6, Wi-Fi scan, association, DHCP,
DNS and SNTP, and `ROLL_CREATE` against a real backend.

What stays **UNVALIDATED**: CAM2–CAM4 (nothing is wired to them), inter-camera
exposure skew and everything else behind the sync gate, `SYNC_TRIGGER_GPIO32`
(driven, but no node reads the edge), `FLASH_EN_GPIO28` (routed, never driven
into a load, no flash board), the shutter and Fn buttons (no switch fitted),
`C6_TLS` (the API is not deployed), `SD_C6_COEXIST`, and `C6_ROLL_UPLOAD` — no
capture has reached a Roll from this body. Read the file rather than this
paragraph before making a claim.
