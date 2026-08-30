/**
 * The durable Roll upload queue: the jobs, where they live on the card, and
 * the worker that drains them.
 *
 * roll_queue.h holds the decisions (what to do next, when to retry, what a
 * response means). upload_store.h holds `UPLOAD.JSON` — the bytes on the card
 * and whether they can be trusted. This module holds the rest: reconciling
 * against the card at boot, and running the worker. Both splits exist so the
 * parts that can be wrong are host-testable without an SD card.
 *
 * ## The card is the truth
 *
 * A job carries no image bytes. It names a capture UUID; every step re-reads
 * from `/sdcard/KINO/CAPTURES/<uuid>/`. So there is nothing a reboot can lose,
 * and re-reading is also exactly what a 422 CHECKSUM_MISMATCH asks for.
 *
 * Job state lives in `UPLOAD.JSON` inside the capture's own directory,
 * written the way `capture.c` writes META.JSON: to a temp name, then renamed,
 * so a power cut leaves either the old record or the new one and never half
 * of either. One file per capture rather than one queue file, so a corrupt
 * record costs one capture instead of the queue, and so reconciliation is a
 * directory scan rather than a cross-check between two files that can
 * disagree.
 *
 * ## The shutter never waits for any of this
 *
 * `ROLL_DEVICE_CONTRACT.md`: "The shutter must never wait on the queue, the
 * network, or the Roll server." Enqueue is called from `capture.c`'s
 * done-listener, which runs on the capture task — so it does the minimum
 * (one small file write) and never blocks on the network. The worker is a
 * separate task at a priority BELOW the UI and the capture workers.
 *
 * ## Reading the card while a capture writes it
 *
 * This is a real hazard and it is worth naming. One card, one SDMMC
 * controller, one descriptor budget (`STORAGE_MAX_OPEN_FILES`). A worker
 * reading the card during a four-camera transfer competes for the bus the
 * capture's timing budget depends on, and for the handles the capture needs.
 *
 * The exclusion is storage.h's priority lock, not a flag in this module. The
 * worker takes `STORAGE_USER_UPLOAD` with a short timeout for every card
 * access and does nothing at all when refused; inside any loop that touches
 * the card more than once it polls `storage_yield_requested()` and lets go
 * early. An abandoned read costs nothing, because every step re-reads from the
 * card anyway. When the C6 transport lands, the asset read loop has the same
 * obligation.
 *
 * There is deliberately no pause boolean any more. A boolean the worker polled
 * was a hint, not exclusion: a reader that opened a handle between the check
 * and the capture still took a descriptor. `storage_capture_active()` answers
 * the same question from the lock's own state, so the two cannot disagree.
 */
#ifndef P4_UPLOAD_QUEUE_H
#define P4_UPLOAD_QUEUE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "roll_queue.h"

/** Jobs held in RAM at once. The card may hold more; the worker refills from
 * it. Bounded so a 500-capture backlog cannot exhaust the heap — which is the
 * failure that would take the camera down with it. */
#define UPLOAD_QUEUE_MAX 32

/** What `UPLOAD_QUEUE_STATUS` reports. Mirrors `UploadQueueReport` in
 * apps/studio/src/roll/rollTypes.ts. */
typedef struct {
  int pending;   /* queued, not yet settled, not currently in flight */
  int uploading; /* the job the worker is on: 0 or 1 */
  int failed;    /* parked — repeating cannot help until something changes */
  int uploaded;  /* completed since boot */
  bool draining; /* the worker is actively working the queue */
  /** True when the queue is stopped on a credential or association fault.
   * Distinct from `failed`: the jobs are fine, the device is not. */
  bool halted;
  /** Redacted, and safe to show on the display or send over KDP. */
  char last_error[RQ_ERROR_LEN];
} upload_queue_report_t;

/**
 * Start the queue: reconcile against the card, then run the worker.
 *
 * Must be called after the card is mounted and after `net_link_init()`.
 * Returns ESP_OK even when the card is absent — a camera with no card has an
 * empty queue, which is not a failure.
 *
 * Reconciliation is the startup half of the durability guarantee. It walks
 * `/sdcard/KINO/CAPTURES`, and for each directory asks
 * `rq_reconcile_action()`:
 *
 *   IGNORE   — no META.JSON (an interrupted commit; storage.c's sweep owns
 *              it) or the job is already COMPLETE.
 *   ENQUEUE  — committed but never queued. The ordinary offline case.
 *   RESUME   — a job with work left. Picks up where it stopped.
 *   REPAIR   — the record is unreadable or from a newer format. Rebuilt
 *              rather than ignored: the photograph is still on the card and
 *              the server is idempotent on its UUID, so a rebuild costs one
 *              redundant registration and cannot duplicate a capture.
 *              Ignoring it would strand the photograph silently.
 */
esp_err_t upload_queue_start(void);

/**
 * Queue a capture that has just been committed.
 *
 * Called from `capture.c`'s done-listener, on the capture task. Writes one
 * small file and returns; it must not block and must not fail the capture.
 * A capture that cannot be queued is still a photograph on the card, and
 * reconciliation will find it at the next boot — which is why this returning
 * an error is not an emergency.
 *
 * No-op when the device is not on a Roll: there is nowhere for the bytes to
 * go, and a job with no destination would park immediately and read as a
 * failure the user cannot act on.
 */
/*
 * Queue a committed capture for the Roll its META.JSON names. Returns
 * ESP_ERR_INVALID_STATE when META names no Roll - a photograph taken off a
 * Roll is a local photograph, and the queue does not adopt it into whichever
 * Roll is active now.
 */
esp_err_t upload_queue_enqueue(const char *capture_uuid, int frame_count, bool thumb_present);

/* Same, with the Roll given explicitly - the shutter's snapshot, from the
 * capture-done listener. `roll_id` empty means no job, ESP_OK. */
esp_err_t upload_queue_enqueue_for(const char *capture_uuid, const char *roll_id, int frame_count,
                                   bool thumb_present);

/** Current counts. Never blocks on the worker. */
void upload_queue_status(upload_queue_report_t *out);

/**
 * Clear the backoff on every waiting job and wake the worker. Returns how
 * many jobs were revived, which is what `UPLOAD_QUEUE_RETRY` reports.
 *
 * Also lifts a halt: the user pressing retry is the signal that they have
 * fixed the credential or the association.
 */
int upload_queue_retry_all(void);

/*
 * The network is usable again after having been down - the radio recovered
 * from a C6 reset without a P4 reboot. Every RETRY_WAIT job becomes due now
 * (rq_job_network_restored: attempts kept, nothing revived that was parked)
 * and the worker is woken, so the first retry does not wait out a backoff
 * that was measuring a dead link. The durable record is what resumes; no
 * job is created and none is re-enqueued.
 */
void upload_queue_network_restored(void);


#endif /* P4_UPLOAD_QUEUE_H */
