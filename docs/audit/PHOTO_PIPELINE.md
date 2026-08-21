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

1. **Provenance is thin.** `captures` persists timing, mode, look, resolution — but not device serial/hardware at capture time, firmware versions, per-frame exposure, flash-fired, or calibration version; `kino.capture` is passthrough so a richer firmware payload is silently dropped. `assets` rows carry no producer identity (pipeline version, settings, producedAt) — retuning a render constant silently reinterprets history. Cheapest fix on file: `provenance jsonb` on captures + `producer jsonb / produced_at` on assets.
2. **The KINO look is device-only.** Looks are device recipes applied on the P4 (deterministic, versioned there); the worker renders derivatives without reading `captures.look`, so there is no server-side reproducible look and re-rendering old captures on new constants changes the photograph invisibly.
3. **Alignment drift.** Studio previews wiggles with per-camera calibration offsets and overlap crop; the baked WebP/MP4 applies none of it — host preview and guest file are different wigglegrams. (Over-stabilization risk is structurally absent: alignment is a rigid transform + crop, so parallax survives; the gap is consistency, not destruction.)
4. **No RAW / ALIGNED / FINAL staging** and no server-side GIF (role exists, encoder is browser-only).
5. Per-capture playback settings (fps/loop/direction) are renderer fallbacks with no persisted host choice.

## Corrections vs creative vs AI

Technical corrections (alignment, exposure/WB/color matching) live in per-camera calibration; creative character lives in deterministic recipes; AI is a separate optional stage (see `AI_PROCESSING.md`). The separations exist in the architecture; the derived pipeline participating in the first two is the open work.

## Concurrency priority

`capture > local persistence > UI > background upload/processing` is the product rule; today it is not stated or enforced in the queue (single queue, no BullMQ priorities — MP4 renders compete with thumbnails). The de facto mitigation is lazy MP4/contact-sheet enqueueing. Explicit priorities are a scheduled follow-up; heavy AI never runs on-camera.
