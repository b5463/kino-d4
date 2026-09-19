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
0x10–0x13  Configuration      0x60–0x66  Firmware
0x20–0x25  Modes / recipes    0x70–0x75  Media
0x26–0x2b  Sounds             0x80–0x89  EVENTS (device→host, unsolicited)
0x30–0x37  Camera             0xa0–0xaa  Network / Roll / upload queue
0x40–0x4d  Diagnostics (0x4d bench-only, private)
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
    "autofocus": false, "focusLock": false, "manualFocus": false,
    "benchDiagnostics": true, "recipes": true, "configStore": true,
    "mediaIndex": true, "powerManagement": true, "powerTelemetry": false,
    "flashHardware": false, "brightnessControl": false,
    "radioFitted": true, "radioRouted": false,
    "network": false, "roll": false, "rollUpload": false
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
above, and these optional ones:

| Flag | True means |
|---|---|
| `autofocus` | The OV5640_AF group exists. Absent on OV3660 firmware, and the whole focus surface goes with it. Never infer it from a sensor name |
| `focusLock` | AF can lock the lens for a capture group (focus → lock → arm → capture) |
| `manualFocus` | The VCM position can be set directly (MANUAL mode) |
| `benchDiagnostics` | The Milestone 1B group answers: `STORAGE_SELF_TEST`, `STORAGE_BENCH`, `CAMERA_LINK_STATS(_RESET)`, `CAMERA_SOAK_TEST`, `GET_HW_VALIDATION`, and the extended `CAMERA_TEST` / `GET_STORAGE_STATUS` payloads |
| `recipes` | The look/recipe family answers: `GET_RECIPES`, `SET_RECIPE`, `UPLOAD_RECIPE`, `DELETE_RECIPE`. Omitted by firmware older than 0.4.8. A look is stored and selected; nothing in this firmware applies one to a sensor |
| `network` | `NETWORK_LIST/SET/DELETE/STATUS` answer |
| `roll` | The `ROLL_*` commands answer |
| `rollUpload` | The upload queue answers, on its own. Typed since 2026-09; it shipped before the interface was settled and Studio read it off the raw object for a while (`supportsRollUpload`) |
| `configStore` | The settings store answers: `GET`/`SET`/`SAVE`/`RESET_CONFIG`. D17, from 0.2.0 |
| `flashHardware` | A flash emitter is fitted and reachable. Apart from `flashControl` on purpose: the firmware can hold a flash window open with no LED on the other end, which is exactly D4-V1 since ECN-0003 |
| `mediaIndex` | The gallery *index* answers: `MEDIA_LIST/INFO/DELETE/FAVORITE`. Apart from `gallery`, which is pixels — `MEDIA_READ` and `MEDIA_THUMB`. 0.2.0 could list captures it could not hand over |
| `powerManagement` | `autoDimS`, `sleepS` and `camIdleTimeoutS` actually cut power. D10/D17 |
| `powerTelemetry` | The body can measure the cell. False on D4-V1 — no sense divider or gauge bus reaches the P4, so `batteryV` and `batteryPct` are `null` |
| `radioFitted` | An ESP32-C6 is soldered on |
| `radioRouted` | This firmware has a transport to that radio. A build-time opt-in on D4-V1 |
| `brightnessControl` | `BodyConfig.brightness` moves the backlight. **Defaults to true — see below** |

Optional means absent on firmware that predates the feature. **Absence is an answer — "not
supported" — not an unknown.** One exception:

> **`brightnessControl` is the one flag a host must read as TRUE when absent.** Only an explicit
> `false` disables the control. Firmware older than 0.4.9 never answered the question, and greying a
> slider on a body that never said it cannot dim would be inventing a limit. Studio carries this as a
> named default inside `supports()` rather than as a general "missing means yes" rule — see
> [README D19](README.md#d19--nl_cmd_sensor-and-the-settings-that-finally-do-something). Applying the
> general rule here greys the brightness control on every body.

Two flags are false on D4-V1 for hardware reasons, not missing drivers: `brightnessControl` (D11 —
the Guition carrier drives the panel backlight from a plain GPIO, so the setting is stored and echoed
and nothing dims) and `flashHardware` (ECN-0003 took GPIO28 for the shutter and left the flash with
no P4 pin).

`syncBench` is now the only flag the reference device reports that the interface does not declare
(**mock**) — and only on `d4-sim-full`; the profiles that pin a real build omit it, as the firmware
does, and `SYNC_BENCH` answers on 0.4.31+ without any flag. `rollUpload` is typed.

The reply carries no top-level field beyond `protocol`, `hardware`, `firmware`, `capabilities`,
`limits` and `configSchemaVersion`. The reference device used to add a `firmwareMismatch` boolean
under its `nodeFwMismatch` scenario; the firmware never sent one and nothing consumed it, so it is
gone — a host detects a stale node from the versions in `GET_DEVICE_INFO` / `FW_QUERY`.

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

`state` ∈ `ready | armed | busy | capturing | updating | rebooting | timeout | offline | error`.

**`armed`** means `CAMERA_ARM` was accepted and the sensor is primed, waiting for the shared
trigger edge. It is deliberately not a shade of `busy`: an armed camera has nothing to do but
wait, and one still reporting `armed` after a burst finished missed the trigger rather than ran
slow. **There is no `CAMERA_DISARM`, and none is needed** — the only two exits are the capture
itself and the arm window expiring (reference device: 3000 ms). A host that armed and then
changed its mind waits the window out; adding a disarm opcode would add a third way for host and
firmware to disagree about whether the sensors are primed, to buy back three seconds. The
firmware clears `armed` on the trigger regardless of whether the capture succeeded.

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
| `GET_MODES` | `0x20` | → `{}` ← **typed** `GetModesResponse`. See below |
| `SET_MODE` | `0x21` | → `{ "mode": "wiggle" \| "quad" }` ← **mock** `{ "ok": true }` |
| `GET_RECIPES` | `0x22` | → `{}` ← **typed** `RecipesResponse` = `{ "factory": Recipe[], "custom": Recipe[] }` |
| `SET_RECIPE` | `0x23` | → `{ "id": "party-neg", "cam"?: "cam1".."cam4" \| "all" }` ← `{ "ok": true, "id": "party-neg", "cam": "cam1" }` (`cam` echoed as sent, absent when omitted; see [README D18](README.md#d18--set_recipe-takes-a-cam-and-the-two-families-that-left-d17)) |
| `UPLOAD_RECIPE` | `0x24` | → `{ "recipe": {...} }` ← **mock** `{ "ok": true }` |
| `DELETE_RECIPE` | `0x25` | → `{ "id": "my-look" }` ← `{ "ok": true }`; an id not on the card is `NOT_FOUND`, a factory id `FACTORY_LOCKED` |

#### `GET_MODES` — 0x20

**typed** `GetModesResponse` in `packages/kdp/src/protocol/types.ts`. Two fields, not one:

```json
{
  "active": "wiggle",
  "modes": [
    { "id": "wiggle", "name": "Wiggle", "available": true, "unavailableReason": null },
    { "id": "quad", "name": "Quad", "available": false, "unavailableReason": "No card mounted" }
  ]
}
```

- `active` is the **stored** selection and survives a reboot. It may name a mode that is currently
  unavailable; that pair is coherent and is what the camera will shoot once the reason clears.
- `available` is derived, not a constant. The P4 answers from the same predicate `capture_fire()`
  uses — a mounted card, then a camera node that answered — so `true` means a capture requested this
  instant would be taken.
- `unavailableReason` is always present: a string in the camera's own words, or `null`. A host never
  has to distinguish absent from null.

A one-mode device answers a one-element `modes` list rather than NACKing.

This entry described `{ "modes": ["wiggle","quad"] }` — a bare string array — and said the command
was "not in the 1B set" and NACKed on 0.1.x. Both were stale. The P4 has answered objects with an
`active` selection since the capture pipeline landed; the stale type in `types.ts` was corrected on
2026-09-01 and the richer shape won, because the availability it carries is the point.
[README D21](README.md#d21--get_modes-answered-a-shape-this-file-never-described-and-lied-about-availability)
records the reconciliation — implement from this entry and D21, not from the array.

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
| `SOUND_END` | `0x29` | → `{}` ← **inline** `{ "ok": true, "sound": SoundInfo }`. Timeout 8 s. The header is checked here (`wav_probe`): RIFF/WAVE, PCM, 16-bit, mono, 16 kHz, with a `data` chunk — anything else is `BAD_FORMAT` naming the reason and the session is discarded |
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
| `CAMERA_ARM` | `0x31` | → `{}` ← `CameraArmResponse` `{ "ok": true, "armWindowMs": 3000 }`. `armWindowMs` is required: with no CAMERA_DISARM it is the only thing telling a host when the sensors drop back to `ready`. Arms all four (the trigger edge is shared); every camera reports `state: "armed"` until the capture or the window expires. No Studio caller |
| `CAMERA_TEST` | `0x32` | → `{ "cam": "cam1" }` ← **inline** `{ "ok": true, "jpegKB": 412, "durationMs": 190 }`. Timeout 8 s (raised for M1B: a real capture + UART transfer takes several seconds) |
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

### Diagnostics — 0x40–0x4c

| Cmd | Value | Payload |
|---|---:|---|
| `GET_LOGS` | `0x40` | → `{}` ← **inline** `{ "entries": LogEntry[] }`. The reply is capped to one frame: the newest entries whose serialization fits the 16384-byte payload budget, oldest-first (a full 200-entry ring exceeds the cap). Firmware and reference device apply the same rule. |
| `CLEAR_LOGS` | `0x41` | → `{}` ← **mock** `{ "ok": true }` |
| `SELF_TEST` | `0x42` | → `{}` ← **inline** `{ "started": true }`, then `SELF_TEST` events |
| `GET_RUNTIME_STATS` | `0x43` | → `{}` ← **typed** `RuntimeStats` |
| `LINK_BENCH` | `0x44` | → `{ "baud": 2000000, "bytes": 262144 }` ← **typed** `LinkBenchResult`. Timeout 20 s |
| `SET_LINK_BAUD` | `0x45` | → `{ "baud": 1500000 }` ← **inline** `{ "ok": true, "baud": 1500000 }`. Timeout 6 s |
| `SYNC_BENCH` | `0x46` | → `{ "pulses": 100, "gapMs": 100, "poll": true }` ← one plain RESPONSE with per-camera edge counts. **Blocking, up to ~200 s.** See below |
| `STORAGE_SELF_TEST` | `0x47` | → `{}` ← **typed** `StorageSelfTestResult`. Timeout 10 s. Gated by `benchDiagnostics` |
| `CAMERA_LINK_STATS` | `0x48` | → `{ "cam": "cam1" }` ← **typed** `CameraLinkStats`. Gated by `benchDiagnostics` |
| `CAMERA_LINK_STATS_RESET` | `0x49` | → `{ "cam": "cam1" }` ← **inline** `{ "ok": true }`. Counters zero, `latencyMaxMs` included; `lastSequence` survives |
| `CAMERA_SOAK_TEST` | `0x4a` | → **typed** `SoakTestRequest` ← `JobStartResponse`, then `JOB_*`; `result` is **typed** `SoakTestSummary` |
| `GET_HW_VALIDATION` | `0x4b` | → `{}` ← **typed** `HwValidationReport`. Gated by `benchDiagnostics` |
| `C6_RESET_BENCH` | `0x4d` | → `{}` ← `{ ok: true, target: "C6" }`. **Bench only, private.** One reset pulse to the C6 coprocessor (the P4 keeps running); exists so ROLL-C test 3 can be run. Handled only by a P4 built with `-DKINO_C6_RESET_BENCH=1`; every other build NACKs `UNSUPPORTED_COMMAND` and moves no pin. Not gated by a capability because no product client may send it |
| `STORAGE_BENCH` | `0x4c` | → **typed** `StorageBenchRequest` ← **typed** `StorageBenchResult`. Timeout 120 s. Gated by `benchDiagnostics`. **Implemented — see below** |

#### `STORAGE_BENCH` — 0x4c

`{ "sizeMB": 16, "blockKB": 64, "passes": 1 }` → `{ "writeMBs": 9.4, "readMBs": 18.1,
"worstBlockMs": 214.0, "p95BlockMs": 13.6, "bytes": 16777216 }`.

Sustained throughput, not a health check — `STORAGE_SELF_TEST` already answers whether the card
works. **`worstBlockMs` is the number that decides a four-frame burst**: the burst stalls on its
slowest block, and an average hides exactly the internal-erase event that drops a frame. Report
it prominently or not at all. No card or no free space is `SD_ERROR`, never a zeroed result.

**Firmware status: implemented.** `handle_storage_bench` in `firmware/p4/main/kdp_server.c`, dispatched
from the `KDP_CMD_STORAGE_BENCH` case; `benchDiagnostics` is true and covers it. This section said
"reserved, no handler" for a while, and the cost of that was a bench operator skipping a working
120 s throughput test — the one that produces `worstBlockMs`, which is the number this section itself
says decides a four-frame burst. Run it.

What the device does, where it differs from the typed request:

- The run is non-destructive: one temp file under `/KINO` with an unmistakably temporary name, CRC-32
  read-back, then removed. Throughput is never reported unless the read-back CRC matched.
- It holds the **capture lock**, shared with `CAMERA_TEST` and the soak run, and answers `BUSY` if a
  capture or soak run is active. It is a plain blocking request, not an async job.
- `sizeKB` is accepted alongside `sizeMB`, so a caller can ask for the 64 KiB size
  `STORAGE_SELF_TEST` uses — a whole number of megabytes cannot express it.
- **Out-of-range values are clamped, not refused.** The firmware does not answer `INVALID_ARGUMENT`
  here. Its bounds are `sizeKB` 64–8192 (default 1024), `blockKB` 4–128 (default 32), `passes` ≤ 8
  (default 1) — tighter than the `sizeMB` 1–512 / `blockKB` 4–4096 / `passes` 1–16 the typed request
  and the reference device carry. A host asking for 512 MB gets 8 MiB and a result that does not say
  so; read `bytes` and `passes` out of the response rather than assuming the request was honoured.
- A failure NACKs with the **failing phase** as the code (`storage_bench_phase_str`), not a bare
  `BENCH_FAILED`: "slow" and "did not finish" are different problems.
- Additive fields beyond the typed result: `ok`, `failedPhase`, `passes`, `totalMs`, `cleanupOk`, and
  two per-pass blocks — `sustained` (the sized run, which the top-level figures come from) and
  `small`, a 64 KiB run directly comparable with `STORAGE_SELF_TEST` on the same card.
- A successful run marks `HWV_SD_LDO_CH4` validated: a verified round trip at a megabyte rather than
  at 64 KB.

`M1B_COMMANDS` does not gate this, and it gates nothing in firmware. It is a **test-fixture
whitelist** — `packages/test-fixtures/src/firmwareProfiles.ts`, "the exact KDP surface of
`kdp_server.c` at 0.1.0" — used to make the reference device refuse what an 0.1.0 body refused. The
real gate is the dispatcher's `switch` plus the capability flag. A command missing from
`M1B_COMMANDS` means the M1B *profile* NACKs it; it says nothing about today's firmware.

#### Milestone 1B bench diagnostics — 0x47–0x4c

Repo additions (issue #66), normative. All six — `STORAGE_SELF_TEST`,
`CAMERA_LINK_STATS`, `CAMERA_LINK_STATS_RESET`, `CAMERA_SOAK_TEST`,
`GET_HW_VALIDATION` and `STORAGE_BENCH` — are gated by one optional capability
flag, **`benchDiagnostics`** — absent means pre-1B firmware and the group answers
`UNSUPPORTED_COMMAND`. The flag and the dispatcher must agree. `C6_RESET_BENCH`
(0x4d) sits inside the numeric range and is **not** part of this group: it is
bench-only, private, and gated by a build flag rather than a capability.

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
  **56 items** (`hwv_item_t` in `firmware/p4/main/hardware_validation.h`, up to
  but not including `HWV_COUNT`; `ITEM_IDS` in the matching `.c` carries the wire
  ids and a `_Static_assert` keeps the two in step). The registry is append-only
  because statuses persist in NVS keyed by the enum's index, so this number only
  ever grows — read it from the enum, never from a count in prose. Each item has
  a status of `unvalidated | validated | failed | not-applicable`. An
  item is `validated` only when the real event happened on that unit (frame
  decoded over USB, card mounted, node HELLO answered, checksummed capture
  stored). Firmware never auto-marks `failed` — it cannot tell a wrong pin
  from a missing card; that diagnosis is bench work recorded in
  `firmware/HARDWARE_VALIDATION.md`.

New NACK codes introduced by the 1B firmware paths, in the reference-device
spirit of "reuse rather than reinvent": `SENSOR_NOT_DETECTED`,
`NODE_BOOT_TIMEOUT`, `JPEG_INVALID`, `TRANSFER_TIMEOUT`,
`TRANSFER_CRC_MISMATCH`, `SD_NOT_MOUNTED`, `SD_WRITE_FAILED`,
`SD_VERIFY_FAILED`, `OUT_OF_MEMORY`. The reference device's `CAMERA_TEST`
guards answer the firmware's `CAMERA_OFFLINE` / `SENSOR_NOT_DETECTED` (they
were the mock's own `CAM_OFFLINE` / `SENSOR_MISSING` until 2026-09-13; the
mock-only `CAMERA_CALIBRATE` and `CAMERA_PREVIEW` paths, which no firmware
implements, keep their old spellings).

`LogEntry` = `{ "t": 1755301234567, "src": "P4", "msg": "…" }`, `src` ∈
`P4 | C1 | C2 | C3 | C4 | PWR | SD | PROTO`. Also pushed live as `LOG` events.

`RuntimeStats`:

```json
{
  "uptimeS": 4210, "resetReason": "power-on", "freeHeapKB": 162, "freePsramKB": 12900,
  "tempC": { "p4": 42, "cams": [38, null, null, null] },
  "protocol": { "droppedPackets": 0, "crcFailures": 0, "cameraTimeouts": 0, "sdErrors": 0,
                "droppedLogEvents": 0, "droppedTxFrames": 0 },
  "ui": { "passes": 84200, "lastPassAgeMs": 41, "stalled": false }
}
```

`tempC.cams[i]` is `null` for a node that is not answering — never a fabricated figure.
`protocol.droppedTxFrames` (0.4.10+) and `ui` (0.4.18+) are additive; the reference device reports
both.

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

**A blocking SYNC-line edge counter. Not an async job, and it measures no skew.** The firmware
(`handle_sync_bench` in `firmware/p4/main/kdp_server.c`) is the shipped truth; this entry describes
it.

Request:

```json
{ "pulses": 100, "gapMs": 100, "poll": true }
```

- `pulses` — 1–200, default **100**. Outside the range is `INVALID_ARGUMENT` ("a longer run is
  several calls").
- `gapMs` — 20–1000, default **100**. The floor is at least twice the node dead time.
- `poll` — default `true`. Read each node's sync counter after every pulse, which is what earns the
  `polled*` fields below. `false` reads only the endpoints.
- `triggers` is **ignored**. It is the field the async design used and no firmware ever read it; a
  request carrying only `triggers` runs the 100 × 100 ms default, which is a 10 s block.

The P4 fires one shared-SYNC pulse per iteration and waits `gapMs` between them, **inside the
request handler**, then answers once. Budget `pulses × gapMs`: the default is ~10 s and the worst
case (200 × 1000 ms) is ~200 s. Set the host's per-command timeout from the request, not from a
default — and expect the KDP link to be held for the duration. `capture_busy()` is checked first, so
a run started while a capture is in flight is refused `BUSY` rather than queued.

Response — one plain RESPONSE frame, no `jobId`, no `JOB_*` events:

```json
{
  "ok": true,
  "pulses": 100,
  "gapMs": 100,
  "polled": true,
  "refusedByCapture": 0,
  "pulseWidthUs": 200,
  "cameras": [
    {
      "cam": "cam1", "watched": true, "inputReady": true, "deadtimeUs": 1500,
      "seqBefore": 0, "seqAfter": 100,
      "acceptedEdges": 100, "rawEdges": 100, "rejectedEdges": 0,
      "expected": 100, "shortBy": 0, "extraRaw": 0,
      "polledMissed": 0, "polledExtra": 0, "firstBadPulse": null, "edgeMonotonic": true,
      "clean": true
    }
  ]
}
```

- `pulses` echoes how many actually **fired**, which is lower than requested if a capture took the
  cameras mid-run: the loop stops rather than report a hole, and `refusedByCapture` counts that.
- `watched` is false for a camera that did not answer at the start of the run. A camera with
  `watched: false` carries no other fields — the bench reports on the cameras that were there. There
  is no all-four-cameras requirement and no `CAMERA_OFFLINE` for a missing one.
- `shortBy` = `expected - acceptedEdges`; `extraRaw` = `rawEdges - expected`. `clean` is
  `acceptedEdges == expected`.
- The `polled*` fields, `firstBadPulse` and `edgeMonotonic` are present only when `poll` was true.
  `firstBadPulse` is the 1-based pulse at which a node's counter first skipped, or `null`.

**No timing figures come out of this command.** It carried `gpioUs`, `vsyncPhaseUs`, `exposureUs`,
`frameIntervalUs`, `aligned`, `samples` and `perTrigger` in the async design; the firmware reports
none of them and cannot — `vsyncTelemetry` is false on this build. Counting edges answers "did every
node see the trigger", which is a wiring and dead-time question. It does not answer any of the three
timing metrics at the end of this document, and a host must not present it as skew.

### Maintenance — 0x50–0x53

| Cmd | Value | Payload |
|---|---:|---|
| `ENTER_MAINTENANCE` | `0x50` | → `{}` ← **mock** `{ "ok": true }` — capture disabled while in maintenance |
| `EXIT_MAINTENANCE` | `0x51` | → `{}` ← **mock** `{ "ok": true }` |
| `REBOOT` | `0x52` | → `{}` ← **mock** `{ "ok": true }`, **then** reboot. Answer first, reboot after |
| `FACTORY_RESET` | `0x53` | → `{}` ← **mock** `{ "ok": true }`, then clear config/recipes/sounds/calibration and reboot. Timeout 6 s |

Both reboots produce a new `sessionId` — see [Session change](#session-change).

### Firmware — 0x60–0x66

`FW_BEGIN` → `FW_CHUNK`* → `FW_END`. The P4 is the update gateway for the camera nodes.

| Cmd | Value | Payload |
|---|---:|---|
| `FW_QUERY` | `0x60` | → `{}` ← **typed** `FwQueryResponse` = `{ "targets": { "p4": { "version", "state" }, "cam1": {...} } }` |
| `FW_BEGIN` | `0x61` | → **typed** `FwBeginRequest` ← **typed** `FwBeginResponse` = `{ "sessionId": 101, "chunkSize": 8192 }`. Timeout 8 s |
| `FW_CHUNK` | `0x62` | → **BINARY**, 8-byte `sessionId`/`offset` header + data ← **inline** `{ "ok": true, "received": 8192 }`. Timeout 8 s |
| `FW_END` | `0x63` | → `{}` ← **typed** `FwEndResponse` = `{ "ok": true, "verified": true }`. Timeout 15 s |
| `FW_ABORT` | `0x64` | → `{}` ← **mock** `{ "ok": true }` |
| `FW_STATUS` | `0x65` | → `{ "target": "cam3" }` ← **typed** `FwStatusResponse` = `{ "target", "state", "version", "error"? }` |
| `FW_ROLLBACK` | `0x66` | → `{}` ← **inline** `{ "ok": true, "rebooting": true }` on a device with A/B slots. **Allocated and reserved; no firmware implements it, and the D4-V1 P4 NACKs `UNSUPPORTED_COMMAND`.** See below |

**`0x66` is taken.** `Cmd.FW_ROLLBACK = 0x66` exists in `packages/kdp/src/protocol/commands.ts` and
carried no row in this file, so "the next free slot after `0x65`" looked like `0x66` and was not.
Allocate the next firmware command at `0x67`, and extend this heading and the value map with it.

`FW_ROLLBACK` returns to the previous OTA slot. Nothing implements it: the D4-V1 P4 build has a
single application partition, so there is no previous slot to return to, and the dispatcher answers
`UNSUPPORTED_COMMAND`. The number is held so it cannot be reused and so no UI is built against an
invented shape; the slot state machine and NACK codes it would need are in `docs/RELEASE_TRUST.md`,
and `ROADMAP.md` carries it as future work. Build no host path against it — see
[README D8](README.md#d8--command-surface-differs-from-spec-047s-name-lists) and
[README D15](README.md#d15--targetid-gained-c6-and-fw_query-is-implemented-without-the-rest-of-fw_).

`FwBeginRequest` = `{ "target": "cam3", "size": 984320, "sha256": "…", "version": "0.2.0" }`.
`target` ∈ `cam1 | cam2 | cam3 | cam4 | p4`.
`FwTargetState` ∈ `idle | receiving | verifying | applying | rebooting | ready | error`.

Reference-device rules: maintenance mode is required first (`MAINT_REQUIRED`); one session at a time
(`BUSY`); image size must be 1 byte – 4 MB (`BAD_SIZE`); a stale `sessionId` gets `BAD_SESSION`;
`FW_END` before all bytes arrive gets `SHORT_IMAGE`. A P4 self-update reboots the device, which
changes the session ID and drops the link — that is expected, not a failure.

`FW_PROGRESS` (`0x82`) exists as an event id but is reserved and unemitted in 0.x (README §Decided).
It has no producer. Progress today is inferred host-side
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

`files[].sha256` and `meta` are both **optional**: 0.1.0+ never computes a digest and attaches
`meta` only when the capture's `META.JSON` parsed. A host reports a download with no digest as
unverified and prints a dash for every `meta` row — see D20 in [`README.md`](README.md).

`meta.calibration` is an **optional, additive** member (no protocol version bump):
`{ "version": "cal-…", "cams": { "cam1": { "x": 0, "y": 0, "rot": 0 }, … } }` — the alignment
calibration as it was at the shutter press, x/y in sensor pixels at the 1600-wide base, rot in
degrees. **No firmware records it yet**; consumers that find it absent fall back to live device
calibration and never invent offsets. Stamping it truthfully has to come from the device.

`MEDIA_READ` `length` is clamped to 8192 by the reference device. Ranges past EOF return short, not
an error.

### Network / Roll / upload queue — 0xa0–0xaa

Values allocated by this repo — see [README D3](README.md#d3--network--roll--upload-queue-numeric-values).
Studio's facade (`apps/studio/src/device/KinoDevice.ts`) calls all of these; the payload shapes are
**inline** there and **mock** in the reference device — no interface exists in `types.ts` yet. Gated
by the `network` / `rollUpload` capability flags.

| Cmd | Value | Payload |
|---|---:|---|
| `NETWORK_LIST` | `0xa0` | → `{}` or `{ "scan": true }` ← `{ "networks": [NetworkView] }`, plus `available[]`, `scanMs`, `scanComplete` when a scan was asked for ([README D3](README.md#d3--network--roll--upload-queue-numeric-values)) |
| `NETWORK_SET` | `0xa1` | → `{ "ssid", "password"?, "security"?, "autoJoin"? }` ← `{ "ok": true, "networks": [NetworkView] }` |
| `NETWORK_DELETE` | `0xa2` | → `{ "ssid": "loft-guest" }` ← `{ "ok": true, "networks": [NetworkView] }` |
| `NETWORK_STATUS` | `0xa3` | → `{}` or `{ "probe": true }` ← `{ "state", "ssid", "ip", "rssi", "since", "internet" }`, plus a `probe{}` block when asked ([README D3](README.md#d3--network--roll--upload-queue-numeric-values)) |
| `ROLL_STATUS` | `0xa4` | → `{}` ← `RollView` |
| `ROLL_CREATE` | `0xa5` | → `{ "name": "Friday party" }` ← firmware answers the full `RollView` (the five roll fields inside `roll`). Studio's `startRoll` (`apps/studio/src/roll/rollOps.ts`) still reads `rollId`/`slug`/`guestUrl` flat off the reply (`RollCreateResponse`), so the reference device answers **both**: the five fields flat *and* the full view. A host should read `roll.*` — the flat copy is compatibility |
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
//
// `pending` is the device's ACTIVE WINDOW (32 jobs on the reference device),
// not the card. `cardPending` is what the card still holds beyond that
// window, and `scanComplete` says whether the card has been seen end to end
// since boot - so "nothing left" is pending 0, cardPending 0, scanComplete
// true, and anything else is "nothing loaded yet" (#166, #167). `failed` is
// parked jobs, including ones parked on the card outside the window; a job
// parked for a run of network failures is revived by the device itself when
// the server answers again, a job the server refused waits for
// UPLOAD_QUEUE_RETRY. `uploaded` counts since power-on. `halted` is not
// `failed`: the jobs are fine and the credential or association is not.
{ "pending": 12, "uploading": 1, "failed": 2, "uploaded": 118, "draining": true,
  "cardPending": 640, "scanComplete": true, "halted": false, "lastError": null }

// RollView — on a roll
{ "active": true,
  "roll": { "rollId": "roll_0001", "slug": "amber-001",
            "guestUrl": "https://kino.roll/amber-001", "name": "Friday party",
            "role": "host", "joinedAt": 1755301234567 },
  "queue": { "pending": 12, "uploading": 1, "failed": 2, "uploaded": 118, "draining": true },
  // Two fields beyond the Studio interface. `serverReachable` is false when
  // the radio has no address OR the last HTTP exchange got no answer; it was
  // the radio state alone until 0.4.43 and read true with the API stopped.
  // `serverState` is offline | unknown (nothing tried since boot) |
  // reachable | unreachable.
  "serverReachable": true, "serverState": "reachable", "tokenStatus": "ok" }

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
| `STATUS` | `0x81` | — | **Reserved.** No producer, no consumer; a 0.x device must not emit it |
| `FW_PROGRESS` | `0x82` | — | **Reserved.** A 0.x device must not emit it. When the update path lands it takes `FwStatusResponse`'s shape |
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
   of a `CAMERA_SOAK_TEST` run rather than per capture. (`SYNC_BENCH` used to be
   the example here; on real firmware it is a blocking request that emits no job
   events at all — see [`SYNC_BENCH` — 0x46](#sync_bench--0x46).)

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
