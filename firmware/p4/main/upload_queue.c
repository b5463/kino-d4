/**
 * Reconciliation and the worker that drains the Roll queue.
 *
 * upload_queue.h holds the design and names the hazards; roll_queue.h owns
 * every decision; upload_store.c owns UPLOAD.JSON. Nothing here re-decides what
 * to do next, how long to wait or what a status code means — it reads the card,
 * calls the transport, and writes the answer back down.
 */
#include "upload_queue.h"

#include <dirent.h>
#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "hardware_validation.h"
#include "hwv_rules.h"
#include "klog.h"
#include "net_link.h"
#include "roll_api.h"
#include "roll_state.h"
#include "storage.h"
#include "taskmon.h"
#include "upload_store.h"

static const char *TAG = "upqueue";

/* Directories one reconciliation pass looks at. Same bound and the same reason
 * as storage.c's orphan sweep: a pathological card must not stall the boot. */
#define SCAN_MAX_DIRS 512

/* The worker exists to be invisible. Both waits are cut short by a task
 * notification, so enqueue and retry are still immediate. */
#define IDLE_TICKS pdMS_TO_TICKS(1000)
#define PAUSED_TICKS pdMS_TO_TICKS(250)

/* How long the worker waits for the card. Long enough to ride out the holders
 * that finish — a gallery tile slurp, a META.JSON write — and far shorter than
 * the one that does not: a four-camera capture holds the card for seconds, and
 * a worker blocked across it is a task on a mutex instead of one watching its
 * own retry deadlines. A refusal costs one IDLE_TICKS, which is free. */
#define CARD_WAIT_MS 200

/*
 * Parked jobs kept in the RAM list at once.
 *
 * A FAILED job needs one slot to be visible in UPLOAD_QUEUE_STATUS and
 * revivable by UPLOAD_QUEUE_RETRY, and nothing else. It never runs a step
 * again — rq_next_step() returns NOTHING for it — so every slot past this one
 * is a slot a runnable capture cannot have. With UPLOAD_QUEUE_MAX at 32, a
 * party that hit a server fault early parks 32 captures and then queues no new
 * one at all: the photographs are still on the card, and none of them go
 * anywhere until someone reboots the camera.
 *
 * Four, because the display shows a handful and the count beside them is what
 * actually matters. A trimmed job's UPLOAD.JSON stays on the card exactly as
 * it was, so the next reconciliation pass still finds it, still counts it, and
 * UPLOAD_QUEUE_RETRY still revives it once a slot is free.
 */
#define PARKED_IN_RAM_MAX 4

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

typedef void (*roll_http_fn)(const rq_job_t *job, rq_step_t step, roll_step_result_t *out);

/**
 * What fills this in: docs/roll/ROLL_DEVICE_CONTRACT.md "Upload procedure",
 * step for step —
 *
 *   RQ_STEP_REGISTER          POST /api/device/rolls/{rollId}/captures
 *   RQ_STEP_UPLOAD_THUMB      assets/init role "thumb" -> part PUTs -> complete
 *   RQ_STEP_UPLOAD_FRAME      assets/init role "original-frame", frameIndex
 *   RQ_STEP_COMPLETE_CAPTURE  POST /api/device/captures/{captureId}/complete
 *
 * `roll_api.c` implements it, and implements it TWICE: with the HTTP client in
 * the radio build, and as "no radio in this build" otherwise. So the queue, its
 * persistence and its retry policy run identically either way, which is what
 * makes the host tests worth having when no radio has ever been exercised.
 *
 * Still a function pointer rather than a direct call: it is the one place a
 * test or a bench tool can substitute a transport without touching the step
 * ordering above it.
 */
static roll_http_fn s_http = roll_api_step;

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

static rq_job_t s_jobs[UPLOAD_QUEUE_MAX];
static int s_count;
static int s_active = -1; /* index the worker is on, -1 when none */
static SemaphoreHandle_t s_lock;
static TaskHandle_t s_task;
static bool s_halted;
static bool s_net_ready; /* last reported can-upload, so the log fires once */
static bool s_cap_hit;   /* the last scan filled the RAM list and stopped */
static bool s_rescan;    /* a slot has freed since then — the card holds more */
static int s_uploaded;
static char s_last_error[RQ_ERROR_LEN];
/* Parked captures on the card that are NOT in the RAM list, so
 * UPLOAD_QUEUE_STATUS reports how many are parked rather than how many
 * happened to fit. Recomputed from the card by a reconciliation pass that runs
 * to the end, and bumped in between by every job this file trims. */
static int s_parked_off_list;

/* Insertion order for the RAM list. list_drop() fills a hole from the tail, so
 * an array index says nothing about age — and when parked jobs have to be
 * trimmed, the ones to keep are the ones that just failed, because those are
 * what the user is looking at. One counter, bumped per add; only the ordering
 * of these values is ever used. */
static uint32_t s_added_seq[UPLOAD_QUEUE_MAX];
static uint32_t s_next_seq;

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

/* All three tolerate being called before upload_queue_start(). */
static void lock(void) { if (s_lock != NULL) xSemaphoreTake(s_lock, portMAX_DELAY); }
static void unlock(void) { if (s_lock != NULL) xSemaphoreGive(s_lock); }
static void wake(void) { if (s_task != NULL) xTaskNotifyGive(s_task); }

/* Every card read and every card write below goes through these. Per storage.h,
 * a false answer means touch nothing — not "try anyway". */
static bool card_take(void) { return storage_acquire(STORAGE_USER_UPLOAD, CARD_WAIT_MS); }
static void card_give(void) { storage_release(STORAGE_USER_UPLOAD); }

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
  s_added_seq[s_count] = ++s_next_seq;
  s_jobs[s_count++] = *job;
  return true;
}

/* Order is not significant to any decision — the worker scans for the first
 * runnable job — so the tail fills the hole. Its sequence number moves with
 * it, because that is the only record of which job arrived first. */
static void list_drop(int idx) {
  if (idx < 0 || idx >= s_count) return;
  s_count--;
  s_jobs[idx] = s_jobs[s_count];
  s_added_seq[idx] = s_added_seq[s_count];
  memset(&s_jobs[s_count], 0, sizeof s_jobs[s_count]);
  s_added_seq[s_count] = 0;
}

/** Parked jobs currently in the RAM list. Lock held. */
static int count_parked(void) {
  int n = 0;
  for (int i = 0; i < s_count; i++) {
    if (s_jobs[i].state == RQ_FAILED) n++;
  }
  return n;
}

/**
 * Drop parked jobs from the RAM list until only PARKED_IN_RAM_MAX remain,
 * oldest first. Returns how many were dropped. Lock held.
 *
 * Only the RAM list is touched: UPLOAD.JSON stays on the card saying FAILED,
 * so nothing is lost and nothing is re-uploaded. Each one dropped is counted
 * into s_parked_off_list so the number the UI shows stays the number of parked
 * captures, not the number still in memory.
 *
 * Must not run while a step is in flight on one of them — see the call site.
 */
static int trim_parked(void) {
  int dropped = 0;
  for (int over = count_parked() - PARKED_IN_RAM_MAX; over > 0; over--) {
    int victim = -1;
    for (int i = 0; i < s_count; i++) {
      if (s_jobs[i].state != RQ_FAILED || i == s_active) continue;
      if (victim < 0 || s_added_seq[i] < s_added_seq[victim]) victim = i;
    }
    if (victim < 0) break;
    ESP_LOGI(TAG, "parked %.8s dropped from the list; still on the card",
             s_jobs[victim].uuid);
    list_drop(victim);
    s_parked_off_list++;
    dropped++;
  }
  return dropped;
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                     */
/* ------------------------------------------------------------------ */

/**
 * One pass over the card, adding what belongs in the queue and is not already
 * in the RAM list. Returns false when it never got the card — the caller's cue
 * to wait rather than loop.
 *
 * The walk stays here rather than moving to upload_store.c because it is queue
 * policy: it consults rq_reconcile_action(), the RAM list and the current Roll,
 * and it is the piece that holds and yields the storage lock. upload_store.c is
 * free of FreeRTOS and storage.h so it can run on a host; this would drag both
 * back in.
 *
 * One acquire for the whole pass, because opendir/readdir touch the card too,
 * and a yield check between entries. A pass abandoned halfway costs nothing: it
 * re-arms s_rescan, and every action it takes is idempotent.
 */
static bool queue_scan(void) {
  if (!card_take()) {
    s_rescan = true;
    return false;
  }

  DIR *d = opendir(UPLOAD_STORE_DIR);
  if (d == NULL) {
    card_give();
    return true; /* no captures directory yet is not a fault */
  }

  char roll_id[RQ_CAPTURE_ID_LEN];
  bool on_roll = current_roll(roll_id, sizeof roll_id);

  int looked_at = 0, added = 0, repaired = 0, parked_off = 0;
  /* True while the pass is still on course to see every directory on the card.
   * Only a pass that finishes may replace s_parked_off_list: a partial walk
   * counts a subset and would report fewer parked captures than there are. */
  bool whole_card = true;
  struct dirent *e;
  s_cap_hit = false;
  s_rescan = false;
  while ((e = readdir(d)) != NULL && looked_at < SCAN_MAX_DIRS) {
    /* Between entries, not inside one: a half-reconciled directory means
     * nothing, and one entry is a stat and a 400-byte read. */
    if (storage_yield_requested(STORAGE_USER_UPLOAD)) {
      s_rescan = true;
      whole_card = false;
      break;
    }
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

    rq_job_t job = {0};
    const rq_reconcile_t action =
        upload_store_inspect(uuid, on_roll ? roll_id : NULL, STORAGE_CAPTURE_FRAMES, &job);
    if (action == RQ_REC_IGNORE) continue;
    if (action == RQ_REC_REPAIR) {
      repaired++;
      ESP_LOGW(TAG, "rebuilding unreadable UPLOAD.JSON for %.8s", uuid);
      klog("SD", "upload record rebuilt for %.8s", uuid);
    }
    /* RESUME is already on the card as it stands. The other two are new records
     * and have to land before the queue acts on them; a write that fails just
     * leaves the directory for the next pass. */
    if (action != RQ_REC_RESUME && !upload_store_save(&job)) continue;

    if (job.state == RQ_FAILED) {
      /* Parked, and the list already holds as many parked captures as it
       * usefully can. Counted rather than queued: the record is on the card
       * unchanged, so it is still here at the next pass and UPLOAD_QUEUE_RETRY
       * still revives it — and the slot it would have taken goes to a capture
       * that can actually be uploaded. */
      lock();
      const bool room_for_parked = count_parked() < PARKED_IN_RAM_MAX;
      unlock();
      if (!room_for_parked) {
        parked_off++;
        continue;
      }
    }

    lock();
    bool room = list_add(&job);
    unlock();
    if (!room) {
      whole_card = false;
      break;
    }
    added++;
  }
  closedir(d);
  card_give();

  if (whole_card && looked_at < SCAN_MAX_DIRS) {
    /* The card is the authority on how many captures are parked. Recomputing
     * here rather than only accumulating keeps the number from drifting when a
     * trimmed job is re-read and trimmed again. */
    lock();
    s_parked_off_list = parked_off;
    unlock();
  }

  if (looked_at > 0) {
    ESP_LOGI(TAG, "reconcile: %d dirs, %d queued, %d repaired", looked_at, added, repaired);
  }
  if (added > 0 || repaired > 0) {
    klog("SD", "upload queue: %d queued, %d repaired", added, repaired);
  }
  return true;
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

/**
 * Where `uuid` lives NOW, given it was at `idx` when the step started. -1 when
 * the job has left the list entirely. Lock held.
 *
 * The index alone was the bug: a step that succeeded while the list was
 * rewritten under it had its result thrown away, and for RQ_STEP_REGISTER that
 * result is the server's capture id. Without it rq_next_step() asks for a
 * REGISTER again, so the capture is re-registered on the next pass — harmless
 * to the server, which is idempotent on the UUID, but the job never advances
 * for as long as the list keeps moving. The UUID is the identity; the index is
 * only where it was.
 */
static int relocate_job(int idx, const char *uuid) {
  if (still_ours(idx, uuid)) return idx;
  return find_job(uuid);
}

/*
 * The queue's backoff with +-25 % of noise on it.
 *
 * rq_backoff_ms() stays deterministic: it is the contract's curve, it mirrors
 * backoffMs() in apps/twin/src/roll/bridge.ts, and the host tests assert it
 * exactly. The jitter belongs here, at the one place that already has a clock
 * and an entropy source.
 *
 * Without it, four cameras that lost the same access point at the same moment
 * retry on the same millisecond and go on doing so for as long as it is down —
 * the AP sees four clients associating at once, every time, which is the shape
 * that gets a burst dropped rather than served.
 */
static uint32_t jittered_backoff(uint32_t attempts) {
  const uint32_t base = rq_backoff_ms(attempts);
  if (base < 4u) return base;
  /* The hardware RNG. This wants spread, not secrecy. */
  const uint32_t span = base / 2u; /* the whole -25 %..+25 % window */
  return base - base / 4u + esp_random() % (span + 1u);
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

  roll_step_result_t res = {0};
  s_http(&snapshot, step, &res);
  rq_disposition_t disp = rq_classify_status(res.status);

  lock();
  /* Apply to the live record, not the snapshot: retry_all may have cleared this
   * job's backoff while the step was in flight, and writing the snapshot back
   * would undo that. rq_apply is a pure transition either way. */
  idx = relocate_job(idx, snapshot.uuid);
  if (idx < 0) {
    /* The UUID has left the list — a COMPLETE drop or a parked trim, and
     * neither wants this result. A job that merely MOVED is found again above
     * and the result applied where it now lives. */
    s_active = -1;
    unlock();
    return true;
  }
  s_active = idx;
  rq_job_t *job = &s_jobs[idx];
  if (disp == RQ_DISP_OK && step.kind == RQ_STEP_REGISTER) {
    /* rq_apply will not advance past REGISTER without this — the server's id is
     * the caller's proof the step landed. */
    snprintf(job->capture_id, sizeof job->capture_id, "%s", res.capture_id);
  }
  bool dirty = rq_apply(job, step, disp, res.detail);

  /* The end of the chain, and the only row that means the product works: the
   * server confirmed a capture, so a photograph from this body reached a Roll.
   * Marked on the completion step alone - a thumb that uploaded is not a
   * capture the server has accepted. */
  if (disp == RQ_DISP_OK && step.kind == RQ_STEP_COMPLETE_CAPTURE &&
      hwv_rule_roll_upload(res.status, true)) {
    hwv_mark_validated(HWV_C6_ROLL_UPLOAD, "server confirmed a capture");
  }
  if (job->state == RQ_RETRY_WAIT) {
    /* roll_queue.c never reads a clock, so the deadline is set here. A re-read
     * runs immediately: a checksum mismatch is not a network failure and has
     * nothing to wait for. */
    job->next_attempt_ms =
        disp == RQ_DISP_REREAD ? now_ms() : now_ms() + jittered_backoff(job->attempts);
  }
  if (disp == RQ_DISP_HALT) s_halted = true;
  if (res.detail[0] != '\0') rq_redact(s_last_error, sizeof s_last_error, res.detail);
  snapshot = *job;
  s_active = -1;
  unlock();

  /* Persist BEFORE the next network operation: a frame that landed and was not
   * written down is a frame this queue uploads twice after a reboot. A failed
   * write backs the job off rather than carrying on — the card is gone or full,
   * and neither gets better by uploading more.
   *
   * Refused and failed are different and get different waits: busy means
   * someone else is on the card, so come back in a moment; a write that failed
   * means the card is gone or full, which is the full backoff cap. */
  if (dirty) {
    const bool busy = !card_take();
    const bool wrote = !busy && upload_store_save(&snapshot);
    if (!busy) card_give();
    if (!wrote) {
      lock();
      const int back_at = relocate_job(idx, snapshot.uuid);
      if (back_at >= 0) {
        s_jobs[back_at].state = RQ_RETRY_WAIT;
        s_jobs[back_at].next_attempt_ms = now_ms() + (busy ? CARD_WAIT_MS : RQ_BACKOFF_CAP_MS);
      }
      unlock();
      if (busy) {
        rq_redact(s_last_error, sizeof s_last_error, "card busy");
      } else {
        rq_redact(s_last_error, sizeof s_last_error, "UPLOAD.JSON write failed");
        ESP_LOGW(TAG, "could not persist %.8s; backing off", snapshot.uuid);
      }
      return true;
    }
  }

  lock();
  int at = relocate_job(idx, snapshot.uuid);
  if (at >= 0 && s_jobs[at].state == RQ_COMPLETE) {
    list_drop(at);
    s_uploaded++;
    /* The card held more than the RAM list could take and a slot has just
     * freed. The rescan happens when the worker next runs dry — a directory
     * scan does not belong between two network steps. */
    if (s_cap_hit) s_rescan = true;
  }
  /* Trimmed here and not at the moment of failure, because the FAILED state
   * has to be on the card first: a job dropped from the list before its record
   * was written would come back from the next reconciliation pass as
   * RETRY_WAIT and run its step again. s_active is already -1, so nothing in
   * flight can be trimmed out from under the worker. */
  if (trim_parked() > 0 && s_cap_hit) s_rescan = true;
  unlock();
  return true;
}

static void worker_task(void *arg) {
  (void)arg;
  for (;;) {
    uint32_t ignored;
    if (storage_capture_active()) {
      /* Photography wins. The lock's own state, not a boolean this module keeps,
       * so there is nothing to get out of step with. Only an optimisation:
       * correctness is the lock's job, not this check's. */
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
      /* Clears both flags, and re-arms s_rescan when it could not finish.
       * Sleeping on a refusal is what keeps that from being a spin. */
      if (queue_scan()) continue;
      xTaskNotifyWait(0, 0, &ignored, IDLE_TICKS);
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

  /* A refusal here is not a failure: s_rescan is re-armed and the worker picks
   * the pass up as soon as the card is free. */
  (void)queue_scan();

  /* Priority 2, below ui (4) and the capture workers (5), deliberately. Gate F
   * in firmware/FIRMWARE_ROADMAP.md asks for capture timing and CRC error rates
   * unchanged with the radio active; the cheapest way to hold that is for this
   * task never to be the one the scheduler picks over a frame. */
  /*
   * 8192, not 4096.
   *
   * 4096 was sized before this task did any HTTP. It now runs the whole upload
   * conversation - esp_http_client, the JSON bodies, and the SD reads that
   * feed them - and the bench caught it the first time a real queue was
   * offered to a reachable API:
   *
   *   Guru Meditation Error: Core 0 panic'ed (Stack protection fault).
   *   Detected in task "upqueue"
   *
   * The panic rebooted the P4, the 32 queued jobs reloaded from the card on
   * the next boot, and the drain panicked again - a loop that never advanced
   * and never lost a job, which is at least the durable half working.
   *
   * Unlike the gallery overflow this is depth rather than an oversized frame:
   * there is no big local to move, the space goes into esp_http_client and
   * mbedtls below it. 8192 is what kdp_server needed for the same shape of
   * work. The high-water mark is in GET_RUNTIME_STATS; check it rather than
   * trusting this number.
   */
  TaskHandle_t h = NULL;
  if (xTaskCreate(worker_task, "upqueue", 8192, NULL, 2, &h) != pdPASS) {
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

  /*
   * One file write, no network, no blocking.
   *
   * This function has two callers at different lock depths and must be correct
   * under both. capture.c's done-listener runs inside that capture's own
   * storage_acquire(STORAGE_USER_CAPTURE), so an unconditional acquire would
   * deadlock the capture task against a non-recursive mutex. kdp_net.c's
   * UPLOAD_ENQUEUE runs on the KDP server task holding nothing, so skipping the
   * acquire would write the card unprotected.
   *
   * storage_acquire_unless_held() is exactly that shape: it takes the lock only
   * if this task is not already the holder, and reports whether a release is
   * owed. A refusal means the card is busy — the photograph is already
   * committed and reconciliation finds it at the next boot, so returning an
   * error here is a missed upload, never a lost picture.
   */
  bool took = false;
  if (!storage_acquire_unless_held(STORAGE_USER_UPLOAD, CARD_WAIT_MS, &took)) {
    return ESP_ERR_TIMEOUT;
  }
  const bool saved = upload_store_save(&job);
  storage_release_if_taken(STORAGE_USER_UPLOAD, took);
  if (!saved) return ESP_FAIL;

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
  /* Parked captures the RAM list no longer holds still count. The record is on
   * the card, UPLOAD_QUEUE_RETRY still revives them, and a display that showed
   * four when eight are parked would be reporting the size of a buffer. */
  out->failed += s_parked_off_list;
  out->uploading = s_active >= 0 ? 1 : 0;
  out->uploaded = s_uploaded;
  out->halted = s_halted;
  out->draining = !storage_capture_active() && s_net_ready && !s_halted &&
                  (out->pending > 0 || s_active >= 0);
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
  /* The parked captures this list had to drop are still on the card, and the
   * retry the user just pressed is meant for them too. Reviving the ones in
   * RAM frees the parked slots, so a pass over the card brings the rest back
   * in. The worker runs it when it next comes up empty. */
  if (s_parked_off_list > 0) s_rescan = true;
  unlock();

  /* Not written to the card. Backoff deadlines are monotonic milliseconds,
   * which a reboot resets anyway, so persisting them buys nothing and would put
   * UPLOAD_QUEUE_RETRY on the SD write path. */
  wake();
  return revived;
}
