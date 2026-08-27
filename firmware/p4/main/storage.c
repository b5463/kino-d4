#include "storage.h"

#include <dirent.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "board_d4v1.h"
#include "driver/sdmmc_host.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_vfs_fat.h"
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
  strncpy(s_last_error, code, sizeof s_last_error - 1);
  s_last_error[sizeof s_last_error - 1] = '\0';
}

uint32_t storage_sd_errors(void) { return s_sd_errors; }

esp_err_t storage_init(void) {
  sdmmc_host_t host = SDMMC_HOST_DEFAULT();
  host.max_freq_khz = SDMMC_FREQ_HIGHSPEED;

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
      .max_files = 4,
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
        if (p.write_bytes_per_sec < out->sustained.write_bytes_per_sec) {
          out->sustained.write_bytes_per_sec = p.write_bytes_per_sec;
          out->sustained.write_ms = p.write_ms;
        }
        if (p.read_bytes_per_sec < out->sustained.read_bytes_per_sec) {
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

// Persistent capture counter — ids are never reused after a reboot.
static uint32_t next_capture_number(void) {
  nvs_handle_t nvs;
  uint32_t count = 0;
  if (nvs_open("kino", NVS_READWRITE, &nvs) == ESP_OK) {
    nvs_get_u32(nvs, "capture", &count);
    count++;
    nvs_set_u32(nvs, "capture", count);
    nvs_commit(nvs);
    nvs_close(nvs);
  }
  return count;
}

esp_err_t storage_capture_open(storage_capture_t *c, const char *capture_uuid,
                               const char *id_prefix) {
  if (s_card == NULL) return ESP_ERR_NOT_FOUND;
  memset(c, 0, sizeof *c);
  c->open_cam = -1;

  snprintf(c->id, sizeof c->id, "%s_%06lu", id_prefix != NULL ? id_prefix : "CAP",
           (unsigned long)next_capture_number());
  snprintf(c->dir, sizeof c->dir, "%s/KINO/CAPTURES/%s", MOUNT, capture_uuid);

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

  char path[80];
  snprintf(path, sizeof path, "%s/C%d.JPG", c->dir, cam + 1);
  c->jpg = fopen(path, "wb");
  if (c->jpg == NULL) {
    set_error("SD_WRITE_FAILED");
    return ESP_FAIL;
  }
  c->open_cam = cam;
  return ESP_OK;
}

esp_err_t storage_capture_frame_end(storage_capture_t *c) {
  if (c->jpg == NULL) return ESP_ERR_INVALID_STATE;
  int failed = fflush(c->jpg) != 0;
  failed |= fsync(fileno(c->jpg)) != 0;
  failed |= fclose(c->jpg) != 0;
  c->jpg = NULL;
  if (failed) {
    set_error("SD_WRITE_FAILED");
    c->open_cam = -1;
    return ESP_FAIL;
  }
  if (c->open_cam >= 0) c->written |= (uint8_t)(1u << c->open_cam);
  c->open_cam = -1;
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
   * bytes on the card, so committing is only ever about META.JSON. */
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
  c->open_cam = -1;
  c->written = 0;
  storage_capture_delete(c->dir);
}

esp_err_t storage_file_crc32(const char *path, uint32_t *out_crc, uint32_t *out_bytes) {
  FILE *f = fopen(path, "rb");
  if (f == NULL) return ESP_ERR_NOT_FOUND;
  static uint8_t buf[SELFTEST_CHUNK];
  uint32_t state = kdp_crc32_begin();
  uint32_t total = 0;
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) {
    state = kdp_crc32_update(state, buf, n);
    total += (uint32_t)n;
  }
  int err = ferror(f);
  fclose(f);
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

void storage_sweep_orphans(storage_sweep_t *out) {
  storage_sweep_t s = {0};
  if (out != NULL) *out = s;
  if (s_card == NULL) return;

  DIR *d = opendir(MOUNT "/KINO/CAPTURES");
  if (d == NULL) return; /* no captures directory yet is not a fault */

  int looked_at = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL && looked_at < SWEEP_MAX_DIRS) {
    if (e->d_name[0] == '.') continue;
    if (!storage_is_capture_dirname(e->d_name)) continue;
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

    /* storage_capture_delete unlinks only the six names a capture can hold and
     * then rmdir()s, which fails on a directory holding anything else. So this
     * either takes an orphan that is entirely ours, or leaves it intact. */
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
    ESP_LOGI(TAG, "capture sweep: %d scanned, %d complete, %d removed, %d preserved", s.scanned,
             s.complete, s.removed, s.preserved);
  }
  if (s.removed > 0 || s.preserved > 0) {
    klog("SD", "capture sweep: %d removed, %d preserved of %d", s.removed, s.preserved,
         s.scanned);
  }
  if (out != NULL) *out = s;
}

void storage_capture_delete(const char *dir) {
  char path[80];
  for (int cam = 0; cam < STORAGE_CAPTURE_FRAMES; cam++) {
    snprintf(path, sizeof path, "%s/C%d.JPG", dir, cam + 1);
    unlink(path);
  }
  snprintf(path, sizeof path, "%s/META.JSON", dir);
  unlink(path);
  /* rmdir only removes an empty directory, so anything unexpected left in the
   * folder keeps the folder - deleting a capture must never take a file this
   * function did not put there. */
  rmdir(dir);
}
