# Physical device Roll flow

How a photograph gets from a KINO D4's SD card into a guest's phone, which
parts of that path exist, and which do not.

[`ROLL_DEVICE_CONTRACT.md`](ROLL_DEVICE_CONTRACT.md) is the normative wire
contract and this document does not restate it. This is the device-side
architecture: which module owns what, and where the path currently stops.

## The invariant

```
SHUTTER
  -> capture succeeds locally
  -> SD commit succeeds (META.JSON written last)
  -> only then may networking begin
```

Never the other way round. The shutter does not wait on the queue, the
network, or the Roll server, and no Roll condition may fail a capture. A dead
network costs uploads; it must never cost a photograph.

That is not a policy statement, it is where the code is: `upload_queue_enqueue()`
is called from `capture.c`'s done-listener *after* the commit, does one small
file write, and returns. If it fails, the photograph is still on the card and
reconciliation finds it at the next boot.

## Modules

| Module | Owns |
|---|---|
| `capture.c` | the capture, the UUID, the SD commit. Unchanged by any of this. |
| `roll_queue.c` | the decisions: next step, retry policy, response meaning, reconcile verdict. Pure, host-tested. |
| `upload_queue.c` | the state: `UPLOAD.JSON`, the boot scan, the worker task. |
| `roll_state.c` | Roll membership and the device credential, in NVS. |
| `net_link.c` | the C6's link and radio state. |
| `wifi_creds.c` | saved networks and their passphrases, in their own NVS namespace. |
| `kdp_net.c` | the `NETWORK_*` / `ROLL_*` / `UPLOAD_*` replies. |

The `roll_queue` / `upload_queue` split is the one worth knowing: decisions are
separated from I/O so the decisions can be tested without a card, a radio or a
server. That is currently the only test coverage any of this has.

## The path

```
capture committed to SD
        |
        v
UPLOAD.JSON written beside it        <- durable from here on
        |
        v
   net_link_can_upload()?
   +----------+-----------+
   | no                   | yes
   v                      v
 stay queued        register capture   POST /rolls/{id}/captures
 (offline is a          |
  normal state,         v
  not an error)     upload THUMB.JPG   -> tile appears on the guest's phone
                        |
                        v
                    upload C1..CN      -> originals arrive progressively
                        |
                        v
                    complete capture   -> server queues processing
                        |
                        v
                     COMPLETE
```

Thumbnail first is not an optimisation. It is what puts a tile on a phone
before four full JPEGs travel.

## Durability

Job state lives in `UPLOAD.JSON` inside the capture's own directory, written
to a temp name and renamed — the same metadata-last discipline that makes
META.JSON the commit marker. One file per capture, not one queue file:

- a corrupt record costs one capture, not the queue;
- the job cannot outlive or precede the capture it describes;
- reconciliation is a directory scan, not a cross-check between two files that
  can disagree.

A job holds no image bytes. It names a UUID and every step re-reads the card,
so there is nothing a reboot can lose — and re-reading is also exactly what a
422 `CHECKSUM_MISMATCH` asks for.

Progress is a set of completion flags, never a byte offset. An offset would be
a second source of truth about the server's state, and it would be wrong
exactly when it mattered.

## Reconciliation at boot

For every directory under `/sdcard/KINO/CAPTURES`:

| Card state | Verdict |
|---|---|
| no META.JSON | **ignore** — an interrupted commit; `storage.c`'s sweep owns it |
| META.JSON, no UPLOAD.JSON | **enqueue** — the ordinary offline case |
| UPLOAD.JSON, COMPLETE | **ignore** — this is what prevents a re-upload |
| UPLOAD.JSON, work left | **resume** from the first unconfirmed step |
| UPLOAD.JSON unreadable or from a newer format | **repair** — rebuild the record |

Repair rather than ignore is deliberate. The photograph is still on the card
and the server is idempotent on its UUID, so rebuilding costs one redundant
registration and cannot produce a second capture. Ignoring it would strand a
photograph silently, which is the failure this whole design exists to prevent.

## Idempotency

`captureUuid + role + frameIndex` is the identity of every unit of work, and
`captures_roll_uuid (roll_id, capture_uuid)` is a UNIQUE index in the
database — so duplicate prevention is enforced by Postgres, not by the
camera's good behaviour. Retrying any step converges. Twenty retries of one
capture produce one row.

The host tests assert the property directly: 50 captures queued offline,
carried across a simulated reboot, then drained — each registers exactly once.

## Retry, and the 422 that needed reconciling

Backoff is 1 s doubling to a 30 s cap, bounded, then the job parks. Responses
classify **five** ways — `rq_classify_response()` in
`firmware/p4/main/roll_queue.c` is the reference, and it reads the error `code`
out of the body because two 409s mean opposite things:

| Response | Action | Bound |
|---|---|---|
| no response at all (DNS, TLS, connect, timeout, link loss), 5xx, 429, and every 409 **except** `UPLOAD_NOT_OPEN` | retry the same bytes after backoff | `RQ_MAX_ATTEMPTS` (12) consecutive failures, then park |
| 409 `UPLOAD_NOT_OPEN` | **re-init the asset at once, with no backoff** | `RQ_MAX_REREADS` (2), then park |
| any 422 — `CHECKSUM_MISMATCH` and `SIZE_MISMATCH` | re-read the file from the card and run the asset again from `init` | `RQ_MAX_REREADS` (2), then park |
| 400, 404, 413, 415, any other 4xx | park this job; the queue continues | — |
| 401, 403 | **halt the queue** and surface it | — |

401/403 halt rather than park because they fail every job identically —
parking them one at a time walks the whole queue into FAILED for a fault the
user can fix. A halted job keeps its progress and resumes untouched.

`UPLOAD_NOT_OPEN` is not a retry and must not inherit backoff. The session the
camera holds is `complete`, `aborted`, or its storage-side multipart was swept
after 24 hours, so repeating the step earns the same 409 forever. Nothing here
is congestion. It shares `RQ_MAX_REREADS` with the re-read row — both mean "run
this asset again from the beginning" — and does not touch the network attempt
counter. Until firmware 0.4.51 it was a plain retry, and a job burned all 12
attempts on a dead upload id before parking.

The re-read row is likewise not a network failure and does not touch
`RQ_MAX_ATTEMPTS`. The contract states 422 twice and the two statements
reconcile: its queue section groups 422 with the drop statuses ("do not retry
the same bytes"), and its error table says "re-read the file from SD and
re-upload". Both hold — the prohibition is on the *same bytes*, and a re-read is
a fresh read, which is the one thing that can fix a mismatch the server measured
against the **stored** object.

## Photography wins

The upload worker runs at priority **2** — below the UI (4) and the capture
workers (5) — and holds off entirely while a capture is in flight.

That is not only about CPU. The FAT volume is mounted with `max_files = 4`, and
a capture already holds a frame handle plus a read-back handle for its CRC
check; an upload reader competing for a handle would fail, and one reading the
card during a four-camera transfer competes for the SDMMC bus the capture's
timing budget depends on. Yielding costs an upload a few seconds. Not yielding
costs frames.

Gate F is the measurement that confirms this, and it has been run on the one
camera attached: 0.4.6, capture timing and CRC unchanged within noise with the
radio idle, uploading, draining a backlog and recovering, and every accepted
photograph byte-identical on the card, in the object store and in the database —
**GATE F GO for the connected single-camera path**
(`firmware/HARDWARE_VALIDATION.md`). The four-camera case, the radio-off baseline
and current draw are still unmeasured.

## What exists

| Piece | State |
|---|---|
| Roll API, database, storage, worker, SSE, guest PWA | **shipped** — issues #7, #8, #9, #10, #20, #21, #114 |
| Twin bridge implementing this contract in the browser | **shipped** — `apps/twin/src/roll/bridge.ts` |
| Studio Network / Roll / upload-queue panels | **shipped**. The Roll and Network pages are still gated on `network`, `roll` and `rollUpload`, which the firmware reports **false on purpose** — see below |
| `roll_queue` decisions | **shipped**, host-tested and run on hardware |
| `upload_queue` durability and reconciliation | **shipped** — two defects that parked good photographs were found on the bench and fixed |
| `roll_state` membership persistence | **shipped** — survives reboot |
| Wi-Fi credential store | **shipped** |
| `NETWORK_*` / `ROLL_*` / `UPLOAD_*` KDP surface | **shipped** — all handlers dispatch |
| C6 slave image | **flashed and run.** Pinned ESP-Hosted 3.0.6 on `KD4-D121BC`, 2026-08-29; `C6_SLAVE_VERSION` VALIDATED. See [`../../firmware/c6/README.md`](../../firmware/c6/README.md) |
| **P4 to C6 transport** | **works.** SDIO slot 1, host version gate passes. It recovers from a C6 reset without a P4 reboot as of 0.4.6 — five times in a row, and under a pending upload |
| **HTTP/TLS client** | **works.** `C6_TLS` earned, and the queue drains over it |
| **Any upload from real hardware** | **has happened.** 0.4.4 is the first firmware whose photographs reached a Roll: capture, thumbnail-first upload, byte-identical original, worker jobs settled, one row per photograph. 0.4.6 closed the local Roll gate — **LOCAL ROLL E2E GO** — and measured **GATE F GO for the connected single-camera path** |

Everything above is recorded in
[`../../firmware/HARDWARE_VALIDATION.md`](../../firmware/HARDWARE_VALIDATION.md)
against an observed event on a named unit, not inferred from code. What is
**still unmeasured**: the four-camera Gate F case, the radio-off baseline, and
current draw.

The one thing in this table that still reads like a gap is the capability flags,
and it is deliberate rather than stale. The body now reports true for every flag
whose handler answers for real — `wiggle`, `quad`, `gallery`, `mediaIndex`,
`flashControl`, `benchDiagnostics`, `configStore`, `powerManagement`,
`radioFitted`, plus `recipes` and `customSounds` off their own module predicates
(`handle_capabilities` in `firmware/p4/main/kdp_server.c`) — and holds `network`,
`roll` and `rollUpload` at **false** — Studio's `supports()` is fail-closed, so
setting them true renders the Roll and Network pages and issues commands that
must then refuse, which is a broken panel instead of an absent one (#133). What
the handlers being present buys meanwhile is a specific `NETWORK_UNAVAILABLE`
naming the radio state instead of an `UNSUPPORTED_COMMAND` that cannot tell an
unimplemented command from an unrouted chip. `rollUpload` goes true when a
capture reaches a Roll from a body with these flags read as permission, not
before.

Nothing on the server side needed changing. The device contract was written
against a working implementation — the Twin bridge and
`infra/scripts/test-uploader.ts` — so the firmware inherits a proven wire
contract rather than a design document, which is what
`ROLL_DEVICE_CONTRACT.md` says those two exist for.

## What works over USB today, with no radio

Worth stating separately, because it is more than it sounds.

Studio has an internet connection. `PublishedRollJoinRequest` — documented in
`apps/studio/src/roll/rollTypes.ts` as a "Server-published Roll assignment
written to the camera over ROLL_JOIN" — carries an already-resolved
`rollId`, `slug`, `guestUrl`, `name` and `role`. So Studio can create or look
up a Roll against the real API and write the answer to the camera over USB-C.

The camera then:

- persists the membership across reboot,
- shows the join QR from `guestUrl` on its ROLL screen,
- queues every capture durably against that Roll,
- reports the backlog in `UPLOAD_QUEUE_STATUS` and on the display.

A guest can scan the camera's screen and open the Roll. This path is worth
keeping now that the radio works: the default P4 build links no radio, so on a
body without the radio route this is the whole provisioning story, and the
backlog it accumulates drains into a Roll that already exists and already has
guests on it the moment a radio build is flashed.

## The acceptance test this is aimed at

From `ROLL_DEVICE_CONTRACT.md`: the physical firmware replaces the Twin bridge
in [`ROLL_GUEST_ACCEPTANCE_TESTS.md`](ROLL_GUEST_ACCEPTANCE_TESTS.md) with no
Roll or API change, and passes the outage drill — two captures taken while the
server is down appear exactly once each after it returns.

That test has run on hardware: 42 captures taken with the API down uploaded by
themselves when it returned (0.4.36, `firmware/HARDWARE_VALIDATION.md`), and
0.4.43 revives jobs the outage parked without a button press. The host half is
`make -C firmware/p4/host_tests test-queue`.
