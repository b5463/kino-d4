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
classify four ways:

| Response | Action |
|---|---|
| network error, timeout, 5xx, 429, 409 | retry with backoff |
| 422 `CHECKSUM_MISMATCH` | re-read the file from the card, bounded, then park |
| 400, 404, 413 | park this job; the queue continues |
| 401, 403 | **halt the queue** and surface it |

401/403 halt rather than park because they fail every job identically —
parking them one at a time walks the whole queue into FAILED for a fault the
user can fix. A halted job keeps its progress and resumes untouched.

The contract states 422 twice and the two statements have to be reconciled:
its queue section groups 422 with the drop statuses ("do not retry the same
bytes"), and its error table says "re-read the file from SD and re-upload".
Both hold — the prohibition is on the *same bytes*, and a re-read is a fresh
read, which is the one thing that can fix a checksum mismatch. So 422 is a
bounded re-read that parks rather than loops.

## Photography wins

The upload worker runs at priority **2** — below the UI (4) and the capture
workers (5) — and holds off entirely while a capture is in flight.

That is not only about CPU. The FAT volume is mounted with `max_files = 4`, and
a capture already holds a frame handle plus a read-back handle for its CRC
check; an upload reader competing for a handle would fail, and one reading the
card during a four-camera transfer competes for the SDMMC bus the capture's
timing budget depends on. Yielding costs an upload a few seconds. Not yielding
costs frames.

Gate F is the measurement that has to confirm this, and it has not been run.

## What exists

| Piece | State |
|---|---|
| Roll API, database, storage, worker, SSE, guest PWA | **shipped** — issues #7, #8, #9, #10, #20, #21, #114 |
| Twin bridge implementing this contract in the browser | **shipped** — `apps/twin/src/roll/bridge.ts` |
| Studio Network / Roll / upload-queue panels | **shipped** — gated on capability flags the firmware does not yet set |
| `roll_queue` decisions | **CODE DONE**, host-tested |
| `upload_queue` durability and reconciliation | **CODE DONE** |
| `roll_state` membership persistence | **CODE DONE** |
| Wi-Fi credential store | **CODE DONE** |
| `NETWORK_*` / `ROLL_*` / `UPLOAD_*` KDP surface | **CODE DONE** |
| D4 radio and Roll screens | **CODE DONE** |
| C6 slave image | see [`../../firmware/c6/README.md`](../../firmware/c6/README.md) |
| **P4 to C6 transport** | **BLOCKED** — routing unknown, see [`../../firmware/C6_HARDWARE_MAP.md`](../../firmware/C6_HARDWARE_MAP.md) |
| **HTTP/TLS client** | **seam only** — blocked on the transport |
| **Any upload from real hardware** | **has never happened** |

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

A guest can scan the camera's screen and open the Roll. What waits for the
transport is only the upload itself — so when the radio does come up, the
backlog drains into a Roll that already exists and already has guests on it.

## The acceptance test this is aimed at

From `ROLL_DEVICE_CONTRACT.md`: the physical firmware replaces the Twin bridge
in [`ROLL_GUEST_ACCEPTANCE_TESTS.md`](ROLL_GUEST_ACCEPTANCE_TESTS.md) with no
Roll or API change, and passes the outage drill — two captures taken while the
server is down appear exactly once each after it returns.

That test cannot run until the transport exists. The part of it that can be
checked without hardware is checked: `make -C firmware/p4/host_tests test-queue`.
