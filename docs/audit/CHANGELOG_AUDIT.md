# Audit changelog — everything changed by audit #51

Branch `master-audit`, 2026-08-21.

## Code fixes

1. **Firmware verification made real (P0).** `MockKinoDevice` now assembles the received image by offset and hashes it at `FW_END`; a mismatch against the `FW_BEGIN` declaration rejects with `SHA256_MISMATCH`, flashes nothing, and reports the error state. Previously it answered `verified: true` without hashing. New dependency-free synchronous SHA-256 (`packages/test-fixtures/src/sha256.ts`, vector-tested). Out-of-range chunks now NACK `BAD_OFFSET`. Tests: `packages/test-fixtures/tests/fwVerify.test.ts`.
2. **Backup credential leak closed (P0).** `buildBackup` strips the whole `config.roll` block (the type's own contract said credentials never persist in Studio); `validateBackup` also strips it from older files so a restore can never post Roll identity back through `SET_CONFIG`. Backups now record `cameraFirmware`, `protocol`, and `configSchemaVersion`. Tests added.
3. **Honest transport labels (P1).** Toolbar/Sidebar now label three ways — `· USB` / `· KINO TWIN` (`· TWIN`) / `· DEMO DEVICE` — a Twin session previously displayed as USB hardware.
4. **FLASH health lamp de-faked (P1).** Overview's hardcoded green `FLASH READY` is now capability-driven (`flashControl` → CONTROL AVAILABLE / NOT AVAILABLE / —); it no longer claims a health it cannot measure.
5. **Conformance classification fix (P2).** Unsupported commands raise `KinoUnsupportedError`; the conformance runner only matched a legacy error code, reporting every genuinely unsupported command as `error`. Now classified `unsupported`.

## Hardware data landed (all `PROVISIONAL`/`OFFICIAL_SPEC`, labelled)

- `d4-v1.json`: provisional P4 GPIO assignments (§9 of the spec — CAM1–4 UARTs, SYNC GPIO32, FLASH_EN GPIO28, CAM_PWR_EN GPIO31; per-channel power pins left null pending hardware), physical `header2x13` left/right table with reserved C6 pins, XIAO `dvpPinMap` (OFFICIAL_SPEC), `sensorProfiles` (OV3660 current / OV5640_AF planned with AFVDD 2.8 V, 2592×1944, MJY5OAF-F3M-V1 family).
- `docs/HARDWARE.md`: new §P4 header and provisional pin assignments, §XIAO camera interface; camera-row records the planned OV5640 upgrade.

## Documents created (`docs/audit/`)

AUDIT.md (compliance matrix + 48-question validation) · HARDWARE_CONTRACT.md · KDP_PROTOCOL.md · CAMERA_PIPELINE.md · POWER_MODEL.md · TWIN_SPEC.md · STUDIO_SPEC.md · PHOTO_PIPELINE.md · AI_PROCESSING.md · ROLL_INTEGRATION.md · CALIBRATION.md · HARDWARE_VALIDATION_PLAN.md · TEST_PLAN.md · this file.

## Issues filed

#55 OV5640/AF architecture · #56 exposure-window + flash bench · #57 power model unification · #58 protocol hardening + contract suite · #59 provenance + render consistency · #60 config migrations + restore identity · #61 Studio production gaps · #62 AI providers/consent/modes · #63 Twin data consumers (pins, materials, optical centers, 16340 profile).

## Implementation waves (same day, after the audit merged)

The owner directed "apply all fixes". Four waves, each merged after green CI:

- **Wave A — PR #65** (#58, #60): idempotent-read retry with fresh sequence numbers; three-state fail-closed capability gate; client-side frame-version rejection; duplicateFrame/droppedByte/midFrameDisconnect/baudMismatch device faults; Twin transport re-chunking parity; one shared contract sequence over both transports; restore serial/hardware mismatch warning.
- **Wave B — PR #67** (#55, #56, #57): CAMERA_FOCUS behind autofocus capabilities with PARTY AUTO/FIXED/MANUAL, per-cam focus state, four AF faults, Studio FOCUS panel, Twin display AF states; per-camera SIMULATED exposure windows with flashBandRisk in the protocol package and a Studio FLASH TIMING bench; one battery truth (engine SoC follows the device), charger scenario, SW6106 shutdown and capture-brownout faults, 5 V droop curve, 18 W class warning.
- **Wave C — PR #68** (#59, #62): captures.provenance (passthrough remainder + device identity at shutter press), assets.producer/produced_at from the derive choke point (migration 0008); EnhanceProvider contract and resolveAiDecision gate — OFF default, external refused without consent.
- **Wave D — PR #69** (#61, #63 subset): calibration report export / offsets-only import; firmware downgrade guard; PowerStatus busV/chargingA/fuse with an honest 5 V rail row; per-cam temperature on camera cards; Twin PINS tab consuming header/gpio/DVP data; massG/material and opticalCenterOffsetMm schema fields.

Remaining scope is recorded on the issues themselves: #59 (worker render consistency — blocked on firmware sending calibration in capture meta), #61 (photo import, armed state, Wi-Fi/Roll health rows, SD write bench — the last in flight as #66), #62 (first provider implementation + per-roll modes), #63 (16340 alternate profile, thermal properties), #55 (real AF once OV5640 modules are benched).
