# Camera pipeline — sensors, capture, synchronization, flash

The path from photons to stored frames, what is implemented, and the audited gaps. Normative behavior: `packages/simulator-engine/src`, `packages/test-fixtures/src/MockKinoDevice.ts`, `firmware-contract/commands.md`.

## Sensor architecture

`CAM → XIAO ESP32-S3 → P4`. Each XIAO owns one sensor; the P4 coordinates. Two sensor profiles exist as data (`d4-v1.json` `sensorProfiles`):

- **OV3660** — current, 3 MP, no AF. All present behavior.
- **OV5640_AF** — planned, 5 MP, VCM AF, AFVDD 2.8 V, `PROVISIONAL`.

Audit verdict: sensor identity is *reported* per camera (`DeviceInfo.sensors`, `CameraInfo.sensor`, nullable for the sensor-missing fault) but the reference device answers from literals rather than the profile, and no OV5640 behavior exists anywhere. That is correct for today's hardware and becomes work item AF-1 (issue tracker) when modules land.

## Autofocus model — required, not yet implemented

Status: **MISSING end to end** (no opcode, no capability key, no UI, no Twin state). The required model, recorded here so it is designed once:

- Focus modes: **PARTY AUTO** (AF before capture → lock → capture), **PARTY FIXED** (stored calibrated position for party distance), **MANUAL** (direct lens position).
- Wiggle flow: focus → lock → arm → capture. Continuous independent AF across four cameras is explicitly *not* the Wiggle behavior — four lenses hunting independently destroys frame-to-frame consistency.
- Per-cam state to expose: focus state, VCM position, estimated distance, AF success/failure, lock status.
- Faults to inject: per-cam AF failure, VCM stuck, AF timeout, divergent focus positions, AF hunting.
- Capability keys: `camera.autofocus`, `camera.focus_lock`, `camera.manual_focus` — absent capability means the whole surface disappears (OV3660 firmware).

Nothing here may be built as OV5640-hardcoded; it keys off capabilities.

## Capture synchronization

The sensors are free-running rolling-shutter devices. A shared trigger edge does not synchronize exposure; each XIAO coordinates the capture against its own sensor stream. The implementation honors this: capture choreography orders exposure by per-cam VSYNC phase, SYNC_BENCH reports per-trigger `gpioUs` / `vsyncPhaseUs` / `exposureUs` spreads separately, Studio's Skew Bench grades effective exposure spread against bands (excellent < 0.5 ms … a full frame ≈ 33 ms unaligned), and unmeasurable values carry a `null` + reason.

Audited simplifications: the engine's exposure timing ignores GPIO skew (phase only); trigger latency in the mock is a seeded random draw; rolling-shutter row timing is a bounded fudge with no row-rate model. All acceptable pre-hardware, all flagged for replacement by measured distributions (validation plan).

## Flash as temporal freeze

Flash can establish a common visual moment across four rolling shutters when the pulse overlaps every camera's illuminated exposure window — an approximation whose worth depends on ambient light and timing, never a claim of global shutter.

Implemented: per-cam pulse-vs-readout timeline (Twin FLASH panel), coverage/banding computation, three drive levels as power draw. Audited gaps: readout window currently equals the whole frame interval (no exposure-time model, so overlap math is optimistic), no ambient/intensity term, flash delay/duration are UI state rather than device config, and Studio has no flash-timing bench (its flash calibration measures highlight clipping only). The exposure-window model plus a flash overlap bench is the P1 follow-up; the physical pulse shape is on the validation plan.

## Frame path

XIAO captures + encodes JPEG → UART transfer to P4 (concurrent across four links, sequential per link) → SD under `/DCIM` → Studio tether or Wi-Fi upload to Roll. Originals are immutable from the moment they land (see `PHOTO_PIPELINE.md`). Incomplete four-frame sets are marked incomplete, never faked.
