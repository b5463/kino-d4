# Roll device contract

What physical D4 firmware implements to upload captures directly to KINO Roll. Implemented and proven on hardware since firmware 0.4.4 (first photographs on a real backend) and 0.4.36 (automatic drain of 166 captures after an outage); the reference implementation is `firmware/p4/main/upload_queue.c`, `roll_api.c`, `roll_queue.c`. The paragraph that stood here until 2026-09-05 described the 0.1.0 firmware with no network stack; that firmware is history.

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

### Heartbeat (OPTIONAL)

`POST /api/device/rolls/{rollId}/heartbeat` — the camera saying it is still there, and what it still owes.

This call is **optional and additive**. Firmware that predates it never makes it, uploads exactly as before, and is not degraded in any way. It exists for one question the host dashboard could not answer without it: *is the camera offline, or is nobody shooting?* A roll with no new captures for ten minutes looks identical in both cases.

The server overwrites the row in place rather than appending to a log — the host needs the camera's current state, not its history — and every field stays **null** for a device that joined and never sent a heartbeat. "Never heard from" is not "0 pending, last seen at the epoch", and the dashboard has to be able to say which it is. Verified against `rollDevices` in `apps/api/src/db/schema.ts`: `last_seen_at`, `queue_pending`, `queue_uploading`, `queue_failed`, `server_state` (`unknown|reachable|unreachable`), `firmware_version`, `upload_paused`.

`uploadPaused` is three-valued and the third value carries weight. `true` means the camera's upload queue is halted because this server refused its credential (401/403) — what the ROLL screen calls UPLOAD PAUSED, and the only camera state that never clears itself: a dead uplink catches up, a rejected token uploads nothing ever again until somebody re-provisions the device. `false` means the queue is running. **Omitting the key stores NULL**, which means "this firmware does not report it" — so a camera that predates the field is not mistaken for one claiming a healthy queue, and a dashboard must not render NULL as a green light.

The camera reads it off its own upload queue's `halted` flag and keeps no second flag. A halt must not change the heartbeat's cadence: no early heartbeat when the queue halts or unhalts, and no suppression while it stays halted. A halted camera is exactly the one whose silence a host would misread as an idle camera, so the halt goes out in the body of whichever ordinary 45 s heartbeat was due anyway. Firmware 0.4.52 got this wrong in a way worth recording: the heartbeat was sent below the queue's own eligibility gate, so a halted queue sent nothing at all and the state that most needed reporting was the one that went silent.

A failed heartbeat is not an upload failure. Treat it as fire-and-forget: no backoff state, no queue effect, and never a reason to stop or delay a capture.

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
   - `POST /api/device/uploads/{uploadId}/complete`. The server re-hashes the stored object and checks its length; 422 `CHECKSUM_MISMATCH` or `SIZE_MISMATCH` means re-read the file from SD and start that asset again from `init`.
4. `POST /api/device/captures/{captureId}/complete` — enqueues server-side processing.
5. Optional: poll `GET /api/device/captures/{captureId}/status` until `ready|partial|failed`.

## Idempotency

The identity of every unit of work is `captureUuid + role + frameIndex`. Retrying any step — capture create, asset init, part PUT, either complete — is safe and converges on the same server state. A reboot mid-upload must not create a second capture: re-read `captureUuid` from SD and repeat the procedure from step 1.

## Queue, retry, resume, offline

- SD originals are the source of truth. The upload queue persists capture UUIDs and per-asset progress on SD and survives reboot.
- The shutter must never wait on the queue, the network, or the Roll server. No Roll condition may block or fail a capture.
- On failure: exponential backoff (1 s doubling, 30 s cap), then resume from the first incomplete step. Five dispositions reach a job, not two — the reference implementation is `rq_classify_response()` in `firmware/p4/main/roll_queue.c`, which reads the error code out of the body because two 409s mean opposite things:
  - **Retry** the same bytes after backoff: no response at all (DNS, TLS, connect, timeout, link loss), 5xx, 429, and every 409 except `UPLOAD_NOT_OPEN`. Bounded at `RQ_MAX_ATTEMPTS` (12) consecutive failures, then the job parks.
  - **Re-init the asset immediately**: 409 `UPLOAD_NOT_OPEN`. The session the camera holds is gone, so repeating the step can only earn the same answer; the asset runs again from `init`, with no backoff, because nothing here is congestion. It shares `RQ_MAX_REREADS` (2) with the re-read disposition below — both mean "run this asset again from the beginning" — and does not touch the network attempt counter.
  - **Re-read from SD and upload again**: 422. The server judged the *stored bytes*, so sending the same buffer again cannot help and re-reading the card can. Bounded at `RQ_MAX_REREADS` (2), then the job parks. This does not touch the network attempt counter — a checksum mismatch is not a network failure and must not inherit its backoff.
  - **Park** the job, keep the queue running: 400, 404, 413, and any other 4xx that is not named above. The photograph stays on the card and stays visible as a failed job the operator can retry.
  - **Halt** the whole queue: 401, 403. These fail every job identically, so walking the queue into failure one job at a time destroys the information. Leave the jobs where they are and surface the fault on the display.
- Wi-Fi loss mid-part: re-init the asset; `alreadyComplete` and part re-PUTs make the resume cheap.
- Progressive delivery: upload thumbs for all queued captures before originals when the queue is deep, so guests see the newest shots first.

## Progressive capture states (server-side)

`created → preview-ready → originals-uploading → complete → processing → ready` (or `partial`/`failed`). The device only ever writes `created` and drives transitions by uploading; it never patches `status` directly.

## Error handling summary

Every row is verified against both sides: the status and code are as `apps/api/src/routes/device-captures.ts` emits them, and the action is what `rq_classify_status()` in `firmware/p4/main/roll_queue.c` does with them.

| Response | Where it comes from | Device action |
|---|---|---|
| 401 / 403 `DEVICE_NOT_IN_ROLL` | any device call | **Halt the queue** and surface it on the display. Credentials or association are wrong; retrying cannot help, and every other job would fail identically. Jobs keep the state they had. |
| 400 `INVALID_CAPTURE`, `INVALID_PART_NUMBER`, `EMPTY_PART`, `NO_PARTS` | capture create, part PUT, upload complete | **Park.** A malformed request produces the same answer every time. |
| 404 `CAPTURE_NOT_FOUND` / `UPLOAD_NOT_FOUND` | any call addressed by id | **Park.** The server-side object is gone. |
| 409 `UPLOAD_IN_PROGRESS` | asset init | **Retry** init after backoff. Another init for the same asset is in flight; the retry finds its session and resumes it. |
| 409 `UPLOAD_NOT_OPEN` | part PUT, upload complete | **Re-init the asset**, at once and without backoff. The session is `complete`, `aborted`, or its storage-side multipart was swept after 24 hours; repeating the step gets the same 409 forever, so the camera goes back to `init`. A session that was genuinely finished answers the re-init with `alreadyComplete` and the step succeeds immediately; a swept one is re-opened by the server against the same session row. Bounded by `RQ_MAX_REREADS` (2), then the job parks. Until firmware 0.4.51 this was classified as a plain retry, so the job burned all 12 attempts on a dead upload id before parking. Asset init never emits this code — the only 409 it can answer is `UPLOAD_IN_PROGRESS` (`apps/api/src/routes/device-captures.ts`), and the two need opposite cures. |
| 409 `ROLL_CLOSED` | capture create, asset init | **Retry** after backoff, then park after 12 attempts. This is honest but not efficient — a closed roll does not reopen on its own — and it stays a retry deliberately: the camera cannot tell a roll the host closed from one the host is about to reopen, and parking every queued job on the first 409 would need an operator to retry each of them by hand. The roll is no longer `live`. Uploads to it do not resume by themselves; the host has to reopen the roll. |
| 413 `PART_TOO_LARGE` | part PUT | **Park.** The part exceeded `partSize` (5 MiB). Fastify's `bodyLimit` rejects it before the handler in most cases; the handler's own check answers the same status and code if the two numbers ever drift. |
| 413 `UPLOAD_TOO_LARGE` | part PUT | **Park.** The parts so far exceed the `bytes` declared at init. The message carries both numbers, because a camera correcting its own bookkeeping needs to know which of the two was wrong. |
| 415 `EXPECTED_OCTET_STREAM` | part PUT | **Park.** The part body did not arrive as `application/octet-stream`, so the server never got a buffer. This is a firmware bug in the request, not a fault of the file, and it will not clear on a retry. |
| 422 `CHECKSUM_MISMATCH` | upload complete | **Re-read the file from SD and upload it again**, from `init`. The server re-hashed the *stored* object and it does not match what init declared; the bytes in RAM are not the thing in question. Bounded at 2 re-reads, then park. |
| 422 `SIZE_MISMATCH` | upload complete | Same as above: re-read from SD, re-init, re-upload, bounded at 2. The stored object's length is not the `bytes` declared at init — a truncated part, or a part that landed twice. |
| 429 | any device call | **Retry.** Honour the backoff. |
| 5xx, or no response at all | any device call | **Retry.** The bytes were never judged. |
| Any other 4xx | — | **Park.** A contract disagreement, not a transient fault. |

A parked job is not a lost photograph. The original is on the SD card, the job stays in the queue and stays visible, and `UPLOAD_QUEUE_RETRY` from Studio revives it. Parks caused by a run of *network* failures are revived automatically when the link or the server returns; parks the server refused with a 4xx wait for a deliberate retry.

## Acceptance for the firmware milestone

The physical firmware replaces the Twin bridge in `docs/roll/ROLL_GUEST_ACCEPTANCE_TESTS.md` without any Roll or API change, and passes the outage drill: two captures taken while the server is down appear exactly once each after it returns.
