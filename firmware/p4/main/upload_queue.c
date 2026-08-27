/**
 * UPLOAD.JSON, reconciliation, and the worker that drains the Roll queue.
 *
 * upload_queue.h holds the design and names the hazards; roll_queue.h owns
 * every decision. Nothing here re-decides what to do next, how long to wait or
 * what a status code means — it reads the card, calls the transport, and writes
 * the answer back down.
 */
#include "upload_queue.h"

#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "cJSON.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "klog.h"
#include "net_link.h"
#include "roll_state.h"
#include "storage.h"
#include "taskmon.h"

static const char *TAG = "upqueue";

#define CAPTURES_DIR "/sdcard/KINO/CAPTURES"

/* Directories one reconciliation pass looks at. Same bound and the same reason
 * as storage.c's orphan sweep: a pathological card must not stall the boot. */
#define SCAN_MAX_DIRS 512

/* The worker exists to be invisible. Both waits are cut short by a task
 * notification, so enqueue and retry are still immediate. */
#define IDLE_TICKS pdMS_TO_TICKS(1000)
#define PAUSED_TICKS pdMS_TO_TICKS(250)

/** The Roll this device is on. Two calls where one would do, because
 * roll_state_active() is the cheap question and roll_state_get() is the one
 * that yields the rollId a job has to carry. */
static bool current_roll(char *roll_id, size_t cap) {
  roll_state_t roll;
  if (cap > 0) roll_id[0] = '\0';
  if (!roll_state_active() || !roll_state_get(&roll)) return false;
  if (roll.roll_id[0] == '\0') return false;
  snprintf(roll_id, cap, "%s", roll.roll_id);
  return true;
}

/* ------------------------------------------------------------------ */
/* The HTTP seam                                                      */
/* ------------------------------------------------------------------ */

/** One network step's outcome, in the vocabulary rq_classify_status() reads.
 * `status` 0 means the request never got a response at all. */
typedef struct {
  int status;
  char capture_id[RQ_CAPTURE_ID_LEN]; /* RQ_STEP_REGISTER only */
  char detail[RQ_ERROR_LEN];          /* already redacted */
} roll_http_result_t;

typedef void (*roll_http_fn)(const rq_job_t *job, rq_step_t step, roll_http_result_t *out);

/**
 * What fills this in: docs/roll/ROLL_DEVICE_CONTRACT.md "Upload procedure",
 * step for step —
 *
 *   RQ_STEP_REGISTER          POST /api/device/rolls/{rollId}/captures
 *   RQ_STEP_UPLOAD_THUMB      assets/init role "thumb" -> part PUTs -> complete
 *   RQ_STEP_UPLOAD_FRAME      assets/init role "original-frame", frameIndex
 *   RQ_STEP_COMPLETE_CAPTURE  POST /api/device/captures/{captureId}/complete
 *
 * A function pointer rather than an #ifdef because the P4 has no route to the
 * C6 (firmware/C6_HARDWARE_MAP.md). esp_http_client + esp-tls + mbedtls would
 * add roughly 300 KB against a 1100 KB CI size guard to reach a radio that
 * cannot be reached. Step ordering, persistence and retry are all written here;
 * only the bytes on the wire are missing.
 */
static void http_no_transport(const rq_job_t *job, rq_step_t step, roll_http_result_t *out) {
  (void)job;
  (void)step;
  out->status = 0; /* no response; rq_classify_status() calls that transient */
  out->capture_id[0] = '\0';
  rq_redact(out->detail, sizeof out->detail, "no transport to the C6");
}

static roll_http_fn s_http = http_no_transport;

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

static rq_job_t s_jobs[UPLOAD_QUEUE_MAX];
static int s_count;
static int s_active = -1; /* index the worker is on, -1 when none */
static SemaphoreHandle_t s_lock;
static TaskHandle_t s_task;
static volatile bool s_paused;
static bool s_halted;
static bool s_net_ready; /* last reported can-upload, so the log fires once */
static bool s_cap_hit;   /* the last scan filled the RAM list and stopped */
static bool s_rescan;    /* a slot has freed since then — the card holds more */
static int s_uploaded;
static char s_last_error[RQ_ERROR_LEN];

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

/* All three tolerate being called before upload_queue_start(). */
static void lock(void) { if (s_lock != NULL) xSemaphoreTake(s_lock, portMAX_DELAY); }
static void unlock(void) { if (s_lock != NULL) xSemaphoreGive(s_lock); }
static void wake(void) { if (s_task != NULL) xTaskNotifyGive(s_task); }

/* ------------------------------------------------------------------ */
/* UPLOAD.JSON                                                        */
/* ------------------------------------------------------------------ */

static void job_path(const char *uuid, const char *name, char *out, size_t cap) {
  snprintf(out, cap, CAPTURES_DIR "/%s/%s", uuid, name);
}

/**
 * Write to a temp name, then rename over it — the metadata-last discipline
 * capture.c uses for META.JSON.
 *
 * The unlink() before the rename is not optional: FatFs `f_rename` fails when
 * the target exists, so a rename straight over UPLOAD.JSON would never land.
 * The window in which neither file exists is safe for the reason the header
 * gives — META.JSON with no UPLOAD.JSON reconciles as ENQUEUE, and the server
 * is idempotent on captureUuid, so the cost is one redundant registration.
 */
static bool job_save(const rq_job_t *job) {
  cJSON *j = cJSON_CreateObject();
  if (j == NULL) return false;

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
  if (text == NULL) return false;

  char tmp[96], dst[96];
  job_path(job->uuid, "UPLOAD.TMP", tmp, sizeof tmp);
  job_path(job->uuid, "UPLOAD.JSON", dst, sizeof dst);

  FILE *f = fopen(tmp, "wb");
  if (f == NULL) {
    cJSON_free(text);
    return false;
  }
  size_t len = strlen(text);
  int failed = fwrite(text, 1, len, f) != len;
  failed |= fflush(f) != 0;
  failed |= fsync(fileno(f)) != 0;
  failed |= fclose(f) != 0;
  cJSON_free(text);
  if (failed) {
    unlink(tmp);
    return false;
  }

  unlink(dst);
  if (rename(tmp, dst) != 0) {
    unlink(tmp);
    return false;
  }
  return true;
}

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

/**
 * Returns false when the file is missing; sets `*valid` false when it is there
 * but cannot be trusted, which is what makes rq_reconcile_action() say REPAIR.
 *
 * A HIGHER formatVersion is invalid on purpose. Read with today's field names it
 * would take a newer schema's meaning for an older one, and the field that
 * would silently change meaning is per-frame progress — the one whose
 * misreading uploads a frame twice.
 */
static bool job_load(const char *uuid, rq_job_t *job, bool *valid) {
  *valid = false;
  char path[96];
  job_path(uuid, "UPLOAD.JSON", path, sizeof path);
  FILE *f = fopen(path, "rb");
  if (f == NULL) return false;

  char buf[768];
  size_t n = fread(buf, 1, sizeof buf - 1, f);
  int over = fgetc(f) != EOF; /* bigger than any record we write: not ours */
  fclose(f);
  buf[n] = '\0';
  if (over) return true;

  cJSON *j = cJSON_Parse(buf);
  if (j == NULL) return true;

  const cJSON *ver = cJSON_GetObjectItem(j, "formatVersion");
  const cJSON *state = cJSON_GetObjectItem(j, "state");
  int st = cJSON_IsNumber(state) ? (int)state->valuedouble : -1;
  if (!cJSON_IsNumber(ver) || ver->valuedouble > RQ_FORMAT_VERSION || st < 0 || st > RQ_FAILED) {
    cJSON_Delete(j);
    return true;
  }

  memset(job, 0, sizeof *job);
  job->state = (rq_state_t)st;
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
  *valid = true;
  return true;
}

/* ------------------------------------------------------------------ */
/* The RAM list. Every function here needs the lock held.              */
/* ------------------------------------------------------------------ */

static int find_job(const char *uuid) {
  for (int i = 0; i < s_count; i++) {
    if (strcmp(s_jobs[i].uuid, uuid) == 0) return i;
  }
  return -1;
}

static bool list_add(const rq_job_t *job) {
  if (s_count >= UPLOAD_QUEUE_MAX) {
    s_cap_hit = true;
    return false;
  }
  s_jobs[s_count++] = *job;
  return true;
}

/* Order is not significant to any decision — the worker scans for the first
 * runnable job — so the tail fills the hole. */
static void list_drop(int idx) {
  if (idx < 0 || idx >= s_count) return;
  s_jobs[idx] = s_jobs[--s_count];
  memset(&s_jobs[s_count], 0, sizeof s_jobs[s_count]);
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                     */
/* ------------------------------------------------------------------ */

static bool has_file(const char *uuid, const char *name) {
  char path[96];
  job_path(uuid, name, path, sizeof path);
  struct stat st;
  return stat(path, &st) == 0;
}

/** Rebuild a record from what is on the card. The frame count comes from the
 * JPEGs present, not from META.JSON: the files are what would be uploaded, and
 * a metadata field that disagreed with them would be the wrong answer. */
static void job_from_card(const char *uuid, const char *roll_id, rq_job_t *job) {
  int frames = 0;
  for (int i = 1; i <= STORAGE_CAPTURE_FRAMES; i++) {
    char name[12];
    snprintf(name, sizeof name, "C%d.JPG", i);
    if (has_file(uuid, name)) frames = i;
  }
  rq_job_init(job, uuid, roll_id, frames, has_file(uuid, "THUMB.JPG"));
}

/** One pass over the card, adding what belongs in the queue and is not already
 * in the RAM list. Returns how many jobs it added. */
static int queue_scan(void) {
  DIR *d = opendir(CAPTURES_DIR);
  if (d == NULL) return 0; /* no captures directory yet is not a fault */

  char roll_id[RQ_CAPTURE_ID_LEN];
  bool on_roll = current_roll(roll_id, sizeof roll_id);

  int looked_at = 0, added = 0, repaired = 0;
  struct dirent *e;
  s_cap_hit = false;
  s_rescan = false;
  while ((e = readdir(d)) != NULL && looked_at < SCAN_MAX_DIRS) {
    if (!storage_is_capture_dirname(e->d_name)) continue;
    looked_at++;

    /* storage_is_capture_dirname has proved this is 36 characters, but d_name
     * is declared up to NAME_MAX and the compiler reasons from the
     * declaration — so the bound has to be visible in the types. */
    char uuid[37];
    memcpy(uuid, e->d_name, 36);
    uuid[36] = '\0';

    lock();
    bool known = find_job(uuid) >= 0;
    unlock();
    if (known) continue;

    rq_job_t loaded;
    bool valid = false;
    bool has_job = job_load(uuid, &loaded, &valid);
    rq_reconcile_t action =
        rq_reconcile_action(has_file(uuid, "META.JSON"), has_job, valid, valid ? &loaded : NULL);

    rq_job_t job = {0};
    switch (action) {
      case RQ_REC_IGNORE:
        continue;
      case RQ_REC_RESUME:
        job = loaded;
        break;
      case RQ_REC_REPAIR:
        repaired++;
        ESP_LOGW(TAG, "rebuilding unreadable UPLOAD.JSON for %.8s", uuid);
        klog("SD", "upload record rebuilt for %.8s", uuid);
        /* fall through */
      case RQ_REC_ENQUEUE:
      default:
        if (!on_roll) continue; /* nowhere for the bytes to go; leave it be */
        job_from_card(uuid, roll_id, &job);
        if (!job_save(&job)) continue; /* the next boot reconciles it again */
        break;
    }

    lock();
    bool room = list_add(&job);
    unlock();
    if (!room) break;
    added++;
  }
  closedir(d);

  if (looked_at > 0) {
    ESP_LOGI(TAG, "reconcile: %d dirs, %d queued, %d repaired", looked_at, added, repaired);
  }
  if (added > 0 || repaired > 0) {
    klog("SD", "upload queue: %d queued, %d repaired", added, repaired);
  }
  return added;
}

/* ------------------------------------------------------------------ */
/* The worker                                                         */
/* ------------------------------------------------------------------ */

/** First job with work due. Lock held. -1 when nothing is runnable, which
 * includes every job sitting in backoff. */
static int pick_job(int64_t t, rq_step_t *step) {
  for (int i = 0; i < s_count; i++) {
    rq_step_t s = rq_next_step(&s_jobs[i], t);
    if (s.kind == RQ_STEP_NOTHING || s.kind == RQ_STEP_WAIT_BACKOFF) continue;
    *step = s;
    return i;
  }
  return -1;
}

/** True when `idx` still holds the job the worker took. The list can be
 * rewritten while a step is in flight, so the index alone proves nothing. */
static bool still_ours(int idx, const char *uuid) {
  return idx >= 0 && idx < s_count && strcmp(s_jobs[idx].uuid, uuid) == 0;
}

/** Run one step for one job, then persist. Returns true when it did work. */
static bool run_one_step(void) {
  rq_step_t step;
  rq_job_t snapshot;

  lock();
  int idx = pick_job(now_ms(), &step);
  s_active = idx;
  if (idx < 0) {
    unlock();
    return false;
  }
  snapshot = s_jobs[idx];
  unlock();

  roll_http_result_t res = {0};
  s_http(&snapshot, step, &res);
  rq_disposition_t disp = rq_classify_status(res.status);

  lock();
  /* Apply to the live record, not the snapshot: retry_all may have cleared this
   * job's backoff while the step was in flight, and writing the snapshot back
   * would undo that. rq_apply is a pure transition either way. */
  if (!still_ours(idx, snapshot.uuid)) {
    s_active = -1;
    unlock();
    return true;
  }
  rq_job_t *job = &s_jobs[idx];
  if (disp == RQ_DISP_OK && step.kind == RQ_STEP_REGISTER) {
    /* rq_apply will not advance past REGISTER without this — the server's id is
     * the caller's proof the step landed. */
    snprintf(job->capture_id, sizeof job->capture_id, "%s", res.capture_id);
  }
  bool dirty = rq_apply(job, step, disp, res.detail);
  if (job->state == RQ_RETRY_WAIT) {
    /* roll_queue.c never reads a clock, so the deadline is set here. A re-read
     * runs immediately: a checksum mismatch is not a network failure and has
     * nothing to wait for. */
    job->next_attempt_ms =
        disp == RQ_DISP_REREAD ? now_ms() : now_ms() + rq_backoff_ms(job->attempts);
  }
  if (disp == RQ_DISP_HALT) s_halted = true;
  if (res.detail[0] != '\0') rq_redact(s_last_error, sizeof s_last_error, res.detail);
  snapshot = *job;
  s_active = -1;
  unlock();

  /* Persist BEFORE the next network operation: a frame that landed and was not
   * written down is a frame this queue uploads twice after a reboot. A failed
   * write backs the job off rather than carrying on — the card is gone or full,
   * and neither gets better by uploading more. */
  if (dirty && !job_save(&snapshot)) {
    lock();
    if (still_ours(idx, snapshot.uuid)) {
      s_jobs[idx].state = RQ_RETRY_WAIT;
      s_jobs[idx].next_attempt_ms = now_ms() + RQ_BACKOFF_CAP_MS;
    }
    unlock();
    rq_redact(s_last_error, sizeof s_last_error, "UPLOAD.JSON write failed");
    ESP_LOGW(TAG, "could not persist %.8s; backing off", snapshot.uuid);
    return true;
  }

  lock();
  if (still_ours(idx, snapshot.uuid) && s_jobs[idx].state == RQ_COMPLETE) {
    list_drop(idx);
    s_uploaded++;
    /* The card held more than the RAM list could take and a slot has just
     * freed. The rescan happens when the worker next runs dry — a directory
     * scan does not belong between two network steps. */
    if (s_cap_hit) s_rescan = true;
  }
  unlock();
  return true;
}

static void worker_task(void *arg) {
  (void)arg;
  for (;;) {
    uint32_t ignored;
    if (s_paused) {
      /* Photography wins. Per the header, the FD budget and the SDMMC bus are
       * both shared, and an upload that arrives seconds later costs nothing. */
      xTaskNotifyWait(0, 0, &ignored, PAUSED_TICKS);
      continue;
    }

    net_status_t st;
    net_link_status(&st, now_ms());
    bool ready = net_link_can_upload(&st);
    if (ready != s_net_ready) {
      s_net_ready = ready;
      ESP_LOGI(TAG, "transport %s (%s)", ready ? "up" : "down", net_state_name(st.state));
      klog("P4", "upload transport %s: %s", ready ? "up" : "down", net_state_name(st.state));
    }
    if (!ready || s_halted) {
      /* NET_C6_NOT_ROUTED is this board's permanent state, so this is the path
       * that always runs. Nothing is logged per tick on purpose: a queue that
       * cannot run must not evict the log lines it would be reported from. */
      xTaskNotifyWait(0, 0, &ignored, IDLE_TICKS);
      continue;
    }

    if (run_one_step()) continue;
    if (s_rescan) {
      queue_scan(); /* clears both flags */
      continue;
    }
    xTaskNotifyWait(0, 0, &ignored, IDLE_TICKS);
  }
}

/* ------------------------------------------------------------------ */
/* Public interface                                                   */
/* ------------------------------------------------------------------ */

esp_err_t upload_queue_start(void) {
  if (s_task != NULL) return ESP_OK;
  if (s_lock == NULL) s_lock = xSemaphoreCreateMutex();
  if (s_lock == NULL) return ESP_ERR_NO_MEM;

  queue_scan();

  /* Priority 2, below ui (4) and the capture workers (5), deliberately. Gate F
   * in firmware/FIRMWARE_ROADMAP.md asks for capture timing and CRC error rates
   * unchanged with the radio active; the cheapest way to hold that is for this
   * task never to be the one the scheduler picks over a frame. */
  TaskHandle_t h = NULL;
  if (xTaskCreate(worker_task, "upqueue", 4096, NULL, 2, &h) != pdPASS) {
    ESP_LOGE(TAG, "worker task create failed");
    return ESP_ERR_NO_MEM;
  }
  s_task = h;
  taskmon_register("upqueue", h);
  return ESP_OK;
}

esp_err_t upload_queue_enqueue(const char *capture_uuid, int frame_count, bool thumb_present) {
  if (capture_uuid == NULL || !storage_is_capture_dirname(capture_uuid)) {
    return ESP_ERR_INVALID_ARG;
  }

  char roll_id[RQ_CAPTURE_ID_LEN];
  if (!current_roll(roll_id, sizeof roll_id)) return ESP_OK; /* no Roll, no job */

  rq_job_t job;
  rq_job_init(&job, capture_uuid, roll_id, frame_count, thumb_present);

  /* One file write, no network, no blocking — this runs on the capture task. A
   * failure is not an emergency: the photograph is on the card and
   * reconciliation finds it at the next boot. */
  if (!job_save(&job)) return ESP_FAIL;

  lock();
  esp_err_t err = ESP_OK;
  if (find_job(job.uuid) < 0 && !list_add(&job)) err = ESP_ERR_NO_MEM;
  unlock();

  wake();
  return err;
}

void upload_queue_status(upload_queue_report_t *out) {
  if (out == NULL) return;
  memset(out, 0, sizeof *out);

  lock();
  for (int i = 0; i < s_count; i++) {
    if (s_jobs[i].state == RQ_FAILED) {
      out->failed++;
    } else if (i != s_active) {
      out->pending++;
    }
  }
  out->uploading = s_active >= 0 ? 1 : 0;
  out->uploaded = s_uploaded;
  out->halted = s_halted;
  out->draining = !s_paused && s_net_ready && !s_halted && (out->pending > 0 || s_active >= 0);
  memcpy(out->last_error, s_last_error, sizeof out->last_error);
  unlock();
}

int upload_queue_retry_all(void) {
  int revived = 0;
  lock();
  for (int i = 0; i < s_count; i++) {
    rq_job_t *job = &s_jobs[i];
    if (job->state != RQ_RETRY_WAIT && job->state != RQ_FAILED) continue;
    /* `attempts` is what parks a job at RQ_MAX_ATTEMPTS, so a user pressing
     * retry is saying that history is stale. RETRY_WAIT with a zero deadline is
     * due immediately, and rq_next_step() re-enters from the completion flags
     * rather than the state — so this need not guess where the job had got to. */
    job->attempts = 0;
    job->reread_attempts = 0;
    job->next_attempt_ms = 0;
    job->state = RQ_RETRY_WAIT;
    revived++;
  }
  s_halted = false;
  s_last_error[0] = '\0';
  unlock();

  /* Not written to the card. Backoff deadlines are monotonic milliseconds,
   * which a reboot resets anyway, so persisting them buys nothing and would put
   * UPLOAD_QUEUE_RETRY on the SD write path. */
  wake();
  return revived;
}

void upload_queue_pause_for_capture(bool capturing) {
  s_paused = capturing;
  if (!capturing) wake();
}

bool upload_queue_paused(void) { return s_paused; }
