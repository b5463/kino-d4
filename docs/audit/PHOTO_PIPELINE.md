# Photo pipeline — original → corrections → look → optional AI → export

The complete image path and its audited integrity properties. Normative: `apps/api/src`, `apps/worker/src`, `packages/schemas/src/media.ts`, `packages/media/src`.

## The path

```
sensor → XIAO JPEG → P4 → SD (/DCIM)
      → resumable upload (S3 multipart, checksum-verified, duplicate-safe via captureUuid unique index)
      → originals under rolls/<roll>/captures/<capture>/original/cam-NN.jpg   [IMMUTABLE]
      → worker derivatives under …/derived/ (thumb, still, contact sheet, wiggle WebP, lazy MP4, metadata.json)
      → Roll guest feed / Studio tether import
      → export (per-frame JPEG, ZIP with 24 h link, client-side GIF)
```

## Originals are immutable — verified

- API: `assertNotOriginalOverwrite` refuses any `original/` write without a declared sha256 or with a differing one (409 `ORIGINAL_IMMUTABLE`).
- Worker: enforced in the S3 client middleware itself — the derived-writer client cannot address `original/` keys at all.
- Deletion: 7-day trash grace, nightly purge, objects-before-rows, re-entrant, erase-only narrow client. Guests never see object keys.

## Capture status ladder

`created → preview-ready → originals-uploading → complete → processing → ready`, with `partial`/`failed` and lost-job recovery. Worker jobs are idempotent (`jobId = jobKey`, DB partial-unique enqueue lock) and independent — one failed derivative never blocks the rest.

## Audited gaps

1. **Provenance — closed on the server, open on the device.** `captures.provenance` (migration 0008) lands the device identity at capture time plus the whole passthrough remainder of `kino.capture`; `assets.producer / produced_at` record which job, encoder, and settings made each derivative, and the wiggle producers also record `calibrationVersion`, `aligned`, `crop`, and `look` (all producers carry `look`). `metadata.json` echoes provenance and the parsed calibration. **Still firmware-blocked:** a truthful capture-time calibration version, per-frame exposure, and flash-fired can only come from the device, and no firmware sends them yet — until then a real capture's provenance carries the device identity and nothing richer.
2. **The KINO look is device-only.** Looks are device recipes applied on the P4 (deterministic, versioned there); the worker renders derivatives without reading `captures.look`, so there is no server-side reproducible look and re-rendering old captures on new constants changes the photograph invisibly.
3. **Alignment drift — mechanism closed, data firmware-blocked.** The alignment geometry (offsets, rotation, overlap crop) lives once, in `@kino/media` (`alignmentPlan`); Studio's canvas preview and the worker's baked WebP/MP4 both execute it, and the worker applies it at source resolution before the resize when the capture's provenance carries `meta.calibration` (validated, clamped ±20 px / ±2°). Absent calibration the render path is unchanged — offsets are never invented, and the current device calibration is never borrowed for an old capture. **What remains:** no firmware records `meta.calibration` on `kino.capture` yet, so real captures still render unaligned until the device stamps its calibration at the shutter press (`firmware-contract/commands.md`). (Over-stabilization risk stays structurally absent: alignment is a rigid transform + crop, so parallax survives.)
4. **No RAW / ALIGNED / FINAL staging** and no server-side GIF (role exists, encoder is browser-only).
5. **Per-capture playback — closed.** `captures.playback` (migration 0009) persists the host's fps/loop/direction in the KDP vocabulary via `PATCH /api/host/captures/:captureId/playback`, which re-renders the wiggle WebP (and the MP4 only when it already exists) and publishes `capture.updated`. The Roll player reads the same stored values (loop mapped through `kdpLoopToMediaLoop` — KDP `sweep` is media `once`), so the live wiggle and the baked files agree. Renderer defaults (10 fps, bounce, ltr) remain the fallback for captures with no stored choice.

## Corrections vs creative vs AI

Technical corrections (alignment, exposure/WB/color matching) live in per-camera calibration; creative character lives in deterministic recipes; AI is a separate optional stage (see `AI_PROCESSING.md`). The separations exist in the architecture; the derived pipeline participating in the first two is the open work.

## Concurrency priority

`capture > local persistence > UI > background upload/processing` is the product rule; today it is not stated or enforced in the queue (single queue, no BullMQ priorities — MP4 renders compete with thumbnails). The de facto mitigation is lazy MP4/contact-sheet enqueueing. Explicit priorities are a scheduled follow-up; heavy AI never runs on-camera.
