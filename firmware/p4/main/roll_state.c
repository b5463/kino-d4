/*
 * KINO Roll membership and the device credential. See roll_state.h for why
 * these are two NVS namespaces, neither of them the config envelope, and for
 * what is and is not protected.
 */
#include "roll_state.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "klog.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "pure.h"

static const char *TAG = "roll_state";

/* Membership. Not secret - `ROLL_STATUS` reports all of it - but not a setting
 * either, so it does not belong in the `"kino"` document a `SET_CONFIG` merge
 * can reach. */
#define ROLL_NS "kino_roll"
#define ROLL_KEY "member"

/* The credential, in a namespace of its own again. Splitting it from ROLL_NS
 * costs one more NVS page and buys the property that no function which reads
 * membership - and the UI task reads it while drawing - ever has a token in
 * its stack frame. A single blob holding both would put one there per frame. */
#define CRED_NS "kino_rollsec"
#define CRED_KEY "device"

/* One blob per record rather than JSON. A JSON document is the thing that
 * leaked in the first place, and a fixed struct cannot grow a field that
 * someone forgets to redact. */

typedef struct {
  uint8_t version; /* 1 */
  uint8_t role;
  uint8_t reserved[2];
  int64_t joined_at_ms;
  char roll_id[ROLL_ID_LEN];
  char slug[ROLL_SLUG_LEN];
  char guest_url[ROLL_GUEST_URL_LEN];
  char name[ROLL_NAME_LEN];
} member_rec_t;

typedef struct {
  uint8_t version; /* 1 */
  uint8_t reserved[3];
  char device_id[ROLL_DEVICE_ID_LEN];
  char device_token[ROLL_DEVICE_TOKEN_LEN];
} cred_rec_t;

#define REC_VERSION 1

static bool s_ready;

/* The membership is cached in RAM and the credential is not.
 * `roll_state_active()` is on the UI's draw path and an NVS read per frame is
 * not affordable. The credential has no hot reader, so it stays in flash and
 * is read only inside the functions that need it - which is also what keeps
 * the token out of every other frame. */
static roll_state_t s_member;
static bool s_active;

/* One lock over the RAM copy. Written from the KDP task on
 * `ROLL_JOIN`/`ROLL_LEAVE`, read from the UI task while it draws the QR code
 * and from the upload task when it builds a URL. The struct is 400-odd bytes,
 * so a reader can observe a half-copied assignment - a guestUrl from the old
 * Roll beside the new rollId, which is a QR code that sends a guest to the
 * wrong party. */
static SemaphoreHandle_t s_lock;

static void lock(void) {
  if (s_lock) xSemaphoreTake(s_lock, portMAX_DELAY);
}
static void unlock(void) {
  if (s_lock) xSemaphoreGive(s_lock);
}

/* ------------------------------------------------------------------ */
/* Role                                                               */
/* ------------------------------------------------------------------ */

const char *roll_role_name(roll_role_t role) { return role == ROLL_ROLE_HOST ? "host" : "guest"; }

bool roll_role_parse(const char *s, roll_role_t *out) {
  if (s == NULL || out == NULL) return false;
  const bool host = strcmp(s, "host") == 0;
  if (!host && strcmp(s, "guest") != 0) return false;
  *out = host ? ROLL_ROLE_HOST : ROLL_ROLE_GUEST;
  return true;
}

/* ------------------------------------------------------------------ */
/* Slug shapes                                                        */
/* ------------------------------------------------------------------ */

/* apps/api/src/rolls/slug.ts, verbatim, so a diff against it is a string
 * comparison rather than a reading exercise. */
static const char SLUG_ALPHABET[] = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

static bool short_code_form(const char *slug, size_t len) {
  if (len != 6) return false;
  for (size_t i = 0; i < len; i++) {
    if (strchr(SLUG_ALPHABET, slug[i]) == NULL) return false;
  }
  return true;
}

/* packages/test-fixtures/src/MockKinoDevice.ts: /^[a-z0-9][a-z0-9-]{2,47}$/.
 * Length 3..48, lower case, first character not a hyphen. */
static bool reference_form(const char *slug, size_t len) {
  if (len < 3 || len > 48) return false;
  for (size_t i = 0; i < len; i++) {
    const char c = slug[i];
    const bool lower = c >= 'a' && c <= 'z';
    const bool digit = c >= '0' && c <= '9';
    if (lower || digit) continue;
    /* A hyphen is allowed everywhere except first, which is the one position
     * the pattern's leading class excludes. */
    if (c == '-' && i > 0) continue;
    return false;
  }
  return true;
}

roll_slug_form_t roll_slug_form(const char *slug) {
  if (slug == NULL) return ROLL_SLUG_INVALID;
  const size_t len = strlen(slug);
  /* Short code first: the forms overlap for a 6-character lower-case string,
   * and the API's is the one a real Roll uses. Either answer accepts. */
  if (short_code_form(slug, len)) return ROLL_SLUG_SHORT_CODE;
  if (reference_form(slug, len)) return ROLL_SLUG_REFERENCE;
  return ROLL_SLUG_INVALID;
}

bool roll_slug_valid(const char *slug) { return roll_slug_form(slug) != ROLL_SLUG_INVALID; }

/* ------------------------------------------------------------------ */
/* Field validation                                                   */
/* ------------------------------------------------------------------ */

/* Non-empty and short enough to store whole. A truncated rollId addresses no
 * Roll, so refusing beats silently storing a prefix. */
static bool text_fits(const char *s, size_t cap, bool allow_empty) {
  if (s == NULL) return allow_empty;
  const size_t len = strlen(s);
  if (len == 0) return allow_empty;
  return len < cap;
}

/* The guestUrl goes on the display as a QR payload and nowhere else - nothing
 * in this firmware parses it. So the check is only that a phone camera will
 * make something of it: a scheme it can follow, and a length that fits. */
static bool guest_url_ok(const char *url) {
  if (!text_fits(url, ROLL_GUEST_URL_LEN, false)) return false;
  return strncmp(url, "https://", 8) == 0 || strncmp(url, "http://", 7) == 0;
}

/* `kdt_` + 43 base64url characters, per docs/roll/ROLL_DEVICE_CONTRACT.md.
 * Checked rather than trusted: a truncated token produces a 401 the contract
 * says not to retry, and the queue would park with nothing to diagnose. */
static bool token_ok(const char *token) {
  if (token == NULL) return false;
  if (strlen(token) != ROLL_DEVICE_TOKEN_LEN - 1) return false;
  if (strncmp(token, "kdt_", 4) != 0) return false;
  for (const char *p = token + 4; *p != '\0'; p++) {
    const char c = *p;
    const bool alnum = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    if (!alnum && c != '-' && c != '_') return false;
  }
  return true;
}

static void copy_field(char *dst, size_t cap, const char *src) {
  if (src == NULL) {
    dst[0] = '\0';
    return;
  }
  strncpy(dst, src, cap - 1);
  dst[cap - 1] = '\0';
}

/* ------------------------------------------------------------------ */
/* NVS                                                                */
/* ------------------------------------------------------------------ */

static esp_err_t open_ns(const char *ns, nvs_open_mode_t mode, nvs_handle_t *out) {
  if (!s_ready) return ESP_ERR_INVALID_STATE;
  return nvs_open(ns, mode, out);
}

/* Returns false for an empty, short, or unrecognised-version record - all of
 * which are "nothing usable here" rather than errors, because a record written
 * by a future build must not stop the camera from booting. */
static bool member_read(nvs_handle_t h, member_rec_t *out) {
  size_t len = sizeof *out;
  if (nvs_get_blob(h, ROLL_KEY, out, &len) != ESP_OK) return false;
  if (len != sizeof *out) return false;
  if (out->version != REC_VERSION) {
    ESP_LOGW(TAG, "membership record has format version %u, ignoring", out->version);
    return false;
  }
  /* A blob whose strings are not terminated would run off the end of every
   * later strlen. Terminate defensively rather than trusting flash. */
  out->roll_id[sizeof out->roll_id - 1] = '\0';
  out->slug[sizeof out->slug - 1] = '\0';
  out->guest_url[sizeof out->guest_url - 1] = '\0';
  out->name[sizeof out->name - 1] = '\0';
  return out->roll_id[0] != '\0' && out->slug[0] != '\0';
}

static bool cred_read(nvs_handle_t h, cred_rec_t *out) {
  size_t len = sizeof *out;
  if (nvs_get_blob(h, CRED_KEY, out, &len) != ESP_OK) return false;
  if (len != sizeof *out) return false;
  if (out->version != REC_VERSION) return false;
  out->device_id[sizeof out->device_id - 1] = '\0';
  out->device_token[sizeof out->device_token - 1] = '\0';
  return out->device_token[0] != '\0';
}

/* Put `rec` in the RAM copy, or clear it when `rec` is NULL. The one writer of
 * s_member, so the field list appears once and a field added to member_rec_t
 * cannot be handled on the load path and forgotten on the assign path. */
static void publish(const member_rec_t *rec) {
  lock();
  memset(&s_member, 0, sizeof s_member);
  s_active = rec != NULL;
  if (rec != NULL) {
    copy_field(s_member.roll_id, sizeof s_member.roll_id, rec->roll_id);
    copy_field(s_member.slug, sizeof s_member.slug, rec->slug);
    copy_field(s_member.guest_url, sizeof s_member.guest_url, rec->guest_url);
    copy_field(s_member.name, sizeof s_member.name, rec->name);
    /* Anything that is not the host byte is a guest. A record from a future
     * build with a third role must not be promoted to host by accident. */
    s_member.role = rec->role == (uint8_t)ROLL_ROLE_HOST ? ROLL_ROLE_HOST : ROLL_ROLE_GUEST;
    s_member.joined_at_ms = rec->joined_at_ms;
  }
  unlock();
}

/* ------------------------------------------------------------------ */
/* Membership API                                                     */
/* ------------------------------------------------------------------ */

esp_err_t roll_state_init(void) {
  if (s_lock == NULL) {
    s_lock = xSemaphoreCreateMutex();
    if (s_lock == NULL) return ESP_ERR_NO_MEM;
  }

  /* nvs_flash_init() is main.c's job and has already run by the time this is
   * called; opening the namespace here only proves it is reachable. A failure
   * costs the remembered Roll, never a photograph, so it is logged and returned
   * rather than fatal. */
  nvs_handle_t h;
  esp_err_t err = nvs_open(ROLL_NS, NVS_READWRITE, &h);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "cannot open %s: %s - Roll membership will not be remembered", ROLL_NS,
             esp_err_to_name(err));
    return err;
  }

  s_ready = true;

  member_rec_t rec;
  const bool have = member_read(h, &rec);
  nvs_close(h);

  publish(have ? &rec : NULL);

  if (have) {
    ESP_LOGI(TAG, "on roll %s (%s, %s)", rec.slug, roll_role_name((roll_role_t)rec.role),
             rec.roll_id);
  } else {
    ESP_LOGI(TAG, "not on a roll");
  }
  return ESP_OK;
}

bool roll_state_active(void) {
  lock();
  const bool active = s_active;
  unlock();
  return active;
}

bool roll_state_get(roll_state_t *out) {
  if (out == NULL) return false;
  lock();
  const bool active = s_active;
  if (active) {
    *out = s_member;
  } else {
    memset(out, 0, sizeof *out);
  }
  unlock();
  return active;
}

esp_err_t roll_state_assign(const char *roll_id, const char *slug, const char *guest_url,
                            const char *name, roll_role_t role, int64_t joined_at_ms) {
  if (!text_fits(roll_id, ROLL_ID_LEN, false)) return ESP_ERR_INVALID_ARG;
  if (!roll_slug_valid(slug) || strlen(slug) >= ROLL_SLUG_LEN) return ESP_ERR_INVALID_ARG;
  if (!guest_url_ok(guest_url)) return ESP_ERR_INVALID_ARG;
  if (!text_fits(name, ROLL_NAME_LEN, true)) return ESP_ERR_INVALID_ARG;
  if (role != ROLL_ROLE_HOST && role != ROLL_ROLE_GUEST) return ESP_ERR_INVALID_ARG;

  nvs_handle_t h;
  esp_err_t err = open_ns(ROLL_NS, NVS_READWRITE, &h);
  if (err != ESP_OK) return err;

  member_rec_t rec;
  memset(&rec, 0, sizeof rec);
  rec.version = REC_VERSION;
  rec.role = (uint8_t)role;
  /* Keep the timestamp only if it could be a real instant. A seconds value
   * sent where milliseconds were meant would date this membership at 1970 and
   * persist that across every reboot; 0 at least reads as "unknown". */
  rec.joined_at_ms = pure_epoch_plausible(joined_at_ms) ? joined_at_ms : 0;
  copy_field(rec.roll_id, sizeof rec.roll_id, roll_id);
  /* Verbatim. See roll_slug_form() for why this is not normalised. */
  copy_field(rec.slug, sizeof rec.slug, slug);
  copy_field(rec.guest_url, sizeof rec.guest_url, guest_url);
  copy_field(rec.name, sizeof rec.name, name);

  err = nvs_set_blob(h, ROLL_KEY, &rec, sizeof rec);
  if (err == ESP_OK) err = nvs_commit(h);
  nvs_close(h);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "cannot persist roll %s: %s", rec.slug, esp_err_to_name(err));
    return err;
  }

  /* RAM copy last: a reader that saw the new membership before the flash
   * write landed would be showing a Roll that a reboot forgets. */
  publish(&rec);

  ESP_LOGI(TAG, "joined roll %s as %s", rec.slug, roll_role_name(role));
  klog("P4", "joined roll %s as %s", rec.slug, roll_role_name(role));
  return ESP_OK;
}

esp_err_t roll_state_leave(void) {
  nvs_handle_t h;
  esp_err_t err = open_ns(ROLL_NS, NVS_READWRITE, &h);
  if (err != ESP_OK) return err;

  char slug[ROLL_SLUG_LEN];
  lock();
  const bool was_active = s_active;
  copy_field(slug, sizeof slug, s_member.slug);
  unlock();

  if (!was_active) {
    nvs_close(h);
    return ESP_ERR_NOT_FOUND;
  }

  /* erase_key rather than writing a zeroed record: "leave this Roll" should
   * not leave a record of it behind. */
  err = nvs_erase_key(h, ROLL_KEY);
  if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK; /* RAM said yes, flash never had it. */
  if (err == ESP_OK) err = nvs_commit(h);
  nvs_close(h);
  if (err != ESP_OK) return err;

  publish(NULL);

  ESP_LOGI(TAG, "left roll %s", slug);
  klog("P4", "left roll %s", slug);
  return err;
}

esp_err_t roll_state_erase(void) {
  esp_err_t first = ESP_OK;

  nvs_handle_t h;
  esp_err_t err = open_ns(ROLL_NS, NVS_READWRITE, &h);
  if (err == ESP_OK) {
    err = nvs_erase_all(h);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
  }
  if (err != ESP_OK) first = err;

  /* The credential goes too, even if the membership erase failed. A camera
   * being handed on must not keep a bearer token that still authorises
   * uploads, and stopping halfway is the worst of both. */
  err = roll_state_clear_credential();
  if (err != ESP_OK && first == ESP_OK) first = err;

  publish(NULL);

  ESP_LOGW(TAG, "erased roll membership and device credential");
  klog("P4", "roll state erased");
  return first;
}

/* ------------------------------------------------------------------ */
/* Device credential                                                  */
/* ------------------------------------------------------------------ */

esp_err_t roll_state_set_credential(const char *device_id, const char *device_token) {
  if (!text_fits(device_id, ROLL_DEVICE_ID_LEN, false)) return ESP_ERR_INVALID_ARG;
  if (!token_ok(device_token)) return ESP_ERR_INVALID_ARG;

  nvs_handle_t h;
  esp_err_t err = open_ns(CRED_NS, NVS_READWRITE, &h);
  if (err != ESP_OK) return err;

  cred_rec_t rec;
  memset(&rec, 0, sizeof rec);
  rec.version = REC_VERSION;
  copy_field(rec.device_id, sizeof rec.device_id, device_id);
  copy_field(rec.device_token, sizeof rec.device_token, device_token);

  err = nvs_set_blob(h, CRED_KEY, &rec, sizeof rec);
  if (err == ESP_OK) err = nvs_commit(h);
  nvs_close(h);

  /* Wipe before returning. The token must not survive in this frame. */
  memset(&rec, 0, sizeof rec);

  /* Deliberately no token, and no length, in the log line. A length is not
   * nothing. */
  ESP_LOGI(TAG, "stored device credential for %s", device_id);
  return err;
}

bool roll_state_device_id(char *out, size_t cap) {
  if (out == NULL || cap == 0) return false;
  out[0] = '\0';

  nvs_handle_t h;
  if (open_ns(CRED_NS, NVS_READONLY, &h) != ESP_OK) return false;

  cred_rec_t rec;
  const bool have = cred_read(h, &rec);
  nvs_close(h);
  if (have) copy_field(out, cap, rec.device_id);

  /* This function does not need the token but cred_read() loaded one. */
  memset(&rec, 0, sizeof rec);
  return have && out[0] != '\0';
}

bool roll_state_has_credential(void) {
  nvs_handle_t h;
  if (open_ns(CRED_NS, NVS_READONLY, &h) != ESP_OK) return false;

  cred_rec_t rec;
  const bool have = cred_read(h, &rec);
  nvs_close(h);
  memset(&rec, 0, sizeof rec);
  return have;
}

esp_err_t roll_state_apply_credential_to(esp_err_t (*sink)(const char *device_id,
                                                           const char *device_token, void *ctx),
                                         void *ctx) {
  if (sink == NULL) return ESP_ERR_INVALID_ARG;

  nvs_handle_t h;
  esp_err_t err = open_ns(CRED_NS, NVS_READONLY, &h);
  if (err != ESP_OK) return err;

  cred_rec_t rec;
  const bool have = cred_read(h, &rec);
  nvs_close(h);

  if (!have) {
    memset(&rec, 0, sizeof rec);
    return ESP_ERR_NOT_FOUND;
  }

  err = sink(rec.device_id, rec.device_token, ctx);

  /* The whole reason this function exists: the token is wiped here, in the
   * only frame that ever held it, before returning to a caller that therefore
   * cannot log it. */
  memset(&rec, 0, sizeof rec);
  return err;
}

esp_err_t roll_state_clear_credential(void) {
  nvs_handle_t h;
  esp_err_t err = open_ns(CRED_NS, NVS_READWRITE, &h);
  if (err != ESP_OK) return err;
  err = nvs_erase_all(h);
  if (err == ESP_OK) err = nvs_commit(h);
  nvs_close(h);
  ESP_LOGI(TAG, "cleared device credential");
  return err;
}
