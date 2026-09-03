/**
 * UPLOAD.JSON read and write. See upload_store.h for the boundary and why it
 * is here; roll_queue.h for the durability model this implements.
 *
 * No ESP-IDF header beyond cJSON, no FreeRTOS, no clock, no logging. The
 * caller logs, because the caller is the one with context — and because that
 * is what lets this file run in the host tests.
 */
#include "upload_store.h"

#include <stdint.h>
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
  /* Which camera each position is, beside whether it landed. The two arrays
   * are the same length and read together: frameSlots [1,3,4] with frameDone
   * [true,false,false] means camera 1 is on the server and cameras 3 and 4
   * are next. Written only when the job knows its cameras; a record that
   * does not is one the reconciler still has to complete from META. */
  if (rq_job_has_slots(job)) {
    cJSON *slots = cJSON_AddArrayToObject(j, "frameSlots");
    for (int i = 0; slots != NULL && i < job->frame_count && i < RQ_MAX_FRAMES; i++) {
      cJSON_AddItemToArray(slots, cJSON_CreateNumber(job->frame_slot[i]));
    }
  }
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

  /* frameSlots: absent on records written before 0.4.29, which leaves every
   * slot 0 and rq_job_has_slots() false - the reconciler then adopts the list
   * from META. Present, it has to be a usable list of exactly frameCount
   * cameras; anything else is a record this queue did not write, refused
   * whole so reconciliation rebuilds it from META rather than uploading from
   * a list that could name the wrong camera. */
  const cJSON *slots = cJSON_GetObjectItem(j, "frameSlots");
  if (slots != NULL) {
    uint8_t list[RQ_MAX_FRAMES];
    int n = 0;
    bool ok = cJSON_IsArray(slots);
    const cJSON *e = NULL;
    if (ok) {
      cJSON_ArrayForEach(e, slots) {
        if (n >= RQ_MAX_FRAMES || !cJSON_IsNumber(e) || e->valuedouble < 1 ||
            e->valuedouble > RQ_MAX_FRAMES || e->valuedouble != (int)e->valuedouble) {
          ok = false;
          break;
        }
        list[n++] = (uint8_t)e->valuedouble;
      }
    }
    if (!ok || n != job->frame_count || !rq_slots_valid(list, n, RQ_MAX_FRAMES)) {
      cJSON_Delete(j);
      memset(job, 0, sizeof *job);
      return false;
    }
    for (int i = 0; i < n; i++) job->frame_slot[i] = list[i];
  }

  cJSON_Delete(j);
  return true;
}

/* ------------------------------------------------------------------ */
/* META.JSON frames                                                   */
/* ------------------------------------------------------------------ */

int upload_store_meta_frames_from_text(const char *text, size_t len, int max_slot,
                                       uint8_t *slots, int cap) {
  if (text == NULL || slots == NULL || cap <= 0) return UPLOAD_META_FRAMES_MALFORMED;
  if (max_slot > RQ_MAX_FRAMES) max_slot = RQ_MAX_FRAMES;
  cJSON *doc = cJSON_ParseWithLength(text, len);
  if (doc == NULL) return UPLOAD_META_FRAMES_MALFORMED;

  const cJSON *frames = cJSON_GetObjectItem(doc, "frames");
  if (!cJSON_IsArray(frames)) {
    cJSON_Delete(doc);
    return UPLOAD_META_FRAMES_MALFORMED;
  }

  int n = 0;
  int err = 0;
  const cJSON *e = NULL;
  cJSON_ArrayForEach(e, frames) {
    const cJSON *cam = cJSON_GetObjectItem(e, "cam");
    const cJSON *file = cJSON_GetObjectItem(e, "file");
    if (!cJSON_IsString(cam) || cam->valuestring == NULL) {
      err = UPLOAD_META_FRAMES_MALFORMED;
      break;
    }
    /* `file: null` is a camera that was asked and produced nothing: not a
     * frame, not an error in the document. Only a string names a file. */
    if (!cJSON_IsString(file) || file->valuestring == NULL) continue;

    /* "cam<n>", one digit: the capture path writes nothing else. */
    const char *c = cam->valuestring;
    if (strncmp(c, "cam", 3) != 0 || c[3] < '1' || c[3] > '9' || c[4] != '\0') {
      err = UPLOAD_META_FRAMES_SLOT;
      break;
    }
    const int slot = c[3] - '0';
    if (slot > max_slot) {
      err = UPLOAD_META_FRAMES_SLOT;
      break;
    }
    /* The file must be the camera's own: C<n>.JPG. A document that says cam3
     * is in C2.JPG is not one capture.c wrote. */
    char want[12];
    snprintf(want, sizeof want, "C%d.JPG", slot);
    if (strcmp(file->valuestring, want) != 0) {
      err = UPLOAD_META_FRAMES_FILE;
      break;
    }
    if (n >= cap || n >= RQ_MAX_FRAMES) {
      err = UPLOAD_META_FRAMES_SLOT;
      break;
    }
    slots[n++] = (uint8_t)slot;
  }

  if (err == 0 && !rq_slots_valid(slots, n, max_slot)) err = UPLOAD_META_FRAMES_SLOT;

  /* frameCount is written as the number of stored frames (meta.c). A document
   * whose count and list disagree is not trusted either way. */
  if (err == 0) {
    const cJSON *fc = cJSON_GetObjectItem(doc, "frameCount");
    if (!cJSON_IsNumber(fc) || (int)fc->valuedouble != n) err = UPLOAD_META_FRAMES_COUNT;
  }

  cJSON_Delete(doc);
  return err != 0 ? err : n;
}

/* META.JSON on this firmware is 1.5-1.9 KB with four frames and their sensor
 * blocks (bench 2026-09-03); roll_api.c reads it with the same 4 KB bound. */
#define META_READ_MAX 4096

int upload_store_meta_frames(const char *uuid, int max_slot, uint8_t *slots, int cap) {
  if (uuid == NULL) return UPLOAD_META_FRAMES_MALFORMED;
  char path[96];
  upload_store_path(uuid, "META.JSON", path, sizeof path);
  FILE *f = fopen(path, "rb");
  if (f == NULL) return UPLOAD_META_FRAMES_MALFORMED;
  static char buf[META_READ_MAX];
  const size_t n = fread(buf, 1, sizeof buf, f);
  const int io_err = ferror(f);
  fclose(f);
  if (io_err || n == 0) return UPLOAD_META_FRAMES_MALFORMED;
  return upload_store_meta_frames_from_text(buf, n, max_slot, slots, cap);
}

static const char *meta_frames_reason(int err) {
  switch (err) {
    case UPLOAD_META_FRAMES_COUNT: return "META frameCount disagrees with its frames";
    case UPLOAD_META_FRAMES_SLOT: return "META names a camera twice or outside the body";
    case UPLOAD_META_FRAMES_FILE: return "META names a frame file that is not its camera's";
    default: return "META has no usable frame list";
  }
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

bool upload_store_meta_roll_id_from_text(const char *text, size_t len, char *out, size_t cap) {
  if (out != NULL && cap > 0) out[0] = '\0';
  if (text == NULL || out == NULL || cap == 0) return false;
  cJSON *doc = cJSON_ParseWithLength(text, len);
  if (doc == NULL) return false;
  const cJSON *v = cJSON_GetObjectItem(doc, "rollId");
  bool ok = false;
  if (cJSON_IsString(v) && v->valuestring != NULL && v->valuestring[0] != '\0' &&
      strlen(v->valuestring) < cap) {
    snprintf(out, cap, "%s", v->valuestring);
    ok = true;
  }
  cJSON_Delete(doc);
  return ok;
}

bool upload_store_meta_roll_id(const char *uuid, char *out, size_t cap) {
  if (out != NULL && cap > 0) out[0] = '\0';
  if (uuid == NULL || out == NULL) return false;
  char path[96];
  upload_store_path(uuid, "META.JSON", path, sizeof path);
  FILE *f = fopen(path, "rb");
  if (f == NULL) return false;
  /* META.JSON is a few hundred bytes; the frames array is the only part that
   * grows, and eight frames stay well inside this. */
  static char buf[2048];
  const size_t n = fread(buf, 1, sizeof buf, f);
  fclose(f);
  return upload_store_meta_roll_id_from_text(buf, n, out, cap);
}

/* Park `job` with `why`, so the queue status and GET_LOGS say what stopped it.
 * The photograph is untouched; UPLOAD_QUEUE_RETRY re-reads META and may find
 * a list next time (a card that was busy, for instance). */
static void park(rq_job_t *job, const char *why) {
  job->state = RQ_FAILED;
  snprintf(job->last_error, sizeof job->last_error, "%s", why);
}

/* The frame list META names, checked against the card: every named file must
 * exist. Returns the count, or a negative upload_meta_frames_err_t; a missing
 * file is UPLOAD_META_FRAMES_FILE. */
static int frames_from_meta(const char *uuid, int max_frames, uint8_t *slots, int cap) {
  const int n = upload_store_meta_frames(uuid, max_frames, slots, cap);
  if (n < 0) return n;
  for (int i = 0; i < n; i++) {
    char name[12];
    snprintf(name, sizeof name, "C%d.JPG", slots[i]);
    if (!upload_store_has_file(uuid, name)) return UPLOAD_META_FRAMES_FILE;
  }
  return n;
}

rq_reconcile_t upload_store_inspect_ex(const char *uuid, int max_frames, rq_job_t *out,
                                       bool *needs_save) {
  if (needs_save != NULL) *needs_save = false;
  if (uuid == NULL || out == NULL) return RQ_REC_IGNORE;

  const bool has_meta = upload_store_has_file(uuid, "META.JSON");
  char meta_roll[RQ_CAPTURE_ID_LEN] = "";
  if (has_meta) (void)upload_store_meta_roll_id(uuid, meta_roll, sizeof meta_roll);

  rq_job_t loaded;
  bool valid = false;
  const bool has_job = upload_store_load(uuid, &loaded, &valid);
  const rq_reconcile_t action =
      rq_reconcile_action(has_meta, meta_roll, has_job, valid, valid ? &loaded : NULL);
  if (action == RQ_REC_IGNORE) return RQ_REC_IGNORE;
  if (action == RQ_REC_RESUME) {
    *out = loaded;
    /* The record's deadline was set by the boot that wrote it. */
    rq_job_boot_resume(out);
    if (out->frame_count > 0 && !rq_job_has_slots(out)) {
      /* Written before frameSlots existed. Its cameras are in META; adopt them
       * (rq_job_adopt_slots keeps what the old queue confirmed, by camera) and
       * ask the caller to write the record back before the queue acts. A META
       * that cannot say parks the job rather than letting it guess C1..CN,
       * which is the guess that stranded CAP_000263. */
      uint8_t slots[RQ_MAX_FRAMES];
      const int n = frames_from_meta(uuid, max_frames, slots, RQ_MAX_FRAMES);
      if (n < 0 || !rq_job_adopt_slots(out, slots, n)) {
        park(out, n < 0 ? meta_frames_reason(n) : "META frame list could not be adopted");
      } else if (out->state == RQ_FAILED && out->attempts >= RQ_MAX_ATTEMPTS) {
        /* Parked by the old enumeration asking for a camera the set never
         * had. The record now knows its cameras; the job stays parked - the
         * user's retry revives it, exactly as for any other parked job - and
         * the reason on it says what happened rather than the stale detail. */
        snprintf(out->last_error, sizeof out->last_error,
                 "frame list recovered from META; retry to upload the remaining cameras");
      }
      if (needs_save != NULL) *needs_save = true;
    }
    return action;
  }
  if (action == RQ_REC_RETIRE) {
    /* Parked with the reason on the record, so GET_LOGS / the queue status
     * can say why this photograph is not going anywhere. The photograph
     * itself is untouched. */
    if (valid) {
      *out = loaded;
    } else {
      rq_job_init(out, uuid, "", 0, false);
    }
    out->state = RQ_FAILED;
    /* Bounded with precision, not truncation: two roll ids are longer than
     * the error field, and the first 20 characters of each identify them. */
    snprintf(out->last_error, sizeof out->last_error,
             "no Roll provenance: capture %.20s, record %.20s", meta_roll[0] ? meta_roll : "none",
             valid ? loaded.roll_id : "?");
    return action;
  }

  /* ENQUEUE or REPAIR: a fresh record from what META says the photograph is. */
  uint8_t slots[RQ_MAX_FRAMES];
  const int n = frames_from_meta(uuid, max_frames, slots, RQ_MAX_FRAMES);
  const bool thumb = upload_store_has_file(uuid, "THUMB.JPG");
  if (n < 0 || !rq_job_init_slots(out, uuid, meta_roll, slots, n, thumb)) {
    rq_job_init_slots(out, uuid, meta_roll, NULL, 0, thumb);
    park(out, n < 0 ? meta_frames_reason(n) : "META frame list could not be adopted");
  }
  if (needs_save != NULL) *needs_save = true;
  return action;
}

rq_reconcile_t upload_store_inspect(const char *uuid, int max_frames, rq_job_t *out) {
  return upload_store_inspect_ex(uuid, max_frames, out, NULL);
}
