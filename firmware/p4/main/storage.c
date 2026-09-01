#include "storage.h"

#include <dirent.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "board_d4v1.h"
#include "upload_store.h"  /* UPLOAD_STORE_RECORD / _TEMP: this firmware's own files in a capture folder */
#include "driver/sdmmc_host.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_vfs_fat.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "hardware_validation.h"
#include "kdp/crc32.h"
#include "klog.h"
#include "pure.h"
#include "nvs.h"
#include "sd_pwr_ctrl_by_on_chip_ldo.h"
#include "sdmmc_cmd.h"

static const char *TAG = "storage";
#define MOUNT "/sdcard"

static sdmmc_card_t *s_card;
static bool s_power_ok;
static uint32_t s_mount_attempts;
static uint32_t s_sd_errors;
static char s_last_error[48];
static const char *s_write_test = "none";

static void set_error(const char *code) {
  if (code[0] != '\0') s_sd_errors++;
  strlcpy(s_last_error, code, sizeof s_last_error);
  s_last_error[sizeof s_last_error - 1] = '\0';
}

uint32_t storage_sd_errors(void) { return s_sd_errors; }

/* ------------------------------------------------------------------ */
/* Card access coordination                                            */
/* ------------------------------------------------------------------ */

/*
 * One card, one SDMMC controller, one FAT mount with a fixed descriptor
 * budget. Before this, capture.c held a file-static mutex nothing else could
 * see and the upload worker coordinated through a boolean — which is a hint,
 * not exclusion. A reader that opened a handle between the check and the
 * capture could still take the last descriptor and make a frame fail to open.
 *
 * A plain mutex would be first-come-first-served, so a capture arriving during
 * a 300 KB upload read would wait for it. That is the wrong way round on a
 * camera, and it is why `storage_yield_requested()` exists: the low-priority
 * holder polls it and lets go early. Cooperative rather than preemptive,
 * because there is no safe way to take a file handle away from a task
 * mid-read — but the holder checks between chunks, so the wait is bounded by
 * one chunk instead of one whole file.
 */
static SemaphoreHandle_t s_card_lock;
/* Tasks waiting, per priority. Read without the mutex by
 * storage_yield_requested(), so a critical section rather than a lock: the
 * yield check runs inside a read loop and must be cheap. */
static portMUX_TYPE s_wait_mux = portMUX_INITIALIZER_UNLOCKED;
static uint16_t s_waiting[3];
static int s_holder = -1;
/* Which task holds it. Needed because one helper (upload_store_save, via
 * upload_queue_enqueue) is called both from inside a capture's own acquire and
 * from the KDP task holding nothing — see storage_acquire_unless_held(). */
static TaskHandle_t s_holder_task;
static uint32_t s_yield_requests;
static uint32_t s_acquire_timeouts;

bool storage_acquire(storage_user_t user, int timeout_ms) {
  if (s_card_lock == NULL) return false; /* before storage_init() */
  if ((int)user < 0 || (int)user > STORAGE_USER_UPLOAD) return false;

  portENTER_CRITICAL(&s_wait_mux);
  s_waiting[user]++;
  portEXIT_CRITICAL(&s_wait_mux);

  const TickType_t wait =
      timeout_ms == STORAGE_WAIT_FOREVER ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
  const bool got = xSemaphoreTake(s_card_lock, wait) == pdTRUE;

  portENTER_CRITICAL(&s_wait_mux);
  s_waiting[user]--;
  if (got) {
    s_holder = (int)user;
    s_holder_task = xTaskGetCurrentTaskHandle();
  }
  portEXIT_CRITICAL(&s_wait_mux);

  if (!got) s_acquire_timeouts++;
  return got;
}

void storage_release(storage_user_t user) {
  if (s_card_lock == NULL) return;
  portENTER_CRITICAL(&s_wait_mux);
  if (s_holder == (int)user) {
    s_holder = -1;
    s_holder_task = NULL;
  }
  portEXIT_CRITICAL(&s_wait_mux);
  xSemaphoreGive(s_card_lock);
}

bool storage_held_by_this_task(void) {
  if (s_card_lock == NULL) return false;
  const TaskHandle_t me = xTaskGetCurrentTaskHandle();
  portENTER_CRITICAL(&s_wait_mux);
  const bool mine = s_holder_task != NULL && s_holder_task == me;
  portEXIT_CRITICAL(&s_wait_mux);
  return mine;
}

bool storage_acquire_unless_held(storage_user_t user, int timeout_ms, bool *took) {
  if (took != NULL) *took = false;
  if (storage_held_by_this_task()) {
    /* Already ours, at whatever priority we took it. Do not acquire again: the
     * mutex is not recursive and this task would block on itself forever. */
    return true;
  }
  const bool got = storage_acquire(user, timeout_ms);
  if (took != NULL) *took = got;
  return got;
}

void storage_release_if_taken(storage_user_t user, bool took) {
  if (took) storage_release(user);
}

bool storage_yield_requested(storage_user_t user) {
  bool wanted = false;
  portENTER_CRITICAL(&s_wait_mux);
  /* Lower enum value is higher priority. Anyone above us waiting means let
   * go — this is the only thing that stops a capture queueing behind a
   * background file read. */
  for (int u = 0; u < (int)user; u++) {
    if (s_waiting[u] > 0) {
      wanted = true;
      break;
    }
  }
  portEXIT_CRITICAL(&s_wait_mux);
  if (wanted) s_yield_requests++;
  return wanted;
}

bool storage_capture_active(void) {
  portENTER_CRITICAL(&s_wait_mux);
  const bool active = s_holder == (int)STORAGE_USER_CAPTURE ||
                      s_waiting[STORAGE_USER_CAPTURE] > 0;
  portEXIT_CRITICAL(&s_wait_mux);
  return active;
}

void storage_lock_stats(uint32_t *yields, uint32_t *timeouts) {
  if (yields != NULL) *yields = s_yield_requests;
  if (timeouts != NULL) *timeouts = s_acquire_timeouts;
}

/* The priority classes as prose, because these strings end up in a NACK a
 * person reads. Named for what the holder IS doing rather than for the enum:
 * "the camera UI" covers the gallery's index rebuild, a thumbnail decode and a
 * host's MEDIA_* command, which is honest - they share the class precisely
 * because they are the same priority - where "UI" alone would read as the
 * screen and send a reader to ui.c. */
static const char *holder_class(int user) {
  switch (user) {
    case STORAGE_USER_CAPTURE: return "a capture";
    case STORAGE_USER_UI: return "the camera UI";
    case STORAGE_USER_UPLOAD: return "an upload";
    default: return "nothing";
  }
}

void storage_holder_name(char *out, size_t len) {
  if (out == NULL || len == 0) return;
  char task[configMAX_TASK_NAME_LEN];
  task[0] = '\0';
  portENTER_CRITICAL(&s_wait_mux);
  const int who = s_holder;
  if (s_holder_task != NULL) {
    /* pcTaskGetName() returns a pointer into the TCB's own name array, so this
     * is a copy out of live memory rather than a call that can block. Inside
     * the critical section so the handle cannot be cleared between the test
     * and the read. */
    const char *n = pcTaskGetName(s_holder_task);
    if (n != NULL) strlcpy(task, n, sizeof task);
  }
  portEXIT_CRITICAL(&s_wait_mux);

  if (who < 0) {
    snprintf(out, len, "nothing");
  } else if (task[0] != '\0') {
    snprintf(out, len, "%s (task %s)", holder_class(who), task);
  } else {
    snprintf(out, len, "%s", holder_class(who));
  }
}

void storage_card_busy_message(char *out, size_t len) {
  if (out == NULL || len == 0) return;
  char who[STORAGE_HOLDER_NAME_LEN];
  storage_holder_name(who, sizeof who);
  if (who[0] == '\0' || strcmp(who, "nothing") == 0) {
    /* Free again by the time we asked. The honest answer is that the wait ran
     * out, not a name: whoever takes the lock next did not cause this, and
     * naming them would be a new version of the same lie. */
    snprintf(out, len, "Card was busy and the wait ran out");
  } else {
    snprintf(out, len, "Card is busy: %s holds it", who);
  }
}

esp_err_t storage_init(void) {
  /* Before the mount, so nothing can reach the card without a lock to take.
   * Idempotent: storage_init() is called once, but a retry must not leak a
   * second mutex and split the exclusion in half. */
  if (s_card_lock == NULL) {
    s_card_lock = xSemaphoreCreateMutex();
    if (s_card_lock == NULL) {
      ESP_LOGE(TAG, "no memory for the card lock");
      return ESP_ERR_NO_MEM;
    }
  }

  sdmmc_host_t host = SDMMC_HOST_DEFAULT();
  host.max_freq_khz = SDMMC_FREQ_HIGHSPEED;
  /*
   * Slot 0, explicitly, and this line is load-bearing twice over.
   *
   * `SDMMC_HOST_DEFAULT()` sets `.slot = SDMMC_HOST_SLOT_1`. Nothing assigned
   * it here, so the card has been on slot 1 — which is the slot ESP-Hosted
   * needs for the C6 radio, and the two share one SDMMC controller. Separate
   * pins are not separate driver resources; that is the actual constraint and
   * the reason the coexistence question was never a pin question.
   *
   * Slot 0 is also just correct for a card on these pins. GPIO39-44 are the
   * P4's slot-0 IOMUX pads (soc/esp32p4/.../sdmmc_pins.h) and slot 1 has no
   * IOMUX path at all, so the old configuration routed the card's own
   * dedicated pads through the GPIO matrix to reach the wrong slot.
   *
   * The card mounted either way, which is exactly why this was worth finding
   * before the radio arrived rather than after. See C6_HARDWARE_MAP.md.
   */
  host.slot = BOARD_SD_SLOT;

  sd_pwr_ctrl_ldo_config_t ldo_config = {.ldo_chan_id = BOARD_SD_LDO_CHANNEL};
  sd_pwr_ctrl_handle_t pwr_ctrl = NULL;
  esp_err_t err = sd_pwr_ctrl_new_on_chip_ldo(&ldo_config, &pwr_ctrl);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "SD_POWER_ENABLE failed: %s", esp_err_to_name(err));
    set_error("POWER_ENABLE_FAILED");
    s_power_ok = false;
    return err;
  }
  s_power_ok = true;
  host.pwr_ctrl_handle = pwr_ctrl;
  ESP_LOGI(TAG, "SD_POWER_ENABLE ok (LDO ch%d)", BOARD_SD_LDO_CHANNEL);

  sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
  slot.width = 4;
  slot.clk = BOARD_SD_CLK;
  slot.cmd = BOARD_SD_CMD;
  slot.d0 = BOARD_SD_D0;
  slot.d1 = BOARD_SD_D1;
  slot.d2 = BOARD_SD_D2;
  slot.d3 = BOARD_SD_D3;

  esp_vfs_fat_sdmmc_mount_config_t mount_config = {
      .format_if_mount_failed = false,
      .max_files = STORAGE_MAX_OPEN_FILES,
      .allocation_unit_size = 16 * 1024,
  };

  s_mount_attempts++;
  err = esp_vfs_fat_sdmmc_mount(MOUNT, &host, &slot, &mount_config, &s_card);
  if (err != ESP_OK) {
    // Missing/unreadable card is a reported state, not a boot failure. The
    // registry is NOT marked failed here — an empty slot and a wrong pin
    // look identical from software; that diagnosis is bench work.
    ESP_LOGW(TAG, "SD_MOUNT failed: %s", esp_err_to_name(err));
    klog("SD", "mount failed: %s", esp_err_to_name(err));
    set_error(err == ESP_ERR_TIMEOUT ? "MOUNT_TIMEOUT" : "MOUNT_FAILED");
    s_card = NULL;
    return err;
  }

  klog("SD", "mounted, %llu MB",
       ((uint64_t)s_card->csd.capacity * s_card->csd.sector_size) / (1024 * 1024));
  set_error("");
  // A real mount on this unit proves the whole pin set and the LDO channel.
  char detail[32];
  snprintf(detail, sizeof detail, "mounted %lluMB",
           ((uint64_t)s_card->csd.capacity * s_card->csd.sector_size) / (1024 * 1024));
  hwv_mark_validated(HWV_SD_CLK_GPIO43, detail);
  hwv_mark_validated(HWV_SD_CMD_GPIO44, detail);
  hwv_mark_validated(HWV_SD_D0_GPIO39, detail);
  hwv_mark_validated(HWV_SD_D1_GPIO40, detail);
  hwv_mark_validated(HWV_SD_D2_GPIO41, detail);
  hwv_mark_validated(HWV_SD_D3_GPIO42, detail);
  hwv_mark_validated(HWV_SD_LDO_CH4, detail);
  /*
   * The slot, separately from the pins.
   *
   * The pins above were validated on 2026-08-26 by a real mount — but on slot
   * 1, because SDMMC_HOST_DEFAULT() selects it and nothing here overrode it.
   * They are the same six pins and they are the chip's own SD pads, so slot 0
   * is expected to be a no-op or an improvement. Expected is not observed, and
   * this is a change to an already-validated path, so it gets its own row
   * rather than riding on theirs.
   */
  hwv_mark_validated(HWV_SD_SLOT0, detail);
  return ESP_OK;
}

bool storage_present(void) { return s_card != NULL; }

void storage_get_status(storage_status_t *out) {
  memset(out, 0, sizeof *out);
  out->present = s_card != NULL;
  out->mounted = s_card != NULL;
  out->filesystem = s_card != NULL ? "FAT" : NULL;
  out->mount_attempts = s_mount_attempts;
  out->last_error = s_last_error[0] != '\0' ? s_last_error : NULL;
  out->write_test = s_write_test;
  if (s_card != NULL) {
    uint64_t total = 0, free_bytes = 0;
    if (esp_vfs_fat_info(MOUNT, &total, &free_bytes) == ESP_OK) {
      out->capacity_bytes = total;
      out->free_bytes = free_bytes;
    }
  }
}

const char *storage_selftest_phase_str(storage_selftest_phase_t phase) {
  switch (phase) {
    case STORAGE_ST_POWER_ENABLE_FAILED: return "POWER_ENABLE_FAILED";
    case STORAGE_ST_MOUNT_FAILED: return "MOUNT_FAILED";
    case STORAGE_ST_WRITE_FAILED: return "WRITE_FAILED";
    case STORAGE_ST_READ_FAILED: return "READ_FAILED";
    case STORAGE_ST_VERIFY_FAILED: return "VERIFY_FAILED";
    case STORAGE_ST_REMOVE_FAILED: return "REMOVE_FAILED";
    default: return "OK";
  }
}

#define SELFTEST_BYTES (64 * 1024)
#define SELFTEST_CHUNK 4096

void storage_self_test(storage_selftest_result_t *out) {
  memset(out, 0, sizeof *out);
  int64_t start = esp_timer_get_time();
  const char *path = MOUNT "/KINO/SELFTEST.TMP";

  storage_selftest_phase_t phase = STORAGE_ST_OK;
  do {
    if (!s_power_ok) { phase = STORAGE_ST_POWER_ENABLE_FAILED; break; }
    if (s_card == NULL) { phase = STORAGE_ST_MOUNT_FAILED; break; }

    mkdir(MOUNT "/KINO", 0775); /* may already exist */

    // Deterministic pattern, written and verified chunk-wise.
    static uint8_t block[SELFTEST_CHUNK];
    uint32_t written_state = kdp_crc32_begin();
    FILE *f = fopen(path, "wb");
    if (f == NULL) { phase = STORAGE_ST_WRITE_FAILED; break; }
    bool failed = false;
    for (uint32_t off = 0; off < SELFTEST_BYTES; off += SELFTEST_CHUNK) {
      for (uint32_t i = 0; i < SELFTEST_CHUNK; i++) {
        block[i] = (uint8_t)(((off + i) * 2654435761u) >> 24);
      }
      written_state = kdp_crc32_update(written_state, block, SELFTEST_CHUNK);
      if (fwrite(block, 1, SELFTEST_CHUNK, f) != SELFTEST_CHUNK) { failed = true; break; }
    }
    failed |= fflush(f) != 0;
    failed |= fsync(fileno(f)) != 0;
    failed |= fclose(f) != 0;
    if (failed) { phase = STORAGE_ST_WRITE_FAILED; break; }
    uint32_t written_crc = kdp_crc32_final(written_state);

    uint32_t read_crc = 0, read_bytes = 0;
    if (storage_file_crc32(path, &read_crc, &read_bytes) != ESP_OK) {
      phase = STORAGE_ST_READ_FAILED;
      break;
    }
    if (read_bytes != SELFTEST_BYTES || read_crc != written_crc) {
      phase = STORAGE_ST_VERIFY_FAILED;
      break;
    }
    if (unlink(path) != 0) { phase = STORAGE_ST_REMOVE_FAILED; break; }
  } while (0);

  if (phase != STORAGE_ST_OK && phase != STORAGE_ST_REMOVE_FAILED) unlink(path);

  out->ok = phase == STORAGE_ST_OK;
  out->failed_phase = phase;
  out->bytes_tested = out->ok ? SELFTEST_BYTES : 0;
  out->duration_ms = (uint32_t)((esp_timer_get_time() - start) / 1000);
  s_write_test = out->ok ? "pass" : "fail";
  if (!out->ok) set_error(storage_selftest_phase_str(phase));
  klog("SD", "self-test %s (%s, %lu ms)", out->ok ? "pass" : "FAIL",
       storage_selftest_phase_str(phase), (unsigned long)out->duration_ms);
}

/* ------------------------------------------------------------------ */
/* Throughput benchmark                                                */
/* ------------------------------------------------------------------ */

/* Bounds. A host asking for 4 GB would fill the card it is measuring, and one
 * asking for a 4 MB block would fail the allocation on a part whose internal
 * RAM is already 50% committed. */
#define BENCH_SIZE_KB_MIN 64u
#define BENCH_SIZE_KB_MAX 8192u /* 8 MiB — enough to outlast any write cache */
#define BENCH_BLOCK_KB_MIN 4u
#define BENCH_BLOCK_KB_MAX 128u
#define BENCH_PASSES_MAX 8u
/* Per-chunk latency samples kept for the percentile. 8 MiB at 4 KiB blocks is
 * 2048 chunks per pass; the cap keeps the array at 8 KB of stack-free heap and
 * is reported when it bites rather than silently truncating the distribution. */
#define BENCH_MAX_SAMPLES 2048u

/* Unmistakably temporary, and NOT under CAPTURES: a benchmark file inside a
 * capture directory would be indistinguishable from a frame to every reader of
 * the card, including our own gallery scan. */
#define BENCH_PATH MOUNT "/KINO/BENCH.TMP"

const char *storage_bench_phase_str(storage_bench_phase_t phase) {
  switch (phase) {
    case STORAGE_BENCH_NOT_MOUNTED: return "SD_NOT_MOUNTED";
    case STORAGE_BENCH_BAD_REQUEST: return "BAD_REQUEST";
    case STORAGE_BENCH_OUT_OF_MEMORY: return "OUT_OF_MEMORY";
    case STORAGE_BENCH_OPEN_FAILED: return "OPEN_FAILED";
    case STORAGE_BENCH_WRITE_FAILED: return "WRITE_FAILED";
    case STORAGE_BENCH_FLUSH_FAILED: return "FLUSH_FAILED";
    case STORAGE_BENCH_FSYNC_FAILED: return "FSYNC_FAILED";
    case STORAGE_BENCH_CLOSE_FAILED: return "CLOSE_FAILED";
    case STORAGE_BENCH_READ_FAILED: return "READ_FAILED";
    case STORAGE_BENCH_CRC_MISMATCH: return "CRC_MISMATCH";
    case STORAGE_BENCH_SHORT_READ: return "SHORT_READ";
    case STORAGE_BENCH_CLEANUP_FAILED: return "CLEANUP_FAILED";
    default: return "OK";
  }
}

/* The same deterministic pattern storage_self_test uses, so a byte at a given
 * offset is identical between the two commands and a mismatch localises to the
 * card rather than to the generator. */
static void bench_fill(uint8_t *block, uint32_t offset, uint32_t len) {
  for (uint32_t i = 0; i < len; i++) {
    block[i] = (uint8_t)(((offset + i) * 2654435761u) >> 24);
  }
}

static uint32_t percentile_us(uint32_t *samples, uint32_t n, int pct) {
  if (n == 0) return 0;
  /* Insertion sort. n is capped at BENCH_MAX_SAMPLES and this runs once per
   * pass, so dragging in qsort's comparator indirection buys nothing. */
  for (uint32_t i = 1; i < n; i++) {
    const uint32_t key = samples[i];
    uint32_t j = i;
    while (j > 0 && samples[j - 1] > key) {
      samples[j] = samples[j - 1];
      j--;
    }
    samples[j] = key;
  }
  uint32_t idx = (uint32_t)(((uint64_t)(n - 1) * (uint64_t)pct) / 100u);
  if (idx >= n) idx = n - 1;
  return samples[idx];
}

/** One write+verify+read cycle at one size. Leaves BENCH_PATH in place. */
static storage_bench_phase_t bench_one(uint32_t bytes, uint32_t chunk, uint8_t *block,
                                       uint32_t *samples, storage_bench_pass_t *p) {
  memset(p, 0, sizeof *p);
  p->bytes = bytes;
  p->chunk_bytes = chunk;

  /* ---- write ---- */
  FILE *f = fopen(BENCH_PATH, "wb");
  if (f == NULL) return STORAGE_BENCH_OPEN_FAILED;

  uint32_t crc = kdp_crc32_begin();
  uint32_t worst = 0, best = UINT32_MAX, samples_kept = 0;
  uint64_t sum_us = 0;
  const int64_t w0 = esp_timer_get_time();

  for (uint32_t off = 0; off < bytes; off += chunk) {
    const uint32_t len = (bytes - off) < chunk ? (bytes - off) : chunk;
    bench_fill(block, off, len);
    crc = kdp_crc32_update(crc, block, len);

    /* Timed around the write alone: the pattern generation and the CRC are
     * ours, not the card's, and folding them in would flatter a slow card. */
    const int64_t c0 = esp_timer_get_time();
    const size_t got = fwrite(block, 1, len, f);
    const int64_t c1 = esp_timer_get_time();
    if (got != len) {
      fclose(f);
      return STORAGE_BENCH_WRITE_FAILED;
    }
    const uint32_t us = (uint32_t)(c1 - c0);
    if (us > worst) worst = us;
    if (us < best) best = us;
    sum_us += us;
    if (samples_kept < BENCH_MAX_SAMPLES) samples[samples_kept++] = us;
  }

  /* flush, fsync and close are separate phases because they fail for different
   * reasons and a card that writes but will not fsync is a specific fault. */
  if (fflush(f) != 0) {
    fclose(f);
    return STORAGE_BENCH_FLUSH_FAILED;
  }
  if (fsync(fileno(f)) != 0) {
    fclose(f);
    return STORAGE_BENCH_FSYNC_FAILED;
  }
  /* The clock stops after fsync: bytes sitting in a FAT cache are not bytes on
   * a card, and a throughput figure that excluded the flush would be a
   * measurement of RAM. */
  const int64_t w1 = esp_timer_get_time();
  if (fclose(f) != 0) return STORAGE_BENCH_CLOSE_FAILED;

  p->write_ms = (uint32_t)((w1 - w0) / 1000);
  p->crc_written = kdp_crc32_final(crc);
  p->chunks = (bytes + chunk - 1) / chunk;
  p->worst_write_chunk_us = worst;
  p->best_write_chunk_us = best == UINT32_MAX ? 0 : best;
  p->mean_write_chunk_us = p->chunks ? (uint32_t)(sum_us / p->chunks) : 0;
  p->p95_write_chunk_us = percentile_us(samples, samples_kept, 95);

  /* ---- read back, from a fresh handle ---- */
  f = fopen(BENCH_PATH, "rb");
  if (f == NULL) return STORAGE_BENCH_OPEN_FAILED;

  uint32_t rcrc = kdp_crc32_begin();
  uint32_t read_total = 0;
  const int64_t r0 = esp_timer_get_time();
  for (;;) {
    const size_t got = fread(block, 1, chunk, f);
    if (got == 0) break;
    rcrc = kdp_crc32_update(rcrc, block, got);
    read_total += (uint32_t)got;
  }
  const int64_t r1 = esp_timer_get_time();
  const bool read_err = ferror(f) != 0;
  fclose(f);
  if (read_err) return STORAGE_BENCH_READ_FAILED;

  p->read_ms = (uint32_t)((r1 - r0) / 1000);
  p->crc_read = kdp_crc32_final(rcrc);
  p->crc_match = p->crc_written == p->crc_read;

  if (read_total != bytes) return STORAGE_BENCH_SHORT_READ;
  if (!p->crc_match) return STORAGE_BENCH_CRC_MISMATCH;

  /* Rates only after verification. A throughput number attached to data that
   * did not survive the round trip is worse than no number. */
  if (p->write_ms > 0) p->write_bytes_per_sec = (uint32_t)((uint64_t)bytes * 1000u / p->write_ms);
  if (p->read_ms > 0) p->read_bytes_per_sec = (uint32_t)((uint64_t)bytes * 1000u / p->read_ms);
  return STORAGE_BENCH_OK;
}

void storage_bench(uint32_t size_kb, uint32_t block_kb, uint32_t passes,
                   storage_bench_result_t *out) {
  memset(out, 0, sizeof *out);
  const int64_t t0 = esp_timer_get_time();

  if (s_card == NULL) {
    out->failed_phase = STORAGE_BENCH_NOT_MOUNTED;
    return;
  }

  if (size_kb == 0) size_kb = 1024;  /* 1 MiB: past any plausible write cache */
  if (block_kb == 0) block_kb = 32;  /* a plausible JPEG-ish write unit */
  if (passes == 0) passes = 1;
  if (size_kb < BENCH_SIZE_KB_MIN) size_kb = BENCH_SIZE_KB_MIN;
  if (size_kb > BENCH_SIZE_KB_MAX) size_kb = BENCH_SIZE_KB_MAX;
  if (block_kb < BENCH_BLOCK_KB_MIN) block_kb = BENCH_BLOCK_KB_MIN;
  if (block_kb > BENCH_BLOCK_KB_MAX) block_kb = BENCH_BLOCK_KB_MAX;
  if (passes > BENCH_PASSES_MAX) passes = BENCH_PASSES_MAX;
  out->passes = passes;

  const uint32_t chunk = block_kb * 1024u;
  uint8_t *block = malloc(chunk);
  uint32_t *samples = malloc(BENCH_MAX_SAMPLES * sizeof(uint32_t));
  if (block == NULL || samples == NULL) {
    free(block);
    free(samples);
    out->failed_phase = STORAGE_BENCH_OUT_OF_MEMORY;
    return;
  }

  mkdir(MOUNT "/KINO", 0775); /* may already exist */

  storage_bench_phase_t phase = STORAGE_BENCH_OK;

  /* The 64 KiB run first, matching STORAGE_SELF_TEST's size so the two
   * commands are comparable on the same card. */
  phase = bench_one(BENCH_SIZE_KB_MIN * 1024u, chunk, block, samples, &out->small);

  /* Then the sustained run, repeated. The worst block across ALL passes is
   * kept, because that single stall is what a four-frame burst trips over. */
  if (phase == STORAGE_BENCH_OK) {
    for (uint32_t i = 0; i < passes && phase == STORAGE_BENCH_OK; i++) {
      storage_bench_pass_t p;
      phase = bench_one(size_kb * 1024u, chunk, block, samples, &p);
      if (phase != STORAGE_BENCH_OK) break;
      if (i == 0) {
        out->sustained = p;
      } else {
        /* Aggregate across passes: slowest of the worsts, mean of the means,
         * and the slowest observed rate rather than the best - a benchmark
         * should report the number the product will actually meet. */
        if (p.worst_write_chunk_us > out->sustained.worst_write_chunk_us) {
          out->sustained.worst_write_chunk_us = p.worst_write_chunk_us;
        }
        if (p.best_write_chunk_us < out->sustained.best_write_chunk_us) {
          out->sustained.best_write_chunk_us = p.best_write_chunk_us;
        }
        if (p.p95_write_chunk_us > out->sustained.p95_write_chunk_us) {
          out->sustained.p95_write_chunk_us = p.p95_write_chunk_us;
        }
        /* Slowest wins, except that a zero cannot be beaten by anything.
         * bench_one leaves the rate at 0 when a pass measured under a
         * millisecond, and once a zero is in the accumulator no later pass can
         * ever replace it - the run then reports 0 KB/s for a card that was
         * merely fast. So a zero baseline is seeded by the first pass that
         * measured a rate at all, and only then does the minimum apply. */
        if (out->sustained.write_bytes_per_sec == 0 ||
            (p.write_bytes_per_sec != 0 &&
             p.write_bytes_per_sec < out->sustained.write_bytes_per_sec)) {
          out->sustained.write_bytes_per_sec = p.write_bytes_per_sec;
          out->sustained.write_ms = p.write_ms;
        }
        if (out->sustained.read_bytes_per_sec == 0 ||
            (p.read_bytes_per_sec != 0 &&
             p.read_bytes_per_sec < out->sustained.read_bytes_per_sec)) {
          out->sustained.read_bytes_per_sec = p.read_bytes_per_sec;
          out->sustained.read_ms = p.read_ms;
        }
        out->sustained.mean_write_chunk_us =
            (out->sustained.mean_write_chunk_us + p.mean_write_chunk_us) / 2u;
      }
    }
  }

  free(block);
  free(samples);

  /* Cleanup always attempted, even on a failed run: a benchmark that leaves
   * megabytes behind after every failure fills the card it is measuring. */
  out->cleanup_ok = unlink(BENCH_PATH) == 0;
  if (phase == STORAGE_BENCH_OK && !out->cleanup_ok) phase = STORAGE_BENCH_CLEANUP_FAILED;

  out->failed_phase = phase;
  out->ok = phase == STORAGE_BENCH_OK;
  out->total_ms = (uint32_t)((esp_timer_get_time() - t0) / 1000);

  if (!out->ok) set_error(storage_bench_phase_str(phase));
  klog("SD", "bench %s (%s): %lu KB/s write, %lu KB/s read, worst block %lu us, %lu ms",
       out->ok ? "ok" : "FAIL", storage_bench_phase_str(phase),
       (unsigned long)(out->sustained.write_bytes_per_sec / 1024u),
       (unsigned long)(out->sustained.read_bytes_per_sec / 1024u),
       (unsigned long)out->sustained.worst_write_chunk_us, (unsigned long)out->total_ms);
}

/*
 * Persistent capture counter — ids are never reused after a reboot.
 *
 * Every NVS return is checked, and the reason is the failure mode: this
 * ignored all four of them and returned the untouched `count`, so a namespace
 * that would not open, or a partition with no free pages, gave 0 to every
 * capture and the whole card filled with folders called CAP_000000. Duplicate
 * ids are not a cosmetic fault - they are what the host sorts and de-duplicates
 * captures by.
 *
 * ESP_ERR_NVS_NOT_FOUND from the get is not a failure: it is the first capture
 * on a fresh device, and the count starts at 1.
 */
static bool next_capture_number(uint32_t *out) {
  nvs_handle_t nvs;
  uint32_t count = 0;
  if (nvs_open("kino", NVS_READWRITE, &nvs) != ESP_OK) return false;
  esp_err_t err = nvs_get_u32(nvs, "capture", &count);
  if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
    nvs_close(nvs);
    return false;
  }
  count++;
  err = nvs_set_u32(nvs, "capture", count);
  if (err == ESP_OK) err = nvs_commit(nvs);
  nvs_close(nvs);
  if (err != ESP_OK) return false;
  *out = count;
  return true;
}

esp_err_t storage_capture_open(storage_capture_t *c, const char *capture_uuid,
                               const char *id_prefix) {
  if (s_card == NULL) return ESP_ERR_NOT_FOUND;
  memset(c, 0, sizeof *c);
  c->open_cam = -1;

  const char *prefix = id_prefix != NULL ? id_prefix : "CAP";
  const char *uuid = capture_uuid != NULL ? capture_uuid : "000000";
  uint32_t seq = 0;
  if (next_capture_number(&seq)) {
    snprintf(c->id, sizeof c->id, "%s_%06lu", prefix, (unsigned long)seq);
  } else {
    /* NVS would not give a number, so the id comes from the capture UUID
     * instead: six hex digits of 122 random bits, which keeps ids unique on the
     * card when the sequence cannot. What is lost is the ordering, and the "x"
     * says so at a glance rather than leaving a mystery in a folder listing.
     * Ordering is recoverable from capturedAtMs in META.JSON; a colliding id
     * is not recoverable at all. */
    ESP_LOGE(TAG, "capture counter unavailable in NVS; id falls back to the UUID");
    klog("SD", "capture id from UUID: the NVS sequence is unreadable");
    snprintf(c->id, sizeof c->id, "%s_x%.6s", prefix, uuid);
  }
  snprintf(c->dir, sizeof c->dir, "%s/KINO/CAPTURES/%s", MOUNT, uuid);

  mkdir(MOUNT "/KINO", 0775);
  mkdir(MOUNT "/KINO/CAPTURES", 0775);
  if (mkdir(c->dir, 0775) != 0) {
    ESP_LOGE(TAG, "mkdir %s failed", c->dir);
    set_error("SD_WRITE_FAILED");
    return ESP_FAIL;
  }
  return ESP_OK;
}

esp_err_t storage_capture_frame_begin(storage_capture_t *c, int cam) {
  if (cam < 0 || cam >= STORAGE_CAPTURE_FRAMES) return ESP_ERR_INVALID_ARG;
  if (c->jpg != NULL) return ESP_ERR_INVALID_STATE;

  /* Kept on the capture, not on this stack: the path is what a failed write
   * needs in order to take the truncated file with it, and by then this
   * function has long returned. */
  snprintf(c->open_path, sizeof c->open_path, "%s/C%d.JPG", c->dir, cam + 1);
  c->jpg = fopen(c->open_path, "wb");
  if (c->jpg == NULL) {
    c->open_path[0] = '\0';
    set_error("SD_WRITE_FAILED");
    return ESP_FAIL;
  }
  c->open_cam = cam;
  return ESP_OK;
}

/** Forget the frame that was open, and delete its file if there is one. */
static void frame_discard(storage_capture_t *c) {
  if (c->open_path[0] != '\0') unlink(c->open_path);
  c->open_path[0] = '\0';
  c->open_cam = -1;
}

esp_err_t storage_capture_frame_abandon(storage_capture_t *c) {
  if (c->jpg == NULL) return ESP_ERR_INVALID_STATE;
  fclose(c->jpg);
  c->jpg = NULL;
  frame_discard(c);
  return ESP_OK;
}

esp_err_t storage_capture_frame_end(storage_capture_t *c) {
  if (c->jpg == NULL) return ESP_ERR_INVALID_STATE;
  /* fflush then fclose, and deliberately no fsync between them.
   *
   * esp_vfs_fat's close is f_close(), and FatFs f_close() begins with
   * f_sync(): the file's dirty sector, its directory entry, the FAT chain and
   * the CTRL_SYNC to the card all go out there regardless. An explicit
   * fsync() one line earlier is a second, identical f_sync — 10-30 ms of
   * serialised card time per frame, 40-120 ms across four.
   *
   * That time is not just slow. SDMMC DMA out of PSRAM does its cache
   * writeback in a critical section with interrupts off, while the other
   * cameras are still pushing bytes into a 128-byte UART RX FIFO with no flow
   * control — 1.39 ms of slack at 921600 baud. A card transaction that buys
   * nothing is a chance to destroy another camera's in-flight frame.
   *
   * The guarantee is unchanged: when this returns ESP_OK the frame is on the
   * card, directory entry and all, exactly as it was with the extra fsync. */
  int failed = fflush(c->jpg) != 0;
  failed |= fclose(c->jpg) != 0;
  c->jpg = NULL;
  if (failed) {
    /* The file on the card is whatever fwrite managed, which is not a JPEG.
     * It leaves with the failure: the written bit stays clear, so META.JSON
     * will not list this frame, and a folder with an unlisted C<n>.JPG in it
     * is exactly the orphan the delete and sweep paths then have to argue
     * about. */
    set_error("SD_WRITE_FAILED");
    frame_discard(c);
    return ESP_FAIL;
  }
  if (c->open_cam >= 0) c->written |= (uint8_t)(1u << c->open_cam);
  c->open_cam = -1;
  c->open_path[0] = '\0';
  return ESP_OK;
}

esp_err_t storage_capture_begin(storage_capture_t *c, const char *capture_uuid) {
  esp_err_t err = storage_capture_open(c, capture_uuid, "TC");
  if (err != ESP_OK) return err;
  return storage_capture_frame_begin(c, 0);
}

esp_err_t storage_capture_append(storage_capture_t *c, const uint8_t *data, size_t len) {
  if (c->jpg == NULL) return ESP_ERR_INVALID_STATE;
  return fwrite(data, 1, len, c->jpg) == len ? ESP_OK : ESP_FAIL;
}

esp_err_t storage_capture_commit(storage_capture_t *c, const char *meta_json) {
  /* A multi-frame capture has already closed its frames one at a time; the
   * single-frame bench path still has one open here. Both arrive with the
   * bytes on the card, so committing is only ever about META.JSON.
   *
   * Every frame was committed by its own fclose() (see frame_end), so the one
   * fsync below is the last card sync a capture needs: after it returns
   * ESP_OK, all four JPEGs and the metadata survive a power cut. */
  if (c->jpg != NULL && storage_capture_frame_end(c) != ESP_OK) return ESP_FAIL;
  if (c->written == 0) return ESP_ERR_INVALID_STATE;

  char path[80];
  snprintf(path, sizeof path, "%s/META.JSON", c->dir);
  FILE *meta = fopen(path, "wb");
  if (meta == NULL) return ESP_FAIL;
  size_t len = strlen(meta_json);
  int failed = fwrite(meta_json, 1, len, meta) != len;
  failed |= fflush(meta) != 0;
  failed |= fsync(fileno(meta)) != 0;
  failed |= fclose(meta) != 0;
  if (failed) set_error("SD_WRITE_FAILED");
  return failed ? ESP_FAIL : ESP_OK;
}

void storage_capture_abort(storage_capture_t *c) {
  if (c->jpg != NULL) {
    fclose(c->jpg);
    c->jpg = NULL;
  }
  /* No separate name list here: the whole folder goes below, and one list of
   * a capture's files is the only way the two paths can agree. */
  c->open_cam = -1;
  c->open_path[0] = '\0';
  c->written = 0;
  storage_capture_delete(c->dir);
}

esp_err_t storage_file_crc32(const char *path, uint32_t *out_crc, uint32_t *out_bytes) {
  /* One buffer per call, not one static shared by every caller.
   *
   * This was `static uint8_t buf[SELFTEST_CHUNK]`, which is only safe while
   * exactly one task is ever inside this function: with a shared buffer, a
   * second caller's fread lands between the first's fread and its
   * kdp_crc32_update, and the first hashes the second's bytes. That reads as
   * an intermittent CRC mismatch on a card that kept every byte - a false
   * alarm that discards a good file, or worse, a false pass.
   *
   * The capture path no longer calls this at all; the read-back was removed
   * from the shutter on 2026-08-29. The remaining callers are the storage
   * self-test and kdp_server's bench read-back, which do not currently run
   * concurrently - so this is now defence against a future second caller
   * rather than a fix for a live race.
   *
   * Heap rather than stack because SELFTEST_CHUNK is 4 KB and the callers do
   * not have that to spare. PSRAM is fine: fread copies through FATFS's own
   * sector cache and the CRC loop reads sequentially. */
  uint8_t *buf = heap_caps_malloc(SELFTEST_CHUNK, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (buf == NULL) buf = malloc(SELFTEST_CHUNK);
  if (buf == NULL) return ESP_ERR_NO_MEM;
  FILE *f = fopen(path, "rb");
  if (f == NULL) {
    free(buf);
    return ESP_ERR_NOT_FOUND;
  }
  uint32_t state = kdp_crc32_begin();
  uint32_t total = 0;
  size_t n;
  while ((n = fread(buf, 1, SELFTEST_CHUNK, f)) > 0) {
    state = kdp_crc32_update(state, buf, n);
    total += (uint32_t)n;
  }
  int err = ferror(f);
  fclose(f);
  free(buf);
  if (err) return ESP_FAIL;
  *out_crc = kdp_crc32_final(state);
  if (out_bytes != NULL) *out_bytes = total;
  return ESP_OK;
}

/* ------------------------------------------------------------------ */
/* Pre-capture space reservation                                       */
/* ------------------------------------------------------------------ */


uint64_t storage_capture_reserve_bytes(int frames, uint32_t width, uint32_t height) {
  return pure_capture_reserve_bytes(frames, width, height);
}
bool storage_capture_space_ok(int frames, uint32_t width, uint32_t height, uint64_t *need,
                              uint64_t *avail) {
  const uint64_t want = storage_capture_reserve_bytes(frames, width, height);
  if (need != NULL) *need = want;

  uint64_t total = 0, free_bytes = 0;
  if (s_card == NULL || esp_vfs_fat_info(MOUNT, &total, &free_bytes) != ESP_OK) {
    if (avail != NULL) *avail = 0;
    return false;
  }
  if (avail != NULL) *avail = free_bytes;
  return free_bytes >= want;
}

/* ------------------------------------------------------------------ */
/* Interrupted-capture recovery                                        */
/* ------------------------------------------------------------------ */

bool storage_is_capture_dirname(const char *name) { return pure_is_capture_dirname(name); }
/* Bounded so one bad card cannot stall a boot or escalate into a mass
 * deletion. A card with more orphans than this has a bigger problem than the
 * sweep can fix, and the remainder is reported rather than removed. */
#define SWEEP_MAX_DIRS 512
#define SWEEP_MAX_REMOVALS 32

/*
 * The sweep's wall-clock budget, and why it needs one.
 *
 * This runs on the main task before usb_link_init(), so every millisecond it
 * spends is a millisecond the board answers no host and shows no UI. The work
 * is one stat() per capture directory across FatFs and SDMMC, and it was
 * measured at boot on a card holding 520 captures: SWEEP_MAX_DIRS of them, at
 * tens of milliseconds each on a slow card, is the recorded 60 s boot.
 *
 * 3 s, and the rest is left for the next boot. An orphan is not urgent - it
 * costs a few hundred kilobytes and nothing reads it - while a camera that
 * appears dead for a minute after power-on is the fault everyone reports. The
 * remainder is picked up on the next boot because readdir() returns entries in
 * directory order and the completed ones are skipped after one stat() each, so
 * successive boots reach further in.
 */
#define SWEEP_BUDGET_MS 3000

void storage_sweep_orphans(storage_sweep_t *out) {
  storage_sweep_t s = {0};
  if (out != NULL) *out = s;
  if (s_card == NULL) return;

  DIR *d = opendir(MOUNT "/KINO/CAPTURES");
  if (d == NULL) return; /* no captures directory yet is not a fault */

  const int64_t deadline = esp_timer_get_time() + (int64_t)SWEEP_BUDGET_MS * 1000;
  int looked_at = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (e->d_name[0] == '.') continue;
    if (!storage_is_capture_dirname(e->d_name)) continue;
    /* Both bounds counted, not just hit: a sweep that stopped early used to
     * look exactly like a sweep that found nothing more, so the one card that
     * needed attention was the one the log said least about. */
    if (looked_at >= SWEEP_MAX_DIRS || esp_timer_get_time() >= deadline) {
      s.skipped++;
      continue;
    }
    looked_at++;
    s.scanned++;

    /* Copy into a bounded buffer before building paths. storage_is_capture_dirname
     * has already proved this is exactly 36 characters, but d_name is declared
     * as up to NAME_MAX and the compiler reasons from the declaration - so the
     * bound has to be visible in the types, not just true. */
    char name[37];
    memcpy(name, e->d_name, 36);
    name[36] = '\0';

    char dir[64];
    snprintf(dir, sizeof dir, "%s/KINO/CAPTURES/%s", MOUNT, name);

    char meta[80];
    snprintf(meta, sizeof meta, "%s/KINO/CAPTURES/%s/META.JSON", MOUNT, name);
    struct stat st;
    if (stat(meta, &st) == 0) {
      s.complete++;
      continue; /* a real capture; never touched */
    }

    if (s.removed >= SWEEP_MAX_REMOVALS) {
      s.preserved++;
      continue;
    }

    /* storage_capture_delete unlinks only the names in STORAGE_CAPTURE_FILES
     * and STORAGE_CAPTURE_INTERNAL_FILES and then rmdir()s, which fails on a
     * directory holding anything else. So this either takes an orphan that is
     * entirely ours, or leaves it intact. Since 0.4.14 the upload record is in
     * the second list, so the husks left by a delete of a queued capture are
     * finally swept here instead of being preserved for ever. */
    storage_capture_delete(dir);
    if (stat(dir, &st) == 0) {
      s.preserved++;
      ESP_LOGW(TAG, "orphan %s holds unexpected files; kept for inspection", name);
      klog("SD", "orphan capture kept (unexpected contents): %.8s", name);
    } else {
      s.removed++;
      ESP_LOGI(TAG, "removed interrupted capture %s", name);
      klog("SD", "removed interrupted capture %.8s", name);
    }
  }
  closedir(d);

  if (s.scanned > 0) {
    ESP_LOGI(TAG, "capture sweep: %d scanned, %d complete, %d removed, %d preserved, %d left",
             s.scanned, s.complete, s.removed, s.preserved, s.skipped);
  }
  if (s.removed > 0 || s.preserved > 0) {
    klog("SD", "capture sweep: %d removed, %d preserved of %d", s.removed, s.preserved,
         s.scanned);
  }
  if (s.skipped > 0) {
    /* Its own line, and in the ring as well as the console: this is the state
     * where the card holds more than one boot can look at, and it is invisible
     * from the counts above. Nothing is wrong with the captures - the next boot
     * carries on from here. */
    ESP_LOGW(TAG, "capture sweep stopped early: %d directories not examined (%d ms budget, "
                  "%d dir cap)", s.skipped, SWEEP_BUDGET_MS, SWEEP_MAX_DIRS);
    klog("SD", "capture sweep left %d dirs for the next boot", s.skipped);
  }
  if (out != NULL) *out = s;
}

/*
 * Every file a capture directory can hold, in one place.
 *
 * This used to be five names built inline here - C1..C4 and META.JSON - while
 * capture_fire() wrote THUMB.JPG on every success. So the rmdir below always
 * refused the still-occupied directory, the delete silently did nothing, and
 * the capture reappeared on the next gallery scan. Five names against six
 * files is the kind of drift a list beats a loop at, which is why kdp_server's
 * media allow-list reads this same array rather than keeping its own.
 */
const char *const STORAGE_CAPTURE_FILES[STORAGE_CAPTURE_FILE_COUNT] = {
    "C1.JPG", "C2.JPG", "C3.JPG", "C4.JPG", "META.JSON", "THUMB.JPG",
};

/*
 * The upload record and its temp file, the seventh and eighth things a capture
 * folder can hold.
 *
 * Missing from the delete path until 0.4.14, and the failure is the one the
 * comment above already describes happening with THUMB.JPG: a capture that had
 * been queued for a Roll kept UPLOAD.JSON, the rmdir below refused the folder,
 * and the husk stayed on the card for ever. Measured on the bench card
 * (KD4-D121BC, 2026-08-31): 275 photographs deleted over KDP freed their
 * JPEGs but left 275 folders, and MEDIA_LIST - which counts directories - went
 * on reporting 529 captures on a card holding 254. The orphan sweep logs
 * "orphan capture kept (unexpected contents)" for each one, which is this bug
 * naming itself once per boot.
 *
 * Deleting the record with the photograph is also the right answer on its own
 * terms: the file it would upload no longer exists, and rq_reconcile_action
 * already ignores a folder with no META.JSON.
 */
const char *const STORAGE_CAPTURE_INTERNAL_FILES[STORAGE_CAPTURE_INTERNAL_FILE_COUNT] = {
    UPLOAD_STORE_RECORD,
    UPLOAD_STORE_TEMP,
};

void storage_capture_delete(const char *dir) {
  char path[80];
  for (int i = 0; i < STORAGE_CAPTURE_FILE_COUNT; i++) {
    snprintf(path, sizeof path, "%s/%s", dir, STORAGE_CAPTURE_FILES[i]);
    unlink(path);
  }
  for (int i = 0; i < STORAGE_CAPTURE_INTERNAL_FILE_COUNT; i++) {
    snprintf(path, sizeof path, "%s/%s", dir, STORAGE_CAPTURE_INTERNAL_FILES[i]);
    unlink(path);
  }
  /* rmdir only removes an empty directory, so anything unexpected left in the
   * folder keeps the folder - deleting a capture must never take a file this
   * firmware did not put there. */
  rmdir(dir);
}
