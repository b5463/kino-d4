/**
 * The KINO Roll upload queue: state machine, resume decisions, retry policy
 * and response classification.
 *
 * Pure logic, in the sense pure.h means it: C99, no ESP-IDF headers, no
 * allocation, no I/O, no globals. The upload task in roll_upload.c does the
 * HTTP and the SD writes and asks this module what to do next; the host tests
 * in firmware/p4/host_tests exercise it directly.
 *
 * That split is deliberate. `docs/roll/ROLL_DEVICE_CONTRACT.md` puts it
 * plainly: "the queue is the hard part, not the HTTP". The hard part is the
 * part that has to be right after a power cut in the middle of frame three,
 * and it is the only part that can be tested without a radio, a card or a
 * server.
 *
 * ## The durability model
 *
 * The SD capture is the truth. A job carries no bytes: it names a capture
 * UUID, and every step re-reads from `/sdcard/KINO/CAPTURES/<uuid>/`. So the
 * queue never holds anything a reboot could lose, and re-reading is also
 * exactly what a 422 CHECKSUM_MISMATCH asks for.
 *
 * Job state lives in `UPLOAD.JSON` inside the capture's own directory,
 * written the same way META.JSON is: to a temp name, then renamed. One file
 * per capture rather than one queue file, for three reasons:
 *
 *   - a corrupt record costs one capture, not the queue;
 *   - the job cannot outlive or precede the capture it describes;
 *   - reconciliation is a directory scan, not a cross-check between two
 *     files that can disagree.
 *
 * A committed capture (it has META.JSON) with no UPLOAD.JSON has never been
 * queued. A capture with an UPLOAD.JSON that is not COMPLETE has work left.
 * There is no third state, which is what makes rq_reconcile_action() total.
 *
 * ## Idempotency
 *
 * Per the contract, the identity of a unit of work is
 * `captureUuid + role + frameIndex`. Every step is safe to repeat, so resume
 * never needs to know how far a step got — only which steps have been
 * confirmed done. That is why progress is a set of completion flags and not a
 * byte offset: a byte offset would be a second source of truth about the
 * server's state, and it would be wrong exactly when it mattered.
 */
#ifndef P4_ROLL_QUEUE_H
#define P4_ROLL_QUEUE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Frames one capture can hold. Four cameras; the extra headroom keeps a
 * future six-lens body from needing a queue-format version. */
#define RQ_MAX_FRAMES 8

/** Longest capture UUID text plus terminator (36 + 1, rounded). */
#define RQ_UUID_LEN 40
/** Server-assigned capture id. Generous: the server's format is its own. */
#define RQ_CAPTURE_ID_LEN 64
/** Longest error detail retained for the display and UPLOAD_QUEUE_STATUS. */
#define RQ_ERROR_LEN 96

/** On-card format version for UPLOAD.JSON. Bump only on a breaking change;
 * rq_job_load() must keep reading every version it has ever written. */
#define RQ_FORMAT_VERSION 1

/**
 * Where a job is. Not a set of booleans: "uploaded: true" cannot distinguish
 * a capture whose thumb landed from one whose originals did, and the
 * difference is what the guest sees on the phone.
 *
 * The order matters — rq_next_step() relies on it being monotonic, so a job
 * can only ever move forward or to RETRY_WAIT/FAILED.
 */
typedef enum {
  RQ_QUEUED = 0,            /* on the card, nothing sent */
  RQ_REGISTERING,           /* POST .../captures — creates or replays */
  RQ_THUMB_UPLOADING,       /* thumb asset in flight */
  RQ_THUMB_READY,           /* thumb confirmed; guest tile is live */
  RQ_ORIGINALS_UPLOADING,   /* C1..CN in flight */
  RQ_VERIFYING,             /* POST .../complete */
  RQ_COMPLETE,              /* server holds every frame we hold */
  RQ_RETRY_WAIT,            /* transient failure, backoff running */
  RQ_FAILED,                /* parked: repeating this cannot help */
} rq_state_t;

/** What the upload task should do next. Returned by rq_next_step(). */
typedef enum {
  RQ_STEP_NOTHING = 0,      /* COMPLETE or FAILED — job is done with */
  RQ_STEP_REGISTER,         /* POST /api/device/rolls/{rollId}/captures */
  RQ_STEP_UPLOAD_THUMB,     /* asset role "thumb" */
  RQ_STEP_UPLOAD_FRAME,     /* asset role "original-frame", see frame_index */
  RQ_STEP_COMPLETE_CAPTURE, /* POST /api/device/captures/{id}/complete */
  RQ_STEP_WAIT_BACKOFF,     /* RETRY_WAIT and the timer has not expired */
} rq_step_kind_t;

/** How a response or transport outcome should be treated. */
typedef enum {
  RQ_DISP_OK = 0,      /* step succeeded */
  RQ_DISP_RETRY,       /* transient: keep the job, back off, resume */
  RQ_DISP_REREAD,      /* stored bytes rejected: re-read from SD, bounded */
  RQ_DISP_PARK,        /* this job can never succeed; the queue continues */
  RQ_DISP_HALT,        /* credentials or association are wrong; stop the queue */
  /* The step did not run: a capture held the card and the upload yielded, as
   * it is designed to. Nothing was judged, so nothing is counted - a yield
   * costs no attempt. Gate F bench 2026-08-30: a good photograph parked
   * FAILED because twelve consecutive yields under a burst of shutters were
   * booked as transient failures. Appended so no other value moves. */
  RQ_DISP_YIELD,
} rq_disposition_t;

/**
 * One queued capture. Mirrors UPLOAD.JSON exactly; nothing here is derived at
 * load time, so a record means the same thing before and after a reboot.
 */
typedef struct {
  char uuid[RQ_UUID_LEN];              /* captureUuid — the idempotency key */
  char capture_id[RQ_CAPTURE_ID_LEN];  /* server id; "" until registered */
  char roll_id[RQ_CAPTURE_ID_LEN];     /* the Roll this job belongs to */
  rq_state_t state;
  int frame_count;                     /* frames the capture actually holds */
  bool thumb_present;                  /* a THUMB.JPG exists on the card */
  bool thumb_done;                     /* server confirmed the thumb asset */
  bool frame_done[RQ_MAX_FRAMES];      /* per-frame confirmation, 0-based */
  uint32_t attempts;                   /* consecutive transient failures */
  uint32_t reread_attempts;            /* bounded 422 re-reads */
  int64_t next_attempt_ms;             /* monotonic deadline while RETRY_WAIT */
  char last_error[RQ_ERROR_LEN];       /* never a credential — see rq_redact */
} rq_job_t;

/** The step rq_next_step() chose. */
typedef struct {
  rq_step_kind_t kind;
  /** 1-based frame index for RQ_STEP_UPLOAD_FRAME, else 0. The contract
   * requires frameIndex 1..N contiguous, so this is the wire value. */
  int frame_index;
} rq_step_t;

/* ------------------------------------------------------------------ */
/* Policy                                                             */
/* ------------------------------------------------------------------ */

/** Transient failures after which a job is parked instead of retried
 * forever. The contract asks for bounded retry; "do not hammer the API". */
#define RQ_MAX_ATTEMPTS 12
/** Re-reads allowed for one asset after CHECKSUM_MISMATCH before parking. */
#define RQ_MAX_REREADS 2
/** Backoff ceiling, from the contract's "1 s → 30 s cap". */
#define RQ_BACKOFF_CAP_MS 30000

/**
 * Backoff for the given number of consecutive failures: 1 s, 2 s, 4 s ...
 * capped at 30 s. `attempts` is the count *including* the one that just
 * failed, so the first retry waits 1 s.
 *
 * Mirrors backoffMs() in apps/twin/src/roll/bridge.ts, which is the reference
 * implementation of this contract.
 */
uint32_t rq_backoff_ms(uint32_t attempts);

/**
 * Classify an HTTP status. `status` of 0 means the request never got a
 * response (DNS, TLS, connection, timeout, or the C6 link dropping).
 *
 * The contract splits these two ways and they have to be reconciled:
 *
 *   - its queue section calls 400/401/403/404/422 "drop-status responses ...
 *     do not retry the same bytes; log and park";
 *   - its error table says 422 CHECKSUM_MISMATCH means "re-read the file from
 *     SD and re-upload".
 *
 * Both hold: the prohibition is on retrying *the same bytes*. A re-read is a
 * fresh read of the card, which is the one thing that can fix a checksum
 * mismatch. So 422 is RQ_DISP_REREAD, bounded by RQ_MAX_REREADS, and parks
 * after that rather than looping.
 *
 * 401/403 are RQ_DISP_HALT rather than RQ_DISP_PARK: a wrong token or a lost
 * association fails every job identically, so parking them one at a time
 * would walk the whole queue into FAILED for a fault the user can fix.
 */
rq_disposition_t rq_classify_status(int status);

/** A step result with the yield flag folded in: yielded wins over any status,
 * because a step that never ran has no status worth reading. */
rq_disposition_t rq_classify_step(int status, bool card_yielded);

/**
 * True when a job in RETRY_WAIT is ready to run again. Split out so the
 * upload task never compares clocks itself, and so the test can.
 */
bool rq_retry_due(const rq_job_t *job, int64_t now_ms);

/* ------------------------------------------------------------------ */
/* Resume                                                             */
/* ------------------------------------------------------------------ */

/**
 * The next step for this job, from its state and its completion flags alone.
 *
 * This is the whole of the resume logic. It does not care whether the process
 * has just booted or has been draining for an hour, which is the property
 * that makes "reboot mid-queue" and "carry on" the same code path.
 *
 * Order follows the contract: register, then thumb, then originals in frame
 * order, then complete. Thumb before originals is not an optimisation, it is
 * what puts a tile on the guest's phone before four full JPEGs travel.
 */
rq_step_t rq_next_step(const rq_job_t *job, int64_t now_ms);

/**
 * Apply the outcome of `step` to `job`, in place. Returns true when the job
 * changed in a way that has to be written back to the card before the next
 * network operation — the caller must not skip that write, or a reboot can
 * lose the fact that a frame landed and upload it twice.
 *
 * `detail` may be NULL; when given it is copied into last_error, truncated,
 * for RETRY_WAIT/FAILED. Callers must pass rq_redact()-safe text.
 */
bool rq_apply(rq_job_t *job, rq_step_t step, rq_disposition_t disp, const char *detail);

/** Initialise a fresh job for a capture that has just been committed. */
void rq_job_init(rq_job_t *job, const char *uuid, const char *roll_id, int frame_count,
                 bool thumb_present);

/** True when the job needs no further network work. */
bool rq_job_settled(const rq_job_t *job);

/* ------------------------------------------------------------------ */
/* Reconciliation                                                     */
/* ------------------------------------------------------------------ */

/** What startup should do with one capture directory found on the card. */
typedef enum {
  RQ_REC_IGNORE = 0,   /* not a committed capture, or already COMPLETE */
  RQ_REC_ENQUEUE,      /* committed, never queued — queue it now */
  RQ_REC_RESUME,       /* has a job with work left — resume it */
  RQ_REC_REPAIR,       /* record unreadable or from a newer format — rebuild */
  RQ_REC_RETIRE,       /* the record names a Roll the capture never claimed — park it, never upload */
} rq_reconcile_t;

/**
 * Decide what to do with one capture directory at startup.
 *
 * `has_meta`   — META.JSON exists, so the capture is committed. Without it
 *                the folder is an interrupted commit and storage.c's sweep
 *                owns it, not the queue.
 * `has_job`    — UPLOAD.JSON exists.
 * `job_valid`  — it parsed, and its format version is one we understand.
 * `job`        — the parsed job, or NULL when !job_valid.
 *
 * The unreadable-record case is REPAIR rather than IGNORE deliberately. A
 * corrupt job file must not silently strand a photograph: the capture is
 * still on the card, the server is idempotent on its UUID, so rebuilding the
 * record and re-running the procedure costs one redundant registration and
 * cannot produce a duplicate capture.
 */
/*
 * `meta_roll_id` is the Roll the capture's own META.JSON names ("" or NULL when
 * it names none). It is the only provenance the queue believes: a job that
 * names a different Roll - or any Roll when META names none - was stamped by a
 * later boot with whatever Roll was current, and is retired rather than
 * uploaded into a Roll the photograph was never taken on.
 */
rq_reconcile_t rq_reconcile_action(bool has_meta, const char *meta_roll_id, bool has_job,
                                   bool job_valid, const rq_job_t *job);

/*
 * A job read back from the card at boot. next_attempt_ms is a deadline on the
 * boot's monotonic clock, and that clock stopped at the reset: a RETRY_WAIT
 * job would otherwise sit until the new uptime passes a number the old boot
 * wrote down - 27 minutes on the bench, hours after a long session. The job is
 * due now. Attempts are kept: the history is real, only the clock is not.
 * Jobs in any other state are untouched.
 */
void rq_job_boot_resume(rq_job_t *job);

/*
 * The network came back after having been down (the radio recovered from a
 * C6 reset, or the link returned). A RETRY_WAIT deadline set while it was
 * down was a guess about a server that could not be reached; now that it
 * can, the job is due. Attempts are kept - this is not a fresh budget, only
 * the end of a wait that no longer means anything. Other states untouched.
 */
void rq_job_network_restored(rq_job_t *job);


/* ------------------------------------------------------------------ */
/* Naming and safety                                                  */
/* ------------------------------------------------------------------ */

/** Human-readable state, for UPLOAD_QUEUE_STATUS and the ROLL screen. */
const char *rq_state_name(rq_state_t state);

/**
 * Copy `src` into `dst` with anything that looks like a bearer token or a
 * Wi-Fi password removed.
 *
 * Error text reaches three places that outlive the device — KDP responses,
 * `GET_LOGS`, and a crash dump — and a URL or header echoed into an error
 * message is the ordinary way a device token ends up in all three. Callers
 * pass every network error detail through here; the tests assert a `kdt_`
 * token cannot survive it.
 *
 * Returns dst.
 */
char *rq_redact(char *dst, size_t dst_size, const char *src);

/**
 * Copy `src` into `dst` with every byte that cannot appear in a JSON string
 * made safe: control bytes (below 0x20, and 0x7f) and any byte that is not
 * part of a valid UTF-8 sequence each become one `?`.
 *
 * The input is bytes off a socket. An error body from a proxy, a gzip page
 * answered to a 502, or an SSID echoed back can all put control bytes and
 * invalid sequences into an error detail, and that detail ends up in a job's
 * `last_error`, which upload_store.c writes through cJSON. cJSON escapes one
 * control byte as six characters, so 95 of them are 570 bytes inside a record
 * bounded at UPLOAD_STORE_MAX_BYTES — the record then exceeds the bound and is
 * refused for the rest of its life, so the job it described can never be read
 * back. Invalid UTF-8 is the other half: cJSON emits it verbatim and the KDP
 * reply carrying it is then a document Studio cannot parse.
 *
 * Never longer than its input, so a caller can sanitise in place of a copy it
 * was making anyway. A multi-byte sequence that would be cut in half by the
 * end of `dst` is dropped whole rather than truncated, because half a sequence
 * is the exact thing this removes.
 *
 * Returns dst.
 */
char *rq_sanitise_detail(char *dst, size_t dst_size, const char *src);

#endif /* P4_ROLL_QUEUE_H */
