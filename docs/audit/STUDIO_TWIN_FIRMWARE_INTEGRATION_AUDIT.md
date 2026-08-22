# Studio + Twin + firmware integration audit

Updated 2026-08-22, issue #72. Every KDP command traced through
`firmware C → contract → TypeScript → Studio → Twin`, classified with the
brief's vocabulary. The firmware column refers to `firmware/p4/main/kdp_server.c`
at 0.1.0 (Milestone 1B); the Twin column refers to `MockKinoDevice` under the
**`d4-m1b` firmware profile** — the profile that emulates the shipped build.
Under the `d4-sim-full` profile the mock answers its whole demo surface,
which is labeled SIMULATED FUTURE and is not firmware parity.

## Classification

- **END_TO_END** — firmware implements it, contract documents it, types
  exist, Studio calls it, Twin's `d4-m1b` profile answers it identically.
- **MOCKED** — Studio and Twin exercise it fully against the reference
  device, but the firmware NACKs it (`UNSUPPORTED_COMMAND`); the milestone
  that implements it is noted. Twin's `d4-m1b` profile also NACKs it, so
  Studio-against-current-firmware behavior is testable without hardware.
- **PARTIAL** — implemented on both sides with a noted asymmetry.

Nothing surveyed classifies as FIRMWARE_ONLY, STUDIO_ONLY, TWIN_ONLY, or
BROKEN after this pass.

## END_TO_END (17 commands + 3 events)

| Command | Studio surface | Notes |
|---|---|---|
| `HELLO` 0x01 | connect flow (`session.ts`) | nonce echo, `boot-N` session, 3×500 ms budget |
| `GET_DEVICE_INFO` 0x02 | Device page, poller | offline cams report `""` firmware / `""` sensor on both sides |
| `GET_CAPABILITIES` 0x06 | capability gate (`deviceStore.supports`) | M1B advertises `benchDiagnostics` only; `maxUartBaud` 921600 |
| `GET_STORAGE_STATUS` 0x05 | Device page storage panel | 1B optional fields on both sides |
| `GET_CAMERA_INFO` 0x03 | Overview camera strip | CAM2–4 honestly `offline` |
| `CAMERA_STATUS` 0x30 | camera cards | |
| `CAMERA_TEST` 0x32 | Overview + Bench Diagnostics | full `CameraTestResult`: staged timing, three CRC-32 checksums, memory |
| `STORAGE_SELF_TEST` 0x47 | Bench Diagnostics | exact failing phase |
| `CAMERA_LINK_STATS` 0x48 / `_RESET` 0x49 | Bench Diagnostics | |
| `CAMERA_SOAK_TEST` 0x4a | Bench Diagnostics (async job) | `JOB_PROGRESS`/`JOB_COMPLETE` |
| `GET_HW_VALIDATION` 0x4b | Bench Diagnostics table | firmware registry is NVS-persisted per unit |
| `GET_RUNTIME_STATS` 0x43 | Developer P4 RUNTIME | real die temps or null — never invented |
| `GET_LOGS` 0x40 / `CLEAR_LOGS` 0x41 | Developer LogViewer | firmware 200-entry ring + live `LOG` events |
| `SELF_TEST` 0x42 | Overview SELF TEST panel | firmware runs its six real checks; the mock runs its eleven — counts are dynamic by design |
| `REBOOT` 0x52 | toolbar / Updates | answer first, reboot after; session changes |

Events end-to-end: `LOG` 0x80, `SELF_TEST` 0x84, `JOB_PROGRESS/COMPLETE/FAILED` 0x87–0x89.

Verified by `packages/test-fixtures/tests/firmwareIntegration.test.ts` (the
brief-§45 contract test) and, for the firmware side, by the M1/M1B host and
CI builds plus `firmware/BENCH_M1B.md` once hardware is on the bench.

## PARTIAL

| Item | Asymmetry |
|---|---|
| `Evt.CAPTURE` 0x85 | The mock emits it on every committed capture; M1B firmware deliberately does not emit it for single-camera test captures (the wire `kind` enum is `wiggle \| quad`). Arrives with real capture modes in milestone 2. |
| NACK code strings | Firmware says `CAMERA_OFFLINE`/`SENSOR_NOT_DETECTED` where the mock's legacy CAMERA_TEST guards say `CAM_OFFLINE`/`SENSOR_MISSING`. Both sides treat codes as strings; recorded in `firmware-contract/commands.md`. |
| `GET_DEVICE_INFO.activeRecipe` | Firmware reports `""` (no recipe system); mock reports the configured recipe. Honest on both sides for what each implements. |

## MOCKED — Studio+Twin complete, firmware pending

| Group | Commands | Firmware milestone |
|---|---|---|
| Power | `GET_POWER_STATUS` 0x04 | M4 (power telemetry) |
| Config | `GET/SET/SAVE/RESET_CONFIG` 0x10–0x13 | M2+ |
| Modes/recipes | 0x20–0x25 | M2+ (looks system) |
| Sounds | 0x26–0x2b | later |
| Camera ops | `CAMERA_ARM` 0x31, `CAMERA_CAPTURE` 0x33, `CAMERA_PREVIEW` 0x34, `CAMERA_CALIBRATE` 0x35 | M2 (multi-cam), calibration after |
| Timing | `CAMERA_PHASE` 0x36, `SYNC_BENCH` 0x46, `LINK_BENCH` 0x44, `SET_LINK_BAUD` 0x45 | M3 (sync bench) |
| Focus | `CAMERA_FOCUS` 0x37 | M5 (OV5640 AF) |
| Maintenance | 0x50/0x51, `FACTORY_RESET` 0x53 | M2+ |
| Firmware OTA | `FW_*` 0x60–0x65 | M7 — **note:** the Twin `d4-sim-full` profile implements the full OTA path with real SHA-256 verification, and installing a `0.1.0` P4 image switches the Twin to the honest `d4-m1b` profile |
| Media/gallery | `MEDIA_*` 0x70–0x75 | M2 (gallery capability) |
| Network/Roll | 0xa0–0xaa | M6 |

Events without any producer or consumer anywhere: `STATUS` 0x81,
`FW_PROGRESS` 0x82 (contract "unspecified", unchanged).

## The two capture paths (brief §14)

- **Physical-style**: Twin SHUTTER (Header / SCREEN tab) → private KDP client
  → `CAMERA_CAPTURE` → device capture → choreographed stages on the 3D view
  and the rear display → virtual sensors render all four views → real JPEGs
  land in the media store → `Evt.CAPTURE` → Studio gallery merge notice.
- **Studio-triggered**: `CAMERA_TEST` over the Studio link → same device,
  same virtual sensors for the m1b bench flow.
Both run over framed KDP bytes; neither touches simulator internals.

## Decorative-engineering pass (brief §47)

Removed/replaced this round: the rear display's synthetic "CAM2 PREVIEW ·
SIMULATED" crosshair now shows the live virtual-sensor render when one
exists (still labeled SIMULATED RENDER); capture assets are now real renders
instead of placeholder art whenever the Twin scene is running. Remaining
known simulations are labeled at the source: mock power/thermal numbers
(`SIMULATED` provenance tags), the demo device's synthesized gallery, the
lens FOV scenario (`MEASURE REQUIRED` physically). No fake progress bars,
no hardcoded success paths were found in the firmware-facing flows; the
builder panel shows only real step results and real SHA-256 digests.

## Hardware-validation honesty (brief §43)

`GET_HW_VALIDATION` + `firmware/HARDWARE_VALIDATION.md` stay the boundary:
USB port identity, SD pins/LDO, UART map remain UNVALIDATED until the bench
runs. The Twin's registry mirrors the same vocabulary and marks items
validated only for events that actually happened in simulation.
