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

/** Frames a capture folder can hold: one per camera. */
#define STORAGE_CAPTURE_FRAMES 4

typedef struct {
  char id[16];   /* "CAP_000042" — NVS sequence, never reused across boots */
  char dir[64];  /* "/sdcard/KINO/CAPTURES/<uuid>" */
  FILE *jpg;     /* the frame currently open for writing, NULL between frames */
  int open_cam;  /* which camera that frame belongs to, -1 when none is open */
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
 * returns ESP_OK; the capture is not committed until META.JSON is written. */
esp_err_t storage_capture_frame_end(storage_capture_t *c);

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

/** Removes a committed capture folder (C1.JPG + META.JSON + dir). Used by the
 * soak test's keepAll=false cleanup — never called on user captures. */
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
 *   - only ever unlinks the six filenames a capture can contain
 *   - the directory itself goes via rmdir(), which refuses a non-empty
 *     directory, so an orphan holding anything unexpected is PRESERVED and
 *     counted rather than forced
 *   - bounded work per boot, so a pathological card cannot stall the boot or
 *     turn one mistake into a mass deletion
 *
 * Every action is logged. Valid captures are never touched.
 */
void storage_sweep_orphans(storage_sweep_t *out);

#endif
