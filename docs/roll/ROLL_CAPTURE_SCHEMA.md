# Roll capture schema

Reference map of the capture identity Roll, Studio, Twin, and firmware share. Normative source: `packages/schemas/src/media.ts` (`kino.capture` v1, `kino.asset` v1) — when this page and the code disagree, the code wins.

## Identity and provenance

| Field | Owner | Notes |
|---|---|---|
| `captureUuid` | Device (or Twin bridge) at commit time | UUIDv4. THE idempotency anchor: unique per `(rollId, captureUuid)`. |
| `deviceId` | Server, from the bearer token | The document's value is overridden server-side. |
| `rollId` | Server, from the URL | Same. |
| `id` | Device | Device-local id (`cap_twin_…`, `cap_local_…`). Kept as provenance. |
| `mode` | Device | `wiggle` \| `quad` \| `single`. Must match stored frame count — Roll renders Wiggle controls from this. |
| `capturedAt` | Device | ISO 8601 with offset. |
| `frameCount`, `resolution` | Device | What was actually stored. |
| `timing` | Device, optional | `gpioTriggerSkewUs`, `vsyncPhaseSkewUs`, `effectiveExposureSkewUs`. |
| Any extra keys | Device | Preserved verbatim in `captures.provenance` (e.g. the Twin bridge writes `twin.firmwareProfile`). |

## Capture status ladder

`CAPTURE_STATUSES`: `created → preview-ready → originals-uploading → complete → processing → ready`, terminal alternatives `partial`, `failed`. The device never patches status; uploads drive it (`nextCaptureStatus` in `apps/api/src/uploads/uploads.ts`).

Mapping from the product-prompt state names:

| Prompt state | Implemented as |
|---|---|
| `CAPTURE_CREATED` | `created` |
| `THUMBNAIL_READY` / `PREVIEW_READY` | `preview-ready` (a `thumb` or `wiggle-preview` asset became ready) |
| `PROCESSED_READY` | `processing → ready` plus per-derivative `processing.completed` events |
| `ORIGINALS_READY` | `complete` (all originals landed, before processing settles) |

## Asset roles

`ASSET_ROLES`: `thumb`, `kino-still`, `original-frame` (the only role with `frameIndex`, JPEG only, immutable once written), `wiggle-preview`, `wiggle-webp`, `wiggle-mp4`, `gif`, `contact-sheet`, `enhanced-still`, `enhanced-wiggle`, `metadata`.

Capability-aware rendering: the guest app renders only assets that exist and are `ready`. A `single` capture never gets wiggle derivatives; `render-wiggle-webp` is planned only for `mode: wiggle` (`plannedJobs`, `apps/api/src/uploads/uploads.ts`).

## Upload idempotency key

`captureUuid + role + frameIndex` (`idempotencyKeyFor`, `apps/api/src/uploads/uploads.ts`). Any retry of any upload step converges; originals can never be overwritten.
