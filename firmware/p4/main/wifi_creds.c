/*
 * Saved Wi-Fi networks. See wifi_creds.h for why this is a separate NVS
 * namespace from the config envelope, and what is and is not protected.
 */
#include "wifi_creds.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "pure.h"

static const char *TAG = "wifi_creds";

/*
 * A namespace of its own, not `"kino"`.
 *
 * config_store.c owns `"kino"` and `GET_CONFIG` returns its `"config"` key
 * verbatim. Nothing in this file ever opens that namespace and nothing there
 * opens this one, so there is no code path from a config reply to a
 * passphrase. That separation is the security property; a redaction filter
 * over a shared document would have to be maintained forever.
 */
#define CREDS_NS "kino_wifi"

/* One blob per slot rather than a JSON document, for two reasons: a JSON
 * document is the thing that leaked in the first place, and a fixed struct
 * cannot grow a field that someone forgets to redact. */
#define SLOT_KEY_FMT "n%u"

/* On-flash record. Written and read as raw bytes, so the layout is the
 * format — see `version` for how it changes. */
typedef struct {
  uint8_t version; /* 1 */
  uint8_t security;
  uint8_t auto_join;
  uint8_t reserved;
  int64_t last_connected_ms;
  char ssid[NET_SSID_LEN];
  char passphrase[PURE_WPA_PASSPHRASE_MAX + 1];
} slot_t;

#define SLOT_VERSION 1

static bool s_ready;

/* ------------------------------------------------------------------ */
/* Slot access                                                        */
/* ------------------------------------------------------------------ */

static void slot_key(unsigned index, char *out, size_t cap) {
  snprintf(out, cap, SLOT_KEY_FMT, index);
}

/* Read slot `index`. Returns false for an empty, short, or
 * unrecognised-version slot — all of which are "nothing usable here" rather
 * than errors, because a slot written by a future build must not make the
 * whole store unreadable. */
static bool slot_read(nvs_handle_t h, unsigned index, slot_t *out) {
  char key[8];
  slot_key(index, key, sizeof key);
  size_t len = sizeof *out;
  if (nvs_get_blob(h, key, out, &len) != ESP_OK) return false;
  if (len != sizeof *out) return false;
  if (out->version != SLOT_VERSION) {
    ESP_LOGW(TAG, "slot %u has format version %u, ignoring", index, out->version);
    return false;
  }
  /* A blob whose strings are not terminated would run off the end of every
   * later strcmp. Terminate defensively rather than trusting flash. */
  out->ssid[sizeof out->ssid - 1] = '\0';
  out->passphrase[sizeof out->passphrase - 1] = '\0';
  return out->ssid[0] != '\0';
}

static esp_err_t slot_write(nvs_handle_t h, unsigned index, const slot_t *slot) {
  char key[8];
  slot_key(index, key, sizeof key);
  esp_err_t err = nvs_set_blob(h, key, slot, sizeof *slot);
  if (err != ESP_OK) return err;
  return nvs_commit(h);
}

/* Index of `ssid`, or -1. Also returns the first free index through
 * `free_out` so a caller can find-or-allocate in one pass. */
static int slot_find(nvs_handle_t h, const char *ssid, int *free_out) {
  int found = -1;
  int first_free = -1;
  slot_t slot;
  for (unsigned i = 0; i < WIFI_CREDS_MAX; i++) {
    if (!slot_read(h, i, &slot)) {
      if (first_free < 0) first_free = (int)i;
      continue;
    }
    if (found < 0 && strcmp(slot.ssid, ssid) == 0) found = (int)i;
  }
  /* Wipe the stack copy: this function reads passphrases it does not need. */
  memset(&slot, 0, sizeof slot);
  if (free_out != NULL) *free_out = first_free;
  return found;
}

static esp_err_t open_ns(nvs_open_mode_t mode, nvs_handle_t *out) {
  if (!s_ready) return ESP_ERR_INVALID_STATE;
  return nvs_open(CREDS_NS, mode, out);
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

esp_err_t wifi_creds_init(void) {
  /* nvs_flash_init() is main.c's job and has already run by the time this is
   * called; opening the namespace here only proves it is reachable. A failure
   * costs remembered networks, never a photograph, so it is logged and
   * returned rather than fatal. */
  nvs_handle_t h;
  esp_err_t err = nvs_open(CREDS_NS, NVS_READWRITE, &h);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "cannot open %s: %s — networks will not be remembered", CREDS_NS,
             esp_err_to_name(err));
    return err;
  }
  nvs_close(h);
  s_ready = true;
  return ESP_OK;
}

esp_err_t wifi_creds_set(const char *ssid, const char *passphrase, net_security_t security,
                         bool auto_join) {
  if (ssid == NULL || !pure_wifi_ssid_valid(ssid)) return ESP_ERR_INVALID_ARG;

  nvs_handle_t h;
  esp_err_t err = open_ns(NVS_READWRITE, &h);
  if (err != ESP_OK) return err;

  int free_index = -1;
  const int found = slot_find(h, ssid, &free_index);

  slot_t slot;
  memset(&slot, 0, sizeof slot);

  if (found >= 0) {
    /* Update in place, so the existing passphrase survives an edit that did
     * not carry one — the host only ever had the mask. */
    if (!slot_read(h, (unsigned)found, &slot)) {
      memset(&slot, 0, sizeof slot);
    }
  } else if (free_index < 0) {
    nvs_close(h);
    /* Full. Refusing is better than evicting: silently forgetting the
     * network the camera is currently using would look like a radio fault. */
    return ESP_ERR_NO_MEM;
  }

  slot.version = SLOT_VERSION;
  slot.security = (uint8_t)security;
  slot.auto_join = auto_join ? 1 : 0;
  strncpy(slot.ssid, ssid, sizeof slot.ssid - 1);
  slot.ssid[sizeof slot.ssid - 1] = '\0';

  if (security == NET_SEC_OPEN) {
    /* An open network keeps no passphrase, and drops one it used to have:
     * leaving the old secret behind would outlive the reason it was stored. */
    memset(slot.passphrase, 0, sizeof slot.passphrase);
  } else if (passphrase != NULL && passphrase[0] != '\0') {
    strncpy(slot.passphrase, passphrase, sizeof slot.passphrase - 1);
    slot.passphrase[sizeof slot.passphrase - 1] = '\0';
  }
  /* else: keep whatever slot_read() loaded. */

  const unsigned index = found >= 0 ? (unsigned)found : (unsigned)free_index;
  err = slot_write(h, index, &slot);
  nvs_close(h);

  /* Wipe before returning. The passphrase must not survive in this frame. */
  memset(&slot, 0, sizeof slot);

  /* Deliberately no passphrase, and no length, in the log line. A length is
   * not nothing. */
  ESP_LOGI(TAG, "saved network %s (%s, autoJoin=%d)", ssid, net_security_name(security),
           auto_join ? 1 : 0);
  return err;
}

esp_err_t wifi_creds_delete(const char *ssid) {
  if (ssid == NULL) return ESP_ERR_INVALID_ARG;

  nvs_handle_t h;
  esp_err_t err = open_ns(NVS_READWRITE, &h);
  if (err != ESP_OK) return err;

  const int found = slot_find(h, ssid, NULL);
  if (found < 0) {
    nvs_close(h);
    return ESP_ERR_NOT_FOUND;
  }

  char key[8];
  slot_key((unsigned)found, key, sizeof key);
  /* erase_key rather than writing zeros: a zeroed blob still occupies the
   * page with the previous passphrase's ciphertext-free bytes until the page
   * is compacted, and "forget this network" should not leave a record. */
  err = nvs_erase_key(h, key);
  if (err == ESP_OK) err = nvs_commit(h);
  nvs_close(h);

  ESP_LOGI(TAG, "removed network %s", ssid);
  return err;
}

size_t wifi_creds_list(wifi_cred_view_t *out, size_t cap) {
  if (out == NULL || cap == 0) return 0;

  nvs_handle_t h;
  if (open_ns(NVS_READONLY, &h) != ESP_OK) return 0;

  size_t n = 0;
  slot_t slot;
  for (unsigned i = 0; i < WIFI_CREDS_MAX && n < cap; i++) {
    if (!slot_read(h, i, &slot)) continue;
    memset(&out[n], 0, sizeof out[n]);
    strncpy(out[n].ssid, slot.ssid, sizeof out[n].ssid - 1);
    /* Metadata only. The struct has nowhere to put a passphrase, which is
     * the point — a caller cannot serialise what it was never handed. */
    out[n].has_password = slot.passphrase[0] != '\0';
    out[n].security = (net_security_t)slot.security;
    out[n].auto_join = slot.auto_join != 0;
    out[n].last_connected_ms = slot.last_connected_ms;
    n++;
  }
  memset(&slot, 0, sizeof slot);
  nvs_close(h);
  return n;
}

size_t wifi_creds_count(void) {
  nvs_handle_t h;
  if (open_ns(NVS_READONLY, &h) != ESP_OK) return 0;
  size_t n = 0;
  slot_t slot;
  for (unsigned i = 0; i < WIFI_CREDS_MAX; i++) {
    if (slot_read(h, i, &slot)) n++;
  }
  memset(&slot, 0, sizeof slot);
  nvs_close(h);
  return n;
}

bool wifi_creds_has_password(const char *ssid) {
  if (ssid == NULL) return false;
  nvs_handle_t h;
  if (open_ns(NVS_READONLY, &h) != ESP_OK) return false;

  bool has = false;
  slot_t slot;
  for (unsigned i = 0; i < WIFI_CREDS_MAX; i++) {
    if (!slot_read(h, i, &slot)) continue;
    if (strcmp(slot.ssid, ssid) == 0) {
      has = slot.passphrase[0] != '\0';
      break;
    }
  }
  memset(&slot, 0, sizeof slot);
  nvs_close(h);
  return has;
}

void wifi_creds_mark_connected(const char *ssid, int64_t epoch_ms) {
  if (ssid == NULL) return;
  nvs_handle_t h;
  if (open_ns(NVS_READWRITE, &h) != ESP_OK) return;

  const int found = slot_find(h, ssid, NULL);
  slot_t slot;
  if (found >= 0 && slot_read(h, (unsigned)found, &slot)) {
    slot.last_connected_ms = epoch_ms;
    (void)slot_write(h, (unsigned)found, &slot);
  }
  memset(&slot, 0, sizeof slot);
  nvs_close(h);
}

bool wifi_creds_auto_join_target(char *ssid_out, size_t cap) {
  if (ssid_out == NULL || cap == 0) return false;
  nvs_handle_t h;
  if (open_ns(NVS_READONLY, &h) != ESP_OK) return false;

  bool found = false;
  slot_t slot;
  int64_t best = -1;
  for (unsigned i = 0; i < WIFI_CREDS_MAX; i++) {
    if (!slot_read(h, i, &slot)) continue;
    if (!slot.auto_join) continue;
    /* Prefer the most recently used. With several saved networks in range,
     * the one that worked last is the better guess than the first slot. */
    if (slot.last_connected_ms > best) {
      best = slot.last_connected_ms;
      strncpy(ssid_out, slot.ssid, cap - 1);
      ssid_out[cap - 1] = '\0';
      found = true;
    }
  }
  memset(&slot, 0, sizeof slot);
  nvs_close(h);
  return found;
}

esp_err_t wifi_creds_apply_to(const char *ssid,
                              esp_err_t (*sink)(const char *ssid, const char *passphrase,
                                                net_security_t security, void *ctx),
                              void *ctx) {
  if (ssid == NULL || sink == NULL) return ESP_ERR_INVALID_ARG;

  nvs_handle_t h;
  esp_err_t err = open_ns(NVS_READONLY, &h);
  if (err != ESP_OK) return err;

  slot_t slot;
  bool hit = false;
  for (unsigned i = 0; i < WIFI_CREDS_MAX; i++) {
    if (!slot_read(h, i, &slot)) continue;
    if (strcmp(slot.ssid, ssid) == 0) {
      hit = true;
      break;
    }
  }
  nvs_close(h);

  if (!hit) {
    memset(&slot, 0, sizeof slot);
    return ESP_ERR_NOT_FOUND;
  }

  err = sink(slot.ssid, slot.passphrase, (net_security_t)slot.security, ctx);

  /* The whole reason this function exists: the passphrase is wiped here, in
   * the only frame that ever held it, before returning to a caller that
   * therefore cannot log it. */
  memset(&slot, 0, sizeof slot);
  return err;
}

esp_err_t wifi_creds_erase_all(void) {
  nvs_handle_t h;
  esp_err_t err = open_ns(NVS_READWRITE, &h);
  if (err != ESP_OK) return err;
  err = nvs_erase_all(h);
  if (err == ESP_OK) err = nvs_commit(h);
  nvs_close(h);
  ESP_LOGI(TAG, "erased all saved networks");
  return err;
}
