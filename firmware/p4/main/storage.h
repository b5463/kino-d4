// SD storage: mount, status, self-test, and the capture writer. A missing or
// failed card is a reported state, never a boot failure — GET_STORAGE_STATUS
// tells the truth and capture paths NACK with the exact failing reason.
#ifndef P4_STORAGE_H
#define P4_STORAGE_H

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "esp_err.h"

esp_err_t storage_init(void);
bool storage_present(void);

typedef struct {
  bool present;
  bool mounted;
  const char *filesystem; /* "FAT" when mounted, NULL otherwise */
  uint64_t capacity_bytes;
  uint64_t free_bytes;
  const char *last_error; /* short code/message, NULL when none */
  uint32_t mount_attempts;
  const char *write_test; /* "none" | "pass" | "fail" */
} storage_status_t;

void storage_get_status(storage_status_t *out);

/** SD errors since boot (mount failures, write failures) — GET_RUNTIME_STATS. */
uint32_t storage_sd_errors(void);

typedef enum {
  STORAGE_ST_OK = 0,
  STORAGE_ST_POWER_ENABLE_FAILED,
  STORAGE_ST_MOUNT_FAILED,
  STORAGE_ST_WRITE_FAILED,
  STORAGE_ST_READ_FAILED,
  STORAGE_ST_VERIFY_FAILED,
  STORAGE_ST_REMOVE_FAILED,
} storage_selftest_phase_t;

typedef struct {
  bool ok;
  storage_selftest_phase_t failed_phase;
  uint32_t duration_ms;
  uint32_t bytes_tested;
} storage_selftest_result_t;

/** Non-destructive: writes/reads/deletes one temp file under /KINO. Existing
 * card data is never touched. */
void storage_self_test(storage_selftest_result_t *out);
const char *storage_selftest_phase_str(storage_selftest_phase_t phase);

/* ------------------------------------------------------------------ */
/* Throughput benchmark (KDP STORAGE_BENCH, 0x4c)                      */
/* ------------------------------------------------------------------ */

/**
 * Where a benchmark run stopped.
 *
 * Deliberately a superset of storage_selftest_phase_t's vocabulary rather than
 * a parallel error architecture: the two share the same phases where they do
 * the same work, and the extra rows are phases the self-test does not have
 * (flush, fsync, close and cleanup are collapsed into WRITE/REMOVE there).
 * A failing phase is the whole diagnostic value of this command — "slow" and
 * "did not finish" are different problems.
 */
typedef enum {
  STORAGE_BENCH_OK = 0,
  STORAGE_BENCH_NOT_MOUNTED,
  STORAGE_BENCH_BAD_REQUEST,
  STORAGE_BENCH_OUT_OF_MEMORY,
  STORAGE_BENCH_OPEN_FAILED,
  STORAGE_BENCH_WRITE_FAILED,
  STORAGE_BENCH_FLUSH_FAILED,
  STORAGE_BENCH_FSYNC_FAILED,
  STORAGE_BENCH_CLOSE_FAILED,
  STORAGE_BENCH_READ_FAILED,
  STORAGE_BENCH_CRC_MISMATCH,
  STORAGE_BENCH_SHORT_READ,
  /* The data verified but the temp file could not be removed. Reported rather
   * than swallowed: a benchmark that silently leaves a megabyte behind on
   * every run is a benchmark that fills the card it is measuring. */
  STORAGE_BENCH_CLEANUP_FAILED,
} storage_bench_phase_t;

const char *storage_bench_phase_str(storage_bench_phase_t phase);

/** One measured pass at one size. */
typedef struct {
  uint32_t bytes;
  uint32_t write_ms;
  uint32_t read_ms;
  uint32_t write_bytes_per_sec;
  uint32_t read_bytes_per_sec;
  uint32_t crc_written;
  uint32_t crc_read;
  bool crc_match;
  /* Per-chunk write latency, measured with esp_timer around each fwrite.
   * worst_us is the number that decides a four-frame burst: the burst stalls
   * on its single worst block, and a mean hides exactly the event that drops
   * a frame. */
  uint32_t chunk_bytes;
  uint32_t chunks;
  uint32_t worst_write_chunk_us;
  uint32_t best_write_chunk_us;
  uint32_t mean_write_chunk_us;
  uint32_t p95_write_chunk_us;
} storage_bench_pass_t;

typedef struct {
  bool ok;
  storage_bench_phase_t failed_phase;
  uint32_t passes;
  /* The sustained run, which is what the contract's writeMBs/readMBs and
   * worstBlockMs/p95BlockMs report. */
  storage_bench_pass_t sustained;
  /* A 64 KiB run alongside it, the same size STORAGE_SELF_TEST uses, so the
   * two commands are directly comparable on the same card. A card that passes
   * the self-test and collapses at a megabyte is a card we want to know about
   * before a four-frame burst finds out. */
  storage_bench_pass_t small;
  bool cleanup_ok;
  uint32_t total_ms;
} storage_bench_result_t;

/**
 * Measure sustained write/read throughput and per-block write latency.
 *
 * Non-destructive and bounded. Writes one temp file under /KINO with an
 * unmistakably temporary name, verifies it by CRC-32 read-back, and removes
 * it. Existing card data is never touched and no capture directory is
 * involved — a benchmark that wrote into /KINO/CAPTURES would be
 * indistinguishable from a capture to every reader of the card.
 *
 * `size_kb` and `block_kb` are clamped to a sane bounded range so a host
 * cannot ask the device to fill the card or to allocate an absurd buffer.
 * Chunked I/O throughout: the largest allocation is one block, not one file.
 *
 * Throughput is never reported as a success unless the read-back CRC matched.
 * A fast wrong answer is worse than a slow right one.
 */
void storage_bench(uint32_t size_kb, uint32_t block_kb, uint32_t passes,
                   storage_bench_result_t *out);

/** Frames a capture folder can hold: one per camera. */
#define STORAGE_CAPTURE_FRAMES 4

/* Every file of a capture a HOST may read. Shared by the delete path and the
 * MEDIA_READ allow-list so the two cannot drift. */
#define STORAGE_CAPTURE_FILE_COUNT 6
extern const char *const STORAGE_CAPTURE_FILES[STORAGE_CAPTURE_FILE_COUNT];

/*
 * Files this firmware writes INSIDE a capture folder and never serves.
 *
 * A second list rather than six-becomes-eight, because the array above is also
 * the MEDIA_READ allow-list: adding the upload record there would put the
 * device's own queue state on the wire, which is a contract change nobody
 * asked for. Deleting a capture must still take them - see
 * storage_capture_delete().
 *
 * Owned by upload_store.h (UPLOAD_STORE_RECORD / UPLOAD_STORE_TEMP); named
 * from those constants in storage.c so a rename there reaches here.
 */
#define STORAGE_CAPTURE_INTERNAL_FILE_COUNT 2
extern const char *const STORAGE_CAPTURE_INTERNAL_FILES[STORAGE_CAPTURE_INTERNAL_FILE_COUNT];

typedef struct {
  /* "CAP_000042" from the NVS sequence, which is never reused across boots.
   * When NVS cannot be read or written the id falls back to "CAP_x" plus the
   * first six hex digits of the capture UUID - still unique on the card, but
   * no longer ordered; see storage_capture_open(). */
  char id[16];
  char dir[64];  /* "/sdcard/KINO/CAPTURES/<uuid>" */
  FILE *jpg;     /* the frame currently open for writing, NULL between frames */
  int open_cam;  /* which camera that frame belongs to, -1 when none is open */
  /* Path of the frame `jpg` is writing, so a failed write can take the
   * truncated file with it. Empty between frames. */
  char open_path[80];
  uint8_t written; /* bitmask of cameras whose frame reached the card */
} storage_capture_t;

/**
 * Create the capture folder and claim an id.
 *
 * `id_prefix` separates what a folder is for at a glance on the card: "CAP"
 * for a picture someone took, "TC" for a bench capture from CAMERA_TEST or a
 * soak run. They share the sequence, so the number is still unique and still
 * monotonic across the whole card.
 *
 * No file is opened; a capture may hold up to STORAGE_CAPTURE_FRAMES frames
 * and does not know yet which cameras will answer.
 */
esp_err_t storage_capture_open(storage_capture_t *c, const char *capture_uuid,
                               const char *id_prefix);
/** Opens <dir>/C<cam+1>.JPG. One frame is open at a time. */
esp_err_t storage_capture_frame_begin(storage_capture_t *c, int cam);
/** Flushes and closes the open frame. The bytes are on the card once this
 * returns ESP_OK; the capture is not committed until META.JSON is written.
 * On failure the frame's file is unlinked and its written bit stays clear —
 * a frame that did not close clean is a truncated JPEG, and leaving one on the
 * card gives META.JSON a frame to describe that is half a picture. */
esp_err_t storage_capture_frame_end(storage_capture_t *c);

/**
 * Close the open frame and delete its file.
 *
 * For a write that failed part way: `storage_capture_append()` returning
 * ESP_FAIL means a short fwrite, so the bytes on the card are a prefix of a
 * JPEG. Ending the frame would close it, set the written bit and leave the
 * stub behind. This is the other ending — no written bit, no file.
 */
esp_err_t storage_capture_frame_abandon(storage_capture_t *c);

/** open() + frame_begin(cam 0) with the "TC" prefix - the single-camera bench
 * path, unchanged. */
esp_err_t storage_capture_begin(storage_capture_t *c, const char *capture_uuid);
esp_err_t storage_capture_append(storage_capture_t *c, const uint8_t *data, size_t len);
/** Closes any open frame and writes META.JSON. The capture exists once this
 * returns: META.JSON is what makes a folder of JPEGs a capture. */
esp_err_t storage_capture_commit(storage_capture_t *c, const char *meta_json);
void storage_capture_abort(storage_capture_t *c);

/** CRC-32 of a stored file, streamed. */
esp_err_t storage_file_crc32(const char *path, uint32_t *out_crc, uint32_t *out_bytes);

/** Removes a capture folder: every name in STORAGE_CAPTURE_FILES and in
 * STORAGE_CAPTURE_INTERNAL_FILES, then the directory itself. Used by
 * MEDIA_DELETE, the photo screen's DELETE, DELETE ALL PHOTOS, the soak test's
 * keepAll=false cleanup and the boot sweep.
 *
 * The two lists are the whole contract, and both have now been short once:
 * THUMB.JPG while the capture path wrote one on every success, and UPLOAD.JSON
 * once captures could be queued for a Roll. Both times rmdir() refused the
 * non-empty directory, and both times the symptom was a deleted capture that
 * was still on the card. Anything a capture folder can hold belongs in one of
 * the two lists. */
void storage_capture_delete(const char *dir);

/* ------------------------------------------------------------------ */
/* Pre-capture space reservation                                       */
/* ------------------------------------------------------------------ */

/**
 * A conservative upper bound on what one capture will occupy.
 *
 * This is a BOUND, not an estimate, and the distinction is the whole point: an
 * estimate that is usually right still lets a capture start that cannot
 * finish, and a capture that dies at frame three has already written frames
 * one and two. Refusing early costs a photograph nobody could have had;
 * refusing late costs a corrupt folder and a confused user.
 *
 * JPEG size is scene-dependent and unbounded in principle, so the bound is
 * struck at 0.5 bytes per pixel per frame. Observed VGA q12 frames on the
 * bench were 7.7-30.4 KB, which is 0.025-0.1 bpp; UXGA at the best quality
 * this firmware ever requests should stay far under 0.5. It is deliberately
 * several times the expected size, because the reserve only ever matters on a
 * nearly-full card and being generous there costs nothing on a 32 GB one.
 *
 * Pure arithmetic, no filesystem access - host-tested.
 */
uint64_t storage_capture_reserve_bytes(int frames, uint32_t width, uint32_t height);

/**
 * True when the card can be trusted to hold `frames` frames at w x h.
 *
 * `need` and `avail` are filled in whenever they are non-NULL, including on
 * the false path, so the caller can say how short it was rather than only
 * that it was short.
 */
bool storage_capture_space_ok(int frames, uint32_t width, uint32_t height, uint64_t *need,
                              uint64_t *avail);

/* ------------------------------------------------------------------ */
/* Interrupted-capture recovery                                        */
/* ------------------------------------------------------------------ */

/**
 * True when `name` is unmistakably a KINO capture directory name.
 *
 * Capture folders are named by RFC 4122 v4 UUID: 36 characters, lowercase hex,
 * dashes at 8/13/18/23. The sweep below deletes things, so the test for "is
 * this ours" is a shape match on the whole string rather than anything looser.
 * A folder someone dropped on the card by hand will not match, and that is the
 * intent.
 *
 * Pure, host-tested.
 */
bool storage_is_capture_dirname(const char *name);

/** What one boot sweep did. */
typedef struct {
  int scanned;   /* directories that looked like captures */
  int complete;  /* had META.JSON - left alone */
  int removed;   /* orphans containing only expected files, deleted */
  int preserved; /* orphans holding something unexpected, kept for inspection */
  /* Capture-shaped directories the sweep never looked inside, because the time
   * budget or the directory cap ran out. Not a fault and not damage: they are
   * examined on the next boot. Nonzero means the card holds more captures than
   * one boot can walk - which used to show only as a boot that took a minute. */
  int skipped;
} storage_sweep_t;

/**
 * Remove capture folders that never got their META.JSON.
 *
 * META.JSON is written last, so a folder without one is an interrupted commit
 * - a reboot, a brownout, or a pulled card between the last frame and the
 * metadata. It can never become a valid capture, and nothing will ever explain
 * the JPEGs inside it.
 *
 * Conservative on every axis that matters:
 *   - only directories whose names pass storage_is_capture_dirname()
 *   - only ever unlinks the names in STORAGE_CAPTURE_FILES and
 *     STORAGE_CAPTURE_INTERNAL_FILES
 *   - the directory itself goes via rmdir(), which refuses a non-empty
 *     directory, so an orphan holding anything unexpected is PRESERVED and
 *     counted rather than forced
 *   - bounded work per boot, so a pathological card cannot stall the boot or
 *     turn one mistake into a mass deletion. Bounded in TIME as well as in
 *     count (SWEEP_BUDGET_MS): this runs on the main task before the USB
 *     transport is up, so the bound is what stops a full card from looking
 *     like a camera that will not boot. What was not reached is counted in
 *     `skipped` and swept on the next boot.
 *
 * Every action is logged. Valid captures are never touched.
 */
void storage_sweep_orphans(storage_sweep_t *out);

/* ------------------------------------------------------------------ */
/* Card access coordination                                            */
/* ------------------------------------------------------------------ */

/**
 * Who wants the card, and how badly.
 *
 * Priority is the whole point of this module: the camera has one card, one
 * SDMMC controller, and a FAT mount with `max_files = 4`. Before this existed
 * `capture.c` held a file-static mutex that only it could see, and the upload
 * worker coordinated with it through a boolean — which is not exclusion, it is
 * a hint. A reader that opened a handle between the check and the capture could
 * still take the fourth descriptor and make a capture fail to open its frame.
 */
typedef enum {
  /** A capture writing frames or committing metadata. Outranks everything and
   * is never made to wait behind background work. */
  STORAGE_USER_CAPTURE = 0,
  /** The camera UI reading a thumbnail or a gallery tile. A person is looking
   * at the screen, so it beats uploading but yields to a capture. */
  STORAGE_USER_UI,
  /** The Roll upload worker, and boot reconciliation. Lowest: an upload that
   * lands a few seconds later costs nothing, a dropped frame costs a
   * photograph. */
  STORAGE_USER_UPLOAD,
} storage_user_t;

/**
 * Handles the mount can have open at once. Mirrors the `max_files` passed to
 * esp_vfs_fat_sdmmc_mount(); exported so callers can reason about the budget
 * instead of discovering it.
 *
 * ## What the code actually opens (audited 2026-08-27)
 *
 * Every path in this firmware opens one file, closes it, then opens the next.
 * Not one of them holds two at a time:
 *
 *   capture frame write     1  storage_capture_frame_begin/_end
 *   thumbnail write         1  thumb.c; the source JPEG is already in RAM
 *   META.JSON commit        1  storage_capture_commit
 *   UPLOAD.JSON write       1  upload_store_save; temp handle closed before the
 *                              rename
 *   reconciliation          1  upload_store_load, plus one DIR (see below)
 *   gallery tile decode     1  thumb_load -> slurp
 *   STORAGE_BENCH           1  the write handle is closed before the read one
 *   STORAGE_SELF_TEST       1  same shape
 *
 * `opendir()` does NOT spend a descriptor: esp_vfs_fat's vfs_fat_opendir()
 * ff_memalloc()s its own vfs_fat_dir_t (vfs_fat.c:894), separate from the
 * `files[]` array `max_files` sizes.
 *
 * Concurrency is what sets the number, and only four tasks touch the card:
 * capture (1 handle, holds STORAGE_USER_CAPTURE), the upload worker (1, holds
 * STORAGE_USER_UPLOAD, so it cannot overlap capture), the UI reading a gallery
 * tile (1, holds STORAGE_USER_UI), and the KDP server serving a MEDIA_*
 * command (1, STORAGE_USER_UI) or running a bench or self-test (1, excluded
 * from capture by capture_lock() rather than by this lock). The worst case is
 * therefore two: the lock holder plus a bench.
 *
 * Two against eight, a 4x headroom — not tight, and not free. The old value of
 * 4 was also sufficient, and the reason once given for it being close ("a
 * capture holds a frame handle plus a read-back handle") never held: the frame
 * was closed before the read-back opened, and since 2026-08-29 the capture
 * path does no read-back at all.
 *
 * ## What each descriptor costs
 *
 * esp_vfs_fat_register_cfg() allocates `sizeof(vfs_fat_ctx_t) + max_files *
 * sizeof(FIL)` plus a parallel `max_files * sizeof(uint32_t)` flags array
 * (vfs_fat.c:202 and :208). FIL is dominated by `BYTE buf[FF_MAX_SS]` (ff.h:225,
 * present because CONFIG_FATFS_PER_FILE_CACHE=y), and FF_MAX_SS is 4096 here,
 * not 512, because CONFIG_FATFS_SECTOR_4096=y.
 *
 * Measured with this project's sdkconfig, riscv32-esp-elf: sizeof(FIL) = 4136 B,
 * plus 4 B of flags = 4140 B, or 4.04 KiB per descriptor. So 8 descriptors is
 * 33.1 KB and the raise from 4 cost 16.6 KB. It comes out of PSRAM, not
 * internal SRAM (CONFIG_FATFS_ALLOC_PREFER_EXTRAM=y), which is why 2.6x headroom
 * is worth paying for and would not be at 512-byte sectors in internal RAM.
 */
#define STORAGE_MAX_OPEN_FILES 8

/**
 * Take the card for `user`. Blocks up to `timeout_ms`; use
 * `STORAGE_WAIT_FOREVER` for the capture path, which must never be refused.
 *
 * Returns false on timeout, and a caller that gets false must do nothing to
 * the card — not "try anyway". The upload worker passes a short timeout
 * precisely so that a busy card makes it give up and come back rather than
 * queue behind photography.
 *
 * Reentrancy: not recursive. One take, one give, on the same task.
 *
 * ## Why a priority lock and not a plain mutex
 *
 * A plain FreeRTOS mutex is first-come-first-served, so a capture arriving
 * while a 300 KB upload read is in flight waits for it. That is the wrong way
 * round on a camera. `storage_yield_requested()` is the other half: a
 * long-running low-priority holder polls it and lets go early.
 */
bool storage_acquire(storage_user_t user, int timeout_ms);

#define STORAGE_WAIT_FOREVER (-1)

/** Release the card. Must be called on the task that acquired it. */
void storage_release(storage_user_t user);

/**
 * True when THIS task already holds the card.
 *
 * For the one function with two callers at different depths.
 * `upload_queue_enqueue()` writes `UPLOAD.JSON`, and it is called both from
 * `capture.c`'s done-listener — which runs inside that capture's own
 * `storage_acquire(STORAGE_USER_CAPTURE)` — and from `kdp_net.c` on the KDP
 * server task, which holds nothing. The lock is not recursive, so acquiring
 * unconditionally deadlocks the capture task against itself, and acquiring
 * never leaves the KDP path writing the card unprotected.
 *
 * So the callee asks. `storage_acquire_unless_held()` below is the whole
 * pattern; this predicate is exported for callers that need to reason about it
 * separately, and for diagnostics.
 *
 * Task-scoped, not user-scoped: it answers "am I the holder", not "is anyone
 * holding". `storage_capture_active()` answers the other question.
 */
bool storage_held_by_this_task(void);

/**
 * Acquire unless this task is already the holder.
 *
 * Sets `*took` to whether a matching `storage_release()` is owed — pass it to
 * `storage_release_if_taken()`, or branch on it. Returns false only when the
 * card was wanted, not held, and not obtained within `timeout_ms`.
 *
 * This exists so a helper can be correct under both of its callers without
 * either of them knowing which. The alternative — a recursive mutex — would
 * also have worked, and was rejected because it makes "who holds the card"
 * unanswerable at a glance, which is the question every yield decision and
 * every deadlock hunt starts from.
 */
bool storage_acquire_unless_held(storage_user_t user, int timeout_ms, bool *took);

/** Release only if the paired `storage_acquire_unless_held()` actually took
 * the lock. Safe with `took == false`. */
void storage_release_if_taken(storage_user_t user, bool took);

/**
 * True when someone more important is waiting.
 *
 * The upload worker checks this between chunks of a file read and returns the
 * card early when a capture wants it. Without a cooperative check the capture
 * still waits for a whole frame read to finish, which is the multi-hundred-
 * millisecond stall this design exists to avoid. Photography wins, and the
 * upload resumes from the same byte because the queue re-reads from the card
 * anyway.
 */
bool storage_yield_requested(storage_user_t user);

/** True while a capture holds the card, or is waiting for it. Cheap; for the
 * UI and for `upload_queue`'s idle check. */
bool storage_capture_active(void);

/** Diagnostics for `GET_RUNTIME_STATS`: how often a low-priority holder was
 * asked to yield, and how often an acquire timed out. Both should be small;
 * a growing timeout count means the budget or the priorities are wrong. */
void storage_lock_stats(uint32_t *yields, uint32_t *timeouts);

/** Longest string storage_holder_name() writes, including the terminator. */
#define STORAGE_HOLDER_NAME_LEN 48

/**
 * Name the card's current holder, for a diagnostic that would otherwise guess.
 *
 * Six KDP sites answered `BUSY, "Card is busy with a capture"` on ANY
 * storage_acquire() timeout, whoever was actually holding the card. At the
 * bench the holder was the gallery's own index rebuild, and the message sent a
 * reader looking for a capture that was not running - the same class of fault
 * as a stall line that fires on an idle screen.
 *
 * Two parts, because they answer different questions: the priority class says
 * why the wait was not jumped, and the task name says which code to go and
 * read. "nothing" when the lock is free.
 *
 * Cheap, and takes no lock - one critical section and one string copy - so it
 * is safe to call from a handler that has just been REFUSED the lock, which is
 * the only caller there is. The holder's task name is read under s_wait_mux so
 * it stays consistent with the holder class; every card user is a long-lived
 * task, so the TCB it names is not going away underneath the copy.
 *
 * Racy by construction, and phrased honestly because of it: this names the
 * holder at the instant of the call, microseconds after an acquire gave up,
 * which need not be the task that actually blocked the caller. So the message
 * built from it is present tense - "X holds it" - and never "X blocked you".
 */
void storage_holder_name(char *out, size_t len);

/**
 * The one BUSY message every card-lock refusal uses.
 *
 * A function rather than a string literal per site: the six sites that said
 * "Card is busy with a capture" held identical text, and identical text in six
 * places is how a message stays wrong in all six at once. Writes at most `len`
 * bytes including the terminator; 96 is comfortable.
 */
void storage_card_busy_message(char *out, size_t len);

#endif
