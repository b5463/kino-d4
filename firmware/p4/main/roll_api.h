/**
 * The KINO Roll device API, step for step as
 * `docs/roll/ROLL_DEVICE_CONTRACT.md` writes it.
 *
 * `apps/twin/src/roll/bridge.ts` is a working implementation of the same
 * contract against the same server, and it is the thing to read against when
 * this changes.
 *
 * ## What this module does not decide
 *
 * Not the step order — `rq_next_step()` owns that. Not what a status code
 * means — `rq_classify_status()` owns that, is host-tested against the
 * contract's own table, and includes the 422 case where the contract's two
 * sections have to be reconciled. Not when to retry — `rq_backoff_ms()`. This
 * module performs the step it is handed and reports the status verbatim.
 *
 * Re-classifying locally is the specific mistake to avoid. A 422 treated as a
 * park here would strand a photograph that a re-read would have fixed, and
 * the host tests could not see it.
 *
 * ## Both builds
 *
 * The default build compiles the "no transport" answer below and links no
 * HTTP client. `upload_queue.c` calls the same function either way, so the
 * queue, its persistence and its retry policy are exercised identically in a
 * build with no radio.
 */
#ifndef P4_ROLL_API_H
#define P4_ROLL_API_H

#include <stdbool.h>
#include <stddef.h>

#include "roll_queue.h"
#include "roll_state.h"

/** One network step's outcome, in the vocabulary `rq_classify_status()`
 * reads. `status` 0 means the request never got a response at all. */
typedef struct {
  int status;
  char capture_id[RQ_CAPTURE_ID_LEN]; /* RQ_STEP_REGISTER only */
  char detail[RQ_ERROR_LEN];          /* already redacted */
} roll_step_result_t;

/**
 * Perform one step of the upload procedure for one job.
 *
 * Blocks the calling task — the upload worker, which runs below the UI and
 * the capture workers for exactly this reason. Every card read inside takes
 * `STORAGE_USER_UPLOAD` and yields to a capture that wants the card.
 */
void roll_api_step(const rq_job_t *job, rq_step_t step, roll_step_result_t *out);

/** What `ROLL_CREATE` and a slug-only `ROLL_JOIN` need back from the server. */
typedef struct {
  char roll_id[ROLL_ID_LEN];
  char slug[ROLL_SLUG_LEN];
  char guest_url[ROLL_GUEST_URL_LEN];
  char name[ROLL_NAME_LEN];
  int status; /* the HTTP status, or 0 for no response */
  char detail[RQ_ERROR_LEN];
} roll_api_assoc_t;

/** `POST /api/device/rolls`. Registers the device first if it has no
 * credential. False with `out->detail` filled on any failure. */
bool roll_api_create(const char *title, roll_api_assoc_t *out);

/** `POST /api/device/rolls/join`, the path that turns a bare slug into a
 * rollId and a guestUrl. This is what a camera cannot do without a radio. */
bool roll_api_join(const char *slug, roll_api_assoc_t *out);

/**
 * True when a call could be attempted, with `why` filled in when not.
 *
 * `kdp_net.c` asks this before refusing `ROLL_CREATE`, so the refusal names
 * the actual obstacle — no radio in this build, no address, no trustworthy
 * clock, no API base URL — rather than a generic "needs the network".
 */
bool roll_api_ready(char *why, size_t cap);

#endif /* P4_ROLL_API_H */
