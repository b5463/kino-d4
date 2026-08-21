# KDP commands and events

Every command and event id, with direction and payload shape. Numeric values are extracted from
`packages/kdp/src/protocol/commands.ts` and are normative. Framing is in [`kdp-framing.md`](kdp-framing.md).

Payload shapes are marked:

- **typed** — an interface exists in `packages/kdp/src/protocol/types.ts` (or `timing.ts`). Compile-time enforced on the host.
- **inline** — the shape is declared at the call site in `apps/studio/src/device/KinoDevice.ts`. Typed, but only there.
- **mock** — the shape exists only in `packages/test-fixtures/src/MockKinoDevice.ts`, the reference device. Match it, but it has no type behind it.

## Value map

```
0x01–0x06  Discovery          0x50–0x53  Maintenance
0x10–0x13  Configuration      0x60–0x65  Firmware
0x20–0x25  Modes / recipes    0x70–0x75  Media
0x26–0x2b  Sounds             0x80–0x89  EVENTS (device→host, unsolicited)
0x30–0x37  Camera             0xa0–0xaa  Network / Roll / upload queue
0x40–0x4b  Diagnostics
```

The Network/Roll group sits above the event range on purpose: a command id and an event id can never
collide in a protocol trace. Do not allocate new commands into `0x80`–`0x89`.

> **Name collision: `SELF_TEST` exists in both enums.** `Cmd.SELF_TEST` = `0x42` (host asks the device
> to run the suite); `Evt.SELF_TEST` = `0x84` (device reports each check as it completes). Different
> ids, different directions, same identifier. Namespace them in firmware — `CMD_SELF_TEST` /
> `EVT_SELF_TEST` — rather than relying on context.

## HELLO

`HELLO` = `0x01`. First frame on every connection.

Request (**typed**, `HelloRequest`):

```json
{ "protocolMin": 1, "protocolMax": 1, "nonce": 3735928559, "client": "studio 0.4.0" }
```

Response (**typed**, `HelloResponse`):

```json
{
  "product": "KINO",
  "protocol": 1,
  "nonce": 3735928559,
  "deviceId": "kino-000012",
  "sessionId": "boot-1"
}
```

| Field | Required | Rule |
|---|---|---|
| `product` | yes | Free-form product string |
| `protocol` | yes | The single protocol the device selected out of `[protocolMin, protocolMax]` |
| `nonce` | optional | Echo of the request nonce |
| `deviceId` | optional | Stable identity of the unit, constant across boots |
| `sessionId` | optional | New value on every boot. String or number; the host stringifies it |

Host behavior firmware must plan for (`KinoProtocolClient.hello`):

- **3 attempts**, 500 ms timeout each, 150 ms between them. A device still printing its boot banner
  gets three chances.
- **Silence** → retry.
- **Wrong nonce echo** → retry. A reply echoing a stale nonce is answering an older request and
  proves nothing about the device being alive now. **Omitting `nonce` entirely is tolerated**; echoing
  the wrong one is not.
- **`protocol` outside the offered range, or not a number** → hard failure, no retry. Retrying cannot
  change the answer.

Optional fields exist for firmware that predates 04§17. New firmware sends all five.

> The Studio facade `KinoDevice.hello()` sends only `{nonce}`. `KinoProtocolClient.hello()` sends the
> full 04§4 request and is the one that runs on connect. Firmware must tolerate a HELLO payload
> carrying only `nonce`.

## Session change

`sessionId` is the boot ID (04§17). Rules:

- A **new** `sessionId` on any HELLO where the host already knew one means the device rebooted.
- Everything scoped to the old boot is dead: the host fails every in-flight job with
  `SESSION_CHANGED` before notifying anything else, then raises a session-change event.
- Firmware must therefore **never reuse a session ID across boots**, and must not carry job state,
  upload progress or upload/firmware session handles across a reboot.
- A device that omits `sessionId` is treated as pre-§17 firmware: no change is ever detected.

The reference device uses `boot-1`, `boot-2`, … Any scheme works as long as it differs per boot.

## Capability negotiation

`GET_CAPABILITIES` = `0x06`. Studio must never assume a command exists.

Response (**typed**, `CapabilitiesResponse`):

```json
{
  "protocol": 1,
  "hardware": "kino-v1",
  "firmware": "0.1.0",
  "capabilities": {
    "cameraCount": 4,
    "wiggle": true, "quad": true, "gallery": true, "flashControl": true,
    "vsyncTelemetry": true, "phaseCalibration": true,
    "xiaoProxyUpdate": true, "linkBench": true, "customSounds": true,
    "autofocus": false, "focusLock": false, "manualFocus": false
  },
  "limits": {
    "maxUartBaud": 3000000,
    "currentUartBaud": 921600,
    "maxResolution": "2048x1536",
    "maxGalleryPageSize": 100
  },
  "configSchemaVersion": 1
}
```

`Capabilities` in `types.ts` declares `cameraCount` (a count, not a flag) plus the nine boolean flags
above. The reference device additionally reports
`rollUpload`, `network` and `syncBench` (**mock**) gating the `0xa0`–`0xa9` group and `SYNC_BENCH`.
Those three are not yet in the `Capabilities` interface.

**A capability flag and the dispatcher must agree.** A device that advertises no network support and
then answers `NETWORK_LIST` is worse than a device with no network support at all.

There is no `GET_CONFIG_SCHEMA` command — `configSchemaVersion` in this response is the config schema
version (see [README D8](README.md#d8--command-surface-differs-from-spec-047s-name-lists)).

## NACK

04§6: **never silently time out.** An unimplemented or refused command gets a frame with flags
`RESPONSE | ERROR` (`0x05`), the request's `TYPE` and `SEQUENCE` echoed, and this payload
(**typed**, `ProtocolError`):

```json
{ "code": "UNSUPPORTED_COMMAND", "message": "Command CAMERA_PHASE not implemented in firmware 0.1.0" }
```

Both fields are strings. The host defaults `code` to `"ERROR"` and `message` to `"Device error"` if
either is missing, but do not rely on that.

### Reason codes

Spec 04§6 defines the standard set. **Use these names for these conditions:**

| Code | Condition |
|---|---|
| `UNSUPPORTED_COMMAND` | This firmware does not implement the command |
| `INVALID_STATE` | Valid command, wrong moment (e.g. `ROLL_CREATE` while already on a roll) |
| `INVALID_ARGUMENT` | Payload failed validation |
| `BUSY` | A conflicting operation is already running |
| `STORAGE_FULL` | Out of space |
| `HARDWARE_ERROR` | A subsystem failed |
| `VERSION_MISMATCH` | Version/compatibility refusal |
| `CHECKSUM_FAILED` | Integrity check failed |

`UNSUPPORTED_COMMAND` is the **only code with special host behavior**: it raises
`KinoUnsupportedError` and Studio renders "not supported by firmware x.y.z". Every other code becomes
a generic `KinoCommandError` carrying the code and message through to the UI. So an unrecognized code
is never fatal — but it is also never actionable.

Codes the reference device emits beyond the spec set. Not spec-normative; listed so firmware can
reuse rather than reinvent:

```
BAD_VERSION  BAD_BAUD  BAD_ID  BAD_OFFSET  BAD_ORDER  BAD_SESSION  BAD_SIZE
CAMERA_OFFLINE  CAM_UNREACHABLE  FACTORY_LOCKED  FLASH_WRITE  MAINT_REQUIRED
MEDIA_ERROR  NOT_FOUND  NO_SESSION  PREVIEW_FAILED  SD_MISSING  SHORT_IMAGE
SHORT_SOUND  SOUND_SLOTS_FULL  UNKNOWN_CMD  SCHEMA_MISMATCH
```

Codes generated **host-side**, never sent on the wire — do not implement them:
`JOB_NOT_ACCEPTED`, `JOB_SUPERSEDED`, `SESSION_CHANGED`, `DISCONNECTED`.

## Command reference

Default host timeout is **3000 ms** unless noted. `→` is the request payload, `←` the response.

### Discovery — 0x01–0x06

| Cmd | Value | Payload |
|---|---:|---|
| `HELLO` | `0x01` | See [HELLO](#hello). Host timeout 500 ms, 3 attempts |
| `GET_DEVICE_INFO` | `0x02` | → `{}` ← **typed** `DeviceInfo` |
| `GET_CAMERA_INFO` | `0x03` | → `{}` ← **inline** `{ "cameras": CameraInfo[] }` |
| `GET_POWER_STATUS` | `0x04` | → `{}` ← **typed** `PowerStatus` |
| `GET_STORAGE_STATUS` | `0x05` | → `{}` ← **typed** `StorageStatus` |
| `GET_CAPABILITIES` | `0x06` | → `{}` ← **typed** `CapabilitiesResponse`, see above |

`DeviceInfo`:

```json
{
  "product": "KINO", "hardware": "V1", "serial": "KINO000012", "protocol": 1,
  "p4Firmware": "0.1.0",
  "cameraFirmware": ["0.1.0","0.1.0","0.1.0","0.1.0"],
  "sensors": ["OV3660","OV3660","OV3660","OV3660"],
  "sdPresent": true, "sdFreeMB": 27431,
  "activeMode": "wiggle", "activeRecipe": "party-neg"
}
```

`CameraInfo` (one per camera):

```json
{
  "id": "cam1", "online": true, "sensor": "OV3660", "sensorDetected": true,
  "firmware": "0.1.0", "state": "ready", "latencyMs": 4.2, "uartErrors": 0,
  "lastCapture": { "ageS": 62, "jpegKB": 412, "durationMs": 190, "gpioSkewUs": 180 }
}
```

`state` ∈ `ready | busy | capturing | updating | rebooting | timeout | offline | error`.
`lastCapture` is `null` when there is none. **`gpioSkewUs` is trigger-edge distribution only — it is
not exposure alignment.** See [Timing](#timing).

`PowerStatus`: `{ "batteryV": 4.02, "batteryPct": 80, "state": "battery|usb|charging", "charging": false }`
`StorageStatus`: `{ "present": true, "totalMB": 30432, "freeMB": 27431 }`

### Configuration — 0x10–0x13

| Cmd | Value | Payload |
|---|---:|---|
| `GET_CONFIG` | `0x10` | → `{}` ← **typed** `ConfigEnvelope` |
| `SET_CONFIG` | `0x11` | → **typed** `{ "schemaVersion": 1, "config": Partial<KinoConfig> }` ← **mock** `{ "ok": true, "configRevision": 4 }` |
| `SAVE_CONFIG` | `0x12` | → `{}` ← **mock** `{ "ok": true }` — commits to NVS |
| `RESET_CONFIG` | `0x13` | → `{}` ← **mock** `{ "ok": true }` |

`ConfigEnvelope`:

```jsonc
{
  "schemaVersion": 1,
  "device": "kino-v1",
  "configRevision": 3,
  "config": { /* KinoConfig — five sections, see below */ }
}
```

- `SET_CONFIG` carries a **partial** config and the device deep-merges it. There is no `PATCH_CONFIG`.
- `configRevision` increments on **every accepted write**, and is the host's staleness check.
- A `schemaVersion` the device does not implement is refused with `SCHEMA_MISMATCH` (reference
  device). `schemaVersion` absent is tolerated.
- Studio always sends `SET_CONFIG` then `SAVE_CONFIG`. A `SET_CONFIG` that is never saved must not
  survive a reboot.

`KinoConfig` has five sections — `mode`, `wiggle`, `quad`, `shoot`, `body` — fully typed in
`types.ts`. Not reproduced here; the interfaces are the contract.

### Modes and recipes — 0x20–0x25

Spec 04§7 calls these `*_LOOK`; source calls them `*_RECIPE`. Note the layer split: these wire
commands and their `recipe*` payload fields keep the recipe name, but the **`kino.capture` document
field is `look`** — writing `recipe` there parses clean and silently loses the reference. See
[README D1](README.md#d1--recipe-vs-look-one-concept-two-names-split-by-layer).

| Cmd | Value | Payload |
|---|---:|---|
| `GET_MODES` | `0x20` | → `{}` ← **mock** `{ "modes": ["wiggle","quad"] }`. No Studio caller |
| `SET_MODE` | `0x21` | → `{ "mode": "wiggle" \| "quad" }` ← **mock** `{ "ok": true }` |
| `GET_RECIPES` | `0x22` | → `{}` ← **typed** `RecipesResponse` = `{ "factory": Recipe[], "custom": Recipe[] }` |
| `SET_RECIPE` | `0x23` | → `{ "id": "party-neg" }` ← **mock** `{ "ok": true }` |
| `UPLOAD_RECIPE` | `0x24` | → `{ "recipe": {...} }` ← **mock** `{ "ok": true }` |
| `DELETE_RECIPE` | `0x25` | → `{ "id": "my-look" }` ← **mock** `{ "ok": true }` |

The recipe document itself is **deliberately not part of the protocol contract** — `RecipesResponse<R>`
is generic and the app defines `R`. The device stores and returns recipes opaquely; it validates them
(reference device answers `INVALID_ARGUMENT` on a malformed recipe) but does not interpret them here.

Factory recipes are immutable: overwriting or deleting one answers `FACTORY_LOCKED` (**mock**).

### Sounds — 0x26–0x2b

Not in spec 04§7 — a repo addition. Gated by the `customSounds` capability. Clips are stored as
16 kHz mono 16-bit WAV; the host converts before upload.

| Cmd | Value | Payload |
|---|---:|---|
| `GET_SOUNDS` | `0x26` | → `{}` ← **typed** `SoundsResponse` = `{ "custom": SoundInfo[], "maxCustom": 8, "maxSoundKB": 128 }` |
| `SOUND_BEGIN` | `0x27` | → **typed** `SoundBeginRequest` ← **typed** `SoundBeginResponse` = `{ "sessionId": 501, "chunkSize": 8192 }`. Timeout 8 s |
| `SOUND_CHUNK` | `0x28` | → **BINARY**, 8-byte `sessionId`/`offset` header + data ← **inline** `{ "ok": true, "received": 8192 }`. Timeout 8 s |
| `SOUND_END` | `0x29` | → `{}` ← **inline** `{ "ok": true, "sound": SoundInfo }`. Timeout 8 s |
| `SOUND_READ` | `0x2a` | → `{ "id": "snd-ding", "offset": 0, "length": 8192 }` ← **BINARY** raw WAV bytes. Timeout 8 s |
| `SOUND_DELETE` | `0x2b` | → `{ "id": "snd-ding" }` ← **mock** `{ "ok": true }` |

`SoundInfo` = `{ "id": "snd-ding", "name": "ding", "sizeBytes": 10284, "durationMs": 320 }`.
`SoundBeginRequest` is the same four fields.

Session rules (reference device): one upload at a time (`BUSY`); a chunk with a stale `sessionId`
gets `BAD_SESSION`; a chunk past the announced size gets `BAD_OFFSET` **and aborts the session**;
`SOUND_END` before all bytes arrive gets `SHORT_SOUND`. Builtin ids
(`click`, `cheap-digi`, `tiny-beep`, `mechanical`, `silent`) cannot be overwritten — `BAD_ID`.
Deleting the currently selected shutter sound must fall back to a builtin and bump `configRevision`.

### Camera — 0x30–0x37

| Cmd | Value | Payload |
|---|---:|---|
| `CAMERA_STATUS` | `0x30` | → `{ "cam": "cam1" }` ← **typed** `CameraInfo`. Timeout 2 s |
| `CAMERA_ARM` | `0x31` | → `{}` ← **mock** `{ "ok": true }`. No Studio caller |
| `CAMERA_TEST` | `0x32` | → `{ "cam": "cam1" }` ← **inline** `{ "ok": true, "jpegKB": 412, "durationMs": 190 }`. Timeout 5 s |
| `CAMERA_CAPTURE` | `0x33` | Action-dispatched, see below. Timeout 8 s |
| `CAMERA_PREVIEW` | `0x34` | → `{ "cam": "cam2" }` or `{}` for the configured viewfinder ← **BINARY** one JPEG frame. Timeout 4 s |
| `CAMERA_CALIBRATE` | `0x35` | Action-dispatched, see below |
| `CAMERA_PHASE` | `0x36` | Action-dispatched, see below. Gated by `phaseCalibration` |
| `CAMERA_FOCUS` | `0x37` | Action-dispatched: `trigger` (AF sweep on every AF camera, replies with per-cam focus results), `lock` `{ locked }`, `set` `{ cam, position 0–255 }` (gated by `manualFocus`; `VCM_STUCK` when the lens cannot move), `mode` `{ mode: party-auto \| party-fixed \| manual }`, `store-fixed` (persists the current locked positions as the PARTY FIXED calibration; `NOT_LOCKED` when nothing holds a lock). Gated by `autofocus` — OV3660 firmware NACKs `UNSUPPORTED_COMMAND`. Continuous per-camera AF is deliberately not part of the contract. |

**`CAMERA_CAPTURE` (0x33)** — `{ "action": "timing-test" }` runs one synchronized capture and returns
**typed** `TimingResult` (see [Timing](#timing)). Any other payload answers **mock** `{ "ok": true }`.

**`CAMERA_CALIBRATE` (0x35)** — a single command id with an `action` discriminator. All shapes below
are **inline** or **mock**:

| `action` | Extra request fields | Response |
|---|---|---|
| `get` | — | **typed** `CalibrationData` |
| `start` | — | `{ "started": true }`, then `CALIBRATION` events |
| `apply` | `offsets: Record<CamId, CamCalibration>` | `{ "ok": true }` |
| `reset` | — | `{ "ok": true }` |
| `order-blink` | `cam` | `{ "ok": true }` — strobes that module's status LED |
| `order-save` | `order: [CamId × 4]` | `{ "ok": true }`; duplicates → `BAD_ORDER` |
| `spacing-save` | `spacingMm: [number × 4]`, `spacingSource: "nominal"\|"measured"` | `{ "ok": true }` |
| `flash-test` | `flash: { level, distance }` | `{ "results": [{ "cam", "clippedPct" }], "suggested": "medium" }`. Timeout 8 s |
| `flash-save` | `flash: { level, distance }` | `{ "ok": true }` |

`CamCalibration` = `{ ev, r, g, b, x, y, rot }`. `CalibrationData` adds `reference`, `cams`,
`capturedAt`, `saved`, `order`, `orderVerifiedAt`, `spacingMm`, `spacingSource`, `flash`.
`level` ∈ `low|medium|high`, `distance` ∈ `0.5-1|1-2|2-3`.

Calibration requires all four cameras; with one offline the reference device answers `CAM_UNREACHABLE`
rather than calibrating against a partial set.

**`CAMERA_PHASE` (0x36)** — VSYNC phase measurement and re-phasing (04§14):

| `action` | Response | Timeout |
|---|---|---|
| `measure` | **typed** `PhaseResult` — read phases, change nothing | 6 s |
| `rephase` | **inline** `{ "started": true }`, then `PHASE` events | 8 s |
| `reset` | **typed** `PhaseResult` — sensors back to free-running | 6 s |

`PhaseResult`:

```json
{
  "cams": [{ "cam": "cam1", "phaseUs": 7420 }, "..."],
  "spreadUs": 21880, "frameIntervalUs": 33333, "reference": "cam2", "aligned": false
}
```

`aligned` is set only once re-phasing has brought the spread inside the target. Re-phasing converges
partially per pass — that is the real bench procedure, not a mock artifact.

### Diagnostics — 0x40–0x4b

| Cmd | Value | Payload |
|---|---:|---|
| `GET_LOGS` | `0x40` | → `{}` ← **inline** `{ "entries": LogEntry[] }` (reference device returns the last 200) |
| `CLEAR_LOGS` | `0x41` | → `{}` ← **mock** `{ "ok": true }` |
| `SELF_TEST` | `0x42` | → `{}` ← **inline** `{ "started": true }`, then `SELF_TEST` events |
| `GET_RUNTIME_STATS` | `0x43` | → `{}` ← **typed** `RuntimeStats` |
| `LINK_BENCH` | `0x44` | → `{ "baud": 2000000, "bytes": 262144 }` ← **typed** `LinkBenchResult`. Timeout 20 s |
| `SET_LINK_BAUD` | `0x45` | → `{ "baud": 1500000 }` ← **inline** `{ "ok": true, "baud": 1500000 }`. Timeout 6 s |
| `SYNC_BENCH` | `0x46` | → `{ "triggers": 20 }` ← **mock** `{ "jobId": "job_1", "accepted": true }`, then `JOB_*` events. See below |
| `STORAGE_SELF_TEST` | `0x47` | → `{}` ← **typed** `StorageSelfTestResult`. Timeout 10 s. Gated by `benchDiagnostics` |
| `CAMERA_LINK_STATS` | `0x48` | → `{ "cam": "cam1" }` ← **typed** `CameraLinkStats`. Gated by `benchDiagnostics` |
| `CAMERA_LINK_STATS_RESET` | `0x49` | → `{ "cam": "cam1" }` ← **inline** `{ "ok": true }`. Counters zero; `lastSequence` survives |
| `CAMERA_SOAK_TEST` | `0x4a` | → **typed** `SoakTestRequest` ← `JobStartResponse`, then `JOB_*`; `result` is **typed** `SoakTestSummary` |
| `GET_HW_VALIDATION` | `0x4b` | → `{}` ← **typed** `HwValidationReport`. Gated by `benchDiagnostics` |

#### Milestone 1B bench diagnostics — 0x47–0x4b

Repo additions (issue #66), normative. All five are gated by one optional
capability flag, **`benchDiagnostics`** — absent means pre-1B firmware and the
group answers `UNSUPPORTED_COMMAND`. The flag and the dispatcher must agree.

- **`STORAGE_SELF_TEST`** is non-destructive: mount → write one temp file
  under `/KINO` → fsync → read back → CRC verify → delete. `failedPhase` names
  the exact failing step (`POWER_ENABLE_FAILED | MOUNT_FAILED | WRITE_FAILED |
  READ_FAILED | VERIFY_FAILED | REMOVE_FAILED`) or is null. The most recent
  result surfaces as `writeTestStatus` in `GET_STORAGE_STATUS`.
- **`GET_STORAGE_STATUS`** gains optional fields on a bench build: `mounted`,
  `filesystem`, `capacityBytes`, `freeBytes`, `lastError`, `mountAttempts`,
  `writeTestStatus`. `present`/`totalMB`/`freeMB` stay the stable core.
- **`CAMERA_TEST`** on a bench build answers **typed** `CameraTestResult`:
  capture UUID, per-stage wall-clock buckets (`requestToNodeMs`,
  `captureCommandToJpegReadyMs`, `jpegTransferMs`, `sdWriteMs`, `totalMs`),
  three CRC-32 checksums (`nodeJpegCrc32`, `transferCrc32`,
  `storedFileCrc32` — computed by the node, over the received bytes, and from
  a read-back of the stored file; a mismatch is a NACK, never a "successful"
  capture), and P4/node memory stats. `ok`/`jpegKB`/`durationMs` remain for
  pre-1B consumers. Host timeout 8 s. **None of the timing buckets is
  exposure timing and none may ever be reported as skew.**
- **`CAMERA_SOAK_TEST`** is an async job (04 §15): captures clamped to
  1–1000, delay to 100–60000 ms, progress batched (~10 %). `keepAll: false`
  (default) keeps the first and last capture and deletes the rest as the run
  progresses. The summary's min/max/avg fields are null when nothing
  succeeded; `heapDeltaKB`/`psramDeltaKB` trending negative fails the bench.
- **`GET_HW_VALIDATION`** reports the runtime hardware-validation registry:
  16 items, status `unvalidated | validated | failed | not-applicable`. An
  item is `validated` only when the real event happened on that unit (frame
  decoded over USB, card mounted, node HELLO answered, checksummed capture
  stored). Firmware never auto-marks `failed` — it cannot tell a wrong pin
  from a missing card; that diagnosis is bench work recorded in
  `firmware/HARDWARE_VALIDATION.md`.

New NACK codes introduced by the 1B firmware paths, in the reference-device
spirit of "reuse rather than reinvent": `SENSOR_NOT_DETECTED`,
`NODE_BOOT_TIMEOUT`, `JPEG_INVALID`, `TRANSFER_TIMEOUT`,
`TRANSFER_CRC_MISMATCH`, `SD_NOT_MOUNTED`, `SD_WRITE_FAILED`,
`SD_VERIFY_FAILED`, `OUT_OF_MEMORY`. Known drift: the mock's legacy
`CAMERA_TEST` guards still answer `CAM_OFFLINE`/`SENSOR_MISSING` where
firmware says `CAMERA_OFFLINE`/`SENSOR_NOT_DETECTED`; both sides treat codes
as strings, so neither breaks, and the firmware names are the ones to keep.

`LogEntry` = `{ "t": 1755301234567, "src": "P4", "msg": "…" }`, `src` ∈
`P4 | C1 | C2 | C3 | C4 | PWR | SD | PROTO`. Also pushed live as `LOG` events.

`RuntimeStats`:

```json
{
  "uptimeS": 4210, "resetReason": "power-on", "freeHeapKB": 162, "freePsramKB": 12900,
  "tempC": { "p4": 42, "cams": [38, 39, 41, 40] },
  "protocol": { "droppedPackets": 0, "crcFailures": 0, "cameraTimeouts": 0, "sdErrors": 0 }
}
```

`LinkBenchResult` — **all four camera UARTs stressed concurrently**, which is the V1 design:

```json
{
  "baud": 2000000, "durationMs": 1420,
  "channels": [{ "cam": "cam1", "bytes": 262144, "kbytesPerSec": 178, "crcErrors": 0, "framingErrors": 0 }],
  "clean": true, "concurrent": true
}
```

`clean` is true only when every channel finished with zero errors.

#### `SYNC_BENCH` — 0x46

`Cmd.SYNC_BENCH` in `packages/kdp/src/protocol/commands.ts`. The value is normative; do not renumber.
See [README D4](README.md#d4--sync_bench-numeric-value).

An async job — a hundred triggers outlives any request deadline. Request/response are **mock**:

→ `{ "triggers": 20 }` (clamped to 1–200, default 20)
← `{ "jobId": "job_1", "accepted": true }`

Then `JOB_PROGRESS` events, and a `JOB_COMPLETE` whose `result` is:

```json
{
  "triggers": 20, "frameIntervalUs": 33333, "aligned": false,
  "samples": [{ "trigger": 0, "cams": [{ "cam": "cam1", "gpioUs": 41, "vsyncPhaseUs": 7180, "exposureUs": 7402 }] }],
  "perTrigger": [{ "trigger": 0, "gpioSpreadUs": 22, "vsyncSpreadUs": 21402, "exposureSpreadUs": 21688 }]
}
```

Requires all four cameras; the reference device answers `CAMERA_OFFLINE` otherwise.

### Maintenance — 0x50–0x53

| Cmd | Value | Payload |
|---|---:|---|
| `ENTER_MAINTENANCE` | `0x50` | → `{}` ← **mock** `{ "ok": true }` — capture disabled while in maintenance |
| `EXIT_MAINTENANCE` | `0x51` | → `{}` ← **mock** `{ "ok": true }` |
| `REBOOT` | `0x52` | → `{}` ← **mock** `{ "ok": true }`, **then** reboot. Answer first, reboot after |
| `FACTORY_RESET` | `0x53` | → `{}` ← **mock** `{ "ok": true }`, then clear config/recipes/sounds/calibration and reboot. Timeout 6 s |

Both reboots produce a new `sessionId` — see [Session change](#session-change).

### Firmware — 0x60–0x65

`FW_BEGIN` → `FW_CHUNK`* → `FW_END`. The P4 is the update gateway for the camera nodes.

| Cmd | Value | Payload |
|---|---:|---|
| `FW_QUERY` | `0x60` | → `{}` ← **typed** `FwQueryResponse` = `{ "targets": { "p4": { "version", "state" }, "cam1": {...} } }` |
| `FW_BEGIN` | `0x61` | → **typed** `FwBeginRequest` ← **typed** `FwBeginResponse` = `{ "sessionId": 101, "chunkSize": 8192 }`. Timeout 8 s |
| `FW_CHUNK` | `0x62` | → **BINARY**, 8-byte `sessionId`/`offset` header + data ← **inline** `{ "ok": true, "received": 8192 }`. Timeout 8 s |
| `FW_END` | `0x63` | → `{}` ← **typed** `FwEndResponse` = `{ "ok": true, "verified": true }`. Timeout 15 s |
| `FW_ABORT` | `0x64` | → `{}` ← **mock** `{ "ok": true }` |
| `FW_STATUS` | `0x65` | → `{ "target": "cam3" }` ← **typed** `FwStatusResponse` = `{ "target", "state", "version", "error"? }` |

`FwBeginRequest` = `{ "target": "cam3", "size": 984320, "sha256": "…", "version": "0.2.0" }`.
`target` ∈ `cam1 | cam2 | cam3 | cam4 | p4`.
`FwTargetState` ∈ `idle | receiving | verifying | applying | rebooting | ready | error`.

Reference-device rules: maintenance mode is required first (`MAINT_REQUIRED`); one session at a time
(`BUSY`); image size must be 1 byte – 4 MB (`BAD_SIZE`); a stale `sessionId` gets `BAD_SESSION`;
`FW_END` before all bytes arrive gets `SHORT_IMAGE`. A P4 self-update reboots the device, which
changes the session ID and drops the link — that is expected, not a failure.

`FW_PROGRESS` (`0x82`) exists as an event id but has no producer. Progress today is inferred host-side
from `FW_CHUNK` acknowledgements. See [README, unspecified item 1](README.md#unspecified--firmware-team-decision-required).

### Media — 0x70–0x75

Gallery access through the P4 file server. Never send the whole gallery (04§9).

| Cmd | Value | Payload |
|---|---:|---|
| `MEDIA_LIST` | `0x70` | → **typed** `MediaListRequest` = `{ "cursor": 0, "limit": 100 }` ← **typed** `MediaListResponse`. Timeout 6 s |
| `MEDIA_INFO` | `0x71` | → `{ "id": "WG_0042" }` ← **typed** `CaptureInfo`. Timeout 10 s |
| `MEDIA_THUMB` | `0x72` | → `{ "id": "WG_0042" }` ← **BINARY** thumbnail bytes. Timeout 8 s |
| `MEDIA_READ` | `0x73` | → `{ "id", "file", "offset", "length" }` ← **BINARY** file bytes. Timeout 8 s |
| `MEDIA_DELETE` | `0x74` | → `{ "id": "WG_0042" }` ← **mock** `{ "ok": true }` |
| `MEDIA_FAVORITE` | `0x75` | → `{ "id": "WG_0042", "favorite": true }` ← **mock** `{ "ok": true }` |

`MediaListResponse`:

```jsonc
{ "total": 2048, "items": [ /* CaptureSummary[] */ ], "nextCursor": 100, "hasMore": true }
```

`nextCursor` is a **number or null**, not an opaque string — see [README D9](README.md#d9--gallery-cursor-is-a-number-not-an-opaque-string).
`limit` is clamped to 1–100 and `maxGalleryPageSize` advertises the ceiling.

`CaptureSummary`:

```json
{
  "id": "WG_0042", "kind": "wiggle", "ts": 1755301234567,
  "recipeIds": ["party-neg"], "favorite": false,
  "resolution": "1600x1200", "totalKB": 1680
}
```

`recipeIds` has 1 entry for `wiggle`, 4 for `quad`. `CaptureInfo` extends it with `files`
(`[{ "name": "C1.JPG", "sizeBytes", "sha256" }]`) and `meta` (`flash`, `batteryV`, `p4Firmware`,
`cameraFirmware`, `gpioSkewUs`, `exposure[]`).

`MEDIA_READ` `length` is clamped to 8192 by the reference device. Ranges past EOF return short, not
an error.

### Network / Roll / upload queue — 0xa0–0xaa

Values allocated by this repo — see [README D3](README.md#d3--network--roll--upload-queue-numeric-values).
Studio's facade (`apps/studio/src/device/KinoDevice.ts`) calls all of these; the payload shapes are
**inline** there and **mock** in the reference device — no interface exists in `types.ts` yet. Gated
by the `network` / `rollUpload` capability flags.

| Cmd | Value | Payload |
|---|---:|---|
| `NETWORK_LIST` | `0xa0` | → `{}` ← `{ "networks": [NetworkView] }` |
| `NETWORK_SET` | `0xa1` | → `{ "ssid", "password"?, "security"?, "autoJoin"? }` ← `{ "ok": true, "networks": [NetworkView] }` |
| `NETWORK_DELETE` | `0xa2` | → `{ "ssid": "loft-guest" }` ← `{ "ok": true, "networks": [NetworkView] }` |
| `NETWORK_STATUS` | `0xa3` | → `{}` ← `{ "state", "ssid", "ip", "rssi", "since", "internet" }` |
| `ROLL_STATUS` | `0xa4` | → `{}` ← `RollView` |
| `ROLL_CREATE` | `0xa5` | → `{ "name": "Friday party" }` ← `{ "rollId", "slug", "guestUrl", "name", "role" }` |
| `ROLL_JOIN` | `0xa6` | → `{ "slug": "amber-001" }` (`code` accepted as an alias) ← `RollView` |
| `ROLL_LEAVE` | `0xa7` | → `{}` ← `{ "ok": true, ...RollView }` |
| `UPLOAD_QUEUE_STATUS` | `0xa8` | → `{}` ← `QueueReport` |
| `UPLOAD_QUEUE_RETRY` | `0xa9` | → `{}` ← `{ "ok": true, "retried": 2, "queue": QueueReport }` |
| `UPLOAD_ENQUEUE` | `0xaa` | → `{ "captureId": "CAP_0042" }` ← `{ "ok": true, "captureId", "queue": QueueReport }` |

```jsonc
// NetworkView — the password NEVER leaves the device
{ "ssid": "kino-bench", "password": "••••", "hasPassword": true,
  "security": "wpa2", "autoJoin": true, "lastSeen": 1755301234567 }

// QueueReport — upload queue counters. `draining` is true while the
// device is actively working the queue on a timer.
{ "pending": 12, "uploading": 1, "failed": 2, "uploaded": 118, "draining": true }

// RollView — on a roll
{ "active": true,
  "roll": { "rollId": "roll_0001", "slug": "amber-001",
            "guestUrl": "https://kino.roll/amber-001", "name": "Friday party",
            "role": "host", "joinedAt": 1755301234567 },
  "queue": { "pending": 12, "uploading": 1, "failed": 2, "uploaded": 118, "draining": true } }

// RollView — NOT on a roll. This is the state a fresh device reports,
// so it is the first one firmware bring-up hits. `roll` is null, not omitted,
// and `queue` is still present.
{ "active": false, "roll": null,
  "queue": { "pending": 0, "uploading": 0, "failed": 0, "uploaded": 118, "draining": false } }
```

`role` ∈ `host | guest` — `ROLL_CREATE` makes the device the host, `ROLL_JOIN` makes it a guest.

**Password handling is a hard rule (05§13).** The device needs a stored passphrase to join; nothing
leaving the camera — list reply, log line, backup — may contain it. `NETWORK_LIST` reports a fixed
mask string and a `hasPassword` boolean. A `NETWORK_SET` that omits `password` for an existing SSID
keeps the stored one, because the host never had it to send back.

Validation in the reference device: SSID 1–32 chars, WPA passphrase ≥ 8 chars, roll slug matching
`^[a-z0-9][a-z0-9-]{2,47}$` — all `INVALID_ARGUMENT`. Creating or joining a roll while already on one
is `INVALID_STATE`; leaving when not on one is `INVALID_STATE`.

`UPLOAD_QUEUE_RETRY` moves `failed` back into `pending` and returns how many were requeued.

`UPLOAD_ENQUEUE` is Studio's "push to Roll" (02§16): a capture already committed to the card is added
to the upload queue by id, so `pending` goes up by one and the reply carries the queue that resulted.
Reference-device rejections: `INVALID_ARGUMENT` for a missing/empty `captureId`, `INVALID_STATE`
(`"Not on a roll"`) when the camera is not on a Roll — there is nowhere for the bytes to go —
and `NOT_FOUND` for an id the card does not hold. Studio hides the action entirely unless
`ROLL_STATUS` reports an active Roll **and** `rollUpload` is advertised, so a NACK here means the two
sides disagree, not that the user pressed something they should not have.

## Events — 0x80–0x89

Device→host, unsolicited, `FLAGS = EVENT (0x02)`, JSON payload. **No meaningful sequence ID** (04§16)
— the reference device writes `0` and the host ignores the field.

| Evt | Value | Payload | Status |
|---|---:|---|---|
| `LOG` | `0x80` | **typed** `LogEntry` | Live |
| `STATUS` | `0x81` | — | **Unspecified.** No producer, no consumer |
| `FW_PROGRESS` | `0x82` | — | **Unspecified.** No producer, no consumer |
| `CALIBRATION` | `0x83` | **typed** `CalibrationEvent` | Live, from `CAMERA_CALIBRATE {action:"start"}` |
| `SELF_TEST` | `0x84` | **typed** `SelfTestEvent` | Live, from `SELF_TEST` |
| `CAPTURE` | `0x85` | **typed** `CaptureEvent` = `{ "id": "WG_0042", "kind": "wiggle" }` | Live, on SD commit |
| `PHASE` | `0x86` | **mock** `{ "step": "rephase"\|"result", "cam"?, ...PhaseResult }` | Live, from `CAMERA_PHASE {action:"rephase"}` |
| `JOB_PROGRESS` | `0x87` | **typed** `JobProgress` | See [Async job model](#async-job-model) |
| `JOB_COMPLETE` | `0x88` | **typed** `JobCompleteEvent` | " |
| `JOB_FAILED` | `0x89` | **typed** `JobFailedEvent` | " |

`CalibrationEvent` = `{ "step": "capture"|"analyze"|"result"|"error", "cam"?, "message"?, "offsets"? }`
`SelfTestEvent` = `{ "index", "total", "name", "status": "running"|"pass"|"fail"|"skip", "detail"?, "done"?, "results"? }`

An event id with no registered handler is decoded and discarded. Emitting an unknown event is safe;
it is simply invisible.

## Async job model

04§15. Calibration, firmware, stress tests, storage checks and large exports do not fit a
request/response deadline.

**Flow:**

1. Host sends the command. Device replies **immediately** with `{ "jobId": "job_1", "accepted": true }`
   (**typed** `JobStartResponse`) under the normal `RESPONSE` flags and echoed sequence.
   `accepted: false`, or a missing/non-string `jobId`, is a hard host-side failure — the job never starts.
2. Device pushes `JOB_PROGRESS` (`0x87`) as it works:
   ```json
   { "jobId": "job_1", "progress": 0.45, "step": "trigger", "message": "9/20 triggers" }
   ```
   `progress` is `0..1`. `step` (machine-readable stage) and `message` (human) are optional.
3. Device ends the job with exactly one of:
   ```jsonc
   // JOB_COMPLETE 0x88
   { "jobId": "job_1", "result": { /* per-command shape */ } }
   // JOB_FAILED 0x89
   { "jobId": "job_1", "error": { "code": "CAMERA_OFFLINE", "message": "CAM3 did not respond" } }
   ```
   `result` is per-command and deliberately open. On `JOB_FAILED` the error object is the full 04§18
   shape (**typed** `JobFailure`): `code`, `message`, optional `details`, `recoverable`,
   `suggestedActions`. It reaches the UI verbatim. A missing `error` defaults host-side to
   `{ code: "JOB_FAILED", message: "Job <id> failed" }`; a missing `result` defaults to `{}`.

**`jobId` is the only routing key.** Job events carry no request sequence ID. Two jobs running at
once are distinguished by `jobId` alone.

### Wire rules firmware must respect

These follow from the host's job lifecycle in `KinoProtocolClient` and are not optional.

1. **Never emit an event for a job after its `JOB_COMPLETE` or `JOB_FAILED`.** The host tombstones a
   settled `jobId` and drops trailing events for it. A retransmitted `JOB_COMPLETE` is silently lost,
   not re-delivered. Tombstones are bounded (32 ids), so a long-running session eventually forgets —
   a very late duplicate can then be misfiled.
2. **Never reuse a `jobId` within a session.** If the host is asked to register a `jobId` that is
   still in flight, it assumes the device restarted that job: it fails the old handle with
   `JOB_SUPERSEDED` and gives the new run the ID. Whatever the old consumer was waiting for it never
   gets. Monotonic counters are fine — the reference device uses `job_1`, `job_2`, … and resets only
   on reboot, which is also a session change.
3. **A reboot ends every job.** Session ID changes, and the host fails all live jobs with
   `SESSION_CHANGED` before anything else reacts. Do not resume a job across a boot.
4. **Events may legitimately arrive before the host has registered the `jobId`** — the device can pack
   the start reply and the first progress event into one write. The host buffers those (bounded: 32
   unclaimed job ids, 16 progress events each, newest kept) and replays them on registration. Ordering
   within a job is preserved; do not reorder progress events to compensate.
5. **Emit progress in batches, not per unit of work.** The reference device reports roughly every 10 %
   of a `SYNC_BENCH` run rather than per trigger.

Abandoning the progress stream host-side does **not** cancel the job. There is no cancel command; a
job runs to completion or dies with the session.

## Timing

Three distinct metrics (04§13, `packages/kdp/src/protocol/timing.ts`). Collapsing them into one
number called "trigger skew" hides the only one that affects the photograph.

| Metric | What it measures | Magnitude |
|---|---|---|
| **GPIO distribution skew** | When the shared SYNC edge reaches each XIAO | tens–hundreds of µs |
| **VSYNC phase skew** | Where each free-running OV3660 sits in its own frame cycle when the trigger arrives | up to a full frame interval (~33 ms) |
| **Effective exposure skew** | When the scene was really recorded, including rolling-shutter row timing | what the wigglegram actually shows |

A 100 µs GPIO spread can still mean 10–30 ms between actual images. **A tight GPIO trigger is not
proof of tight exposure on a free-running rolling shutter** (04§14).

`CAMERA_CAPTURE {action:"timing-test"}` returns **typed** `TimingResult`:

```json
{
  "cams": [{ "cam": "cam1", "gpioUs": 41, "vsyncPhaseUs": 7180, "exposureUs": 7402 }],
  "gpioSpreadUs": 22, "vsyncSpreadUs": 21402, "exposureSpreadUs": 21688,
  "vsyncMeasured": true, "frameIntervalUs": 33333
}
```

`vsyncMeasured: false` means firmware cannot read VSYNC — the other two figures are then estimates and
Studio labels them as such. Report it honestly; do not fabricate a phase.

The same honesty rule applies to `RuntimeStats.tempC` (Milestone 1B): `p4` and each `cams` entry
are `number | null` — a real on-chip sensor reading or null, never an invented temperature. A build
whose camera link is down reports that camera's temperature as null.

Grading bands applied host-side to `exposureSpreadUs` (`gradeSkew` in `timing.ts`), stated here so
firmware and bench tooling use the same vocabulary:

| Spread | Grade |
|---|---|
| < 0.5 ms | EXCELLENT |
| 0.5–1 ms | VERY GOOD |
| 1–2 ms | USABLE |
| 2–5 ms | VISIBLE ON FAST SUBJECTS |
| 5–10 ms | MOTION CONTAMINATED |
| > 10 ms | NOT ACCEPTABLE — not a synchronized capture |

`TimingResult` is the **wire** shape for a live measurement. The **persisted** shape that travels with
a capture is the `kino.capture` `timing` block, which is different and has its own required-keys rule —
see [`schemas.md § Timing block`](schemas.md#timing-block).
