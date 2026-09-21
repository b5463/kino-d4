#include "fw_update.h"

#include <string.h>

#include "cam_link.h"
#include "capture.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "klog.h"
#include "mbedtls/sha256.h"
#include "node_link/node_link.h"
#include "power.h"

static const char *TAG_P4 = "FW";

/* The image size the contract allows; both OTA slots are 3 MB, checked
 * against the real slot at BEGIN as well. */
#define FW_MAX_IMAGE (4u * 1024u * 1024u)
/* What FW_BEGIN advertises to the host. The KDP payload cap is 16 KB and the
 * chunk carries an 8-byte header; 8 KB is what Studio's updater clamps to. */
#define FW_HOST_CHUNK 8192u
/* A node that does not answer HELLO this long after FW_END gets the camera
 * bank cycled, which is what makes its bootloader roll back an image that
 * never reached a healthy state. After the second wait it is an error. */
#define FW_NODE_BACK_MS 40000
#define FW_NODE_GIVEUP_MS 95000
/* The reply to FW_END has to leave the device before the device restarts. */
#define FW_P4_RESTART_DELAY_US 800000

typedef struct {
  const char *state;
  char error[80];
  char pending_version[24];
  int64_t end_us;     /* when FW_END finished, for the node watch */
  bool bank_cycled;   /* the one power cycle a lost node is allowed */
} target_t;

static struct {
  SemaphoreHandle_t lock;
  bool open;
  fw_target_t target;
  uint32_t id;
  uint32_t size;
  uint32_t received;
  uint8_t want[32];
  char version[24];
  mbedtls_sha256_context sha;
  /* P4 only */
  esp_ota_handle_t handle;
  const esp_partition_t *part;
  esp_timer_handle_t restart;
} s;

static target_t s_t[FW_T_COUNT];
static uint32_t s_next_id = 100;

static const char *const NAMES[FW_T_COUNT] = {"p4", "cam1", "cam2", "cam3", "cam4"};

static void ensure_lock(void) {
  if (s.lock == NULL) {
    s.lock = xSemaphoreCreateMutex();
    for (int i = 0; i < FW_T_COUNT; i++) {
      if (s_t[i].state == NULL) s_t[i].state = "idle";
    }
  }
}

bool fw_update_target_parse(const char *str, fw_target_t *out) {
  if (str == NULL || out == NULL) return false;
  for (int i = 0; i < FW_T_COUNT; i++) {
    if (strcmp(str, NAMES[i]) == 0) {
      *out = (fw_target_t)i;
      return true;
    }
  }
  return false;
}

const char *fw_update_target_name(fw_target_t t) {
  return (t >= 0 && t < FW_T_COUNT) ? NAMES[t] : "?";
}

static void refuse(fw_refusal_t *why, const char *code, const char *message) {
  if (why == NULL) return;
  why->code = code;
  why->message = message;
}

static void set_error(fw_target_t t, const char *message) {
  s_t[t].state = "error";
  strlcpy(s_t[t].error, message, sizeof s_t[t].error);
  klog(TAG_P4, "%s update failed: %s", NAMES[t], message);
}

static bool hex_to_bytes(const char *hex, uint8_t *out, size_t n) {
  if (hex == NULL || strlen(hex) != n * 2) return false;
  for (size_t i = 0; i < n; i++) {
    unsigned v = 0;
    for (int k = 0; k < 2; k++) {
      const char c = hex[i * 2 + k];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
      else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
      else return false;
    }
    out[i] = (uint8_t)v;
  }
  return true;
}

/* Close the session without applying anything. Caller holds the lock. */
static void drop_session(void) {
  if (!s.open) return;
  if (s.target == FW_T_P4) {
    esp_ota_abort(s.handle);
  } else {
    camlink_fw_abort_ch((int)s.target - 1);
  }
  mbedtls_sha256_free(&s.sha);
  s.open = false;
}

esp_err_t fw_update_begin(fw_target_t t, uint32_t size, const char *sha256_hex,
                          const char *version, uint32_t *session_id, uint32_t *chunk_size,
                          fw_refusal_t *why) {
  ensure_lock();
  if (t < 0 || t >= FW_T_COUNT) {
    refuse(why, "INVALID_ARGUMENT", "target must be p4 or cam1..cam4");
    return ESP_ERR_INVALID_ARG;
  }
  uint8_t want[32];
  if (!hex_to_bytes(sha256_hex, want, sizeof want)) {
    refuse(why, "INVALID_ARGUMENT", "sha256 must be 64 hex characters");
    return ESP_ERR_INVALID_ARG;
  }
  if (size == 0 || size > FW_MAX_IMAGE) {
    refuse(why, "BAD_SIZE", "Image size must be 1 byte to 4 MB");
    return ESP_ERR_INVALID_SIZE;
  }
  xSemaphoreTake(s.lock, portMAX_DELAY);
  if (s.open) {
    xSemaphoreGive(s.lock);
    refuse(why, "BUSY", "An update session is already open");
    return ESP_ERR_INVALID_STATE;
  }
  if (capture_busy()) {
    xSemaphoreGive(s.lock);
    refuse(why, "INVALID_STATE", "A capture is running");
    return ESP_ERR_INVALID_STATE;
  }

  esp_err_t err = ESP_OK;
  if (t == FW_T_P4) {
    const esp_partition_t *next = esp_ota_get_next_update_partition(NULL);
    if (next == NULL) {
      xSemaphoreGive(s.lock);
      refuse(why, "HARDWARE_ERROR", "No OTA slot to write: single-app partition table");
      return ESP_ERR_NOT_SUPPORTED;
    }
    if (size > next->size) {
      xSemaphoreGive(s.lock);
      refuse(why, "BAD_SIZE", "Image is larger than the OTA slot");
      return ESP_ERR_INVALID_SIZE;
    }
    /* Erases the slot: seconds on 3 MB, which is why the contract gives BEGIN
     * an 8 s timeout. */
    err = esp_ota_begin(next, size, &s.handle);
    if (err != ESP_OK) {
      xSemaphoreGive(s.lock);
      klog(TAG_P4, "esp_ota_begin: %s", esp_err_to_name(err));
      refuse(why, "FLASH_WRITE", "Could not open the OTA slot");
      return err;
    }
    s.part = next;
  } else {
    char code[24] = "";
    uint32_t node_chunk = 0;
    err = camlink_fw_begin_ch((int)t - 1, size, sha256_hex, version != NULL ? version : "",
                              &node_chunk, code, sizeof code);
    if (err != ESP_OK) {
      xSemaphoreGive(s.lock);
      if (err == ESP_ERR_INVALID_RESPONSE && code[0] != '\0') {
        /* The node's own reason, in its own words: BAD_SIZE, FLASH_WRITE,
         * HARDWARE_ERROR for a node still on a single-app table. */
        static char msg[64];
        snprintf(msg, sizeof msg, "%s refused the update: %s", NAMES[t], code);
        refuse(why, strcmp(code, "HARDWARE_ERROR") == 0 ? "HARDWARE_ERROR" : "FLASH_WRITE", msg);
      } else {
        refuse(why, "CAM_UNREACHABLE", "The camera node did not answer");
      }
      return err;
    }
  }

  s.open = true;
  s.target = t;
  s.id = s_next_id++;
  s.size = size;
  s.received = 0;
  memcpy(s.want, want, sizeof want);
  strlcpy(s.version, version != NULL ? version : "", sizeof s.version);
  mbedtls_sha256_init(&s.sha);
  mbedtls_sha256_starts(&s.sha, 0);
  s_t[t].state = "receiving";
  s_t[t].error[0] = '\0';
  s_t[t].bank_cycled = false;
  strlcpy(s_t[t].pending_version, s.version, sizeof s_t[t].pending_version);
  xSemaphoreGive(s.lock);

  klog(TAG_P4, "%s update begins: %lu B, version %s, session %lu", NAMES[t], (unsigned long)size,
       s.version[0] ? s.version : "?", (unsigned long)s.id);
  if (session_id != NULL) *session_id = s.id;
  if (chunk_size != NULL) *chunk_size = FW_HOST_CHUNK;
  return ESP_OK;
}

esp_err_t fw_update_chunk(uint32_t session_id, uint32_t offset, const uint8_t *data, size_t len,
                          fw_refusal_t *why) {
  ensure_lock();
  xSemaphoreTake(s.lock, portMAX_DELAY);
  if (!s.open) {
    xSemaphoreGive(s.lock);
    refuse(why, "NO_SESSION", "No update session is open");
    return ESP_ERR_INVALID_STATE;
  }
  if (session_id != s.id) {
    xSemaphoreGive(s.lock);
    refuse(why, "BAD_SESSION", "That session is not the open one");
    return ESP_ERR_INVALID_ARG;
  }
  if (offset != s.received) {
    xSemaphoreGive(s.lock);
    refuse(why, "BAD_OFFSET", "Chunks must arrive in order");
    return ESP_ERR_INVALID_ARG;
  }
  if (len == 0 || s.received + len > s.size) {
    xSemaphoreGive(s.lock);
    refuse(why, "BAD_SIZE", "Chunk runs past the image size named at BEGIN");
    return ESP_ERR_INVALID_SIZE;
  }

  esp_err_t err = ESP_OK;
  if (s.target == FW_T_P4) {
    err = esp_ota_write(s.handle, data, len);
    if (err != ESP_OK) {
      klog(TAG_P4, "esp_ota_write at %lu: %s", (unsigned long)offset, esp_err_to_name(err));
      set_error(s.target, "Flash write failed");
      drop_session();
      xSemaphoreGive(s.lock);
      refuse(why, "FLASH_WRITE", "Flash write failed");
      return err;
    }
  } else {
    /* The node link carries smaller frames than the host link: a host chunk
     * is several node chunks, each acknowledged. */
    for (size_t at = 0; at < len; at += NL_FW_CHUNK_MAX) {
      const size_t n = len - at < NL_FW_CHUNK_MAX ? len - at : NL_FW_CHUNK_MAX;
      char code[24] = "";
      err = camlink_fw_chunk_ch((int)s.target - 1, offset + (uint32_t)at, data + at, n, code,
                                sizeof code);
      if (err != ESP_OK) {
        set_error(s.target, code[0] ? code : "The camera node stopped answering");
        drop_session();
        xSemaphoreGive(s.lock);
        refuse(why, code[0] ? "FLASH_WRITE" : "CAM_UNREACHABLE",
               code[0] ? "The camera node refused a chunk" : "The camera node did not answer");
        return err;
      }
    }
  }
  mbedtls_sha256_update(&s.sha, data, len);
  s.received += (uint32_t)len;
  xSemaphoreGive(s.lock);
  return ESP_OK;
}

static void restart_cb(void *arg) {
  (void)arg;
  esp_restart();
}

esp_err_t fw_update_end(bool *verified, fw_refusal_t *why) {
  ensure_lock();
  if (verified != NULL) *verified = false;
  xSemaphoreTake(s.lock, portMAX_DELAY);
  if (!s.open) {
    xSemaphoreGive(s.lock);
    refuse(why, "NO_SESSION", "No update session is open");
    return ESP_ERR_INVALID_STATE;
  }
  const fw_target_t t = s.target;
  if (s.received < s.size) {
    static char msg[72];
    snprintf(msg, sizeof msg, "Only %lu of %lu bytes arrived", (unsigned long)s.received,
             (unsigned long)s.size);
    set_error(t, msg);
    drop_session();
    xSemaphoreGive(s.lock);
    refuse(why, "SHORT_IMAGE", msg);
    return ESP_ERR_INVALID_SIZE;
  }

  s_t[t].state = "verifying";
  uint8_t got[32];
  mbedtls_sha256_finish(&s.sha, got);
  if (memcmp(got, s.want, sizeof got) != 0) {
    set_error(t, "SHA-256 of the received image does not match");
    drop_session();
    xSemaphoreGive(s.lock);
    refuse(why, "CHECKSUM_FAILED", "SHA-256 of the received image does not match");
    return ESP_ERR_INVALID_CRC;
  }

  if (t == FW_T_P4) {
    /* esp_ota_end validates the image header and, with secure boot off, the
     * app's own checksum. A rejected image never becomes the boot slot. */
    esp_err_t err = esp_ota_end(s.handle);
    mbedtls_sha256_free(&s.sha);
    s.open = false;
    if (err != ESP_OK) {
      set_error(t, err == ESP_ERR_OTA_VALIDATE_FAILED ? "Image failed validation"
                                                       : "Could not finish the OTA write");
      xSemaphoreGive(s.lock);
      refuse(why, err == ESP_ERR_OTA_VALIDATE_FAILED ? "CHECKSUM_FAILED" : "FLASH_WRITE",
             s_t[t].error);
      return err;
    }
    s_t[t].state = "applying";
    err = esp_ota_set_boot_partition(s.part);
    if (err != ESP_OK) {
      set_error(t, "Could not select the new slot");
      xSemaphoreGive(s.lock);
      refuse(why, "FLASH_WRITE", "Could not select the new slot");
      return err;
    }
    s_t[t].state = "rebooting";
    klog(TAG_P4, "p4 update verified into %s; restarting into version %s", s.part->label,
         s.version[0] ? s.version : "?");
    if (s.restart == NULL) {
      const esp_timer_create_args_t args = {.callback = restart_cb, .name = "fw-restart"};
      esp_timer_create(&args, &s.restart);
    }
    if (s.restart != NULL) esp_timer_start_once(s.restart, FW_P4_RESTART_DELAY_US);
    xSemaphoreGive(s.lock);
    if (verified != NULL) *verified = true;
    return ESP_OK;
  }

  /* A node verifies its own copy against the same hash and restarts itself
   * when it answers; the P4 hears whether it verified and then watches for
   * it to come back. */
  bool node_ok = false;
  char code[24] = "";
  esp_err_t err = camlink_fw_end_ch((int)t - 1, &node_ok, code, sizeof code);
  mbedtls_sha256_free(&s.sha);
  s.open = false;
  if (err != ESP_OK || !node_ok) {
    set_error(t, code[0] ? code : "The camera node did not confirm the image");
    xSemaphoreGive(s.lock);
    refuse(why, code[0] ? "CHECKSUM_FAILED" : "CAM_UNREACHABLE",
           code[0] ? "The camera node rejected the image" : "The camera node did not answer");
    return err != ESP_OK ? err : ESP_ERR_INVALID_RESPONSE;
  }
  s_t[t].state = "rebooting";
  s_t[t].end_us = esp_timer_get_time();
  klog(TAG_P4, "%s update verified; the node is restarting into version %s", NAMES[t],
       s.version[0] ? s.version : "?");
  xSemaphoreGive(s.lock);
  if (verified != NULL) *verified = true;
  return ESP_OK;
}

void fw_update_abort(void) {
  ensure_lock();
  xSemaphoreTake(s.lock, portMAX_DELAY);
  if (s.open) {
    klog(TAG_P4, "%s update aborted by the host at %lu of %lu B", NAMES[s.target],
         (unsigned long)s.received, (unsigned long)s.size);
    s_t[s.target].state = "idle";
    drop_session();
  }
  xSemaphoreGive(s.lock);
}

bool fw_update_busy(void) { return s.open; }

/* A node's way back: HELLO answered with the version we sent. Called from
 * FW_STATUS, so the host's polling is what advances it. */
static void watch_node(fw_target_t t) {
  target_t *tt = &s_t[t];
  if (strcmp(tt->state, "rebooting") != 0) return;
  const int64_t elapsed_ms = (esp_timer_get_time() - tt->end_us) / 1000;
  if (elapsed_ms < 3000) return; /* still writing otadata and resetting */
  const int cam = (int)t - 1;
  if (camlink_hello_ch_timeout(cam, 400) == ESP_OK) {
    camlink_info_t info;
    camlink_get_info_ch(cam, &info);
    if (tt->pending_version[0] == '\0' || strcmp(info.firmware, tt->pending_version) == 0) {
      tt->state = "ready";
      klog(TAG_P4, "%s is back on %s after %lld ms", NAMES[t], info.firmware,
           (long long)elapsed_ms);
      return;
    }
    if (elapsed_ms > FW_NODE_BACK_MS) {
      /* Answering, but with the old version: the bootloader rolled it back,
       * or the image never took. Say which version is running. */
      char msg[80];
      snprintf(msg, sizeof msg, "%s came back on %s, not %s", NAMES[t], info.firmware,
               tt->pending_version);
      set_error(t, msg);
    }
    return;
  }
  if (elapsed_ms > FW_NODE_BACK_MS && !tt->bank_cycled) {
    /* Not answering: the new image may have hung before it could confirm
     * itself. A reset is what makes its bootloader roll back, and the bank
     * switch is the one reset the P4 has over a node. */
    tt->bank_cycled = true;
    klog(TAG_P4, "%s silent %lld ms after its update; cycling the camera bank", NAMES[t],
         (long long)elapsed_ms);
    power_cam_bank_cycle();
    return;
  }
  if (elapsed_ms > FW_NODE_GIVEUP_MS) {
    set_error(t, "The camera node did not come back after the update");
  }
}

const char *fw_update_state(fw_target_t t) {
  ensure_lock();
  if (t < 0 || t >= FW_T_COUNT) return "idle";
  if (t != FW_T_P4) watch_node(t);
  return s_t[t].state;
}

const char *fw_update_error(fw_target_t t) {
  ensure_lock();
  if (t < 0 || t >= FW_T_COUNT) return "";
  return strcmp(s_t[t].state, "error") == 0 ? s_t[t].error : "";
}

void fw_update_mark_healthy(void) {
  const esp_partition_t *running = esp_ota_get_running_partition();
  esp_ota_img_states_t st;
  if (running == NULL || esp_ota_get_state_partition(running, &st) != ESP_OK) return;
  if (st == ESP_OTA_IMG_PENDING_VERIFY) {
    const esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    klog(TAG_P4, "new image in %s confirmed%s", running->label,
         err == ESP_OK ? "" : " (mark failed)");
  }
}
