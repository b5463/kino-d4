/*
 * The authenticated JSON client, and the device credential. See roll_client.h
 * for why this is separate from the procedures that use it.
 *
 * Nothing here has been run on hardware. This camera has never registered with
 * a Roll server.
 */
#include "roll_client.h"

#include <stdio.h>
#include <string.h>

#ifndef KINO_RADIO

/*
 * The default build has no HTTP client to wrap, so the only thing this module
 * can answer is why. `roll_api_ready()` lives here rather than in roll_api.c
 * because "is there a usable client" is this file's question in both builds.
 */
bool roll_api_ready(char *why, size_t cap) {
  snprintf(why, cap, "no radio in this build");
  return false;
}

#else /* KINO_RADIO */

#include "esp_log.h"
#include "esp_mac.h"
#include "klog.h"
#include "roll_state.h"

static const char *TAG = "rollclient";

bool roll_api_ready(char *why, size_t cap) { return roll_http_ready(why, cap); }

/* ------------------------------------------------------------------ */
/* JSON plumbing                                                      */
/* ------------------------------------------------------------------ */

cJSON *roll_client_call(const char *method, const char *path, const char *body,
                        roll_http_out_t *out) {
  char response[ROLL_HTTP_MAX_RESPONSE];
  const roll_http_req_t req = {
      .method = method,
      .path = path,
      .json_body = body,
      .authenticate = true,
      .response = response,
      .response_cap = sizeof response,
  };
  roll_http_perform(&req, out);
  if (out->status < 200 || out->status >= 300) return NULL;
  return cJSON_Parse(response);
}

const char *roll_client_str(const cJSON *o, const char *key) {
  const cJSON *v = cJSON_GetObjectItem(o, key);
  return (cJSON_IsString(v) && v->valuestring != NULL) ? v->valuestring : NULL;
}

void roll_client_copy(char *dst, size_t cap, const cJSON *o, const char *key) {
  const char *v = roll_client_str(o, key);
  snprintf(dst, cap, "%s", v != NULL ? v : "");
}

/* ------------------------------------------------------------------ */
/* Registration                                                       */
/* ------------------------------------------------------------------ */

/*
 * The serial is derived from the factory MAC, the same derivation main.c uses
 * for `kdp_identity_t.serial`. It is a fact about the chip rather than stored
 * state, which is why deriving it twice is safe; registration is
 * first-write-wins per serial, so two derivations that disagreed would show up
 * as a second device rather than as a silent mismatch.
 */
bool roll_client_ensure_registered(roll_http_out_t *out) {
  if (roll_state_has_credential()) {
    out->status = 200;
    return true;
  }

  uint8_t mac[6] = {0};
  (void)esp_efuse_mac_get_default(mac);
  char serial[16];
  snprintf(serial, sizeof serial, "KD4-%02X%02X%02X", mac[3], mac[4], mac[5]);

  cJSON *body = cJSON_CreateObject();
  if (body == NULL) {
    out->status = 0;
    rq_redact(out->detail, sizeof out->detail, "no memory to register");
    return false;
  }
  cJSON_AddStringToObject(body, "serial", serial);
  cJSON_AddStringToObject(body, "product", "KINO D4");
  cJSON_AddStringToObject(body, "hardwareRevision", "v1");
  cJSON_AddStringToObject(body, "name", serial);
  char *text = cJSON_PrintUnformatted(body);
  cJSON_Delete(body);
  if (text == NULL) {
    out->status = 0;
    rq_redact(out->detail, sizeof out->detail, "no memory to register");
    return false;
  }

  /* Not authenticated: this is the call that produces the credential. */
  char response[ROLL_HTTP_MAX_RESPONSE];
  const roll_http_req_t req = {
      .method = "POST",
      .path = "/api/studio/devices/register",
      .json_body = text,
      .authenticate = false,
      .response = response,
      .response_cap = sizeof response,
  };
  roll_http_perform(&req, out);
  cJSON_free(text);

  if (out->status < 200 || out->status >= 300) return false;

  cJSON *reply = cJSON_Parse(response);
  /* The token is in `response` and in `reply` and in nothing else. Both are
   * wiped before this returns. */
  bool ok = false;
  if (reply != NULL) {
    const char *device_id = roll_client_str(reply, "deviceId");
    const char *token = roll_client_str(reply, "deviceToken");
    if (device_id != NULL && token != NULL) {
      ok = roll_state_set_credential(device_id, token) == ESP_OK;
      if (!ok) rq_redact(out->detail, sizeof out->detail, "the credential would not store");
    }
    cJSON_Delete(reply);
  }
  memset(response, 0, sizeof response);

  if (!ok && out->detail[0] == '\0') {
    rq_redact(out->detail, sizeof out->detail, "the register reply had no credential");
  }
  if (ok) {
    klog("P4", "device registered as %s", serial);
    ESP_LOGI(TAG, "registered %s", serial);
  }
  return ok;
}

#endif /* KINO_RADIO */
