/**
 * UPLOAD.JSON: the on-card form of one queued upload job.
 *
 * Split out of upload_queue.c, which owns the worker, the queue policy and the
 * state transitions. This file owns exactly one thing: turning an `rq_job_t`
 * into bytes in the capture's own directory and back again, and deciding
 * whether what came back can be trusted.
 *
 * roll_queue.h states the durability model this implements; upload_queue.h
 * states how the queue drives it. Neither is re-decided here.
 *
 * ## Why the boundary is here
 *
 * Everything in this file is either cJSON or one `fopen`, and no part of it
 * needs FreeRTOS, a task, a clock or the network. That makes it the only piece
 * of the queue that can be compiled and run on a host against the SAME cJSON
 * the firmware links — see firmware/p4/host_tests/test_upload_store.c. The
 * encode/decode pair below is exposed for that reason: a round-trip, a
 * corrupted record and a future format version are all testable without an SD
 * card, and those are precisely the three cases whose misbehaviour costs a
 * photograph or uploads a frame twice.
 *
 * ## Locking
 *
 * Nothing here takes the storage lock. These are the persistence primitives;
 * the caller decides at what priority the card is being touched, and only the
 * caller knows whether it already holds it. upload_queue.c takes
 * STORAGE_USER_UPLOAD around the reconciliation pass and around the
 * post-step write.
 */
#ifndef P4_UPLOAD_STORE_H
#define P4_UPLOAD_STORE_H

#include <stdbool.h>
#include <stddef.h>

#include "roll_queue.h"

/** Where captures live. One record per capture, inside the capture's own
 * directory — roll_queue.h gives the three reasons. */
#define UPLOAD_STORE_DIR "/sdcard/KINO/CAPTURES"
#define UPLOAD_STORE_RECORD "UPLOAD.JSON"
#define UPLOAD_STORE_TEMP "UPLOAD.TMP"

/**
 * Largest record this module will accept back from the card.
 *
 * A full record is under 400 bytes: 36 for the UUID, up to 63 each for the
 * server capture id and the roll id, 95 for the error text, eight frame flags
 * and a handful of numbers. Anything past this bound was not written by us, so
 * it is refused rather than parsed — a file we did not write has no reason to
 * mean what our field names say it means, and the field that would silently
 * change meaning is per-frame progress.
 */
#define UPLOAD_STORE_MAX_BYTES 768

/** `<UPLOAD_STORE_DIR>/<uuid>/<name>`, truncated to `cap`. */
void upload_store_path(const char *uuid, const char *name, char *out, size_t cap);

/** True when `<uuid>/<name>` exists on the card. */
bool upload_store_has_file(const char *uuid, const char *name);

/**
 * Serialize `job`. Returns a NUL-terminated string owned by cJSON — release it
 * with `cJSON_free()` — or NULL when the allocation failed.
 *
 * The result fits within UPLOAD_STORE_MAX_BYTES whenever it can: `last_error`
 * is shortened until it does. That is not cosmetic. cJSON escapes one control
 * byte as six characters, so a 95-byte error text of them is 570 bytes and
 * pushes the record past the bound — and a record past the bound is one
 * upload_store_decode() refuses forever, so the job would be rebuilt from the
 * card on every boot and its capture re-registered every time. The error text
 * is the only field in the record that is a diagnostic rather than a decision,
 * so it is the one that gives way.
 *
 * Exposed so the host test can round-trip a job without a filesystem.
 */
char *upload_store_encode(const rq_job_t *job);

/**
 * Parse `len` bytes of a record into `job`, taking `uuid` from the directory
 * name rather than from the file.
 *
 * Returns true when the record can be trusted. It returns FALSE, not a
 * partially-filled job, for a record that is empty, oversized, unparseable,
 * missing its format version, carrying an out-of-range state, or carrying a
 * format version NEWER than RQ_FORMAT_VERSION. That last one is refused on
 * purpose: read with today's field names, a newer schema's per-frame progress
 * would be taken for an older one's, and misreading per-frame progress is what
 * uploads a frame twice. `*job` is untouched on false.
 *
 * A false answer is what makes rq_reconcile_action() say REPAIR, which
 * rebuilds the record from the files on the card. The photograph is never the
 * thing that gets lost.
 */
bool upload_store_decode(const char *text, size_t len, const char *uuid, rq_job_t *job);

/**
 * Write `job` to `<uuid>/UPLOAD.JSON`.
 *
 * Temp name, fsync, then rename over the record — the metadata-last discipline
 * capture.c uses for META.JSON, so a power cut leaves either the old record or
 * the new one and never half of either. Returns false when the card refused
 * any step; the caller must treat that as a reason to stop uploading, because
 * a step that landed and was not written down is a step this queue repeats.
 */
bool upload_store_save(const rq_job_t *job);

/**
 * Read `<uuid>/UPLOAD.JSON`.
 *
 * Returns false when the file is not there at all. Returns true with `*valid`
 * false when it is there and cannot be trusted — the two answers are
 * different, and rq_reconcile_action() needs both: no record means never
 * queued, an untrustworthy record means rebuild.
 */
bool upload_store_load(const char *uuid, rq_job_t *job, bool *valid);

/**
 * What the card says about one capture directory, and the record that answer
 * implies.
 *
 * Wraps the load, the META.JSON probe and rq_reconcile_action() into the one
 * question a reconciliation pass actually asks. `*out` is filled for RESUME
 * (the record as stored) and for ENQUEUE/REPAIR (a fresh record rebuilt from
 * the files present), and untouched for IGNORE.
 *
 * The rebuilt frame list comes from META.JSON's `frames`, bounded by
 * `max_frames` cameras; see upload_store_inspect_ex below for why not the
 * files.
 *
 * `roll_id` NULL or empty means the device is not on a Roll. ENQUEUE and REPAIR
 * then degrade to IGNORE — there is nowhere for the bytes to go, and a job with
 * no destination would park immediately and read as a failure nobody can act
 * on.
 *
 * Reads only. The caller logs the repair and persists the record.
 */
/**
 * The Roll named by a META.JSON document. `text` need not be NUL-terminated.
 * Returns true and copies the id when `rollId` is a non-empty string; returns
 * false (and an empty `out`) for null, absent, or unparseable. Pure - this is
 * what the host tests exercise.
 */
bool upload_store_meta_roll_id_from_text(const char *text, size_t len, char *out, size_t cap);

/** Same, from `<uuid>/META.JSON` on the card. */
bool upload_store_meta_roll_id(const char *uuid, char *out, size_t cap);

/** Why a META.JSON frame list could not be used. Values are negative so the
 * count of a usable list (>= 0) and a refusal never collide. */
typedef enum {
  UPLOAD_META_FRAMES_MALFORMED = -1,   /* not JSON, no `frames` array, or an entry without a `cam` */
  UPLOAD_META_FRAMES_COUNT = -2,       /* `frameCount` disagrees with the entries that have a file */
  UPLOAD_META_FRAMES_SLOT = -3,        /* a camera outside 1..max_slot, or named twice */
  UPLOAD_META_FRAMES_FILE = -4,        /* an entry's `file` is not C<cam>.JPG */
} upload_meta_frames_err_t;

/**
 * The frames a META.JSON document says the capture holds: for every entry of
 * `frames` whose `file` is a string, the camera number from its `cam`
 * ("cam3" -> 3), in document order, into `slots` (up to `cap`). Entries with
 * `file: null` are cameras that were asked and failed; they are not frames.
 *
 * Returns the number of frames, or an upload_meta_frames_err_t. Refused, not
 * guessed: a document whose `frameCount` is not the number of frames, that
 * names a camera twice or outside 1..max_slot, or whose file name is not the
 * camera's, is one this queue will not upload from - the capture path writes
 * all of those consistently, so a disagreement means the document is not one
 * it wrote. Pure; `text` need not be NUL-terminated.
 */
int upload_store_meta_frames_from_text(const char *text, size_t len, int max_slot,
                                       uint8_t *slots, int cap);

/** Same, from `<uuid>/META.JSON` on the card. UPLOAD_META_FRAMES_MALFORMED when
 * the file cannot be read. */
int upload_store_meta_frames(const char *uuid, int max_slot, uint8_t *slots, int cap);

/*
 * Reconcile one capture folder. The Roll comes from the capture's META.JSON,
 * never from a parameter: the caller no longer tells this function which Roll
 * is current, because that is exactly the information it must not use.
 *
 * The frame list comes from META.JSON's `frames` (upload_store_meta_frames),
 * never from a scan for C<n>.JPG: files tell you what is there, META tells you
 * what the photograph is, and the two agree by construction (metadata last).
 * A committed capture whose META names no usable frame list, or names a frame
 * that is not on the card, comes back FAILED with the reason in last_error -
 * parked where the queue status can show it, never guessed at.
 *
 * `*needs_save` (may be NULL) is set when the record on the card must be
 * rewritten before the queue acts: a new ENQUEUE/REPAIR record, or a RESUME
 * record written before frame_slot existed that has just adopted its list
 * from META (rq_job_adopt_slots).
 */
rq_reconcile_t upload_store_inspect_ex(const char *uuid, int max_frames, rq_job_t *out,
                                       bool *needs_save);

/** upload_store_inspect_ex without the save flag: RESUME records that adopted
 * a frame list are then persisted on the next post-step write. */
rq_reconcile_t upload_store_inspect(const char *uuid, int max_frames,
                                    rq_job_t *out);

#endif /* P4_UPLOAD_STORE_H */
