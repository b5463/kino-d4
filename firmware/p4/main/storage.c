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
