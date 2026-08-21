# Roll integration — device ↔ Studio ↔ kino.acronym.sk

How captures reach the party gallery, and the audited state of every link in that chain. Normative: `firmware-contract/commands.md` (0xa0–0xaa), `apps/api/src`, `apps/studio/src/pages/Roll`, `apps/roll-web/src`.

## Party workflow

host creates event → KINO joins Wi-Fi (`NETWORK_*`) → associates with the Roll (`ROLL_JOIN`/`ROLL_CREATE`) → people shoot → frames save to SD immediately → background queue uploads → guests watch photos appear at the event page. **No capture ever fails because Wi-Fi or the server is down** — upload is asynchronous, SD is the source of truth.

## Verified properties

- **Device contract**: network and roll command groups, `QueueReport {pending, uploading, failed, uploaded, draining}`, `UPLOAD_QUEUE_RETRY` (failed → pending), roll-less state spelled out. Capability-gated (`rollUpload`) so non-Roll firmware simply lacks the surface.
- **Resume**: every upload is S3 multipart with per-part records; interruption resumes; completion re-reads and verifies.
- **Duplicate detection**: `(rollId, captureUuid)` unique index decides races; replayed capture POSTs return the same id, byte-identical retries are safe end to end (proven by the camera-simulating uploader under drop/dup/reboot).
- **States**: full capture ladder with `partial`/`failed`; guests only ever see `ready` assets.
- **Security**: device tokens are 256-bit, hash-only at rest, write-only scope; Wi-Fi passphrases go to `NETWORK_SET` and provably never reach the backend or Studio persistence; PIN cookies are signed/httpOnly and rotate with the PIN; log redaction is tested. As of this audit, Studio backups also strip the camera's Roll identity block.
- **Server availability**: `rollServerUnreachable` / `rollTokenExpired` faults exist; Studio's unconfigured server client fails loudly instead of pretending.

## Audited gaps

1. "Queue persists across camera reboot" is contract prose without a reference implementation or test — the mock queue is in-memory. Firmware must persist it on SD; the mock should model that.
2. No test pins the capture-never-blocked invariant (capture to SD succeeding *while* `rollServerUnreachable` is active); the scenarios are exercised for UI state only.
3. Device-side retry is a fixed drain tick, not a backoff policy.
4. Production `PUBLIC_BASE_URL` is kino.acronym.sk; hardening for internet exposure (rate budgets, first-write-wins registration, timeouts) is merged — see the Roll issues (#20/#21, both closed) for the record.
