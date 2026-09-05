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

#include "esp_attr.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "hardware_validation.h"
#include "hwv_rules.h"
#include "capture.h"
#include "klog.h"
#include "net_link.h"
#include "roll_api.h"
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

/* In PSRAM: task-only, under s_lock, never touched with the flash cache off.
 * Internal SRAM is reserved for what must be internal (#162). */
static EXT_RAM_BSS_ATTR rq_job_t s_jobs[UPLOAD_QUEUE_MAX];
static int s_count;
static int s_active = -1; /* index the worker is on, -1 when none */
static SemaphoreHandle_t s_lock;
static TaskHandle_t s_task;
static bool s_halted;
static bool s_net_ready; /* last reported can-upload, so the log fires once */
static bool s_cap_hit;   /* the last scan filled the RAM list and stopped */
static bool s_rescan;    /* a pass is owed now */
/* A delete asked for the job the worker is mid-step on; see
 * upload_queue_forget() and the check after the step returns. */
static bool s_forget_active;
/* Where the next pass starts, and what the last complete cycle found that the
 * RAM window had no room for. The card is the queue; this is the window's
 * position on it (#167). */
static rq_scan_t s_scan;
static int s_uploaded;
static char s_last_error[RQ_ERROR_LEN];
/* Parked captures on the card that are NOT in the RAM list, so
 * UPLOAD_QUEUE_STATUS reports how many are parked rather than how many
 * happened to fit. Recomputed from the card by a reconciliation pass that runs
 * to the end, and bumped in between by every job this file trims. */
static int s_parked_off_list;
/* What the last step learned about the server (see upload_server_state_t),
 * and whether transient parks on the card are welcome back into the window:
 * set when the network or the server comes back, so the next pass adopts
 * them as RETRY_WAIT instead of counting them as failed. */
static upload_server_state_t s_server_state;
static bool s_revive_parked;
static bool s_boot_revived; /* the once-per-boot welcome above ran */
/* When a probe last woke a parked job to find out whether the server is back.
 * A link that is up with every job parked would otherwise never try again. */
static int64_t s_last_probe_ms;
#define PARKED_PROBE_MS (10 * 60 * 1000)

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
  lock();
  if (s_parked_off_list == 0) s_revive_parked = false;
  unlock();
  if (!card_take()) {
    s_rescan = true;
    return false;
  }

  DIR *d = opendir(UPLOAD_STORE_DIR);
  if (d == NULL) {
    card_give();
    return true; /* no captures directory yet is not a fault */
  }


  int looked_at = 0, added = 0, repaired = 0, parked_off = 0, unadmitted = 0, unreadable = 0,
      retired = 0, retired_no_roll = 0, unwritten = 0;
  /*
   * The pass is a WINDOW on the card, not a prefix of it.
   *
   * SCAN_MAX_DIRS bounds the work one pass may do - the card is slow and a
   * capture must be able to take it back - and rq_scan_skip() says where that
   * work starts. Without the cursor the bound made every pass examine the same
   * first 512 directories: with 788 on the card the newest 276 were invisible,
   * so a capture that missed the RAM window at the shutter was never uploaded,
   * not by a later pass and not after a reboot (#167).
   *
   * `seen` counts capture directories encountered including the skipped ones,
   * because the cursor is positional. `looked_at` counts the ones this pass
   * actually examined, which is what the work bound limits and what the cursor
   * advances by.
   */
  const uint32_t skip = rq_scan_skip(&s_scan);
  uint32_t seen = 0;
  bool reached_end = false;
  struct dirent *e = NULL;
  /* Take the request under the lock rather than clearing it mid-function: an
   * enqueue that lands while this pass is walking must not have its request
   * dropped, and the only writer that clears it is this line. */
  lock();
  s_cap_hit = false;
  s_rescan = false;
  unlock();
  while ((e = readdir(d)) != NULL) {
    if (!storage_is_capture_dirname(e->d_name)) continue;
    if (seen++ < skip) continue; /* examined by an earlier pass in this cycle */
    if (looked_at >= SCAN_MAX_DIRS) break;
    /* Between entries, not inside one: a half-reconciled directory means
     * nothing, and one entry is a stat and a 400-byte read. */
    if (storage_yield_requested(STORAGE_USER_UPLOAD)) break;
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
    bool needs_save = false;
    const rq_reconcile_t action =
        upload_store_inspect_ex(uuid, STORAGE_CAPTURE_FRAMES, &job, &needs_save);
    if (action == RQ_REC_IGNORE) continue;
    if (action == RQ_REC_UNREADABLE) {
      /* Left exactly as found, and counted. A card where this is not zero has
       * captures no pass can decide about, which is worth seeing in the log
       * rather than inferring from a queue that never drains. */
      unreadable++;
      continue;
    }
    if (action == RQ_REC_REPAIR) {
      repaired++;
      ESP_LOGW(TAG, "rebuilding unreadable UPLOAD.JSON for %.8s", uuid);
      klog("SD", "upload record rebuilt for %.8s", uuid);
    } else if (action == RQ_REC_RESUME && needs_save) {
      /* A record from before frameSlots: its cameras were just read from META
       * (or it was parked because META could not say). Logged because it is
       * the migration #164 called for, and it happens once per photograph. */
      klog("SD", "upload record %.8s: cameras %s", uuid,
           job.state == RQ_FAILED ? "unknown, parked" : "recovered from META");
    }
    if (action == RQ_REC_RETIRE) {
      /*
       * Say which capture, and say why, because nothing else does.
       *
       * RETIRE parks the job in RAM with the reason and deliberately leaves
       * `UPLOAD.JSON` alone, so the only trace of the decision is a number in
       * `failed`. On a card with a hundred of them that number is unusable: it
       * cannot separate "these photographs were taken off a Roll" from a
       * reader that lost their Roll for them, which is exactly the confusion
       * #168 lived in. Bounded to the first few per pass - the reason repeats,
       * and a flooded log ring evicts the lines it is read from.
       */
      retired++;
      /* Two classes, and only one of them is interesting. A META naming no
       * Roll is an old photograph taken off a Roll and there are 166 of them
       * on the bench card; a META naming a DIFFERENT Roll from the record is a
       * disagreement worth a line every time. */
      if (job.last_error[0] != '\0' && strstr(job.last_error, "capture none") != NULL) {
        retired_no_roll++;
      } else {
        klog("SD", "capture %.8s retired: %s", uuid, job.last_error);
      }
    }

    if (job.state == RQ_FAILED && rq_park_is_transient(&job)) {
      lock();
      const bool welcome = s_revive_parked;
      unlock();
      if (welcome) {
        /* Parked because the server was away, and the server is back (or the
         * network is): back in play, and the record rewritten so the card
         * agrees. Bounded by list room like any other adoption; what does
         * not fit stays parked on the card for the next pass. */
        rq_job_revive(&job);
        needs_save = true;
      }
    }

    /*
     * A record that changed, or that is new, has to land before the queue acts
     * on it; a write that fails leaves the directory for the next pass.
     *
     * Counted and named, because this was the scan's last silent exit. A
     * capture that lands here is skipped with no bucket, no count and no log
     * line, and on a card where the write keeps failing that repeats on every
     * pass and every boot - a photograph on the card, a record that says
     * QUEUED, and a queue that says nothing is owed.
     */
    if (needs_save && !upload_store_save(&job)) {
      unwritten++;
      if (unwritten <= 3) {
        klog("SD", "capture %.8s: its record could not be rewritten, left for the next pass",
             uuid);
      }
      continue;
    }

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
      /* Nowhere to put it. Counted so the queue can say that durable work is
       * waiting, and the pass stops here so the cursor resumes on this very
       * directory once a slot frees. */
      unadmitted++;
      break;
    }
    if (added < 6) klog("SD", "queue admitted %.8s as %s", uuid, rq_state_name(job.state));
    added++;
  }
  /* e is NULL only when readdir ran out, which is the whole card seen. Every
   * break above leaves it non-NULL. */
  reached_end = e == NULL;
  closedir(d);
  card_give();

  lock();
  rq_scan_pass_done(&s_scan, (uint32_t)looked_at, (uint32_t)unadmitted, reached_end);
  /* Another pass is owed while the cycle is unfinished or the last complete
   * cycle found work the window refused. */
  if (rq_scan_more(&s_scan)) s_rescan = true;
  if (reached_end) {
    /* The card is the authority on how many captures are parked. Only a pass
     * that reached the end may replace the count: a partial walk counts a
     * subset and would report fewer parked captures than there are. */
    s_parked_off_list = parked_off;
    /* The first complete count after boot finds the captures an outage parked
     * before the reboot. The link-up revive ran before any of them had been
     * counted, so without this they waited for the ten-minute probe (bench
     * 2026-09-05: 101 parked, first upload at +10 min). If the server is not
     * known to be down, welcome them back now; the next pass adopts them. */
    if (parked_off > 0 && !s_revive_parked && s_server_state != UPLOAD_SERVER_UNREACHABLE &&
        !s_boot_revived) {
      s_boot_revived = true;
      s_revive_parked = true;
      s_rescan = true;
      klog("P4", "upload: %d job(s) parked before boot, back in play", parked_off);
    }
  }
  unlock();

  if (looked_at > 0) {
    ESP_LOGI(TAG,
             "reconcile: %d dirs from %u, %d queued, %d repaired, %d unadmitted, %d unreadable, "
             "%d retired (%d of them taken off any Roll), %d unwritten%s",
             looked_at, (unsigned)skip, added, repaired, unadmitted, unreadable, retired,
             retired_no_roll, unwritten, reached_end ? ", card seen" : "");
  }
  if (unreadable > 0) {
    klog("SD", "upload queue: %d captures with an unreadable META, not queued", unreadable);
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

/*
 * The server is back, or the network is: every job parked for a run of
 * network failures goes back in play. Lock held by the caller. Parked
 * captures the window trimmed are on the card; the flag tells the next pass
 * to adopt them as RETRY_WAIT rather than count them (#167 shape, in
 * reverse).
 */
static void revive_transient_locked(const char *why) {
  int revived = 0;
  for (int i = 0; i < s_count; i++) {
    if (!rq_park_is_transient(&s_jobs[i])) continue;
    rq_job_revive(&s_jobs[i]);
    revived++;
  }
  if (s_parked_off_list > 0) {
    s_revive_parked = true;
    s_rescan = true;
  }
  if (revived > 0 || s_parked_off_list > 0) {
    klog("P4", "upload: %s, %d parked job(s) back in play, %d more on the card", why, revived,
         s_parked_off_list);
  }
}

/* What the step's HTTP result says about the server. Lock held. */
static void note_server_locked(const roll_step_result_t *res) {
  if (res->card_yielded) return; /* the card refused; the server was never asked */
  const upload_server_state_t was = s_server_state;
  s_server_state = res->status > 0 ? UPLOAD_SERVER_REACHABLE : UPLOAD_SERVER_UNREACHABLE;
  if (s_server_state == UPLOAD_SERVER_REACHABLE && was != UPLOAD_SERVER_REACHABLE) {
    revive_transient_locked("server answered");
  }
}

/*
 * Nothing to do and jobs parked for network reasons: every PARKED_PROBE_MS,
 * wake one of them so the queue finds out whether the server is back. One,
 * not all - if it is still down that costs one connect attempt per ten
 * minutes, and if it is up its answer revives the rest. True when it did
 * something, so the worker loops rather than sleeps.
 */
static bool maybe_probe_parked(void) {
  const int64_t now = now_ms();
  if (s_last_probe_ms != 0 && now - s_last_probe_ms < PARKED_PROBE_MS) return false;
  bool did = false;
  lock();
  for (int i = 0; i < s_count; i++) {
    if (!rq_park_is_transient(&s_jobs[i])) continue;
    rq_job_revive(&s_jobs[i]);
    did = true;
    break;
  }
  if (!did && s_parked_off_list > 0) {
    /* Nothing parked in RAM, some on the card: let the pass bring one in. */
    s_revive_parked = true;
    s_rescan = true;
    did = true;
  }
  unlock();
  if (did) {
    s_last_probe_ms = now;
    klog("P4", "upload: probing whether the server is back");
  } else {
    s_last_probe_ms = now; /* nothing parked; check again in a while */
  }
  return did;
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
  rq_disposition_t disp = rq_classify_step(res.status, res.card_yielded);

  lock();
  note_server_locked(&res);
  /* Apply to the live record, not the snapshot: retry_all may have cleared this
   * job's backoff while the step was in flight, and writing the snapshot back
   * would undo that. rq_apply is a pure transition either way. */
  idx = relocate_job(idx, snapshot.uuid);
  if (idx < 0) {
    /* The UUID has left the list — a COMPLETE drop or a parked trim, and
     * neither wants this result. A job that merely MOVED is found again above
     * and the result applied where it now lives. */
    s_forget_active = false;
    s_active = -1;
    unlock();
    return true;
  }
  if (s_forget_active) {
    /* upload_queue_forget() ran while this step was in flight. The photograph
     * is gone from the card, so the result - landed or not - has nowhere to
     * be recorded and nothing left to upload. Drop, and do not persist. */
    s_forget_active = false;
    list_drop(idx);
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
    job->next_attempt_ms = disp == RQ_DISP_REREAD ? now_ms()
                           : disp == RQ_DISP_YIELD ? now_ms() + CARD_WAIT_MS
                                                   : now_ms() + jittered_backoff(job->attempts);
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
  /*
   * A settled job leaves the list whatever the card said.
   *
   * The drop used to sit after the persist branch below, which returns early
   * when the write was refused - and a capture holding the card at that moment
   * is exactly what a shutter three seconds later does. The job then stayed in
   * the list as COMPLETE for ever: pick_job() skips it, UPLOAD_QUEUE_RETRY
   * will not revive it, and upload_queue_status() counts it as pending (#166).
   * Dropping it here costs at most one redundant `complete` call after a
   * reboot, which the server is idempotent about and which this file already
   * accepts elsewhere; leaving it costs a queue that never reads zero, which
   * is also what made #167 hard to see.
   */
  if (snapshot.state == RQ_COMPLETE) {
    lock();
    const int done_at = relocate_job(idx, snapshot.uuid);
    if (done_at >= 0) {
      list_drop(done_at);
      s_uploaded++;
      /* A slot has freed: look at the card again rather than waiting for a
       * reason to. */
      s_rescan = true;
    }
    unlock();
  }

  if (dirty) {
    const bool busy = !card_take();
    const bool wrote = !busy && upload_store_save(&snapshot);
    if (!busy) card_give();
    if (!wrote) {
      lock();
      const int back_at = relocate_job(idx, snapshot.uuid);
      /* A settled job stays settled: re-stepping a parked job because its
       * record could not be written is how one reached 20 attempts against a
       * budget of 12 (Gate F bench, 2026-08-30). The record catches up at the
       * next successful write or at boot reconciliation. */
      if (back_at >= 0 && snapshot.state != RQ_FAILED && snapshot.state != RQ_COMPLETE) {
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
      /* Not eligible: no radio in this build (NOT_ROUTED), or a routed radio
       * short of IP_READY, or the queue halted on a credential failure. The
       * transition above is the only thing logged; nothing per tick, so a
       * queue that cannot run does not evict the log lines it is reported
       * from. Eligibility is net_link's IP_READY and nothing else - the same
       * answer NETWORK_STATUS gives, from the same state. */
      xTaskNotifyWait(0, 0, &ignored, IDLE_TICKS);
      continue;
    }

    if (run_one_step()) continue;
    if (!s_rescan && maybe_probe_parked()) continue;
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

/*
 * The shutter's own hand-off. Runs on the capture task inside that capture's
 * storage lock (upload_queue_enqueue_for() takes the card lock only if this
 * task does not already hold it). The Roll is the report's snapshot, taken at
 * the shutter - not whatever is active when this runs, and not looked up
 * again at boot. A capture off a Roll produces no job here and none later.
 */
static void on_capture_done(const capture_report_t *r) {
  if (r == NULL || !r->ok || r->stored <= 0) return;
  if (r->roll_id[0] == '\0') return;
  const bool thumb = upload_store_has_file(r->uuid, "THUMB.JPG");
  /* The cameras whose frames are on the card, by slot - the same list META's
   * `frames` was just written from (meta.c walks r->cam the same way). Not a
   * count: a set with camera 2 dark is [1,3,4], and the job has to say so. */
  uint8_t slots[RQ_MAX_FRAMES];
  int n = 0;
  for (int i = 0; i < CAPTURE_CAMS && n < RQ_MAX_FRAMES; i++) {
    if (r->cam[i].ok) slots[n++] = (uint8_t)(i + 1);
  }
  const esp_err_t err = upload_queue_enqueue_slots(r->uuid, r->roll_id, slots, n, thumb);
  if (err != ESP_OK) {
    klog("P4", "upload: %s not queued (%s); reconciliation will retry at boot", r->id,
         esp_err_to_name(err));
  }
}

esp_err_t upload_queue_start(void) {
  if (s_task != NULL) return ESP_OK;
  capture_on_done(on_capture_done);
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

esp_err_t upload_queue_enqueue(const char *capture_uuid, bool thumb_present) {
  if (capture_uuid == NULL || !storage_is_capture_dirname(capture_uuid)) {
    return ESP_ERR_INVALID_ARG;
  }
  /* The capture's own Roll and its own frame list, both from its META.JSON.
   * Not the Roll that is active now, and not a count of C<n>.JPG files:
   * UPLOAD_ENQUEUE is a host asking about an existing photograph, and the
   * photograph already says which Roll it was taken on, or that it was taken
   * on none, and which cameras it holds. */
  char roll_id[RQ_CAPTURE_ID_LEN];
  if (!upload_store_meta_roll_id(capture_uuid, roll_id, sizeof roll_id)) {
    return ESP_ERR_INVALID_STATE;
  }
  uint8_t slots[RQ_MAX_FRAMES];
  const int n = upload_store_meta_frames(capture_uuid, STORAGE_CAPTURE_FRAMES, slots, RQ_MAX_FRAMES);
  if (n < 0) return ESP_ERR_INVALID_RESPONSE;
  return upload_queue_enqueue_slots(capture_uuid, roll_id, slots, n, thumb_present);
}

esp_err_t upload_queue_enqueue_slots(const char *capture_uuid, const char *roll_id,
                                     const uint8_t *slots, int count, bool thumb_present) {
  if (capture_uuid == NULL || !storage_is_capture_dirname(capture_uuid)) {
    return ESP_ERR_INVALID_ARG;
  }
  if (roll_id == NULL || roll_id[0] == '\0') return ESP_OK; /* no Roll, no job */

  rq_job_t job;
  if (!rq_job_init_slots(&job, capture_uuid, roll_id, slots, count, thumb_present)) {
    return ESP_ERR_INVALID_ARG;
  }

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
  if (find_job(job.uuid) < 0 && !list_add(&job)) {
    err = ESP_ERR_NO_MEM;
    /* The record is on the card and the window is full. Ask for a pass rather
     * than waiting for a reboot: before #167 nothing set this, so the capture
     * sat un-uploaded until the next boot - and on a card past the old scan
     * horizon, for ever. */
    s_rescan = true;
  }
  /* Whether or not it was admitted: the card now holds a capture no pass has
   * seen, so the last cycle's "the whole card is seen and nothing is owed" is
   * no longer an answer about this card, and a cycle is owed. */
  rq_scan_card_changed(&s_scan);
  s_rescan = true;
  unlock();

  wake();
  return err;
}


/* Set by upload_queue_forget() when the job being deleted is the one the
 * worker is inside a step on. run_one_step() reads it once the step returns
 * and drops the job instead of persisting it. Lock held for both. */

void upload_queue_forget(const char *capture_uuid) {
  if (capture_uuid == NULL) return;
  lock();
  const int idx = find_job(capture_uuid);
  const rq_forget_t what = rq_forget_action(idx >= 0, idx >= 0 && idx == s_active);
  switch (what) {
    case RQ_FORGET_NOW:
      list_drop(idx);
      break;
    case RQ_FORGET_AFTER_STEP:
      s_forget_active = true;
      break;
    case RQ_FORGET_NONE:
    default:
      break;
  }
  /*
   * The card changed under the window either way. Its UPLOAD.JSON is gone
   * with the directory, so reconciliation cannot resurrect the job; what a
   * cycle still owes is the parked-off-list recount, which is the only place
   * a deleted parked capture could otherwise keep inflating `failed` (#167).
   */
  rq_scan_card_changed(&s_scan);
  s_rescan = true;
  unlock();
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
  /* Durable work the window has not taken yet, and whether the card has been
   * seen end to end since boot. `pending` is the active window; these two are
   * what make "pending 0" mean "nothing left" rather than "nothing loaded"
   * (#167). */
  out->card_pending = (int)s_scan.card_pending;
  out->scan_complete = s_scan.cycle_complete && !rq_scan_more(&s_scan);
  out->uploading = s_active >= 0 ? 1 : 0;
  out->uploaded = s_uploaded;
  out->halted = s_halted;
  out->server_state = s_server_state;
  out->draining = !storage_capture_active() && s_net_ready && !s_halted &&
                  (out->pending > 0 || s_active >= 0);
  memcpy(out->last_error, s_last_error, sizeof out->last_error);
  unlock();
}

void upload_queue_network_restored(void) {
  int due = 0;
  lock();
  for (int i = 0; i < s_count; i++) {
    if (s_jobs[i].state != RQ_RETRY_WAIT) continue;
    rq_job_network_restored(&s_jobs[i]);
    due++;
  }
  /* The link is back. Jobs that parked because it was gone come back with
   * it - the user should not have to press anything for a photograph the
   * network lost. */
  revive_transient_locked("network back");
  unlock();
  if (due > 0) klog("P4", "upload: network back, %d waiting job(s) due now", due);
  wake();
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
    rq_job_revive(job);
    revived++;
  }
  s_halted = false;
  s_last_error[0] = '\0';
  /* The parked captures this list had to drop are still on the card, and the
   * retry the user just pressed is meant for them too. Reviving the ones in
   * RAM frees the parked slots, so a pass over the card brings the rest back
   * in. The worker runs it when it next comes up empty. */
  if (s_parked_off_list > 0) {
    s_revive_parked = true;
    s_rescan = true;
  }
  unlock();

  /* Not written to the card. Backoff deadlines are monotonic milliseconds,
   * which a reboot resets anyway, so persisting them buys nothing and would put
   * UPLOAD_QUEUE_RETRY on the SD write path. */
  wake();
  return revived;
}
