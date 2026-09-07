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
  /** The API's `code` from the error body, empty when there was none to read.
   * Read on the failure path only, and read at all because 409
   * UPLOAD_IN_PROGRESS and 409 UPLOAD_NOT_OPEN need opposite cures — see
   * rq_classify_response(). Never persisted. */
  char code[RQ_ERROR_CODE_LEN];
  /** The step did not run because a capture held the card. Costs no attempt;
   * see RQ_DISP_YIELD. */
  bool card_yielded;
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

/* ------------------------------------------------------------------ */
/* Heartbeat                                                          */
/* ------------------------------------------------------------------ */

/**
 * What one `POST /api/device/rolls/{rollId}/heartbeat` says.
 *
 * Every field on the wire is optional and the body may be `{}` — the arrival
 * is most of the message, and a dashboard that only learns "this camera was
 * alive 20 seconds ago" already knows more than it did. These are the fields
 * this camera has an honest answer for. The body is `.strict()` server-side,
 * so an extra key is a 400: add one here only with the API.
 *
 * `pending` is what the ROLL screen calls waiting — the RAM window plus the
 * durable remainder on the card — so the display and the dashboard cannot
 * disagree about how much is owed. `failed` is parked, not retrying: a job
 * still backing off is work in progress, not a job that needs a person.
 */
typedef struct {
  int pending;
  int uploading;
  int failed;
  /** "unknown" | "reachable" | "unreachable". Anything else is refused by the
   * API's enum, so upload_queue.c maps its own state and never passes text
   * through from elsewhere. */
  const char *server_state;
  /**
   * The upload queue is halted on a credential this server refused - the ROLL
   * screen's UPLOAD PAUSED, sent as `uploadPaused`.
   *
   * The one camera state that does not clear itself: an uplink comes back on
   * its own, a rejected token does not, and nothing uploads until somebody
   * re-provisions the device. The dashboard had the words already and nothing
   * feeding them.
   *
   * Read straight off upload_queue_report_t.halted at the call site. This
   * struct holds no opinion of its own about whether the queue is stopped.
   */
  bool upload_paused;
} roll_heartbeat_t;

/**
 * Tell the host this camera is alive. Blocks the calling task for one request.
 *
 * The least important thing this firmware does, and it is written to behave
 * that way: it takes no card lock, changes no job, and a failure is silent —
 * the caller drops it. A 401 or 403 here must never halt the upload queue; the
 * queue's own steps are what decide that.
 *
 * Returns true only on a 200. `out_status` may be NULL; when given it carries
 * the HTTP status (0 for no response) so the caller can rate-limit its log.
 */
bool roll_api_heartbeat(const char *roll_id, const roll_heartbeat_t *hb, int *out_status);

/**
 * True when a call could be attempted, with `why` filled in when not.
 *
 * `kdp_net.c` asks this before refusing `ROLL_CREATE`, so the refusal names
 * the actual obstacle — no radio in this build, no address, no trustworthy
 * clock, no API base URL — rather than a generic "needs the network".
 */
bool roll_api_ready(char *why, size_t cap);

#endif /* P4_ROLL_API_H */
