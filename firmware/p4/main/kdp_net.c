/*
 * The NETWORK_* / ROLL_* / UPLOAD_* KDP replies. See kdp_net.h for which of
 * these answer for real today and which refuse, and why ROLL_JOIN works with
 * no radio.
 *
 * Field names here are normative from apps/studio/src/roll/rollTypes.ts. That
 * file is the only contract this command group has — its shapes were never
 * frozen into @kino/kdp — so a rename there and a rename here have to happen
 * together, and the host tests in test_kdp_net.c are what notice if they do
 * not.
 */
#include "kdp_net.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "clock.h"
#include "esp_timer.h"
#include "klog.h"
#include "net_link.h"
#include "pure.h"
#include "roll_queue.h"
#include "roll_state.h"
#include "storage.h"
#include "upload_queue.h"
#include "wifi_creds.h"

/* The mask NETWORK_LIST reports in place of a stored passphrase. Must match
 * MASKED_PASSWORD in apps/studio/src/roll/rollTypes.ts exactly — Studio
 * compares against it to decide whether the field it holds is a real
 * passphrase or a placeholder it must not send back. Four U+2022 bullets. */
#define MASKED_PASSWORD "\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2"

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

/* ------------------------------------------------------------------ */
/* Reply helpers                                                      */
/* ------------------------------------------------------------------ */

static kdp_net_reply_t ok_reply(cJSON *json) {
  kdp_net_reply_t r;
  memset(&r, 0, sizeof r);
  if (json == NULL) {
    /* Out of memory building a reply. Say so rather than sending an empty
     * object that reads as a successful answer with no content. */
    r.ok = false;
    r.code = "INTERNAL_ERROR";
    snprintf(r.message, sizeof r.message, "Could not build the reply");
    return r;
  }
  r.ok = true;
  r.json = json;
  return r;
}

static kdp_net_reply_t err_reply(const char *code, const char *fmt, ...) {
  kdp_net_reply_t r;
  memset(&r, 0, sizeof r);
  r.ok = false;
  r.code = code;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(r.message, sizeof r.message, fmt, ap);
  va_end(ap);
  return r;
}

/**
 * The refusal for anything that needs the radio.
 *
 * Carries the reason from net_link rather than a generic "no network", so
 * Studio and the logs can tell "no route to the C6" from "wrong passphrase"
 * from "DHCP timed out". A refusal that does not say which of those it is
 * costs a bench cycle to diagnose.
 */
static kdp_net_reply_t no_network(const char *what) {
  net_status_t net;
  net_link_status(&net, now_ms());
  return err_reply("NETWORK_UNAVAILABLE", "%s needs the network: radio %s, %s (%s)", what,
                   net.radio_routed ? "routed" : "NOT routed", net_state_name(net.state),
                   net_reason_name(net.reason));
}

/* Read a trimmed string field, or NULL. */
static const char *str_field(const cJSON *req, const char *key) {
  const cJSON *v = cJSON_GetObjectItem(req, key);
  return (cJSON_IsString(v) && v->valuestring != NULL) ? v->valuestring : NULL;
}

/* ------------------------------------------------------------------ */
/* Shared sub-objects                                                 */
/* ------------------------------------------------------------------ */

/* `{networks: [...]}` — the payload NETWORK_LIST returns and NETWORK_SET and
 * NETWORK_DELETE echo, so a host never has to re-read after a write. */
static cJSON *networks_array(void) {
  cJSON *arr = cJSON_CreateArray();
  if (arr == NULL) return NULL;

  wifi_cred_view_t views[WIFI_CREDS_MAX];
  const size_t n = wifi_creds_list(views, WIFI_CREDS_MAX);

  for (size_t i = 0; i < n; i++) {
    cJSON *o = cJSON_CreateObject();
    if (o == NULL) break;
    cJSON_AddStringToObject(o, "ssid", views[i].ssid);
    /* Never the passphrase. `hasPassword` is the only way a host learns one
     * is stored, and the mask is what it must send back unchanged when it
     * edits something else about the network. */
    cJSON_AddStringToObject(o, "password", views[i].has_password ? MASKED_PASSWORD : "");
    cJSON_AddBoolToObject(o, "hasPassword", views[i].has_password);
    cJSON_AddStringToObject(o, "security", net_security_name(views[i].security));
    cJSON_AddBoolToObject(o, "autoJoin", views[i].auto_join);
    if (views[i].last_connected_ms > 0) {
      cJSON_AddNumberToObject(o, "lastSeen", (double)views[i].last_connected_ms);
    } else {
      /* null, not 0. 1970 is not a time this camera has ever been. */
      cJSON_AddNullToObject(o, "lastSeen");
    }
    cJSON_AddItemToArray(arr, o);
  }
  return arr;
}

/* `UploadQueueReport`. Real counts from the durable queue. */
static cJSON *queue_object(void) {
  upload_queue_report_t q;
  upload_queue_status(&q);

  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return NULL;
  cJSON_AddNumberToObject(o, "pending", q.pending);
  cJSON_AddNumberToObject(o, "uploading", q.uploading);
  cJSON_AddNumberToObject(o, "failed", q.failed);
  cJSON_AddNumberToObject(o, "uploaded", q.uploaded);
  cJSON_AddBoolToObject(o, "draining", q.draining);
  /* Beyond the Studio interface, and deliberately: `halted` is not `failed`.
   * The jobs are fine and the device's credentials are not, and a user who
   * cannot tell those apart retries the wrong thing. */
  cJSON_AddBoolToObject(o, "halted", q.halted);
  if (q.last_error[0] != '\0') {
    /* Already redacted by the queue. Passing it through rq_redact() again is
     * cheap and means this file does not have to trust that. */
    char safe[RQ_ERROR_LEN];
    cJSON_AddStringToObject(o, "lastError", rq_redact(safe, sizeof safe, q.last_error));
  } else {
    cJSON_AddNullToObject(o, "lastError");
  }
  return o;
}

/* `RollView` — `{active, roll, queue}` plus the two fields the reference
 * device adds (`serverReachable`, `tokenStatus`). */
static cJSON *roll_view(void) {
  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return NULL;

  roll_state_t roll;
  const bool active = roll_state_get(&roll);
  cJSON_AddBoolToObject(o, "active", active);

  if (!active) {
    /* null rather than omitted — `RollView.roll` is documented as null when
     * the camera is not on a Roll, and an absent key would read as an older
     * firmware rather than an empty state. */
    cJSON_AddNullToObject(o, "roll");
  } else {
    cJSON *r = cJSON_CreateObject();
    if (r != NULL) {
      cJSON_AddStringToObject(r, "rollId", roll.roll_id);
      cJSON_AddStringToObject(r, "slug", roll.slug);
      cJSON_AddStringToObject(r, "guestUrl", roll.guest_url);
      cJSON_AddStringToObject(r, "name", roll.name);
      cJSON_AddStringToObject(r, "role", roll_role_name(roll.role));
      cJSON_AddNumberToObject(r, "joinedAt", (double)roll.joined_at_ms);
      cJSON_AddItemToObject(o, "roll", r);
    }
  }

  cJSON_AddItemToObject(o, "queue", queue_object());

  /* The camera cannot reach the server, so it must not claim the server is
   * reachable. This is a fact about the radio, not about the server. */
  net_status_t net;
  net_link_status(&net, now_ms());
  cJSON_AddBoolToObject(o, "serverReachable", net_link_can_upload(&net));

  /* `ok` | `token-expired`. A token the camera has never obtained is not
   * expired — the honest third value is that there is none, and reporting
   * `token-expired` for it would send someone to re-authenticate something
   * that was never authenticated. */
  cJSON_AddStringToObject(o, "tokenStatus",
                          roll_state_has_credential() ? "ok" : "no-credential");
  return o;
}

/* ------------------------------------------------------------------ */
/* NETWORK_*                                                          */
/* ------------------------------------------------------------------ */

kdp_net_reply_t kdp_net_list(void) {
  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return err_reply("INTERNAL_ERROR", "Could not build the reply");
  cJSON_AddItemToObject(o, "networks", networks_array());
  return ok_reply(o);
}

kdp_net_reply_t kdp_net_set(const cJSON *req) {
  const char *ssid = str_field(req, "ssid");
  if (ssid == NULL || !pure_wifi_ssid_valid(ssid)) {
    return err_reply("INVALID_ARGUMENT", "SSID must be 1-%d characters, no control codes",
                     PURE_SSID_MAX);
  }

  const char *sec_name = str_field(req, "security");
  const net_security_t security = net_security_parse(sec_name);
  const char *passphrase = str_field(req, "password");

  /* The keep-what-is-stored case. NETWORK_LIST only ever handed the host a
   * mask, so an edit that changes autoJoin has nothing to put in `password`.
   * A host that echoes the mask back is doing the same thing, and must not
   * have the mask stored as a passphrase. */
  const bool masked = passphrase != NULL && strcmp(passphrase, MASKED_PASSWORD) == 0;
  if (masked) passphrase = NULL;

  const bool keeps_stored = wifi_creds_has_password(ssid);
  if (!pure_wifi_passphrase_ok(passphrase, security == NET_SEC_OPEN, keeps_stored)) {
    if (security == NET_SEC_OPEN) {
      return err_reply("INVALID_ARGUMENT", "An open network takes no passphrase");
    }
    return err_reply("INVALID_ARGUMENT", "WPA passphrase must be %d-%d characters",
                     PURE_WPA_PASSPHRASE_MIN, PURE_WPA_PASSPHRASE_MAX);
  }

  const cJSON *jauto = cJSON_GetObjectItem(req, "autoJoin");
  const bool auto_join = cJSON_IsBool(jauto) ? cJSON_IsTrue(jauto) : true;

  const esp_err_t err = wifi_creds_set(ssid, passphrase, security, auto_join);
  if (err == ESP_ERR_NO_MEM) {
    return err_reply("STORAGE_ERROR", "The camera remembers at most %d networks",
                     WIFI_CREDS_MAX);
  }
  if (err != ESP_OK) return err_reply("STORAGE_ERROR", "Could not store the network");

  /* Deliberately no passphrase and no length in the log line. A length is
   * not nothing. */
  klog("P4", "wifi network saved: %s", ssid);

  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return err_reply("INTERNAL_ERROR", "Could not build the reply");
  cJSON_AddBoolToObject(o, "ok", true);
  cJSON_AddItemToObject(o, "networks", networks_array());
  return ok_reply(o);
}

kdp_net_reply_t kdp_net_delete(const cJSON *req) {
  const char *ssid = str_field(req, "ssid");
  if (ssid == NULL) return err_reply("INVALID_ARGUMENT", "Expected {\"ssid\":\"...\"}");

  const esp_err_t err = wifi_creds_delete(ssid);
  if (err == ESP_ERR_NOT_FOUND) {
    /* Say so rather than reporting a success that removed nothing — a host
     * that believes it forgot a network the camera will still auto-join has
     * been told something false. */
    return err_reply("INVALID_ARGUMENT", "No saved network %s", ssid);
  }
  if (err != ESP_OK) return err_reply("STORAGE_ERROR", "Could not remove the network");

  klog("P4", "wifi network removed: %s", ssid);

  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return err_reply("INTERNAL_ERROR", "Could not build the reply");
  cJSON_AddBoolToObject(o, "ok", true);
  cJSON_AddItemToObject(o, "networks", networks_array());
  return ok_reply(o);
}

kdp_net_reply_t kdp_net_status(void) {
  net_status_t net;
  net_link_status(&net, now_ms());

  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return err_reply("INTERNAL_ERROR", "Could not build the reply");

  /* The three-value field Studio's NetworkStatus already reads. Only
   * IP_READY is `connected`; association without an address is `connecting`,
   * because a camera that says connected while DNS would fail has lied to
   * both the user and its own upload queue. */
  cJSON_AddStringToObject(o, "state", net_wire_state(net.state));
  if (net.ssid[0] != '\0') {
    cJSON_AddStringToObject(o, "ssid", net.ssid);
  } else {
    cJSON_AddNullToObject(o, "ssid");
  }
  if (net.ip[0] != '\0') {
    cJSON_AddStringToObject(o, "ip", net.ip);
  } else {
    cJSON_AddNullToObject(o, "ip");
  }
  /* null, not 0. 0 dBm is a real and excellent signal level, so reporting it
   * for "unknown" would show a full-strength bar with no radio. */
  if (net.rssi != 0) {
    cJSON_AddNumberToObject(o, "rssi", net.rssi);
  } else {
    cJSON_AddNullToObject(o, "rssi");
  }
  if (net.since_ms > 0) {
    cJSON_AddNumberToObject(o, "since", (double)net.since_ms);
  } else {
    cJSON_AddNullToObject(o, "since");
  }
  /* `internet` means a request would actually reach the API. Association is
   * not that. */
  cJSON_AddBoolToObject(o, "internet", net_link_can_upload(&net));

  /* Beyond the Studio interface. Extra keys are safe — the group's consumers
   * read known fields — and these are what make the difference between "no
   * radio" and "radio fitted, no route to it" visible instead of collapsed
   * into `disconnected`. This is the whole point of the D4 V1 UI fix. */
  cJSON_AddBoolToObject(o, "radioFitted", net.radio_fitted);
  cJSON_AddBoolToObject(o, "radioRouted", net.radio_routed);
  cJSON_AddStringToObject(o, "radioState", net_state_name(net.state));
  cJSON_AddStringToObject(o, "reason", net_reason_name(net.reason));
  if (net.channel != 0) {
    cJSON_AddNumberToObject(o, "channel", net.channel);
  } else {
    cJSON_AddNullToObject(o, "channel");
  }
  if (net.c6_version[0] != '\0') {
    cJSON_AddStringToObject(o, "c6Firmware", net.c6_version);
  } else {
    /* null rather than "unknown": nothing has ever answered a handshake, so
     * there is no version to be unsure about. */
    cJSON_AddNullToObject(o, "c6Firmware");
  }
  cJSON_AddNumberToObject(o, "transportErrors", net.transport_errors);
  cJSON_AddNumberToObject(o, "reconnects", net.reconnects);
  cJSON_AddNumberToObject(o, "savedNetworks", (double)wifi_creds_count());
  if (net.detail[0] != '\0') {
    char safe[NET_DETAIL_LEN];
    cJSON_AddStringToObject(o, "detail", rq_redact(safe, sizeof safe, net.detail));
  } else {
    cJSON_AddNullToObject(o, "detail");
  }
  return ok_reply(o);
}

/* ------------------------------------------------------------------ */
/* ROLL_*                                                             */
/* ------------------------------------------------------------------ */

kdp_net_reply_t kdp_net_roll_status(void) {
  cJSON *o = roll_view();
  return ok_reply(o);
}

kdp_net_reply_t kdp_net_roll_create(const cJSON *req) {
  (void)req;
  if (roll_state_active()) {
    roll_state_t roll;
    roll_state_get(&roll);
    return err_reply("INVALID_STATE", "Already on roll %s", roll.slug);
  }
  /* Creating a Roll is `POST /api/device/rolls`, and there is no route to the
   * API. Refusing with the radio's actual reason is the honest answer;
   * inventing a rollId the server has never heard of would produce a QR code
   * that sends a guest at a party to a 404. */
  return no_network("ROLL_CREATE");
}

kdp_net_reply_t kdp_net_roll_join(const cJSON *req) {
  if (roll_state_active()) {
    roll_state_t roll;
    roll_state_get(&roll);
    return err_reply("INVALID_STATE", "Already on roll %s", roll.slug);
  }

  /* Two forms, and the difference is whether the camera has to resolve
   * anything itself.
   *
   * A published assignment carries rollId, guestUrl and role already
   * resolved: Studio has internet, so it asked the API and is handing the
   * camera the answer. That needs no radio and is the path that works today.
   *
   * A bare {slug} requires POST /api/device/rolls/join to turn a slug into a
   * rollId and a guestUrl. The camera cannot do that, and must not guess. */
  const char *slug = str_field(req, "slug");
  if (slug == NULL) slug = str_field(req, "code"); /* `code` is an accepted alias */
  const char *roll_id = str_field(req, "rollId");
  const char *guest_url = str_field(req, "guestUrl");

  if (slug == NULL) {
    return err_reply("INVALID_ARGUMENT", "Expected {\"slug\":\"...\"}");
  }
  if (!roll_slug_valid(slug)) {
    return err_reply("INVALID_ARGUMENT", "Roll code must be a 6-character code or a slug");
  }

  if (roll_id == NULL || guest_url == NULL) {
    return no_network("Resolving a roll code");
  }

  roll_role_t role = ROLL_ROLE_GUEST;
  const char *role_name = str_field(req, "role");
  if (role_name != NULL && !roll_role_parse(role_name, &role)) {
    return err_reply("INVALID_ARGUMENT", "role must be \"host\" or \"guest\"");
  }

  const char *name = str_field(req, "name");
  const esp_err_t err = roll_state_assign(roll_id, slug, guest_url, name == NULL ? "" : name,
                                          role, clock_now_ms());
  if (err == ESP_ERR_INVALID_ARG) {
    return err_reply("INVALID_ARGUMENT", "The roll assignment is not usable");
  }
  if (err != ESP_OK) return err_reply("STORAGE_ERROR", "Could not store the roll");

  klog("P4", "roll joined: %s", slug);
  return ok_reply(roll_view());
}

kdp_net_reply_t kdp_net_roll_leave(void) {
  const esp_err_t err = roll_state_leave();
  if (err == ESP_ERR_NOT_FOUND) {
    return err_reply("INVALID_STATE", "Not on a roll");
  }
  if (err != ESP_OK) return err_reply("STORAGE_ERROR", "Could not clear the roll");

  klog("P4", "roll left");

  cJSON *o = roll_view();
  if (o != NULL) cJSON_AddBoolToObject(o, "ok", true);
  return ok_reply(o);
}

/* ------------------------------------------------------------------ */
/* UPLOAD_*                                                           */
/* ------------------------------------------------------------------ */

kdp_net_reply_t kdp_net_upload_status(void) { return ok_reply(queue_object()); }

kdp_net_reply_t kdp_net_upload_retry(void) {
  const int retried = upload_queue_retry_all();
  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return err_reply("INTERNAL_ERROR", "Could not build the reply");
  cJSON_AddBoolToObject(o, "ok", true);
  cJSON_AddNumberToObject(o, "retried", retried);
  cJSON_AddItemToObject(o, "queue", queue_object());
  return ok_reply(o);
}

/* Count the frames a capture actually holds, and whether it has a thumbnail.
 * Read from the card rather than from META.JSON's `frameCount`: the queue must
 * upload what is there, and a document that disagrees with the directory is
 * exactly the case where fabricating a missing frame would happen. */
static int capture_frames_on_card(const char *uuid, bool *thumb_out) {
  char path[200];
  struct stat st;

  snprintf(path, sizeof path, "/sdcard/KINO/CAPTURES/%s/THUMB.JPG", uuid);
  *thumb_out = stat(path, &st) == 0 && st.st_size > 0;

  int frames = 0;
  for (int i = 1; i <= STORAGE_CAPTURE_FRAMES; i++) {
    snprintf(path, sizeof path, "/sdcard/KINO/CAPTURES/%s/C%d.JPG", uuid, i);
    if (stat(path, &st) == 0 && st.st_size > 0) frames++;
  }
  return frames;
}

kdp_net_reply_t kdp_net_upload_enqueue(const cJSON *req) {
  const char *id = str_field(req, "captureId");
  /* The gallery's capture id IS the folder name, which is the capture UUID.
   * Reject anything that is not that shape before it reaches a path: this
   * value is concatenated into a filesystem path. */
  if (id == NULL || !pure_is_capture_dirname(id)) {
    return err_reply("INVALID_ARGUMENT", "Expected {\"captureId\":\"<capture uuid>\"}");
  }

  if (!roll_state_active()) {
    /* The contract's own words: only meaningful while the device is on a
     * Roll, because there is nowhere else for the bytes to go. */
    return err_reply("INVALID_STATE", "Not on a roll — there is nowhere to upload to");
  }

  char meta[200];
  snprintf(meta, sizeof meta, "/sdcard/KINO/CAPTURES/%s/META.JSON", id);
  struct stat st;
  if (stat(meta, &st) != 0) {
    /* No META.JSON means the commit never finished, so this is not a capture
     * yet. storage.c's orphan sweep owns that folder, not the queue. */
    return err_reply("NOT_FOUND", "No committed capture %s", id);
  }

  bool thumb = false;
  const int frames = capture_frames_on_card(id, &thumb);

  const esp_err_t err = upload_queue_enqueue(id, frames, thumb);
  if (err != ESP_OK) return err_reply("STORAGE_ERROR", "Could not queue the capture");

  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return err_reply("INTERNAL_ERROR", "Could not build the reply");
  cJSON_AddBoolToObject(o, "ok", true);
  cJSON_AddStringToObject(o, "captureId", id);
  cJSON_AddItemToObject(o, "queue", queue_object());
  return ok_reply(o);
}
