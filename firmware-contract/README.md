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

## Unspecified — firmware team decision required

These are genuinely undefined. Do not infer a behavior from this document; decide and then amend
`commands.ts` / `types.ts` so the decision becomes source.

1. **`STATUS` (0x81) and `FW_PROGRESS` (0x82) event payloads.** Both ids exist in the `Evt` enum.
   Neither has a producer or a consumer anywhere in the repo. Shape is undefined.
2. **Sequence-ID wraparound.** The client increments a counter from 1 per connection and truncates to
   uint32 on encode. Behavior at wrap is untested and unspecified. In practice no session runs long
   enough to reach it.
3. **Whether HELLO is mandatory before other commands.** The client does not enforce ordering and the
   reference device answers any command without a prior HELLO. Firmware may be stricter; if it is,
   the rejection code is unspecified.
4. **Binary media resume.** 04§10 asks for per-chunk CRC and a completion hash. `MEDIA_READ` is a
   plain `{id, file, offset, length}` pull with no chunk sequencing beyond the frame CRC. Resume
   semantics beyond "ask for a different offset" are unspecified.
5. **`GET_MODES` (0x20) and `CAMERA_ARM` (0x31) payloads.** Only the reference mock defines them
   (`{"modes":["wiggle","quad"]}` and `{"ok":true}`). No Studio code path calls either.
6. **Whether a device may emit `JOB_PROGRESS` for a job the host never started.** The client buffers
   such events under a bounded orphan map, so it is survivable, but it is not sanctioned.
