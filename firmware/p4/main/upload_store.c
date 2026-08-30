/**
 * UPLOAD.JSON read and write. See upload_store.h for the boundary and why it
 * is here; roll_queue.h for the durability model this implements.
 *
 * No ESP-IDF header beyond cJSON, no FreeRTOS, no clock, no logging. The
 * caller logs, because the caller is the one with context — and because that
 * is what lets this file run in the host tests.
 */
#include "upload_store.h"

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "cJSON.h"

void upload_store_path(const char *uuid, const char *name, char *out, size_t cap) {
  snprintf(out, cap, UPLOAD_STORE_DIR "/%s/%s", uuid, name);
}

bool upload_store_has_file(const char *uuid, const char *name) {
  char path[96];
  upload_store_path(uuid, name, path, sizeof path);
  struct stat st;
  return stat(path, &st) == 0;
}

/* ------------------------------------------------------------------ */
/* Encode                                                             */
/* ------------------------------------------------------------------ */

/** Serialise `job` exactly as its fields stand, with no bound applied. */
static char *encode_raw(const rq_job_t *job) {
  cJSON *j = cJSON_CreateObject();
  if (j == NULL) return NULL;

  cJSON_AddNumberToObject(j, "formatVersion", RQ_FORMAT_VERSION);
  cJSON_AddStringToObject(j, "captureUuid", job->uuid);
  cJSON_AddStringToObject(j, "captureId", job->capture_id);
  cJSON_AddStringToObject(j, "rollId", job->roll_id);
  cJSON_AddNumberToObject(j, "state", (double)job->state);
  /* The state name travels beside the number so the file means something to a
   * person with a card reader. Nothing parses it back. */
  cJSON_AddStringToObject(j, "stateName", rq_state_name(job->state));
  cJSON_AddNumberToObject(j, "frameCount", job->frame_count);
  cJSON_AddBoolToObject(j, "thumbPresent", job->thumb_present);
  cJSON_AddBoolToObject(j, "thumbDone", job->thumb_done);
  cJSON *frames = cJSON_AddArrayToObject(j, "frameDone");
  for (int i = 0; frames != NULL && i < job->frame_count && i < RQ_MAX_FRAMES; i++) {
    cJSON_AddItemToArray(frames, cJSON_CreateBool(job->frame_done[i]));
  }
  cJSON_AddNumberToObject(j, "attempts", (double)job->attempts);
  cJSON_AddNumberToObject(j, "rereadAttempts", (double)job->reread_attempts);
  cJSON_AddNumberToObject(j, "nextAttemptMs", (double)job->next_attempt_ms);
  cJSON_AddStringToObject(j, "lastError", job->last_error);

  char *text = cJSON_PrintUnformatted(j);
  cJSON_Delete(j);
  return text;
}

char *upload_store_encode(const rq_job_t *job) {
  if (job == NULL) return NULL;

  char *text = encode_raw(job);
  if (text == NULL) return NULL;
  if (strlen(text) <= UPLOAD_STORE_MAX_BYTES) return text;

  /*
   * A record past the bound is one upload_store_decode() refuses on the way
   * back, so the job it describes can never be read again: every boot rebuilds
   * it from the card and every boot re-registers the capture.
   *
   * The field that gets a record there is lastError, and only through the
   * encoder. It is 95 bytes, but cJSON escapes a control byte as `\u00XX` —
   * six characters for one — so 95 control bytes are 570 bytes on their own
   * and the ids beside them no longer fit under 768. roll_http.c sanitises the
   * text before it becomes an error, which is where that should be stopped;
   * this is the backstop for every other path into the field, and it is here
   * rather than in upload_store_save() so the host test can reach it.
   *
   * The error text is what gets shortened because it is the only field that is
   * a diagnostic. Per-frame progress, the ids and the state all decide whether
   * a photograph is uploaded twice. Halved until it fits, and an empty
   * lastError is tried before giving up.
   */
  rq_job_t trimmed = *job;
  size_t keep = sizeof trimmed.last_error - 1;
  while (strlen(text) > UPLOAD_STORE_MAX_BYTES && keep > 0) {
    keep /= 2;
    trimmed.last_error[keep] = '\0';
    cJSON_free(text);
    text = encode_raw(&trimmed);
    if (text == NULL) return NULL;
  }
  /* Still over with no error text at all means the ids alone are past the
   * bound, which is a field-width bug and not something to fix by dropping the
   * record. Returned anyway: an unreadable record still reconciles as REPAIR,
   * and no record at all reconciles as ENQUEUE, which is worse. */
  return text;
}

/* ------------------------------------------------------------------ */
/* Decode                                                             */
/* ------------------------------------------------------------------ */

static void copy_str(const cJSON *j, const char *key, char *dst, size_t cap) {
  const cJSON *v = cJSON_GetObjectItem(j, key);
  if (cJSON_IsString(v) && v->valuestring != NULL) {
    snprintf(dst, cap, "%s", v->valuestring);
  }
}

static double read_num(const cJSON *j, const char *key) {
  const cJSON *v = cJSON_GetObjectItem(j, key);
  return cJSON_IsNumber(v) ? v->valuedouble : 0;
}

bool upload_store_decode(const char *text, size_t len, const char *uuid, rq_job_t *job) {
  if (text == NULL || uuid == NULL || job == NULL) return false;
  if (len == 0 || len > UPLOAD_STORE_MAX_BYTES) return false;

  cJSON *j = cJSON_ParseWithLength(text, len);
  if (j == NULL) return false;

  const cJSON *ver = cJSON_GetObjectItem(j, "formatVersion");
  const cJSON *state = cJSON_GetObjectItem(j, "state");
  const int st = cJSON_IsNumber(state) ? (int)state->valuedouble : -1;
  /* A HIGHER formatVersion is invalid, not "read it anyway" — the header says
   * why. An out-of-range state is the same class of answer: rq_next_step()
   * switches on it, so a number outside the enum has no defined next step. */
  if (!cJSON_IsNumber(ver) || ver->valuedouble > RQ_FORMAT_VERSION || st < 0 || st > RQ_FAILED) {
    cJSON_Delete(j);
    return false;
  }

  memset(job, 0, sizeof *job);
  job->state = (rq_state_t)st;
  /* The UUID comes from the directory the record was found in, never from the
   * file. The directory name is what the uploader reads bytes from, so a
   * captureUuid field disagreeing with it would be the wrong answer. */
  snprintf(job->uuid, sizeof job->uuid, "%s", uuid);
  copy_str(j, "captureId", job->capture_id, sizeof job->capture_id);
  copy_str(j, "rollId", job->roll_id, sizeof job->roll_id);
  copy_str(j, "lastError", job->last_error, sizeof job->last_error);

  job->frame_count = (int)read_num(j, "frameCount");
  if (job->frame_count < 0) job->frame_count = 0;
  if (job->frame_count > RQ_MAX_FRAMES) job->frame_count = RQ_MAX_FRAMES;
  job->attempts = (uint32_t)read_num(j, "attempts");
  job->reread_attempts = (uint32_t)read_num(j, "rereadAttempts");
  job->next_attempt_ms = (int64_t)read_num(j, "nextAttemptMs");
  job->thumb_present = cJSON_IsTrue(cJSON_GetObjectItem(j, "thumbPresent"));
  job->thumb_done = cJSON_IsTrue(cJSON_GetObjectItem(j, "thumbDone"));

  const cJSON *frames = cJSON_GetObjectItem(j, "frameDone");
  if (cJSON_IsArray(frames)) {
    int i = 0;
    const cJSON *e = NULL;
    cJSON_ArrayForEach(e, frames) {
      if (i >= RQ_MAX_FRAMES) break;
      job->frame_done[i++] = cJSON_IsTrue(e);
    }
  }

  cJSON_Delete(j);
  return true;
}

/* ------------------------------------------------------------------ */
/* Card I/O                                                           */
/* ------------------------------------------------------------------ */

bool upload_store_save(const rq_job_t *job) {
  char *text = upload_store_encode(job);
  if (text == NULL) return false;

  char tmp[96], dst[96];
  upload_store_path(job->uuid, UPLOAD_STORE_TEMP, tmp, sizeof tmp);
  upload_store_path(job->uuid, UPLOAD_STORE_RECORD, dst, sizeof dst);

  FILE *f = fopen(tmp, "wb");
  if (f == NULL) {
    cJSON_free(text);
    return false;
  }
  const size_t len = strlen(text);
  int failed = fwrite(text, 1, len, f) != len;
  failed |= fflush(f) != 0;
  failed |= fsync(fileno(f)) != 0;
  failed |= fclose(f) != 0;
  cJSON_free(text);
  if (failed) {
    unlink(tmp);
    return false;
  }

  /* The unlink() before the rename is not optional: FatFs `f_rename` fails when
   * the target exists, so a rename straight over UPLOAD.JSON would never land.
   * The window in which neither file exists is safe for the reason roll_queue.h
   * gives — META.JSON with no UPLOAD.JSON reconciles as ENQUEUE, and the server
   * is idempotent on captureUuid, so the cost is one redundant registration. */
  unlink(dst);
  if (rename(tmp, dst) != 0) {
    unlink(tmp);
    return false;
  }
  return true;
}

bool upload_store_load(const char *uuid, rq_job_t *job, bool *valid) {
  if (valid != NULL) *valid = false;
  if (uuid == NULL || job == NULL) return false;

  char path[96];
  upload_store_path(uuid, UPLOAD_STORE_RECORD, path, sizeof path);
  FILE *f = fopen(path, "rb");
  if (f == NULL) return false;

  /* One byte past the bound, so an oversized file is DETECTED rather than
   * silently truncated into something that parses. */
  char buf[UPLOAD_STORE_MAX_BYTES + 1];
  const size_t n = fread(buf, 1, sizeof buf, f);
  const int io_err = ferror(f);
  fclose(f);
  if (io_err) return true; /* the record exists but the card would not read it */

  const bool ok = upload_store_decode(buf, n, uuid, job);
  if (valid != NULL) *valid = ok;
  return true;
}

rq_reconcile_t upload_store_inspect(const char *uuid, const char *roll_id, int max_frames,
                                    rq_job_t *out) {
  if (uuid == NULL || out == NULL) return RQ_REC_IGNORE;

  rq_job_t loaded;
  bool valid = false;
  const bool has_job = upload_store_load(uuid, &loaded, &valid);
  const rq_reconcile_t action = rq_reconcile_action(upload_store_has_file(uuid, "META.JSON"),
                                                   has_job, valid, valid ? &loaded : NULL);
  if (action == RQ_REC_IGNORE) return RQ_REC_IGNORE;
  if (action == RQ_REC_RESUME) {
    *out = loaded;
    return action;
  }
  if (roll_id == NULL || roll_id[0] == '\0') return RQ_REC_IGNORE;

  int frames = 0;
  for (int i = 1; i <= max_frames && i <= RQ_MAX_FRAMES; i++) {
    char name[12];
    snprintf(name, sizeof name, "C%d.JPG", i);
    if (upload_store_has_file(uuid, name)) frames = i;
  }
  rq_job_init(out, uuid, roll_id, frames, upload_store_has_file(uuid, "THUMB.JPG"));
  return action;
}
