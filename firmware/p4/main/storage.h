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

typedef struct {
  char id[16];   /* "TC_000042" — NVS sequence, never reused across boots */
  char dir[64];  /* "/sdcard/KINO/CAPTURES/<uuid>" */
  FILE *jpg;
} storage_capture_t;

/** Opens <dir>/C1.JPG for writing under the capture's UUID folder. */
esp_err_t storage_capture_begin(storage_capture_t *c, const char *capture_uuid);
esp_err_t storage_capture_append(storage_capture_t *c, const uint8_t *data, size_t len);
/** Flushes C1.JPG and writes META.JSON. The capture exists once this returns. */
esp_err_t storage_capture_commit(storage_capture_t *c, const char *meta_json);
void storage_capture_abort(storage_capture_t *c);

/** CRC-32 of a stored file, streamed. */
esp_err_t storage_file_crc32(const char *path, uint32_t *out_crc, uint32_t *out_bytes);

/** Removes a committed capture folder (C1.JPG + META.JSON + dir). Used by the
 * soak test's keepAll=false cleanup — never called on user captures. */
void storage_capture_delete(const char *dir);

#endif
