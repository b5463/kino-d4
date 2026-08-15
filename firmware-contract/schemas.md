# Portable document schemas

`kino.*` documents — anything persisted, exported, uploaded or backed up. Distinct from KDP wire
payloads, which are covered in [`commands.md`](commands.md).

**This is a pointer document.** The zod schemas in `packages/schemas/src/` are the type authority.
Field tables copied here would rot; the source will not. Each schema below gets its identity, its
source file, and one worked example. For the exact field list, constraints and optionality, read the
zod object.

## Wire payloads vs portable documents

| | Wire payload | Portable document |
|---|---|---|
| Defined in | `packages/kdp/src/protocol/types.ts` | `packages/schemas/src/*.ts` |
| Form | TypeScript interfaces | zod schemas |
| Versioning | covered by `PROTOCOL_VERSION` | per-document `schema` + `version` |
| Carries an envelope | no | yes — `{ "schema": "...", "version": 1, ... }` |
| Lives | inside one KDP frame | on disk, in a backup, in an upload, in the catalog |

They overlap in subject and differ in shape. `DeviceInfo` (wire, from `GET_DEVICE_INFO`) and
`kino.device-info` (document) both describe the camera and share no field list. Do not substitute one
for the other.

Firmware produces both.

## The schemas

Source: `packages/schemas/src/`. All are at **version 1** with **no migrations defined yet**.

| Schema | Version | Source file |
|---|---:|---|
| `kino.device-info` | 1 | `device.ts` |
| `kino.device-capabilities` | 1 | `device.ts` |
| `kino.device-config` | 1 | `config.ts` |
| `kino.capture` | 1 | `media.ts` |
| `kino.asset` | 1 | `media.ts` |
| `kino.roll` | 1 | `media.ts` |
| `kino.firmware-manifest` | 1 | `firmware.ts` |

01§3 also lists `kino.calibration`, `kino.look`, `kino.profile`, `kino.device-backup` and
`kino.diagnostic-report`. **Those are not implemented.** Do not emit a document under those names
until a zod schema exists for it.

Export surface: `packages/schemas/src/index.ts`.

## Envelope

Every document carries the same two fields, validated by `registry.ts` before anything else:

```json
{ "schema": "kino.capture", "version": 1, "...": "rest of the document" }
```

| Field | Rule |
|---|---|
| `schema` | Exact string match against the expected schema. A mismatch throws before any field is read |
| `version` | Integer ≥ 1 |

The envelope parser is `.passthrough()` — unknown top-level fields survive it.

## Migration and version rules

`parseVersioned(def, raw)` in `packages/schemas/src/registry.ts` is the single entry point. Its
behavior is the contract:

| Case | Result |
|---|---|
| `schema` string differs | Throws `expected schema X, got Y` |
| `version` > the version this build knows | Throws **`SchemaTooNewError`** |
| `version` < known, and a migration exists for every step | Migrations run in sequence, each bumping `version` by 1, then the current-version schema parses the result |
| `version` < known, and a step is missing | Throws **`MissingMigrationError`** |
| `version` == known | Parsed directly |

Consequences for firmware:

- **Never emit a `version` higher than the host advertises support for.** `SchemaTooNewError` is
  terminal — there is no forward migration. Forward compatibility is achieved by adding *fields* at
  the same version (they pass through), not by bumping the version.
- **A version bump requires a migration function** written at the same time, in the same file, for
  the step it introduces. `version: 2` without a `1 → 2` migration makes every existing v1 document
  unreadable.
- Migrations are pure `Record<string, unknown> → Record<string, unknown>` and only ever run forward.
- `SchemaTooNewError` and `MissingMigrationError` are exported from `@kino/schemas`; hosts distinguish
  "your firmware is newer than this Studio" from "this document is corrupt".

## Unknown-field tolerance

**Every schema object is `.passthrough()`.** Unknown keys are preserved, not stripped and not rejected.

This is a requirement, not an accident (07§14: "tolerate unknown future capability fields"; 01§2
forbids hard-coding one camera count / one sensor / one sync method / one transport). It means:

- A newer device may add fields to any document and an older Studio will read it, keep the unknown
  fields intact through a read-modify-write, and write them back.
- `kino.device-config`'s `config` body is only lightly validated (`mode`, `resolution`, optional
  `flash`) and passes everything else through, so nested sections such as `wiggle` and sections added
  by later firmware survive a round trip untouched.
- `kino.device-capabilities.features` is `z.record(z.unknown())`, not a boolean map. A future device
  may report a list or a count under a name Studio has never seen and the parse must not fail.
  **Read a feature flag as `features.x === true`.** Absent means "not advertised", i.e. unsupported.
- `kino.firmware-manifest.targets` is an open record, not a fixed `{ main, cameraNode }` pair.

Corollary: adding a field is never a breaking change and never justifies a version bump.

## Worked examples

One per schema. These are the spec-pack examples, which the repo's fixtures parse clean.

### `kino.device-info`

Note the identifier: 05§19 prints this example under `"schema": "kino.device"`. **`kino.device-info`
is the canonical name** (01§3) — see [README D2](README.md#d2--kinodevice-info-vs-kinodevice).

```json
{
  "schema": "kino.device-info",
  "version": 1,
  "id": "dev_01",
  "serial": "KD4-00001",
  "product": "KINO D4",
  "hardwareRevision": "D4-V1",
  "name": "House Camera"
}
```

`name` is a user-assigned label and is optional — a factory-fresh camera has none.

### `kino.device-capabilities`

```json
{
  "schema": "kino.device-capabilities",
  "version": 1,
  "cameraCount": 4,
  "cameraSensor": "OV3660",
  "maxResolution": "2048x1536",
  "syncMethod": "vsync-assisted",
  "features": { "wiggle": true, "quad": true, "rollUpload": true, "vsyncTelemetry": true }
}
```

Only `cameraCount` is required (positive integer). `maxResolution` must match `WIDTHxHEIGHT`.
`syncMethod` and `cameraTransport` are free strings so a later device can report `"hardware"` or
`"mipi"` without a schema change.

This is the **document**. `GET_CAPABILITIES` returns a different, non-enveloped wire shape — see
[`commands.md § Capability negotiation`](commands.md#capability-negotiation).

### `kino.device-config`

```json
{
  "schema": "kino.device-config",
  "version": 1,
  "revision": 12,
  "config": {
    "mode": "wiggle",
    "resolution": "1600x1200",
    "flash": "auto",
    "wiggle": { "fps": 10, "direction": "ltr", "loop": "bounce" }
  }
}
```

`revision` is the same counter the wire config envelope calls `configRevision` — bumped on every
accepted write. `mode` is a free string, not an enum: 03§12 already lists `video`/`burst`/`panorama`
as future capture types that older builds must still be able to read. `flash` is optional — a device
with no flash hardware omits it.

### `kino.capture`

```json
{
  "schema": "kino.capture",
  "version": 1,
  "id": "cap_0042",
  "captureUuid": "b96c0f5e-8f2a-4d3b-9c11-2f7a6c8e1d40",
  "rollId": "roll_01",
  "deviceId": "dev_01",
  "mode": "wiggle",
  "look": "party-neg",
  "capturedAt": "2026-08-14T23:42:18+02:00",
  "frameCount": 4,
  "resolution": "1600x1200",
  "timing": {
    "gpioTriggerSkewUs": 140,
    "vsyncPhaseSkewUs": 1200,
    "effectiveExposureSkewUs": null
  },
  "status": "ready",
  "visible": true
}
```

`captureUuid` must be a real UUID. `capturedAt` is ISO 8601 **with offset**. `frameCount` is whatever
the device produced — 03§12 forbids a hard-coded 4-frame model. `rollId` is null or absent until the
capture is filed into a roll. `mode` ∈ `wiggle | quad | single`; `status` ∈ `created`,
`preview-ready`, `originals-uploading`, `complete`, `processing`, `ready`, `partial`, `failed`.

### `kino.asset`

```json
{
  "schema": "kino.asset",
  "version": 1,
  "id": "asset_01",
  "captureId": "cap_0042",
  "role": "wiggle-preview",
  "mime": "image/webp",
  "width": 1280,
  "height": 960,
  "bytes": 412032,
  "sha256": "…64 lowercase hex chars…",
  "status": "ready"
}
```

`role` is a closed enum — `ASSET_ROLES` in `media.ts`, eleven values. `status` is deliberately **not**
an enum: 05§8 enumerates capture states only and describes asset progress in prose, so pinning wire
strings would be invention. `width`/`height` are absent for non-pixel roles such as `metadata`.
`bytes` and `sha256` are unknown until the upload finalizes. `sha256` must be 64 lowercase hex chars
when present.

### `kino.roll`

```json
{
  "schema": "kino.roll",
  "version": 1,
  "id": "roll_01",
  "slug": "7F3K9Q",
  "title": "Friday House Party",
  "status": "live",
  "privacy": "unlisted",
  "downloadsEnabled": true
}
```

`slug` is a random unguessable public slug (05§14). `status` ∈ `draft | live | closed | archived | trash`.
`privacy` is a free string — 03§9 names the modes in prose without fixing wire strings.
`downloadsEnabled` has **no default**: download policy is a privacy decision and is never inferred.

### `kino.firmware-manifest`

```json
{
  "schema": "kino.firmware-manifest",
  "version": 1,
  "release": "0.6.1",
  "channel": "stable",
  "protocolMin": 1,
  "protocolMax": 1,
  "compatibleHardware": ["D4-V1"],
  "targets": {
    "main":       { "file": "p4-app.bin",  "sha256": "…" },
    "cameraNode": { "file": "xiao-app.bin", "sha256": "…" }
  },
  "updateOrder": ["cameraNode", "main"]
}
```

- `targets` is an open record. Per-target `version` is optional — 04§12's device-facing manifest omits
  it while 05§19's catalog manifest carries it.
- `compatibleHardware` needs at least one entry.
- **`updateOrder` must name only targets this manifest ships.** A typo would otherwise parse clean and
  make a flasher silently skip a node — the worst possible OTA failure, since 04§11 rollback assumes
  every target was attempted. The schema enforces this with a subset check.
- Listing **fewer** entries than `targets` has is legal: pin the order of the targets that matter and
  leave the rest to Studio. `updateOrder` absent means Studio picks the order entirely.

## Timing block

The `timing` block inside `kino.capture` (04§13–14). This is the persisted telemetry; the live
measurement shape is `TimingResult` — see [`commands.md § Timing`](commands.md#timing).

```json
{
  "timing": {
    "gpioTriggerSkewUs": 140,
    "vsyncPhaseSkewUs": 1200,
    "effectiveExposureSkewUs": null,
    "unavailableReason": "VSYNC not readable on this sensor build"
  }
}
```

Rules, in order of how often they get broken:

1. **All three skew keys are required whenever the block is present.** Each is `number | null`.
   Omitting a key is **not** an allowed substitute for `null`. An absent field reads as "this build
   has no such concept"; `null` reads as "measured, unavailable here". Those are different facts and
   the schema will not let you blur them.
2. **Only the whole block is optional.** A device that reported no telemetry at all omits `timing`
   entirely. A device that measured anything sends all three keys.
3. **Null plus a reason. Never fabricate.** If a skew cannot be measured, send `null` and set
   `unavailableReason` to a human-readable explanation. `unavailableReason` itself is optional but
   should be present whenever any value is `null`.
4. **Never conflate the three.** A tight `gpioTriggerSkewUs` does not prove a tight
   `effectiveExposureSkewUs` on a free-running rolling shutter. Reporting the GPIO figure under the
   exposure key is the specific failure this contract exists to prevent.
5. The block is `.passthrough()` — extra measurements may be added later without a version bump.
