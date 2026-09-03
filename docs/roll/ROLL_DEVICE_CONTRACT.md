# Roll device contract

What physical D4 firmware must implement to upload captures directly to KINO Roll. This is the target for the future Wi-Fi/Roll-upload firmware milestone. It is NOT part of Milestone 1: the shipped 0.1.0 firmware has no network stack and reports `rollUpload: false`, `network: false`.

Until that milestone, the Twin development bridge (`apps/twin/src/roll/bridge.ts`) implements this exact contract in the browser, against the real API. The `infra/scripts/test-uploader.ts` and `infra/scripts/party-sim.ts` scripts implement it from Node. All three exist so the firmware team inherits a proven wire contract, not a design document.

Normative sources, in order: `apps/api/src/routes/device-captures.ts`, `device-rolls.ts`, `studio-devices.ts`; `packages/schemas/src/media.ts` (`kino.capture`, `ASSET_ROLES`, `CAPTURE_STATUSES`).

## Authentication

| Step | Call | Notes |
|---|---|---|
| Register once | `POST /api/studio/devices/register` `{serial, product, hardwareRevision, name?}` with `Authorization: Bearer <PROVISIONING_TOKEN>` | Returns `{deviceId, deviceToken}`. Token is `kdt_` + 43 base64url chars. Registration requires the server's provisioning secret (401 `PROVISIONING_TOKEN_REQUIRED` without it) — it is a bench/Studio step, not something a device in the field does. Studio registers the camera and writes the credential to NVS over KDP (`roll.credentials`); the camera's own register fallback only works against a dev server whose token it has been given. Outside development, registration is also first-write-wins per serial (409 `DEVICE_ALREADY_REGISTERED`). |
| Every device call | `Authorization: Bearer kdt_...` | The server stores only the SHA-256 of the token. Persist the token in device NVS; it cannot be re-read from the server. |

## Roll association

| Call | Result |
|---|---|
| `POST /api/device/rolls` `{title, pin?}` | Creates a Roll this device owns. Returns `{rollId, slug, guestUrl, hostUrl, hostToken}`. `guestUrl` is the QR payload the D4 display shows (`JOIN THIS ROLL`). |
| `POST /api/device/rolls/join` `{slug}` | Associates with an existing Roll. 10 wrong slugs lock joining (429 `JOIN_LOCKED`). |
| `GET /api/device/rolls/current` | Lists this device's Rolls after reboot. |

Uploads to a Roll the device is not associated with return 403 `DEVICE_NOT_IN_ROLL`.

## Capture identity

One capture = one `kino.capture` document (schema version 1). The firmware must generate a UUIDv4 `captureUuid` at commit time and store it with the capture on SD. Required fields: `schema`, `version`, `id`, `captureUuid`, `deviceId`, `mode` (`wiggle`|`quad`|`single`), `capturedAt` (ISO 8601 with offset), `frameCount`, `resolution` (`WxH`), `status: "created"`, `visible`. Unknown extra keys are preserved as provenance.

`mode` must match what was stored: a capture with one frame is `single`. Never claim `wiggle` for fewer than 2 frames — Roll renders Wiggle controls from this field.

## Upload procedure

Per capture, in this order:

1. `POST /api/device/rolls/{rollId}/captures` with the capture document. 201 (created) and 200 (replay) both return the same `{captureId}` for the same `captureUuid`.
2. Optional but strongly preferred first asset: `thumb` (JPEG, ~200×150). It flips the capture to `preview-ready` and guests see the tile immediately.
3. Each original frame as role `original-frame` with `frameIndex` = the camera slot (1..4 on D4; `image/jpeg` only). The set is the frames META.JSON lists, and it need not be contiguous: a capture taken with camera 2 dark holds frames 1, 3 and 4, `frameCount` is 3, and exactly those three assets are uploaded — `frameIndex` names the camera, never a position in the sequence (firmware #164, 2026-09-03):
   - `POST /api/device/captures/{captureId}/assets/init` `{role, frameIndex?, mime, bytes, sha256}` → `{uploadId, partSize, alreadyComplete}`. If `alreadyComplete`, skip to the next asset.
   - `PUT /api/device/uploads/{uploadId}/parts/{partNo}` raw octet-stream, parts ≤ `partSize` (5 MiB).
   - `POST /api/device/uploads/{uploadId}/complete`. The server re-hashes the stored object; 422 `CHECKSUM_MISMATCH` means re-upload.
4. `POST /api/device/captures/{captureId}/complete` — enqueues server-side processing.
5. Optional: poll `GET /api/device/captures/{captureId}/status` until `ready|partial|failed`.

## Idempotency

The identity of every unit of work is `captureUuid + role + frameIndex`. Retrying any step — capture create, asset init, part PUT, either complete — is safe and converges on the same server state. A reboot mid-upload must not create a second capture: re-read `captureUuid` from SD and repeat the procedure from step 1.

## Queue, retry, resume, offline

- SD originals are the source of truth. The upload queue persists capture UUIDs and per-asset progress on SD and survives reboot.
- The shutter must never wait on the queue, the network, or the Roll server. No Roll condition may block or fail a capture.
- On failure: exponential backoff (suggested 1 s → 30 s cap), then resume from the first incomplete step. Distinguish drop-status responses (400/401/403/404/422 — do not retry the same bytes; log and park) from transient failures (network, 5xx, 429 — retry).
- Wi-Fi loss mid-part: re-init the asset; `alreadyComplete` and part re-PUTs make the resume cheap.
- Progressive delivery: upload thumbs for all queued captures before originals when the queue is deep, so guests see the newest shots first.

## Progressive capture states (server-side)

`created → preview-ready → originals-uploading → complete → processing → ready` (or `partial`/`failed`). The device only ever writes `created` and drives transitions by uploading; it never patches `status` directly.

## Error handling summary

| Response | Device action |
|---|---|
| 401/403 | Stop the queue, surface on the device display. Credentials or association are wrong; retrying cannot help. |
| 409 `UPLOAD_IN_PROGRESS` | Another init is open for the same asset; retry init after backoff. |
| 422 `CHECKSUM_MISMATCH` | Re-read the file from SD and re-upload. |
| 429 | Honor backoff. |
| Network error / 5xx | Keep the job, back off, resume. |

## Acceptance for the firmware milestone

The physical firmware replaces the Twin bridge in `docs/roll/ROLL_GUEST_ACCEPTANCE_TESTS.md` without any Roll or API change, and passes the outage drill: two captures taken while the server is down appear exactly once each after it returns.
