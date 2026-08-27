# KINO firmware contract

The canonical reference the firmware team implements against.

Everything in these four files is **extracted from working source**, not designed here. Where the
implementation and the spec pack disagree, the implementation wins and the difference is recorded
under [Deviations](#deviations). No document in this directory introduces new protocol behavior.

| File | Contents |
|---|---|
| [`kdp-framing.md`](kdp-framing.md) | Byte layout, CRC, flags, sequence IDs, decoder requirements, payload limits |
| [`commands.md`](commands.md) | Every command and event with its numeric value, direction and payload shape; HELLO, NACK, session and job semantics |
| [`schemas.md`](schemas.md) | Portable document schemas (`kino.*`), envelope and migration rules, the timing-block contract |

## Source of truth

The prose here can rot. These files cannot — they are compiled, tested and shipped:

| Authority | Path | Covers |
|---|---|---|
| Framing | `packages/kdp/src/protocol/packet.ts` | Encoder, decoder, `MAX_PAYLOAD` |
| CRC | `packages/kdp/src/protocol/crc32.ts` | CRC-32 implementation |
| Command / event / flag values | `packages/kdp/src/protocol/commands.ts` | `Cmd`, `Evt`, `FrameFlags`, `PROTOCOL_VERSION` |
| Wire payload types | `packages/kdp/src/protocol/types.ts` | TypeScript interfaces for command payloads |
| Client semantics | `packages/kdp/src/protocol/KinoProtocolClient.ts` | Handshake, timeouts, event routing, job lifecycle |
| Timing vocabulary | `packages/kdp/src/protocol/timing.ts` | The three skew metrics and their grading bands |
| Portable document schemas | `packages/schemas/src/*.ts` | `kino.*` zod schemas, versions, migrations |
| Reference device | `packages/test-fixtures/src/MockKinoDevice.ts` | A working device-side implementation of everything below |

**If a payload shape appears in this contract but not in `types.ts`, it is marked "reference mock
only".** That means the shape is what `MockKinoDevice` produces and what Studio consumes today, but
it has no compile-time type behind it. Firmware should match it; treat it as slightly softer than
the typed surface.

Two distinct type systems are in play and must not be confused:

- **Wire payloads** (`@kino/kdp` `types.ts`) — what travels inside a KDP frame. Plain TypeScript
  interfaces, not versioned individually, covered by `PROTOCOL_VERSION`.
- **Portable documents** (`@kino/schemas`) — what gets persisted, exported, uploaded or backed up.
  Each carries `schema` + `version` and has its own migration path. See [`schemas.md`](schemas.md).

Firmware produces both. They overlap in subject (a capture, a device, a config) and differ in shape.

## Versioning

| Constant | Value | Where |
|---|---|---|
| `PROTOCOL_VERSION` | `1` | `commands.ts` — goes in the `VERSION` header byte and is negotiated by HELLO |
| `CONFIG_SCHEMA_VERSION` | `1` | `types.ts` — the config envelope's `schemaVersion` on the wire |
| All `kino.*` document schemas | `1` | `packages/schemas/src/*.ts` |

Rules:

- A **compatible** addition (new optional field, new command id, new capability flag) does not bump
  `PROTOCOL_VERSION`. Every parser on both sides tolerates unknown fields; unknown command ids get a
  `UNSUPPORTED_COMMAND` NACK. Gate new behavior behind a capability flag, never behind a version bump.
- A **breaking** change to framing or to an existing payload's meaning bumps `PROTOCOL_VERSION`, and
  the device must then accept the older version too for as long as it advertises it in HELLO's
  selected range.
- Document schema versions bump independently of `PROTOCOL_VERSION` and carry a migration function
  per step. See [`schemas.md`](schemas.md).

## Deviations

Recorded, not resolved. The implementation column is normative.

### D1 — Recipe vs Look: one concept, two names, split by layer

Spec 04§7 names the commands `GET_LOOKS` / `SET_LOOK` / `UPLOAD_LOOK` / `DELETE_LOOK`. Source names
them `GET_RECIPES` (0x22) / `SET_RECIPE` (0x23) / `UPLOAD_RECIPE` (0x24) / `DELETE_RECIPE` (0x25).

**The two names are not interchangeable — which one is correct depends on the layer:**

| Layer | Name | Where |
|---|---|---|
| KDP wire commands | **`*_RECIPE`** | `Cmd.GET_RECIPES` … `Cmd.DELETE_RECIPE`, `commands.ts` |
| KDP wire payload fields | **`recipe`** | `DeviceInfo.activeRecipe`, `CaptureSummary.recipeIds`, `WiggleConfig.recipeId`, `QuadSlotConfig.recipeId` — `types.ts` |
| `kino.capture` portable document | **`look`** | `look: z.string().optional()`, `packages/schemas/src/media.ts` |

Same value, two field names, and **crossing them fails silently.** `kino.capture` is a
`.passthrough()` schema and `look` is optional, so a device that writes `"recipe": "party-neg"` into a
capture document parses **clean** — no error, no warning. The unknown key is preserved verbatim, `look`
is simply absent, and every consumer that reads `look` sees a capture with no look reference. This is
a data-loss bug that validation cannot catch for you.

Firmware rules:

- Send `*_RECIPE` command ids and `recipe*` field names **on the wire**.
- Write `look` — never `recipe` — in a **`kino.capture`** document.
- The numeric command values are unambiguous either way; the document field name is not.

### D2 — `kino.device-info` vs `kino.device`

01§3 lists the schema identifier as `kino.device-info`; 05§19 prints the same example under
`"schema": "kino.device"`. `packages/schemas/src/device.ts` implements `kino.device-info`.

**Normative string: `kino.device-info`.** 05§19 is a spec inconsistency, not a second schema.

### D3 — Network / Roll / upload-queue numeric values

Spec 04§7 lists ten of these commands by name only and assigns no values. This repo allocated them,
plus `UPLOAD_ENQUEUE`, which 04§7 does not list at all — 02§16 requires a "push to Roll" gallery
action and no command existed to carry it, so it took the next free slot in the same block:

| Command | Value |
|---|---|
| `NETWORK_LIST` | `0xa0` |
| `NETWORK_SET` | `0xa1` |
| `NETWORK_DELETE` | `0xa2` |
| `NETWORK_STATUS` | `0xa3` |
| `ROLL_STATUS` | `0xa4` |
| `ROLL_CREATE` | `0xa5` |
| `ROLL_JOIN` | `0xa6` |
| `ROLL_LEAVE` | `0xa7` |
| `UPLOAD_QUEUE_STATUS` | `0xa8` |
| `UPLOAD_QUEUE_RETRY` | `0xa9` |
| `UPLOAD_ENQUEUE` | `0xaa` |

**These values are normative.** They sit deliberately above the `0x80`–`0x89` event range so a
command id and an event id can never collide in a protocol trace.

### D4 — `SYNC_BENCH` numeric value

Spec 04§7 lists `SYNC_BENCH` in the Diagnostics group and assigns no value. This repo allocated the
next free slot in KDP's diagnostics range (`0x40`–`0x45` were taken): `Cmd.SYNC_BENCH = 0x46` in
`packages/kdp/src/protocol/commands.ts`.

**`0x46` is normative.** Firmware implements `SYNC_BENCH` at `0x46`.

### D5 — Async job model additions

Spec 04§15 defines the job model in three bullets. Source adds concrete lifecycle rules that firmware
must respect on the wire — no events after `JOB_COMPLETE`/`JOB_FAILED`, no jobId reuse within a
session. Full wire expectations in [`commands.md § Async job model`](commands.md#async-job-model).

### D6 — Timing telemetry: all three keys required when the block is present

04§13 says "return null + reason" if a skew is unavailable. Source hardens this: when a
`kino.capture.timing` block is present, **all three** of `gpioTriggerSkewUs`, `vsyncPhaseSkewUs`,
`effectiveExposureSkewUs` must be present as `number | null`. Omitting a key is not a substitute for
`null` — an absent field reads as "this build has no such concept", `null` reads as "measured,
unavailable here". Only the whole block is optional. `unavailableReason` is optional and explains the
nulls. See [`schemas.md § Timing block`](schemas.md#timing-block).

### D7 — Payload cap is 16384, not ~4096

04§3 says "routine payload max ~4096 bytes" and "firmware chunk 4096–8192". `packet.ts` sets
`MAX_PAYLOAD = 16384` and the decoder rejects any declared length above it.

**16384 is the normative decoder limit.** The spec's figures are budget guidance, not a wire limit.
The reference device negotiates an 8192-byte chunk size for firmware and sound uploads.

### D8 — Command surface differs from spec 04§7's name lists

04§7 lists intended command groups. The implemented surface differs. Source is normative.

Spec commands **not implemented** — a firmware build may answer these with `UNSUPPORTED_COMMAND`
until they are added to `commands.ts`:

| Spec 04§7 name | Status in source |
|---|---|
| `GET_CONFIG_SCHEMA` | Not a command. `GET_CAPABILITIES` returns `configSchemaVersion` instead |
| `PATCH_CONFIG` | Not a command. `SET_CONFIG` takes a partial config and deep-merges it |
| `CAMERA_DISARM` | Absent (`CAMERA_ARM` 0x31 exists) |
| `CAMERA_PREVIEW_START` / `CAMERA_PREVIEW_STOP` | Replaced by a single-frame pull, `CAMERA_PREVIEW` 0x34 |
| `CAMERA_GET_TIMING` | Replaced by `CAMERA_CAPTURE` 0x33 with `{"action":"timing-test"}` |
| `GET_PROFILES` / `SET_PROFILE` | Absent |
| `GALLERY_LIST`, `CAPTURE_GET`, `ASSET_GET`, `ASSET_DELETE`, `CAPTURE_DELETE` | Replaced by the `MEDIA_*` group, `0x70`–`0x75` |
| `STORAGE_CHECK` / `STORAGE_FORMAT` | Absent (`GET_STORAGE_STATUS` 0x05 reports, does not act) |
| `UART_STRESS_TEST` | Named `LINK_BENCH` 0x44 |
| `FLASH_TEST` | Replaced by `CAMERA_CALIBRATE` 0x35 with `{"action":"flash-test"}` |
| `SPEAKER_TEST` / `BUTTON_TEST` | Absent — both are checks inside `SELF_TEST` 0x42 |
| `FW_ROLLBACK` | Absent |

Source commands **not in spec 04§7** — repo additions, normative:

| Command | Value | Note |
|---|---|---|
| `GET_SOUNDS` … `SOUND_DELETE` | `0x26`–`0x2b` | Custom shutter-sound storage, chunked upload |
| `CAMERA_PHASE` | `0x36` | VSYNC phase measurement and re-phasing (04§14 calls for it in prose) |
| `SET_LINK_BAUD` | `0x45` | Camera UART baud switching |
| `GET_RUNTIME_STATS` | `0x43` | Heap, temps, protocol counters |
| `MEDIA_THUMB`, `MEDIA_FAVORITE` | `0x72`, `0x75` | |

### D9 — Gallery cursor is a number, not an opaque string

04§9's example shows `"nextCursor": "opaque_cursor"` and a `filters` object in the request.
`MediaListResponse` in `types.ts` types `nextCursor` as `number | null`, and `MediaListRequest` has
`cursor?: number` and `limit?: number` with no `filters`. **Source is normative.** The reference
device caps `limit` at 100 and reports `total` and `hasMore` alongside.

### D10 — `PowerStatus.batteryV` / `batteryPct` are null on D4 V1: there is nothing to measure

`PowerStatus` in `types.ts` types `batteryV: number` and `batteryPct: number` as required, and makes
`busV`, `chargingA` and `fuse` optional with the note that a firmware without a rail ADC omits them
so *"Studio shows '—' rather than inventing 5.00"*.

**D4 V1 cannot measure the cell either.** The 505573 LiPo reaches the board through a protection
board and an SW6106 charger/boost carrier, and neither the pack nor the carrier routes a sense
divider or a fuel-gauge bus to the P4 — `docs/HARDWARE.md` §Battery and power describes the path and
no GPIO in the 2×13 header carries battery telemetry. Nothing in the camera knows the voltage.

The P4 firmware therefore sends **`null`** for both, not `0`:

| Field | 0.1.x value | Why |
|---|---|---|
| `batteryV` | `null` | `0` is a number a client draws as a flat battery. A wrong reading is worse than an absent one. |
| `batteryPct` | `null` | Same. |
| `batteryMeasured` | `false` | Added field, so a client need not infer intent from a null. |
| `state` | `"usb"` \| `"battery"` | Derived from whether a host is talking to us, **not** from the power path — the SW6106 feeds the same 5 V rail either way. |
| `charging` | `false` | Not sensable. Never reported true on this hardware. |

Clients must check `capabilities.powerTelemetry` before reading either field; 0.1.x reports it
`false`. `capabilities.powerManagement` is separately `true`, because the *other* half — `autoDimS`,
`sleepS` and `camIdleTimeoutS` from `BodyConfig` — is implemented and does work. Two flags, because
a client that wants to draw a battery and a client that wants to set a sleep timeout are asking
different questions.

This is a hardware gap, not a protocol one. It closes when the V2 carrier routes a divider or a
gauge; the field types do not need to change.

### D11 — `BodyConfig.brightness` and the dim stage have no hardware on D4 V1

`BodyConfig.brightness` is `1..10` and `autoDimS` implies a dimmed state between awake and asleep.
The Guition carrier drives the panel backlight from a plain GPIO, not a PWM channel, so the only
achievable states are lit and dark.

0.1.x therefore honours `sleepS` (backlight off) and `camIdleTimeoutS` (camera bank off via
`CAM_PWR_EN`) exactly, tracks and reports the `dim` stage in `GET_POWER_STATUS.displayStage` so a
client can show where the timeout has got to, and **ignores `brightness`**. The setting is stored and
returned unchanged rather than silently rewritten, so it is ready the moment the pin gets a
transistor.

### D12 — `jpegQuality` is a percentage on the wire and the inverse on the sensor

`jpegQuality` is documented `// 60..95` in `types.ts` and `recipeTypes.ts`, and Studio's sliders
present it that way: higher is better. `esp32-camera`'s `set_quality()` takes **5..63, where lower is
better**, and the camera node clamps to that range.

Nothing converted between them. A value of 85 sent down the node link arrived as a request for
quality 63 — the *worst* JPEG the sensor can produce — and 95 did the same. Both numbers are inside
the other scale's range, so neither end could detect it; the only symptom was that asking for better
quality made the picture worse.

0.3.0 converts in one place, `capture_quality_to_sensor()`, mapping 60..95 onto 20..5. The wire
contract is unchanged: the percentage is what Studio sends and what the settings envelope stores.

### D13 — the shared trigger wire is driven, and coordinates nothing yet

`GPIO32` (`BOARD_SYNC_OUT`) is pulsed for 200 µs at the start of every capture, and the pulse is
timed and logged. **The camera nodes do not arm on that edge.** They expose when their
`NL_CMD_CAPTURE` arrives over their own UART, exactly as they did before the wire was driven.

The pulse exists so the trace is proven and the node-side arm becomes a node change alone. Until it
does, the four frames of a capture are separated by however long it takes to wake four workers and
put four commands on four UARTs. `kino.capture.timing` reports that figure as `dispatchSpreadUs`,
under its own name, and reports all three of `gpioTriggerSkewUs`, `vsyncPhaseSkewUs` and
`effectiveExposureSkewUs` as `null` with an `unavailableReason`.

Dispatch spread is not exposure skew and must never be presented as it: the sensors free-run with a
rolling shutter, so when a command arrived says nothing certain about when light was integrated (04
§14). `CAMERA_CAPTURE` with `action: "timing-test"` is refused with `UNSUPPORTED_COMMAND` rather than
answered, and `GET_CAPABILITIES` reports `vsyncTelemetry: false`.

`GPIO32` and `GPIO28` are their own nets — `SYNC_OUT` and `FLASH_EN` in
`packages/hardware-profiles/src/profiles/d4-v1.json`. They sit beside `C6_U0RXD` and `C6_U0TXD` on
the 2×13 header, which is adjacency in the pinout table and not a shared signal; the C6 pins stay
reserved and undriven.

What `FLASH_EN` drives is a bench LED until the flash board exists. The pin is asserted before the
trigger and released as soon as every node reports its capture finished, bounded at 900 ms — because
without exposure sync a flash has to cover a window rather than an instant, and at 350–500 mA the
difference is worth bounding.

### D14 — `capturedAt` is required, and the body has no clock

`kino.capture` requires `capturedAt`, an ISO 8601 timestamp. The D4 V1 has no RTC, no battery-backed
clock, and no network. A body that has never been told the time cannot produce a true timestamp, and
a *plausible* false one is worse than an obviously false one: it survives import, sorts into the
wrong place in someone's roll, and is never questioned.

So the timestamp always travels with its source. `HELLO` gained two optional additive request fields,
`hostEpochMs` and `hostUtcOffsetMin`, and answers with `clockSource`; `META.JSON` and
`CAMERA_CAPTURE` carry the same field:

| `clockSource` | What the timestamp is worth |
| --- | --- |
| `host` | A host set it this session. Trust it. |
| `persisted` | Restored across a power cycle as a lower bound. The shot happened at or after this. |
| `unset` | Never told. The reading is uptime since the epoch and is visibly not a date. |

Firmware refuses a host time outside 2020–2100, which is what a seconds-for-milliseconds mix-up
looks like, and only persists a time it was actually given.

### D15 — `TargetId` gained `c6`, and `FW_QUERY` is implemented without the rest of `FW_*`

Two changes, one cause: the D4 carries a sixth firmware image and the version model could not name
it.

`TargetId` was `CamId | 'p4'` — five images. The Guition carrier's ESP32-C6 runs a hosted-slave
image of its own, which is a second thing that can be stale in the field, and issue #133 requires it
to be reportable "alongside the P4 and nodes". So `TargetId` is now `CamId | 'p4' | 'c6'` and
`ALL_TARGETS` has six members. Purely additive: nothing reads a specific target by position, and
`ALL_TARGETS` had no consumers outside its own declaration.

`FW_QUERY (0x60)` is now implemented. Every other command in the group —
`FW_BEGIN`/`CHUNK`/`END`/`ABORT`/`STATUS`/`ROLLBACK` — still returns `UNSUPPORTED_COMMAND`, because
the partition table is a single `factory` slot with no OTA pair (M8). That split is deliberate: a
query is not an update path, `GET_CAPABILITIES` advertises no update capability, and version
discovery is useful long before an update mechanism exists.

Two conventions this establishes for the response:

- An empty `version` means the device could not read one — a node that has never answered, or a C6
  with no transport. It is **not** version zero and must not be rendered as one.
- `state` describes an update in progress, so an unreachable target is `idle` rather than `error`:
  nothing failed and nothing was attempted. `error` there would send someone to re-flash a chip that
  is merely unwired.

The `c6` target carries two additive booleans, `fitted` and `reachable`, for the same reason
`flashControl` and `flashHardware` are two flags. Without them a host sees an empty version and
cannot tell an absent chip from an unrouted one — which on the D4 V1 is exactly the distinction that
matters, since the chip is fitted and no P4-side transport pin for it is recorded anywhere
(`firmware/C6_HARDWARE_MAP.md`).

Known divergence: the reference device (`packages/test-fixtures/src/MockKinoDevice.ts`) reports five
targets, not six. It simulates no C6, so reporting one would be an invented version. Studio's
`FW_QUERY` conformance check asserts only that the five it knows are *present*, so both devices
pass; a host must therefore treat a missing `c6` key as "this body has no radio", not as a protocol
error.

## Decided — was "firmware team decision required"

Issue #5 closed the six open questions this section used to list. They were open because physical
firmware cannot guess them, and a bench is a bad place to discover a design question. Each decision
below is now source: `commands.ts`, `types.ts`, `packet.ts` and the reference device implement it,
and a test pins it.

Three of the six are ratifications rather than inventions. Where the client, the reference device
and the P4 dispatcher already agreed on a behavior, the decision is to keep that behavior and forbid
firmware from being stricter — changing it would break a host that is entitled to the old one.

1. **`STATUS` (0x81) and `FW_PROGRESS` (0x82) — reserved, not emitted.** Neither has a producer or a
   consumer, and neither is on the 1B path: firmware update is gated behind `xiaoProxyUpdate`, which
   0.1.x reports `false`. A 0.x device **must not** emit either id. The shape stays undefined on
   purpose — defining it now would be guessing at a payload for a feature whose flow does not exist,
   and a wrong guess is worse than a gap. When the update path lands, `FW_PROGRESS` takes the shape
   `FwStatusResponse` already has, and that is the moment to write it down. The host drops unknown
   events, so a stray one is survivable but out of contract.
2. **Sequence-ID wraparound — wrap to 1, never to 0.** `nextSeq()` in `packet.ts` is the rule, and
   firmware mirrors that one function. Sequence 0 is the events' sentinel; a uint32 counter left to
   overflow naturally would start minting requests that look like events to anything reading the
   field literally. No session runs long enough to reach it, which is exactly why both sides have to
   agree in advance instead of meeting the overflow separately.
3. **HELLO is not mandatory — and firmware must not make it so.** The client does not enforce
   ordering, the reference device answers any command without one, and `kdp_server.c` dispatches
   without checking. Three implementations already agree; a stricter firmware would reject hosts that
   are within contract. HELLO stays the only way to obtain a `sessionId`, and commands that need
   session state (sound upload, firmware sessions) keep answering `NO_SESSION` — that is a
   per-command precondition, not a connection-wide one. Because there is no such thing as a rejected
   pre-HELLO command, no rejection code is needed.
4. **Binary media resume — offset restart is the whole mechanism.** 04§10 asked for per-chunk CRC and
   a completion hash. The per-chunk CRC is the frame CRC, which already covers every byte of every
   chunk and is checked before the payload is handed up. There is no completion hash in v1: `MEDIA_INFO`
   carries the size, a short read is visible without one, and hashing a 4 MB JPEG on the P4 costs
   more than it proves. Resume is "ask for a different offset", and firmware must serve any valid
   offset into a file it listed.
5. **`GET_MODES` (0x20) and `CAMERA_ARM` (0x31) — the reference payloads are now the spec.**
   `GetModesResponse` = `{ modes: ShootMode[] }` and `CameraArmResponse` = `{ ok, armWindowMs }` live
   in `types.ts`, and the reference device is typed against them. `armWindowMs` is not optional: with
   no CAMERA_DISARM, the window is the only thing that tells a host when the sensors fall back to
   `ready`. Neither command is in the 1B set, so 0.1.x NACKs both `UNSUPPORTED_COMMAND` — the payload
   is decided for the firmware that implements them, not smuggled into this one.
6. **`JOB_PROGRESS` for a job this session never started — sanctioned, but only after a reconnect.**
   A host that reconnects mid-job legitimately receives progress for a job it did not start, so the
   client's bounded orphan map is contract, not tolerance. What a device must not do is invent jobs:
   every `jobId` it reports has to correspond to work some host asked for. Unbounded orphan traffic
   is a firmware bug, and the host's bound is what keeps it from being a host bug too.

**Compatibility.** None of the six bumps `PROTOCOL_VERSION`. Four are documentation of behavior that
already shipped, one adds response types for commands no 0.1.x device answers, and the wrap rule is
unreachable in any real session. KDP stays at **1** for all of 0.x, and `versions.json` keeps
`protocol.kdp: 1`. New behavior goes behind a capability flag; the version byte changes only when the
framing or an existing payload's meaning does.
