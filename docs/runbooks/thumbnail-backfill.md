# Per-camera thumbnail backfill

## What this fixes

`generate-thumbnail` writes one thumbnail per camera alongside the capture-level tile. A capture page then draws its strip and its 2×2 overview from 720 px WebP rows instead of the stored `original-frame` JPEGs: 293 kB instead of 754 kB, measured on the bench roll.

Only captures processed after that change have those rows. An older capture has the capture-level thumb and nothing per camera, so its page still fetches four full originals to fill eight boxes, none of which is wider than 195 CSS px.

There is nothing to migrate. The fix is to run the same job again on the old captures. Its only inputs are the stored frames, and it upserts on `(captureId, role, frameIndex)`, so re-running it produces the same bytes under the same keys.

## The tool

```sh
npx tsx infra/scripts/backfill-thumbnails.ts --roll <slug|id> [--apply] [--batch N] [--pause MS] [--limit N] [--state FILE]
```

`--all-rolls` replaces `--roll` for every roll in the database. Naming neither is an error: "all rolls on production" is a decision, not a default.

Connection settings come from `DATABASE_URL`, `REDIS_URL` and `JOB_QUEUE_PREFIX`, with `--database-url`, `--redis-url` and `--queue-prefix` as overrides. `JOB_QUEUE_PREFIX` must be the value the worker uses, or the jobs land in a queue nobody consumes.

`npx tsx infra/scripts/backfill-thumbnails.ts --help` prints the full option list.

## Procedure

1. **Dry run first.** Without `--apply` nothing is written and no Redis connection is opened. The report says how many captures are missing per-camera thumbs, how many objects would be written, how many bytes they would add, and how much worker time that is.

   ```sh
   npx tsx infra/scripts/backfill-thumbnails.ts --roll RRG8AZ
   ```

   `bytesBasis: measured` means the per-object size is the mean of the per-camera thumbs this deployment has already written, and `bytesSamples` is how many. `bench-constant` means there are none yet and the estimate is using 27.5 kB per frame thumb from the bench measurement — treat that as an order of magnitude, not a figure.

2. **Check the queue is idle.** Do not start a large backfill during a live party. Queueing a job moves a settled capture back to `processing` until the worker writes `done`, so the host dashboard's Pending count rises for the length of the run. That is honest — the platform does owe those captures a derivative — but it is indistinguishable from a stalled party at a glance.

3. **Run it.**

   ```sh
   npx tsx infra/scripts/backfill-thumbnails.ts --roll RRG8AZ --apply --state ./thumb-backfill.state.json
   ```

   Batches of 100 captures with a second between them, so the live queue stays short. `--batch` and `--pause` change that; a busy deployment wants a smaller batch and a longer pause, not the reverse.

4. **Watch the worker.** `kino_queue_jobs{state="waiting"}` climbs by roughly the batch size and drains between batches. Worker failures should stay flat; a failing `generate-thumbnail` means a missing or unreadable original, not a problem with the backfill.

5. **Confirm.** Run the dry run again. `capturesMissingFrameThumbs` falls to 0 once the worker has finished the queue. Then open a capture page from the oldest part of the roll and check the transfer size.

## Interruption and re-runs

The script is safe to run twice, and re-running it *is* the resume:

- a capture that already has a `thumb` row with a frame index drops out of the selection;
- a capture whose `generate-thumbnail` is still queued is skipped by the `processing_events` partial unique index over `status = 'queued'`, which is the same index that stops two capture-completes doubling the work;
- BullMQ keeps one job per `jobId`, and the id is `<captureId>~generate-thumbnail`.

Ctrl-C finishes the batch in hand and then prints the summary with a resume cursor. `--state FILE` records that cursor between batches so a later run continues where the last one stopped instead of re-scanning the roll from the start; the state file only saves the scan, it is not what makes the run safe. Delete it to start the scan over.

## Cost, measured

Bench roll, four cameras per capture, 2026-09-06:

| Quantity | Value |
|---|---|
| Worker time per capture | ~550 ms |
| New objects per capture | 4 (one per camera) |
| New bytes per capture | ~110 kB on the bench; 13.4 kB per object measured on the dev database |
| A 1,900-capture roll | ~17 minutes, ~210 MB |
| Capture page before / after | 754 kB / 293 kB |

The per-object figure is what varies: it is a 720 px WebP of a photograph. Trust the dry run's `measured` number over the table.

## What it does not do

- It does not delete anything. The `original-frame` objects stay; they are the originals, and a capture page simply stops fetching them to draw thumbnails.
- It does not touch the capture-level `thumb` row, which the feed tile picks and which a client built before the change still looks for.
- It does not repair a capture with fewer than two stored frames. One stored frame *is* the capture-level thumb, so a per-camera copy would be the same bytes under a second name, and the worker skips it for that reason.
