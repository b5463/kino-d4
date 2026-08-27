/*
 * The Roll device API. See roll_api.h for what this module deliberately does
 * not decide, and docs/roll/ROLL_DEVICE_CONTRACT.md for the procedure.
 *
 * Nothing here has been run on hardware. No capture has ever reached a Roll
 * from a camera.
 */
#include "roll_api.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef KINO_RADIO

/* ------------------------------------------------------------------ */
/* The default build                                                  */
/* ------------------------------------------------------------------ */

/*
 * No radio is linked, so there is nothing to attempt. Status 0 rather than an
 * invented HTTP code: rq_classify_status(0) is "transient", which keeps the
 * job on the card and the queue idle instead of parking a photograph for a
 * reason the user could fix by flashing a different build.
 *
 * The rest of the queue — reconciliation, resume after reboot, bounded retry,
 * persistence before every network operation — runs exactly as it does in the
 * radio build, which is what makes the host tests worth having.
 */
void roll_api_step(const rq_job_t *job, rq_step_t step, roll_step_result_t *out) {
  (void)job;
  (void)step;
  memset(out, 0, sizeof *out);
  rq_redact(out->detail, sizeof out->detail, "no radio in this build");
}

bool roll_api_create(const char *title, roll_api_assoc_t *out) {
  (void)title;
  memset(out, 0, sizeof *out);
  rq_redact(out->detail, sizeof out->detail, "no radio in this build");
  return false;
}

bool roll_api_join(const char *slug, roll_api_assoc_t *out) {
  (void)slug;
  memset(out, 0, sizeof *out);
  rq_redact(out->detail, sizeof out->detail, "no radio in this build");
  return false;
}

bool roll_api_ready(char *why, size_t cap) {
  snprintf(why, cap, "no radio in this build");
  return false;
}

#else /* KINO_RADIO */

#include "cJSON.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "klog.h"
#include "roll_http.h"
#include "storage.h"
#include "upload_store.h"

static const char *TAG = "rollapi";

/** Same value and the same reason as upload_queue.c's. */
#define CARD_WAIT_MS 200

/** The contract's part ceiling. The server reports its own `partSize` and this
 * is only the clamp: a server that asked for 64 MiB parts would otherwise ask
 * this device to hold one. */
#define PART_SIZE_MAX (5 * 1024 * 1024)

bool roll_api_ready(char *why, size_t cap) { return roll_http_ready(why, cap); }

/* ------------------------------------------------------------------ */
/* JSON plumbing                                                      */
/* ------------------------------------------------------------------ */

/** POST or GET with a JSON body, returning the parsed reply or NULL. The
 * caller always gets a status in `out` whether or not the body parsed. */
static cJSON *call_json(const char *method, const char *path, const char *body,
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

static const char *json_str(const cJSON *o, const char *key) {
  const cJSON *v = cJSON_GetObjectItem(o, key);
  return (cJSON_IsString(v) && v->valuestring != NULL) ? v->valuestring : NULL;
}

static void copy_field(char *dst, size_t cap, const cJSON *o, const char *key) {
  const char *v = json_str(o, key);
  snprintf(dst, cap, "%s", v != NULL ? v : "");
}

/* ------------------------------------------------------------------ */
/* Registration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Register this body once and store the credential.
 *
 * The token comes back exactly once — the server keeps only its SHA-256 — so
 * the write to NVS is the whole point of this function and a failure to store
 * it is worse than a failure to obtain it.
 *
 * The serial is derived from the factory MAC, the same derivation main.c uses
 * for `kdp_identity_t.serial`. It is a fact about the chip rather than stored
 * state, which is why deriving it twice is safe; registration is
 * first-write-wins per serial, so two derivations that disagreed would show up
 * as a second device rather than a silent mismatch.
 */
static bool ensure_registered(roll_http_out_t *out) {
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
    const char *device_id = json_str(reply, "deviceId");
    const char *token = json_str(reply, "deviceToken");
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
  if (ok) klog("P4", "device registered as %s", serial);
  return ok;
}

/* ------------------------------------------------------------------ */
/* The capture document                                               */
/* ------------------------------------------------------------------ */

/** Read a file off the card into a NUL-terminated buffer the caller frees. */
static char *read_card_file(const char *path, size_t cap) {
  if (!storage_acquire(STORAGE_USER_UPLOAD, CARD_WAIT_MS)) return NULL;
  char *buf = NULL;
  FILE *f = fopen(path, "rb");
  if (f != NULL) {
    buf = malloc(cap + 1);
    if (buf != NULL) {
      const size_t n = fread(buf, 1, cap, f);
      buf[n] = '\0';
      if (n == 0) {
        free(buf);
        buf = NULL;
      }
    }
    fclose(f);
  }
  storage_release(STORAGE_USER_UPLOAD);
  return buf;
}

/**
 * The `kino.capture` document to register, from META.JSON on the card.
 *
 * The card is the truth, so the document is the one written at commit time
 * rather than one rebuilt here — a second builder would be a second answer to
 * "what was this photograph". Three fields are patched, and only three:
 *
 *   - `rollId`, which META.JSON writes as null because the capture did not
 *     know where it would go;
 *   - `deviceId`, which is empty at commit time on a camera that had not yet
 *     registered;
 *   - `frameCount`, from the files the queue is actually going to upload. The
 *     contract requires frameIndex 1..N contiguous, and a document claiming a
 *     frame that is not on the card would promise one that never arrives.
 *
 * `mode` is forced to "single" for a one-frame capture, because Roll renders
 * Wiggle controls from that field and a single frame with Wiggle controls is a
 * broken page on a guest's phone.
 */
static char *capture_document(const rq_job_t *job) {
  char path[200];
  upload_store_path(job->uuid, "META.JSON", path, sizeof path);
  char *text = read_card_file(path, 4096);
  if (text == NULL) return NULL;

  cJSON *doc = cJSON_Parse(text);
  free(text);
  if (doc == NULL) return NULL;

  char device_id[ROLL_DEVICE_ID_LEN] = {0};
  (void)roll_state_device_id(device_id, sizeof device_id);

  cJSON_DeleteItemFromObject(doc, "rollId");
  cJSON_AddStringToObject(doc, "rollId", job->roll_id);
  cJSON_DeleteItemFromObject(doc, "deviceId");
  cJSON_AddStringToObject(doc, "deviceId", device_id);
  cJSON_DeleteItemFromObject(doc, "frameCount");
  cJSON_AddNumberToObject(doc, "frameCount", job->frame_count);
  if (job->frame_count == 1) {
    cJSON_DeleteItemFromObject(doc, "mode");
    cJSON_AddStringToObject(doc, "mode", "single");
  }

  char *out = cJSON_PrintUnformatted(doc);
  cJSON_Delete(doc);
  return out;
}

/* ------------------------------------------------------------------ */
/* Steps                                                              */
/* ------------------------------------------------------------------ */

static void step_register(const rq_job_t *job, roll_step_result_t *res) {
  roll_http_out_t http;
  memset(&http, 0, sizeof http);
  if (!ensure_registered(&http)) {
    res->status = http.status;
    memcpy(res->detail, http.detail, sizeof res->detail);
    return;
  }

  char *doc = capture_document(job);
  if (doc == NULL) {
    /* No META.JSON, or it will not parse. The photograph is still on the card
     * and this is not a network fault, so it is reported as one the queue can
     * re-read: rq_classify_status(0) keeps the job. */
    res->status = 0;
    rq_redact(res->detail, sizeof res->detail, "META.JSON unreadable on the card");
    return;
  }

  char path[128];
  snprintf(path, sizeof path, "/api/device/rolls/%s/captures", job->roll_id);
  cJSON *reply = call_json("POST", path, doc, &http);
  cJSON_free(doc);

  res->status = http.status;
  memcpy(res->detail, http.detail, sizeof res->detail);
  if (reply != NULL) {
    /* 201 created and 200 replay both carry the same captureId for the same
     * captureUuid, which is what makes a reboot mid-upload safe. */
    copy_field(res->capture_id, sizeof res->capture_id, reply, "captureId");
    cJSON_Delete(reply);
  }
  if (res->capture_id[0] == '\0' && res->status >= 200 && res->status < 300) {
    res->status = 0;
    rq_redact(res->detail, sizeof res->detail, "the capture reply had no captureId");
  }
}

/**
 * One asset: init, then parts, then complete.
 *
 * `alreadyComplete` is the resume path and it is the cheap one: a reboot in
 * the middle of frame three re-inits every asset and the server says three of
 * them are done.
 */
static void step_asset(const rq_job_t *job, const char *role, int frame_index,
                       const char *filename, roll_step_result_t *res) {
  char file_path[200];
  upload_store_path(job->uuid, filename, file_path, sizeof file_path);

  const size_t bytes = roll_http_file_size(file_path);
  if (bytes == 0) {
    res->status = 0;
    rq_redact(res->detail, sizeof res->detail, "the asset is not on the card");
    return;
  }

  char sha[65];
  if (!roll_http_sha256_file(file_path, 0, bytes, sha, sizeof sha)) {
    res->status = 0;
    rq_redact(res->detail, sizeof res->detail, "could not hash the asset; card busy");
    return;
  }

  cJSON *body = cJSON_CreateObject();
  if (body == NULL) {
    res->status = 0;
    rq_redact(res->detail, sizeof res->detail, "no memory for the asset init");
    return;
  }
  cJSON_AddStringToObject(body, "role", role);
  if (frame_index > 0) cJSON_AddNumberToObject(body, "frameIndex", frame_index);
  cJSON_AddStringToObject(body, "mime", "image/jpeg");
  cJSON_AddNumberToObject(body, "bytes", (double)bytes);
  cJSON_AddStringToObject(body, "sha256", sha);
  char *text = cJSON_PrintUnformatted(body);
  cJSON_Delete(body);
  if (text == NULL) {
    res->status = 0;
    rq_redact(res->detail, sizeof res->detail, "no memory for the asset init");
    return;
  }

  char path[160];
  snprintf(path, sizeof path, "/api/device/captures/%s/assets/init", job->capture_id);
  roll_http_out_t http;
  cJSON *reply = call_json("POST", path, text, &http);
  cJSON_free(text);

  res->status = http.status;
  memcpy(res->detail, http.detail, sizeof res->detail);
  if (reply == NULL) return;

  char upload_id[64];
  copy_field(upload_id, sizeof upload_id, reply, "uploadId");
  const cJSON *jsize = cJSON_GetObjectItem(reply, "partSize");
  size_t part_size = cJSON_IsNumber(jsize) ? (size_t)jsize->valuedouble : PART_SIZE_MAX;
  const bool done = cJSON_IsTrue(cJSON_GetObjectItem(reply, "alreadyComplete"));
  cJSON_Delete(reply);

  if (done) {
    res->status = 200;
    return;
  }
  if (upload_id[0] == '\0') {
    res->status = 0;
    rq_redact(res->detail, sizeof res->detail, "the asset init returned no uploadId");
    return;
  }
  if (part_size == 0 || part_size > PART_SIZE_MAX) part_size = PART_SIZE_MAX;

  int part_no = 1;
  for (size_t offset = 0; offset < bytes; offset += part_size, part_no++) {
    const size_t len = bytes - offset < part_size ? bytes - offset : part_size;
    snprintf(path, sizeof path, "/api/device/uploads/%s/parts/%d", upload_id, part_no);
    roll_http_put_file(path, file_path, offset, len, &http);
    res->status = http.status;
    memcpy(res->detail, http.detail, sizeof res->detail);
    if (http.status < 200 || http.status >= 300) return;
  }

  snprintf(path, sizeof path, "/api/device/uploads/%s/complete", upload_id);
  cJSON *fin = call_json("POST", path, NULL, &http);
  if (fin != NULL) cJSON_Delete(fin);
  res->status = http.status;
  memcpy(res->detail, http.detail, sizeof res->detail);
}

static void step_complete(const rq_job_t *job, roll_step_result_t *res) {
  char path[160];
  snprintf(path, sizeof path, "/api/device/captures/%s/complete", job->capture_id);
  roll_http_out_t http;
  cJSON *reply = call_json("POST", path, NULL, &http);
  if (reply != NULL) cJSON_Delete(reply);
  res->status = http.status;
  memcpy(res->detail, http.detail, sizeof res->detail);
}

void roll_api_step(const rq_job_t *job, rq_step_t step, roll_step_result_t *out) {
  memset(out, 0, sizeof *out);

  char why[RQ_ERROR_LEN];
  if (!roll_http_ready(why, sizeof why)) {
    rq_redact(out->detail, sizeof out->detail, why);
    return; /* status stays 0: transient, keep the job */
  }

  switch (step.kind) {
    case RQ_STEP_REGISTER:
      step_register(job, out);
      break;
    case RQ_STEP_UPLOAD_THUMB:
      step_asset(job, "thumb", 0, "THUMB.JPG", out);
      break;
    case RQ_STEP_UPLOAD_FRAME: {
      char filename[12];
      snprintf(filename, sizeof filename, "C%d.JPG", step.frame_index);
      step_asset(job, "original-frame", step.frame_index, filename, out);
      break;
    }
    case RQ_STEP_COMPLETE_CAPTURE:
      step_complete(job, out);
      break;
    default:
      /* rq_next_step() does not hand out NOTHING or WAIT_BACKOFF to a worker
       * that is about to make a call, so this is a caller bug rather than a
       * network event. Reported as transient, which costs one backoff. */
      rq_redact(out->detail, sizeof out->detail, "nothing to do for this step");
      break;
  }
  ESP_LOGI(TAG, "step %d for %.8s -> %d", (int)step.kind, job->uuid, out->status);
}

/* ------------------------------------------------------------------ */
/* Roll association                                                   */
/* ------------------------------------------------------------------ */

static bool association(const char *path, cJSON *body, const char *slug_fallback,
                        roll_api_assoc_t *out) {
  memset(out, 0, sizeof *out);

  roll_http_out_t http;
  memset(&http, 0, sizeof http);
  if (!ensure_registered(&http)) {
    out->status = http.status;
    memcpy(out->detail, http.detail, sizeof out->detail);
    cJSON_Delete(body);
    return false;
  }

  char *text = cJSON_PrintUnformatted(body);
  cJSON_Delete(body);
  if (text == NULL) {
    rq_redact(out->detail, sizeof out->detail, "no memory for the roll request");
    return false;
  }

  cJSON *reply = call_json("POST", path, text, &http);
  cJSON_free(text);
  out->status = http.status;
  memcpy(out->detail, http.detail, sizeof out->detail);
  if (reply == NULL) {
    if (out->detail[0] == '\0') {
      rq_redact(out->detail, sizeof out->detail, "the roll reply would not parse");
    }
    return false;
  }

  copy_field(out->roll_id, sizeof out->roll_id, reply, "rollId");
  copy_field(out->slug, sizeof out->slug, reply, "slug");
  copy_field(out->guest_url, sizeof out->guest_url, reply, "guestUrl");
  copy_field(out->name, sizeof out->name, reply, "title");
  if (out->name[0] == '\0') copy_field(out->name, sizeof out->name, reply, "name");
  cJSON_Delete(reply);

  /* The join reply does not always name the slug it resolved, and the camera
   * stores slugs verbatim (roll_state.h explains why upper-casing here would
   * be wrong), so the one the user typed is the fallback. */
  if (out->slug[0] == '\0' && slug_fallback != NULL) {
    snprintf(out->slug, sizeof out->slug, "%s", slug_fallback);
  }

  if (out->roll_id[0] == '\0') {
    rq_redact(out->detail, sizeof out->detail, "the roll reply had no rollId");
    return false;
  }
  return true;
}

bool roll_api_create(const char *title, roll_api_assoc_t *out) {
  cJSON *body = cJSON_CreateObject();
  if (body == NULL) {
    memset(out, 0, sizeof *out);
    rq_redact(out->detail, sizeof out->detail, "no memory for the roll request");
    return false;
  }
  cJSON_AddStringToObject(body, "title", title != NULL ? title : "");
  return association("/api/device/rolls", body, NULL, out);
}

bool roll_api_join(const char *slug, roll_api_assoc_t *out) {
  cJSON *body = cJSON_CreateObject();
  if (body == NULL) {
    memset(out, 0, sizeof *out);
    rq_redact(out->detail, sizeof out->detail, "no memory for the roll request");
    return false;
  }
  cJSON_AddStringToObject(body, "slug", slug != NULL ? slug : "");
  return association("/api/device/rolls/join", body, slug, out);
}

#endif /* KINO_RADIO */
