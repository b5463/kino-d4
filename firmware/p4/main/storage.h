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

#endif
