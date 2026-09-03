/*
 * Host tests for firmware/p4/main/roll_queue.c — the Roll upload queue's
 * state machine, resume decisions, retry policy and redaction.
 *
 *   make -C firmware/p4/host_tests test-queue    # no dependencies
 *
 * These exercise the REAL production functions. Nothing here reimplements a
 * rule: a test that duplicated the state machine would agree with a wrong
 * state machine.
 *
 * Every test below names a way a photograph could be lost or duplicated,
 * because that is the only thing this module is for. The camera has no radio
 * routed yet (firmware/C6_HARDWARE_MAP.md), so this file is the ONLY thing
 * that currently proves any of it — which is exactly why it is worth having.
 */
#include <stdio.h>
#include <string.h>

#include "roll_queue.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond, ...)                          \
  do {                                            \
    checks++;                                     \
    if (!(cond)) {                                \
      failures++;                                 \
      printf("FAIL %s:%d: ", __FILE__, __LINE__); \
      printf(__VA_ARGS__);                        \
      printf("\n");                               \
    }                                             \
  } while (0)

static const char *UUID_A = "6f1c6f2a-9b3d-4c1e-8a77-0f2b5d4e1a90";

/* Drive one job to completion the way the upload task would, returning the
 * number of network steps it took. Every step is written back, so this is
 * also the shape a reboot would see between any two calls. */
static int drive_to_complete(rq_job_t *job, int64_t now_ms) {
  int steps = 0;
  for (int guard = 0; guard < 64; guard++) {
    rq_step_t step = rq_next_step(job, now_ms);
    if (step.kind == RQ_STEP_NOTHING) break;
    if (step.kind == RQ_STEP_WAIT_BACKOFF) break;
    if (step.kind == RQ_STEP_REGISTER) {
      strncpy(job->capture_id, "cap_srv_0001", sizeof job->capture_id - 1);
    }
    rq_apply(job, step, RQ_DISP_OK, NULL);
    steps++;
  }
  return steps;
}

/* ---- backoff ---------------------------------------------------------- */

static void test_backoff(void) {
  /* The contract's "1 s -> 30 s cap". attempts includes the failure that
   * just happened, so the first retry waits one second, not zero. */
  CHECK(rq_backoff_ms(0) == 0, "no failures means no wait, got %u", rq_backoff_ms(0));
  CHECK(rq_backoff_ms(1) == 1000, "first retry 1 s, got %u", rq_backoff_ms(1));
  CHECK(rq_backoff_ms(2) == 2000, "second retry 2 s, got %u", rq_backoff_ms(2));
  CHECK(rq_backoff_ms(3) == 4000, "third retry 4 s, got %u", rq_backoff_ms(3));
  CHECK(rq_backoff_ms(4) == 8000, "fourth retry 8 s, got %u", rq_backoff_ms(4));
  CHECK(rq_backoff_ms(5) == 16000, "fifth retry 16 s, got %u", rq_backoff_ms(5));
  CHECK(rq_backoff_ms(6) == RQ_BACKOFF_CAP_MS, "sixth retry caps, got %u", rq_backoff_ms(6));

  /* Monotonic and capped for every value, including the ones that would
   * shift a 32-bit word off its end. A backoff that wrapped to zero would
   * turn a bounded retry into a tight loop against the API. */
  for (uint32_t a = 1; a < 200; a++) {
    uint32_t ms = rq_backoff_ms(a);
    CHECK(ms >= 1000 && ms <= RQ_BACKOFF_CAP_MS, "attempt %u produced %u ms", a, ms);
  }
  CHECK(rq_backoff_ms(4000000000u) == RQ_BACKOFF_CAP_MS, "huge attempt count still caps");
}

/* ---- response classification ------------------------------------------ */

static void test_classify(void) {
  /* No response at all: the bytes were never judged, so it is always
   * transient. This is the C6 link dropping mid-request. */
  CHECK(rq_classify_status(0) == RQ_DISP_RETRY, "no response retries");
  CHECK(rq_classify_status(-1) == RQ_DISP_RETRY, "negative status retries");

  /* Both success codes the contract names for capture create: 201 created
   * and 200 replay. Treating the replay as anything but success is how a
   * retry loop turns into a duplicate. */
  CHECK(rq_classify_status(200) == RQ_DISP_OK, "200 ok");
  CHECK(rq_classify_status(201) == RQ_DISP_OK, "201 ok");
  CHECK(rq_classify_status(204) == RQ_DISP_OK, "204 ok");

  /* Credentials/association: halt, not park. These fail every job
   * identically, so parking them one at a time walks the whole queue into
   * FAILED for something the user can fix. */
  CHECK(rq_classify_status(401) == RQ_DISP_HALT, "401 halts the queue");
  CHECK(rq_classify_status(403) == RQ_DISP_HALT, "403 halts the queue");

  /* Transient, per the contract's error table. */
  CHECK(rq_classify_status(409) == RQ_DISP_RETRY, "409 UPLOAD_IN_PROGRESS retries init");
  CHECK(rq_classify_status(429) == RQ_DISP_RETRY, "429 honours backoff");
  CHECK(rq_classify_status(500) == RQ_DISP_RETRY, "500 retries");
  CHECK(rq_classify_status(502) == RQ_DISP_RETRY, "502 retries");
  CHECK(rq_classify_status(503) == RQ_DISP_RETRY, "503 retries");

  /* 422 is the reconciled case: re-read the card rather than re-send the
   * same bytes, and rather than parking a recoverable photograph. */
  CHECK(rq_classify_status(422) == RQ_DISP_REREAD, "422 re-reads from SD");

  /* Permanent: repeating produces the same answer. */
  CHECK(rq_classify_status(400) == RQ_DISP_PARK, "400 parks");
  CHECK(rq_classify_status(404) == RQ_DISP_PARK, "404 parks");
  CHECK(rq_classify_status(413) == RQ_DISP_PARK, "413 parks");
  CHECK(rq_classify_status(418) == RQ_DISP_PARK, "unknown 4xx parks rather than looping");
}

/* ---- the happy path --------------------------------------------------- */

static void test_order_is_thumb_first(void) {
  rq_job_t job;
  rq_job_init(&job, UUID_A, "roll_0001", 4, true);

  /* Register first — there is no capture id to upload against yet. */
  rq_step_t s = rq_next_step(&job, 0);
  CHECK(s.kind == RQ_STEP_REGISTER, "first step registers, got %d", s.kind);

  strncpy(job.capture_id, "cap_srv_0001", sizeof job.capture_id - 1);
  rq_apply(&job, s, RQ_DISP_OK, NULL);

  /* Thumb before any original. This is the whole point of the ordering:
   * a guest sees a tile before four full JPEGs travel. */
  s = rq_next_step(&job, 0);
  CHECK(s.kind == RQ_STEP_UPLOAD_THUMB, "thumb precedes originals, got %d", s.kind);
  rq_apply(&job, s, RQ_DISP_OK, NULL);
  CHECK(job.state == RQ_THUMB_READY, "thumb done means THUMB_READY, got %s",
        rq_state_name(job.state));

  /* Then frames, in contiguous 1..N order, as the contract requires. */
  for (int expect = 1; expect <= 4; expect++) {
    s = rq_next_step(&job, 0);
    CHECK(s.kind == RQ_STEP_UPLOAD_FRAME, "frame step %d, got %d", expect, s.kind);
    CHECK(s.frame_index == expect, "frames ascend contiguously: wanted %d got %d", expect,
          s.frame_index);
    rq_apply(&job, s, RQ_DISP_OK, NULL);
  }

  s = rq_next_step(&job, 0);
  CHECK(s.kind == RQ_STEP_COMPLETE_CAPTURE, "completes after the last frame, got %d", s.kind);
  rq_apply(&job, s, RQ_DISP_OK, NULL);

  CHECK(job.state == RQ_COMPLETE, "settles COMPLETE, got %s", rq_state_name(job.state));
  CHECK(rq_job_settled(&job), "COMPLETE is settled");
  CHECK(rq_next_step(&job, 0).kind == RQ_STEP_NOTHING, "a complete job asks for nothing more");
}

static void test_capture_without_thumb_skips_it(void) {
  /* thumb.c may not have produced a THUMB.JPG. The job must not wait for a
   * file that does not exist, and must not claim one it never sent. */
  rq_job_t job;
  rq_job_init(&job, UUID_A, "roll_0001", 2, false);
  strncpy(job.capture_id, "cap_srv_0002", sizeof job.capture_id - 1);

  rq_step_t s = rq_next_step(&job, 0);
  CHECK(s.kind == RQ_STEP_UPLOAD_FRAME, "no thumb means straight to frames, got %d", s.kind);
  CHECK(s.frame_index == 1, "starts at frame 1");
  CHECK(!job.thumb_done, "a thumb that was never sent is never marked done");
}

static void test_partial_capture_uploads_only_what_exists(void) {
  /* Two cameras failed. The capture is still worth having, and the server
   * decides `partial` from what arrives — the camera must not fabricate the
   * missing frames to make the count look right. */
  rq_job_t job;
  rq_job_init(&job, UUID_A, "roll_0001", 2, true);
  strncpy(job.capture_id, "cap_srv_0003", sizeof job.capture_id - 1);

  int seen = 0;
  for (int guard = 0; guard < 16; guard++) {
    rq_step_t s = rq_next_step(&job, 0);
    if (s.kind == RQ_STEP_COMPLETE_CAPTURE) break;
    if (s.kind == RQ_STEP_UPLOAD_FRAME) seen++;
    rq_apply(&job, s, RQ_DISP_OK, NULL);
  }
  CHECK(seen == 2, "a 2-frame capture uploads exactly 2 frames, saw %d", seen);
}

/* ---- reboot and resume ------------------------------------------------ */

static void test_resume_after_reboot_repeats_nothing(void) {
  /* The defining test. Power cut between frame 2 and frame 3: the record on
   * the card is all the next boot has. It must resume at frame 3 — not
   * restart at frame 1 (wasted bandwidth, and a re-PUT of bytes the server
   * already holds) and not skip to complete (a lost photograph). */
  rq_job_t before;
  rq_job_init(&before, UUID_A, "roll_0001", 4, true);
  strncpy(before.capture_id, "cap_srv_0004", sizeof before.capture_id - 1);
  before.thumb_done = true;
  before.frame_done[0] = true;
  before.frame_done[1] = true;
  before.state = RQ_ORIGINALS_UPLOADING;

  /* What survives is exactly the struct, because that is what UPLOAD.JSON
   * holds. Copy it to make the "nothing else carried over" claim literal. */
  rq_job_t after = before;

  rq_step_t s = rq_next_step(&after, 0);
  CHECK(s.kind == RQ_STEP_UPLOAD_FRAME, "resumes into a frame upload, got %d", s.kind);
  CHECK(s.frame_index == 3, "resumes at frame 3, got %d", s.frame_index);

  /* And the capture id is reused, so the re-POST is a replay and not a
   * second capture. */
  CHECK(strcmp(after.capture_id, "cap_srv_0004") == 0, "capture id survives the reboot");

  int steps = drive_to_complete(&after, 0);
  CHECK(steps == 3, "frames 3, 4 and the complete call remain: 3 steps, got %d", steps);
  CHECK(after.state == RQ_COMPLETE, "finishes, got %s", rq_state_name(after.state));
}

static void test_deadline_from_a_previous_boot_is_void(void) {
  /* Bench 2026-08-30, boot-412 -> boot-413: CAP_000186 was captured with the
   * API down, backed off to next_attempt_ms 1620904 on that boot's clock, the
   * P4 rebooted, reconciliation resumed the job - and the worker then held it
   * until the new uptime reached 27 minutes. The API had been back for three. */
  rq_job_t job;
  rq_job_init(&job, UUID_A, "roll_0001", 1, true);
  job.state = RQ_RETRY_WAIT;
  job.attempts = 3;
  job.next_attempt_ms = 1620904;
  CHECK(!rq_retry_due(&job, 25000), "as written, a fresh boot at 25 s would wait");
  rq_job_boot_resume(&job);
  CHECK(rq_retry_due(&job, 25000), "after boot the job is due now");
  CHECK(rq_retry_due(&job, 0), "due at uptime zero, not at some later tick");
  CHECK(job.attempts == 3, "the attempt history survives; only the clock does not");
  CHECK(job.state == RQ_RETRY_WAIT, "state is not the resume's business");

  /* Other states carry no deadline that matters; they are left as they are. */
  rq_job_t queued;
  rq_job_init(&queued, UUID_A, "roll_0001", 1, true);
  queued.next_attempt_ms = 777;
  rq_job_boot_resume(&queued);
  CHECK(queued.next_attempt_ms == 777 && queued.state == RQ_QUEUED, "a QUEUED job is untouched");
  rq_job_t parked;
  rq_job_init(&parked, UUID_A, "roll_0001", 1, true);
  parked.state = RQ_FAILED;
  parked.next_attempt_ms = 777;
  rq_job_boot_resume(&parked);
  CHECK(parked.state == RQ_FAILED && parked.next_attempt_ms == 777, "a parked job stays parked");
  rq_job_boot_resume(NULL);
}

static void test_yield_costs_no_attempt(void) {
  /* Gate F bench 2026-08-30: CAP_000231 parked FAILED with attempts 20 and
   * "the asset is not on the card" while C1.JPG sat on the card intact -
   * every stat during a burst of shutters found the card held by a capture,
   * and each refusal was booked as a transient failure. */
  CHECK(rq_classify_step(0, true) == RQ_DISP_YIELD, "a yield is a yield whatever the status");
  CHECK(rq_classify_step(201, true) == RQ_DISP_YIELD, "even with a status the step did not run");
  CHECK(rq_classify_step(0, false) == RQ_DISP_RETRY, "no yield: status 0 is the usual transient");
  CHECK(rq_classify_step(201, false) == RQ_DISP_OK, "no yield: the status speaks");

  rq_job_t job;
  rq_job_init(&job, UUID_A, "roll_0001", 1, true);
  job.state = RQ_ORIGINALS_UPLOADING;
  snprintf(job.capture_id, sizeof job.capture_id, "cap_x");
  job.thumb_done = true;
  job.attempts = 3;
  rq_step_t s = rq_next_step(&job, 0);
  for (int i = 0; i < 100; i++) {
    const bool dirty = rq_apply(&job, s, RQ_DISP_YIELD, "yielded the card to a capture");
    CHECK(!dirty, "a yield changes nothing durable");
    CHECK(job.state == RQ_RETRY_WAIT, "waits, briefly");
    CHECK(job.attempts == 3, "attempts untouched after %d yields, got %u", i + 1, job.attempts);
  }
  CHECK(job.state != RQ_FAILED, "a hundred yields never park a photograph");
  CHECK(strcmp(job.last_error, "yielded the card to a capture") == 0, "the wait says why");
  /* The next real outcome is judged on its own. */
  job.state = RQ_ORIGINALS_UPLOADING;
  rq_apply(&job, s, RQ_DISP_RETRY, "connect failed");
  CHECK(job.attempts == 4, "a real transient still counts, got %u", job.attempts);
  /* And a settled job ignores a yield, like everything else. */
  job.state = RQ_FAILED;
  CHECK(!rq_apply(&job, s, RQ_DISP_YIELD, "x"), "parked stays parked");

  /* The register step, the one CAP_000253 died in: a yielded META.JSON read
   * leaves the job unregistered, unpunished and due again - never parked. */
  rq_job_t fresh;
  rq_job_init(&fresh, "7a2d9c11-3e4f-4b6a-9c8d-1e2f3a4b5c6d", "roll_0001", 1, true);
  rq_step_t reg = rq_next_step(&fresh, 0);
  CHECK(reg.kind == RQ_STEP_REGISTER, "a new job registers first");
  for (int i = 0; i < 12; i++) {
    CHECK(!rq_apply(&fresh, reg, RQ_DISP_YIELD, "yielded the card to a capture"),
          "a yielded register is not durable");
  }
  CHECK(fresh.attempts == 0, "twelve yielded registers cost nothing, got %u", fresh.attempts);
  CHECK(fresh.state == RQ_RETRY_WAIT, "waiting for the card, not parked");
  CHECK(fresh.capture_id[0] == '\0', "still unregistered");
  fresh.next_attempt_ms = 0;
  CHECK(rq_next_step(&fresh, 1).kind == RQ_STEP_REGISTER, "and it registers next");
}

static void test_network_restored_makes_waiting_jobs_due(void) {
  /* The radio recovered from a C6 reset (ROLL-C test 3). A job that backed
   * off while the server was unreachable is due now - with its history. */
  rq_job_t job;
  rq_job_init(&job, UUID_A, "roll_0001", 1, true);
  job.state = RQ_RETRY_WAIT;
  job.attempts = 3;
  job.next_attempt_ms = 500000;
  CHECK(!rq_retry_due(&job, 100000), "before: waiting on the old deadline");
  rq_job_network_restored(&job);
  CHECK(rq_retry_due(&job, 100000), "after: due now");
  CHECK(job.attempts == 3, "attempts kept - not a fresh budget, got %u", job.attempts);
  CHECK(job.state == RQ_RETRY_WAIT, "state unchanged");

  rq_job_t queued;
  rq_job_init(&queued, UUID_A, "roll_0001", 1, true);
  queued.next_attempt_ms = 42;
  rq_job_network_restored(&queued);
  CHECK(queued.next_attempt_ms == 42 && queued.state == RQ_QUEUED, "QUEUED untouched");
  rq_job_t done;
  rq_job_init(&done, UUID_A, "roll_0001", 1, true);
  done.state = RQ_COMPLETE;
  done.next_attempt_ms = 42;
  rq_job_network_restored(&done);
  CHECK(done.state == RQ_COMPLETE && done.next_attempt_ms == 42, "COMPLETE untouched");
  rq_job_t parked;
  rq_job_init(&parked, UUID_A, "roll_0001", 1, true);
  parked.state = RQ_FAILED;
  parked.attempts = 12;
  rq_job_network_restored(&parked);
  CHECK(parked.state == RQ_FAILED && parked.attempts == 12,
        "a parked job is not revived by the network coming back");
  rq_job_network_restored(NULL);
}


static void test_reboot_before_registering_is_safe(void) {
  /* Power cut before the capture document was ever POSTed. The next boot has
   * no capture id, so it registers — and because the server keys on
   * captureUuid, a registration that actually DID land server-side before
   * the response was lost replays to the same capture. */
  rq_job_t job;
  rq_job_init(&job, UUID_A, "roll_0001", 4, true);
  job.state = RQ_REGISTERING; /* mid-flight when the power went */

  rq_step_t s = rq_next_step(&job, 0);
  CHECK(s.kind == RQ_STEP_REGISTER, "re-registers rather than guessing an id, got %d", s.kind);
  CHECK(job.capture_id[0] == '\0', "no id was invented");
}

static void test_state_disagreeing_with_flags_cannot_strand_a_photograph(void) {
  /* A record written by a build whose state field advanced before its flags
   * did. rq_next_step() reads the flags, not the state, so the photograph
   * still finishes. A state-driven machine would have skipped the frames. */
  rq_job_t job;
  rq_job_init(&job, UUID_A, "roll_0001", 3, false);
  strncpy(job.capture_id, "cap_srv_0005", sizeof job.capture_id - 1);
  job.state = RQ_VERIFYING; /* claims it is done uploading; the flags say no */

  rq_step_t s = rq_next_step(&job, 0);
  CHECK(s.kind == RQ_STEP_UPLOAD_FRAME, "flags win over state, got %d", s.kind);
  CHECK(s.frame_index == 1, "starts where the flags say, got %d", s.frame_index);
}

/* ---- failure handling ------------------------------------------------- */

static void test_transient_failure_backs_off_then_resumes(void) {
  rq_job_t job;
  rq_job_init(&job, UUID_A, "roll_0001", 1, false);
  strncpy(job.capture_id, "cap_srv_0006", sizeof job.capture_id - 1);

  rq_step_t s = rq_next_step(&job, 0);
  CHECK(s.kind == RQ_STEP_UPLOAD_FRAME, "frame first");

  rq_apply(&job, s, RQ_DISP_RETRY, "connection lost");
  CHECK(job.state == RQ_RETRY_WAIT, "transient failure waits, got %s", rq_state_name(job.state));
  CHECK(job.attempts == 1, "one attempt recorded, got %u", job.attempts);

  /* The job holds its place: the frame is still pending, not lost. */
  job.next_attempt_ms = 1000;
  CHECK(!rq_retry_due(&job, 500), "not due before the deadline");
  CHECK(rq_next_step(&job, 500).kind == RQ_STEP_WAIT_BACKOFF, "waits while backing off");
  CHECK(rq_retry_due(&job, 1000), "due at the deadline");

  rq_step_t again = rq_next_step(&job, 1000);
  CHECK(again.kind == RQ_STEP_UPLOAD_FRAME, "resumes the same step, got %d", again.kind);
  CHECK(again.frame_index == 1, "the same frame, not the next one");

  /* A success clears the backoff, so a later unrelated failure starts from
   * 1 s again instead of inheriting this one's delay. */
  rq_apply(&job, again, RQ_DISP_OK, NULL);
  CHECK(job.attempts == 0, "success resets the attempt count, got %u", job.attempts);
  CHECK(job.last_error[0] == '\0', "success clears the error text");
}

static void test_retry_is_bounded(void) {
  rq_job_t job;
  rq_job_init(&job, UUID_A, "roll_0001", 1, false);
  strncpy(job.capture_id, "cap_srv_0007", sizeof job.capture_id - 1);

  for (uint32_t i = 0; i < RQ_MAX_ATTEMPTS; i++) {
    rq_step_t s = rq_next_step(&job, 0);
    if (s.kind == RQ_STEP_WAIT_BACKOFF) {
      job.next_attempt_ms = 0;
      s = rq_next_step(&job, 0);
    }
    rq_apply(&job, s, RQ_DISP_RETRY, "server unreachable");
  }
  CHECK(job.state == RQ_FAILED, "bounded retry parks eventually, got %s",
        rq_state_name(job.state));
  CHECK(rq_job_settled(&job), "FAILED is settled — the API is not hammered forever");
}

static void test_checksum_mismatch_rereads_then_parks(void) {
  rq_job_t job;
  rq_job_init(&job, UUID_A, "roll_0001", 1, false);
  strncpy(job.capture_id, "cap_srv_0008", sizeof job.capture_id - 1);
  rq_step_t s = rq_next_step(&job, 0);

  rq_apply(&job, s, RQ_DISP_REREAD, "CHECKSUM_MISMATCH");
  CHECK(job.state == RQ_RETRY_WAIT, "first mismatch re-reads, got %s", rq_state_name(job.state));
  CHECK(job.reread_attempts == 1, "counted, got %u", job.reread_attempts);
  /* A checksum mismatch is not a network fault and must not contribute to
   * the network backoff — otherwise a bad file slows down every later
   * upload for this job. */
  CHECK(job.attempts == 0, "re-read does not touch the network attempt count, got %u",
        job.attempts);
  CHECK(rq_retry_due(&job, 0), "re-reads immediately; there is nothing to wait for");

  rq_apply(&job, s, RQ_DISP_REREAD, "CHECKSUM_MISMATCH");
  CHECK(job.state == RQ_RETRY_WAIT, "second mismatch still re-reads");

  rq_apply(&job, s, RQ_DISP_REREAD, "CHECKSUM_MISMATCH");
  CHECK(job.state == RQ_FAILED, "a genuinely corrupt file parks, got %s",
        rq_state_name(job.state));
}

static void test_park_and_halt_differ(void) {
  rq_job_t parked;
  rq_job_init(&parked, UUID_A, "roll_0001", 1, false);
  strncpy(parked.capture_id, "cap_srv_0009", sizeof parked.capture_id - 1);
  rq_step_t s = rq_next_step(&parked, 0);
  rq_apply(&parked, s, RQ_DISP_PARK, "INVALID_CAPTURE");
  CHECK(parked.state == RQ_FAILED, "park settles the job, got %s", rq_state_name(parked.state));

  /* HALT is about the device, not the job. The job must stay resumable so
   * that fixing the token drains the queue instead of losing it. */
  rq_job_t halted;
  rq_job_init(&halted, UUID_A, "roll_0001", 2, false);
  strncpy(halted.capture_id, "cap_srv_0010", sizeof halted.capture_id - 1);
  s = rq_next_step(&halted, 0);
  rq_apply(&halted, s, RQ_DISP_HALT, "INVALID_DEVICE_TOKEN");
  CHECK(!rq_job_settled(&halted), "a halted job is NOT settled — it resumes once fixed");
  CHECK(halted.state == RQ_ORIGINALS_UPLOADING, "records where it stopped, got %s",
        rq_state_name(halted.state));
  CHECK(rq_next_step(&halted, 0).kind == RQ_STEP_UPLOAD_FRAME, "still has work to do");
  CHECK(halted.frame_done[0] == false, "and lost no progress");
}

static void test_settled_jobs_ignore_further_outcomes(void) {
  rq_job_t job;
  rq_job_init(&job, UUID_A, "roll_0001", 1, false);
  strncpy(job.capture_id, "cap_srv_0011", sizeof job.capture_id - 1);
  drive_to_complete(&job, 0);
  CHECK(job.state == RQ_COMPLETE, "complete first");

  rq_step_t s = {RQ_STEP_UPLOAD_FRAME, 1};
  CHECK(!rq_apply(&job, s, RQ_DISP_RETRY, "late failure"), "a settled job absorbs nothing");
  CHECK(job.state == RQ_COMPLETE, "and stays COMPLETE, got %s", rq_state_name(job.state));
}

/* ---- reconciliation --------------------------------------------------- */

static void test_reconcile(void) {
  rq_job_t complete;
  rq_job_init(&complete, UUID_A, "roll_0001", 4, true);
  complete.state = RQ_COMPLETE;

  rq_job_t pending;
  rq_job_init(&pending, UUID_A, "roll_0001", 4, true);
  pending.state = RQ_ORIGINALS_UPLOADING;

  rq_job_t failed;
  rq_job_init(&failed, UUID_A, "roll_0001", 4, true);
  failed.state = RQ_FAILED;

  rq_job_t other_roll;
  rq_job_init(&other_roll, UUID_A, "roll_0002", 4, true);
  other_roll.state = RQ_QUEUED;

  /* No META.JSON: an interrupted commit, not a capture. storage.c's sweep
   * owns it. Adopting it would upload a photograph the camera never
   * claimed to have taken. */
  CHECK(rq_reconcile_action(false, NULL, false, false, NULL) == RQ_REC_IGNORE,
        "an uncommitted folder is not the queue's business");
  CHECK(rq_reconcile_action(false, "roll_0001", true, true, &pending) == RQ_REC_IGNORE,
        "still ignored even with a job file");

  /* Committed on a Roll, never queued - the ordinary offline case. */
  CHECK(rq_reconcile_action(true, "roll_0001", false, false, NULL) == RQ_REC_ENQUEUE,
        "a committed capture taken on a Roll gets queued for that Roll");

  /* Committed off any Roll, never queued: a local photograph. This is the
   * case the bench card had 68 of, and the old rule queued every one of them
   * into the Roll that happened to be active at boot. */
  CHECK(rq_reconcile_action(true, NULL, false, false, NULL) == RQ_REC_IGNORE,
        "a capture taken on no Roll is never queued, whatever Roll is active");
  CHECK(rq_reconcile_action(true, "", false, false, NULL) == RQ_REC_IGNORE,
        "an empty rollId is no Roll");

  CHECK(rq_reconcile_action(true, "roll_0001", true, true, &complete) == RQ_REC_IGNORE,
        "a COMPLETE job is left alone - this is what prevents a re-upload");
  CHECK(rq_reconcile_action(true, "roll_0001", true, true, &pending) == RQ_REC_RESUME,
        "an unfinished job for the capture's own Roll resumes");
  CHECK(rq_reconcile_action(true, "roll_0001", true, true, &failed) == RQ_REC_RESUME,
        "a parked job is still surfaced, so the user can see and retry it");

  /* The record's Roll is not the capture's Roll. Measured: 34 records naming
   * the current Roll beside METAs naming none. Retired, never uploaded, and
   * the record says why. */
  CHECK(rq_reconcile_action(true, NULL, true, true, &pending) == RQ_REC_RETIRE,
        "a job for a capture that names no Roll is retired");
  CHECK(rq_reconcile_action(true, "roll_0001", true, true, &other_roll) == RQ_REC_RETIRE,
        "a job naming a different Roll than the capture is retired");
  CHECK(rq_reconcile_action(true, NULL, true, true, &complete) == RQ_REC_IGNORE,
        "but a COMPLETE job stays complete: the server already has it");

  /* A corrupt or future-format record must not silently strand a photograph
   * that is on a Roll. Rebuilding costs one redundant registration, which the
   * server's captureUuid idempotency absorbs. */
  CHECK(rq_reconcile_action(true, "roll_0001", true, false, NULL) == RQ_REC_REPAIR,
        "an unreadable record on a Roll is repaired, never ignored");
  CHECK(rq_reconcile_action(true, "roll_0001", true, false, &pending) == RQ_REC_REPAIR,
        "invalid wins over a stale struct");
  CHECK(rq_reconcile_action(true, NULL, true, false, NULL) == RQ_REC_RETIRE,
        "an unreadable record for a capture on no Roll has nothing to rebuild toward");
}

/* ---- redaction -------------------------------------------------------- */

/* ---- sanitising an error body ------------------------------------------ */

/*
 * An error detail is bytes off a socket. Two things it must not carry into a
 * job's last_error, because both cost the record permanently:
 *
 *   control bytes  cJSON escapes each one as `\u00XX` — six characters. 95 of
 *                  them are 570 bytes inside a record bounded at 768, so the
 *                  record exceeds the bound and upload_store_decode() refuses
 *                  it for the rest of its life;
 *   invalid UTF-8  cJSON emits it verbatim, and the KDP reply carrying it is
 *                  then a document Studio cannot parse.
 */
static void test_sanitise_detail(void) {
  char out[RQ_ERROR_LEN];

  /* Every control byte becomes one '?', and nothing below 0x20 survives. */
  char controls[40];
  for (int i = 0; i < 31; i++) controls[i] = (char)(i + 1); /* 0x01..0x1f */
  controls[31] = (char)0x7f;
  controls[32] = '\0';
  rq_sanitise_detail(out, sizeof out, controls);
  CHECK(strlen(out) == 32, "one byte out per byte in, got %u", (unsigned)strlen(out));
  for (size_t i = 0; i < strlen(out); i++) {
    CHECK((unsigned char)out[i] == '?', "byte %u became '?', got 0x%02x", (unsigned)i,
          (unsigned char)out[i]);
  }

  /* A 502 answered with a binary page, which is what a proxy does. */
  rq_sanitise_detail(out, sizeof out, "POST /x -> 502 \x1f\x8b\x08\x00gzip");
  CHECK(strstr(out, "POST /x -> 502") != NULL, "the useful part survives: %s", out);
  for (size_t i = 0; out[i] != '\0'; i++) {
    CHECK((unsigned char)out[i] >= 0x20 && (unsigned char)out[i] != 0x7f,
          "no control byte survives, found 0x%02x", (unsigned char)out[i]);
  }

  /* Valid UTF-8 passes through untouched: a network really is called that. */
  rq_sanitise_detail(out, sizeof out, "join failed: Kaffeeh\xc3\xa4us");
  CHECK(strcmp(out, "join failed: Kaffeeh\xc3\xa4us") == 0, "valid UTF-8 unchanged: %s", out);
  rq_sanitise_detail(out, sizeof out, "\xe2\x82\xac \xf0\x9f\x93\xb7");
  CHECK(strcmp(out, "\xe2\x82\xac \xf0\x9f\x93\xb7") == 0, "3- and 4-byte forms unchanged");

  /* A stray continuation byte, a lead with nothing after it, an overlong form
   * and a surrogate are each one '?'. */
  rq_sanitise_detail(out, sizeof out, "a\x80" "b");
  CHECK(strcmp(out, "a?b") == 0, "stray continuation byte, got %s", out);
  rq_sanitise_detail(out, sizeof out, "a\xc3");
  CHECK(strcmp(out, "a?") == 0, "a lead with no continuation, got %s", out);
  rq_sanitise_detail(out, sizeof out, "a\xc0\xaf" "b");
  CHECK(strcmp(out, "a??b") == 0, "overlong two-byte form, got %s", out);
  rq_sanitise_detail(out, sizeof out, "a\xed\xa0\x80" "b");
  CHECK(strcmp(out, "a???b") == 0, "a UTF-16 surrogate, got %s", out);
  rq_sanitise_detail(out, sizeof out, "a\xf5\x80\x80\x80" "b");
  CHECK(strcmp(out, "a????b") == 0, "past U+10FFFF, got %s", out);

  /* Never longer than its input, so a caller can size one buffer for both. */
  rq_sanitise_detail(out, sizeof out, "plain ascii, unchanged");
  CHECK(strcmp(out, "plain ascii, unchanged") == 0, "clean text unchanged: %s", out);

  /* A multi-byte sequence that would be cut in half by the end of the buffer
   * is dropped whole. Half a sequence is the exact thing this removes. */
  char small[6];
  rq_sanitise_detail(small, sizeof small, "abc\xe2\x82\xac");
  CHECK(strcmp(small, "abc") == 0, "a sequence that does not fit is dropped, got %s", small);
  for (size_t i = 0; small[i] != '\0'; i++) {
    CHECK((unsigned char)small[i] < 0x80, "and no lead byte is left behind");
  }

  rq_sanitise_detail(out, sizeof out, NULL);
  CHECK(out[0] == '\0', "NULL input yields an empty string");
}

static void test_redaction(void) {
  char out[RQ_ERROR_LEN];

  /* The device token. This is the one that matters: error text reaches KDP
   * responses, GET_LOGS and a crash dump, all of which outlive the device. */
  rq_redact(out, sizeof out,
            "POST /api/device/rolls failed: kdt_AbCdEf0123456789_-xyzQRS thrown");
  CHECK(strstr(out, "kdt_") == NULL, "no kdt_ token survives: %s", out);
  CHECK(strstr(out, "AbCdEf0123456789") == NULL, "nor its body: %s", out);
  CHECK(strstr(out, "[redacted]") != NULL, "and it says so: %s", out);
  CHECK(strstr(out, "POST /api/device/rolls failed") != NULL, "the useful part survives: %s", out);

  rq_redact(out, sizeof out, "authorization: Bearer kdt_secretsecret");
  CHECK(strstr(out, "kdt_secretsecret") == NULL, "header form redacted: %s", out);
  CHECK(strstr(out, "secretsecret") == NULL, "no residue: %s", out);

  rq_redact(out, sizeof out, "Bearer kdt_aaaabbbbcccc");
  CHECK(strstr(out, "aaaabbbbcccc") == NULL, "bare bearer redacted: %s", out);

  /* Wi-Fi passphrases arrive by the same accident. */
  rq_redact(out, sizeof out, "join failed password=hunter2hunter2 ssid=Home");
  CHECK(strstr(out, "hunter2hunter2") == NULL, "passphrase redacted: %s", out);
  CHECK(strstr(out, "ssid=Home") != NULL, "the SSID is not a secret: %s", out);

  rq_redact(out, sizeof out, "token=abc123 passphrase=letmein12");
  CHECK(strstr(out, "abc123") == NULL, "token= redacted: %s", out);
  CHECK(strstr(out, "letmein12") == NULL, "passphrase= redacted: %s", out);

  /* Case must not be an escape hatch. */
  rq_redact(out, sizeof out, "AUTHORIZATION: BEARER kdt_UPPERCASE123");
  CHECK(strstr(out, "UPPERCASE123") == NULL, "case-insensitive: %s", out);

  /* Ordinary text is untouched, and the result is always terminated. */
  rq_redact(out, sizeof out, "DHCP timed out after 12000 ms");
  CHECK(strcmp(out, "DHCP timed out after 12000 ms") == 0, "clean text unchanged: %s", out);

  rq_redact(out, sizeof out, NULL);
  CHECK(out[0] == '\0', "NULL input yields an empty string");

  /* A token longer than the buffer must still not leak a prefix of itself
   * through truncation. */
  char tiny[12];
  rq_redact(tiny, sizeof tiny, "kdt_abcdefghijklmnopqrstuvwxyz");
  CHECK(strstr(tiny, "abcdef") == NULL, "truncation does not leak: %s", tiny);
  CHECK(strlen(tiny) < sizeof tiny, "and stays terminated");

  /* Degenerate buffers must not be written past. */
  char one[1];
  rq_redact(one, sizeof one, "kdt_secret");
  CHECK(one[0] == '\0', "a 1-byte buffer gets an empty string");
}

/* ---- naming ----------------------------------------------------------- */

static void test_state_names(void) {
  /* Every state has a name, because these strings are what the ROLL screen
   * and UPLOAD_QUEUE_STATUS show. An "UNKNOWN" on the display is a defect. */
  const rq_state_t all[] = {RQ_QUEUED,   RQ_REGISTERING,        RQ_THUMB_UPLOADING,
                            RQ_THUMB_READY, RQ_ORIGINALS_UPLOADING, RQ_VERIFYING,
                            RQ_COMPLETE, RQ_RETRY_WAIT,         RQ_FAILED};
  for (size_t i = 0; i < sizeof all / sizeof all[0]; i++) {
    const char *name = rq_state_name(all[i]);
    CHECK(name != NULL && name[0] != '\0', "state %d has a name", (int)all[i]);
    CHECK(strcmp(name, "UNKNOWN") != 0, "state %d is not UNKNOWN", (int)all[i]);
  }
}

static void test_init_clamps(void) {
  rq_job_t job;

  /* A frame count past the array bound must clamp rather than let
   * first_pending_frame() walk off the end. */
  rq_job_init(&job, UUID_A, "roll_0001", 999, true);
  CHECK(job.frame_count == RQ_MAX_FRAMES, "frame count clamps to %d, got %d", RQ_MAX_FRAMES,
        job.frame_count);

  rq_job_init(&job, UUID_A, "roll_0001", -3, false);
  CHECK(job.frame_count == 0, "negative frame count clamps to 0, got %d", job.frame_count);

  /* A capture with no frames still completes rather than parking: the
   * server decides whether zero frames is partial or failed. */
  strncpy(job.capture_id, "cap_srv_0012", sizeof job.capture_id - 1);
  CHECK(rq_next_step(&job, 0).kind == RQ_STEP_COMPLETE_CAPTURE,
        "a frameless capture is completed, not parked");

  /* An over-long UUID must be truncated, not overflow the field. */
  rq_job_init(&job, "0123456789012345678901234567890123456789012345678901234567890123456789",
              "roll_0001", 1, false);
  CHECK(strlen(job.uuid) == RQ_UUID_LEN - 1, "uuid truncated to fit, got %zu", strlen(job.uuid));

  rq_job_init(&job, NULL, NULL, 1, false);
  CHECK(job.uuid[0] == '\0', "NULL uuid is empty, not a crash");
  CHECK(job.roll_id[0] == '\0', "NULL roll id is empty");
}

/* ---- the acceptance scenario ------------------------------------------ */

static void test_fifty_offline_captures_reach_roll_exactly_once(void) {
  /* ROLL_DEVICE_CONTRACT.md's hard acceptance test, in the form this module
   * can answer: 50 captures queued with no network, a reboot in the middle,
   * then a drain. Every capture must complete exactly once.
   *
   * "Exactly once" is checked by counting register steps: the server keys on
   * captureUuid, so one register per capture is the property that makes the
   * upload idempotent end to end. */
  enum { N = 50 };
  rq_job_t jobs[N];
  int registers[N];
  memset(registers, 0, sizeof registers);

  for (int i = 0; i < N; i++) {
    char uuid[RQ_UUID_LEN];
    snprintf(uuid, sizeof uuid, "6f1c6f2a-9b3d-4c1e-8a77-%012d", i);
    rq_job_init(&jobs[i], uuid, "roll_0001", 4, true);
  }

  /* Offline: every step fails transiently. Nothing is lost, nothing is
   * sent, and the shutter was never involved. */
  for (int i = 0; i < N; i++) {
    rq_step_t s = rq_next_step(&jobs[i], 0);
    CHECK(s.kind == RQ_STEP_REGISTER, "job %d wants to register", i);
    rq_apply(&jobs[i], s, RQ_DISP_RETRY, "network unavailable");
    CHECK(!rq_job_settled(&jobs[i]), "job %d survives being offline", i);
  }

  /* Reboot: only the records survive. Simulate that literally by copying
   * the structs, which is all UPLOAD.JSON holds. */
  rq_job_t after_reboot[N];
  memcpy(after_reboot, jobs, sizeof jobs);

  /* Network returns. Drain. */
  int completed = 0;
  for (int i = 0; i < N; i++) {
    rq_job_t *job = &after_reboot[i];
    job->next_attempt_ms = 0;
    for (int guard = 0; guard < 64 && !rq_job_settled(job); guard++) {
      rq_step_t s = rq_next_step(job, 1000);
      if (s.kind == RQ_STEP_NOTHING) break;
      if (s.kind == RQ_STEP_WAIT_BACKOFF) {
        job->next_attempt_ms = 0;
        continue;
      }
      if (s.kind == RQ_STEP_REGISTER) {
        registers[i]++;
        snprintf(job->capture_id, sizeof job->capture_id, "cap_srv_%04d", i);
      }
      rq_apply(job, s, RQ_DISP_OK, NULL);
    }
    if (after_reboot[i].state == RQ_COMPLETE) completed++;
  }

  CHECK(completed == N, "all %d offline captures reach Roll, got %d", N, completed);
  for (int i = 0; i < N; i++) {
    CHECK(registers[i] == 1, "capture %d registered exactly once, not %d times", i,
          registers[i]);
    CHECK(after_reboot[i].thumb_done, "capture %d uploaded its thumb", i);
    for (int f = 0; f < 4; f++) {
      CHECK(after_reboot[i].frame_done[f], "capture %d frame %d landed", i, f + 1);
    }
  }
}

/* ---- which frames: camera slots, not a count (#164) ------------------- */

/* Drive a registered job through its frame steps and record the camera slot
 * of every RQ_STEP_UPLOAD_FRAME it asks for, in order. Returns how many. */
static int frame_sequence(rq_job_t *job, int *out, int cap) {
  int n = 0;
  strncpy(job->capture_id, "cap_srv_slots", sizeof job->capture_id - 1);
  for (int guard = 0; guard < 32; guard++) {
    rq_step_t s = rq_next_step(job, 0);
    if (s.kind == RQ_STEP_NOTHING || s.kind == RQ_STEP_WAIT_BACKOFF) break;
    if (s.kind == RQ_STEP_UPLOAD_FRAME && n < cap) out[n++] = s.frame_index;
    rq_apply(job, s, RQ_DISP_OK, NULL);
    if (s.kind == RQ_STEP_COMPLETE_CAPTURE) break;
  }
  return n;
}

static void expect_sequence(const uint8_t *slots, int count, const char *label) {
  rq_job_t job;
  CHECK(rq_job_init_slots(&job, UUID_A, "roll_0001", slots, count, true), "%s: init", label);
  int got[RQ_MAX_FRAMES];
  const int n = frame_sequence(&job, got, RQ_MAX_FRAMES);
  CHECK(n == count, "%s: uploads %d frames, not %d", label, count, n);
  for (int i = 0; i < count && i < n; i++) {
    CHECK(got[i] == slots[i], "%s: frame %d is camera %d, asked for %d", label, i + 1, slots[i],
          got[i]);
  }
  CHECK(job.state == RQ_COMPLETE, "%s: completes, got %s", label, rq_state_name(job.state));
  /* And nothing was asked for that the set does not hold. */
  for (int i = 0; i < n; i++) {
    bool held = false;
    for (int k = 0; k < count; k++) held |= slots[k] == got[i];
    CHECK(held, "%s: asked for camera %d, which this set never had", label, got[i]);
  }
}

static void test_sparse_sets_upload_their_own_cameras(void) {
  /* The bench case (2026-09-03, CAP_000263): camera 2 dark, the set is
   * C1/C3/C4. The old queue asked for C1, C2, C3 - C2 twelve times, then
   * parked - and C3 and C4 never travelled. */
  static const uint8_t full[] = {1, 2, 3, 4};
  static const uint8_t no4[] = {1, 2, 3};
  static const uint8_t no3[] = {1, 2, 4};
  static const uint8_t no2[] = {1, 3, 4};
  static const uint8_t no1[] = {2, 3, 4};
  static const uint8_t two[] = {1, 4};
  static const uint8_t one[] = {3};
  expect_sequence(full, 4, "A full set");
  expect_sequence(no4, 3, "B missing CAM4");
  expect_sequence(no3, 3, "C missing CAM3");
  expect_sequence(no2, 3, "D missing CAM2");
  expect_sequence(no1, 3, "E missing CAM1");
  expect_sequence(two, 2, "F only CAM1 and CAM4");
  expect_sequence(one, 1, "one camera, and not camera 1");
}

static void test_frame_done_is_by_camera_across_a_reboot(void) {
  /* I. Power cut after the first frame of a C1/C3/C4 set. The record holds
   * slots [1,3,4] and done [true,false,false]; the next boot must ask for
   * camera 3 - not "frame 2", which would be C2.JPG, which is not there. */
  static const uint8_t slots[] = {1, 3, 4};
  rq_job_t before;
  rq_job_init_slots(&before, UUID_A, "roll_0001", slots, 3, true);
  strncpy(before.capture_id, "cap_srv_sparse", sizeof before.capture_id - 1);
  before.thumb_done = true;
  before.frame_done[0] = true;
  before.state = RQ_ORIGINALS_UPLOADING;

  rq_job_t after = before; /* what UPLOAD.JSON carries across the reset */
  rq_step_t s = rq_next_step(&after, 0);
  CHECK(s.kind == RQ_STEP_UPLOAD_FRAME, "resumes into a frame, got %d", s.kind);
  CHECK(s.frame_index == 3, "resumes at camera 3, got %d", s.frame_index);
  rq_apply(&after, s, RQ_DISP_OK, NULL);
  CHECK(after.frame_done[1] && !after.frame_done[2], "camera 3 confirmed at position 1, camera 4 still pending");

  s = rq_next_step(&after, 0);
  CHECK(s.frame_index == 4, "then camera 4, got %d", s.frame_index);
  rq_apply(&after, s, RQ_DISP_OK, NULL);
  CHECK(rq_next_step(&after, 0).kind == RQ_STEP_COMPLETE_CAPTURE, "then complete");

  /* A confirmation for a camera the job does not hold changes nothing. */
  rq_job_t stray;
  rq_job_init_slots(&stray, UUID_A, "roll_0001", slots, 3, false);
  strncpy(stray.capture_id, "cap_srv_stray", sizeof stray.capture_id - 1);
  rq_step_t bogus = {RQ_STEP_UPLOAD_FRAME, 2};
  rq_apply(&stray, bogus, RQ_DISP_OK, NULL);
  CHECK(!stray.frame_done[0] && !stray.frame_done[1] && !stray.frame_done[2],
        "confirming camera 2 on a set without it marks nothing");
}

static void test_retry_after_second_sparse_frame_registers_once(void) {
  /* J. Camera 3 of a C1/C3/C4 set fails transiently, twice; the retry must
   * come back to camera 3 under the same capture id, not re-register and not
   * skip to camera 4. */
  static const uint8_t slots[] = {1, 3, 4};
  rq_job_t job;
  rq_job_init_slots(&job, UUID_A, "roll_0001", slots, 3, false);
  int registers = 0;
  int asked3 = 0;
  for (int guard = 0; guard < 32 && !rq_job_settled(&job); guard++) {
    rq_step_t s = rq_next_step(&job, 1000);
    if (s.kind == RQ_STEP_WAIT_BACKOFF) {
      job.next_attempt_ms = 0;
      continue;
    }
    if (s.kind == RQ_STEP_REGISTER) {
      registers++;
      strncpy(job.capture_id, "cap_srv_j", sizeof job.capture_id - 1);
    }
    if (s.kind == RQ_STEP_UPLOAD_FRAME && s.frame_index == 3 && asked3++ < 2) {
      rq_apply(&job, s, RQ_DISP_RETRY, "502");
      continue;
    }
    rq_apply(&job, s, RQ_DISP_OK, NULL);
  }
  CHECK(registers == 1, "registered once, not %d times", registers);
  CHECK(asked3 == 3, "camera 3 was asked for until it landed: %d times", asked3);
  CHECK(job.state == RQ_COMPLETE, "completes after the retries, got %s", rq_state_name(job.state));
  CHECK(job.frame_done[0] && job.frame_done[1] && job.frame_done[2], "all three cameras landed");
}

static void test_legacy_record_adopts_its_cameras_from_meta(void) {
  /* G. CAP_000263 as the old queue left it: frameCount 3, no slots, done
   * [true,false,false] - camera 1 landed, then it asked for C2.JPG until it
   * parked. META says [1,3,4]. After adoption camera 1 stays done and cameras
   * 3 and 4 are what remains. */
  rq_job_t legacy;
  rq_job_init(&legacy, UUID_A, "roll_0001", 3, true);
  memset(legacy.frame_slot, 0, sizeof legacy.frame_slot); /* as decoded from a pre-slot record */
  strncpy(legacy.capture_id, "cap_sIU7yKIzcmDMlxm63j9EQQ", sizeof legacy.capture_id - 1);
  legacy.thumb_done = true;
  legacy.frame_done[0] = true;
  legacy.state = RQ_FAILED;
  legacy.attempts = 12;
  CHECK(!rq_job_has_slots(&legacy), "a pre-slot record does not know its cameras");
  CHECK(rq_next_step(&legacy, 0).kind == RQ_STEP_NOTHING, "parked: asks for nothing until revived");

  static const uint8_t meta[] = {1, 3, 4};
  CHECK(rq_job_adopt_slots(&legacy, meta, 3), "adopts META's list");
  CHECK(rq_job_has_slots(&legacy), "knows its cameras now");
  CHECK(legacy.frame_count == 3, "still three frames");
  CHECK(legacy.frame_done[0] && !legacy.frame_done[1] && !legacy.frame_done[2],
        "camera 1 kept as done; cameras 3 and 4 pending (done=%d,%d,%d)", legacy.frame_done[0],
        legacy.frame_done[1], legacy.frame_done[2]);
  CHECK(strcmp(legacy.capture_id, "cap_sIU7yKIzcmDMlxm63j9EQQ") == 0, "same server capture id");

  /* The user's retry: revive as upload_queue_retry_all() does, then drain. */
  legacy.attempts = 0;
  legacy.next_attempt_ms = 0;
  legacy.state = RQ_RETRY_WAIT;
  int got[RQ_MAX_FRAMES];
  const int n = frame_sequence(&legacy, got, RQ_MAX_FRAMES);
  CHECK(n == 2 && got[0] == 3 && got[1] == 4, "uploads cameras 3 then 4 and nothing else (n=%d)", n);
  CHECK(legacy.state == RQ_COMPLETE, "completes");

  /* Old done bits map by CAMERA: a legacy 4-frame record with C1 and C3
   * confirmed under the contiguous reading keeps exactly those. */
  rq_job_t four;
  rq_job_init(&four, UUID_A, "roll_0001", 4, false);
  memset(four.frame_slot, 0, sizeof four.frame_slot);
  four.frame_done[0] = true;
  four.frame_done[2] = true;
  static const uint8_t full[] = {1, 2, 3, 4};
  CHECK(rq_job_adopt_slots(&four, full, 4), "H. legacy full set adopts");
  CHECK(four.frame_done[0] && !four.frame_done[1] && four.frame_done[2] && !four.frame_done[3],
        "H. cameras 1 and 3 stay done, 2 and 4 pending");

  /* Legacy done bit at an index past the new list is dropped, and a done bit
   * for a camera the old queue confirmed under the wrong name is re-offered
   * rather than believed: old [true,true,false] with META [1,3,4] means C1 and
   * C2 were "confirmed" - C2 could not have been - so camera 3 (old index 2)
   * is pending and camera 4 (old index 3) is pending. */
  rq_job_t odd;
  rq_job_init(&odd, UUID_A, "roll_0001", 3, false);
  memset(odd.frame_slot, 0, sizeof odd.frame_slot);
  odd.frame_done[0] = true;
  odd.frame_done[1] = true;
  CHECK(rq_job_adopt_slots(&odd, meta, 3), "adopts");
  CHECK(odd.frame_done[0] && !odd.frame_done[1] && !odd.frame_done[2],
        "a confirmation that could only have been camera 2's is not carried to camera 3");

  /* A job that already knows its cameras is left alone. */
  rq_job_t knows;
  rq_job_init_slots(&knows, UUID_A, "roll_0001", meta, 3, false);
  CHECK(!rq_job_adopt_slots(&knows, full, 4), "a record with slots does not adopt another list");
  CHECK(knows.frame_count == 3 && knows.frame_slot[1] == 3, "and is unchanged");
}

static void test_slot_lists_are_validated(void) {
  /* M/N and friends: the lists this queue refuses to upload from. */
  static const uint8_t dup[] = {1, 3, 3};
  static const uint8_t zero[] = {0, 1};
  static const uint8_t five[] = {1, 5};
  static const uint8_t ok[] = {4, 1};
  CHECK(!rq_slots_valid(dup, 3, 4), "N. a camera named twice");
  CHECK(!rq_slots_valid(zero, 2, 4), "slot 0 is no camera");
  CHECK(!rq_slots_valid(five, 2, 4), "camera 5 on a four-camera body");
  CHECK(rq_slots_valid(five, 2, 8), "camera 5 is fine when the body has eight");
  CHECK(!rq_slots_valid(NULL, 1, 4), "no list with a count");
  CHECK(!rq_slots_valid(ok, -1, 4), "negative count");
  CHECK(!rq_slots_valid(ok, RQ_MAX_FRAMES + 1, RQ_MAX_FRAMES), "count past the array");
  CHECK(rq_slots_valid(ok, 2, 4), "order is the caller's; [4,1] is a valid list");
  CHECK(rq_slots_valid(NULL, 0, 4), "an empty list is valid: a frameless capture completes");

  rq_job_t job;
  CHECK(!rq_job_init_slots(&job, UUID_A, "roll_0001", dup, 3, true), "init refuses a duplicate");
  CHECK(job.frame_count == 0 && strcmp(job.uuid, UUID_A) == 0,
        "and leaves an empty, identifiable job rather than a guessed one");
  /* The body's camera count is the reconciler's bound (it passes max_frames);
   * the pure adoption refuses what no body could have: a duplicate, or a slot
   * past RQ_MAX_FRAMES. */
  static const uint8_t nine[] = {1, 9};
  rq_job_t bare;
  rq_job_init(&bare, UUID_A, "roll_0001", 2, false);
  memset(bare.frame_slot, 0, sizeof bare.frame_slot);
  CHECK(!rq_job_adopt_slots(&bare, nine, 2), "adoption refuses camera 9");
  CHECK(!rq_job_adopt_slots(&bare, dup, 3), "adoption refuses a duplicate");
  CHECK(!rq_job_has_slots(&bare) && bare.frame_count == 2, "and leaves the record as it was");
}

int main(void) {
  test_backoff();
  test_classify();
  test_order_is_thumb_first();
  test_capture_without_thumb_skips_it();
  test_partial_capture_uploads_only_what_exists();
  test_resume_after_reboot_repeats_nothing();
  test_reboot_before_registering_is_safe();
  test_deadline_from_a_previous_boot_is_void();
  test_network_restored_makes_waiting_jobs_due();
  test_yield_costs_no_attempt();
  test_state_disagreeing_with_flags_cannot_strand_a_photograph();
  test_transient_failure_backs_off_then_resumes();
  test_retry_is_bounded();
  test_checksum_mismatch_rereads_then_parks();
  test_park_and_halt_differ();
  test_settled_jobs_ignore_further_outcomes();
  test_reconcile();
  test_redaction();
  test_sanitise_detail();
  test_state_names();
  test_init_clamps();
  test_fifty_offline_captures_reach_roll_exactly_once();
  test_sparse_sets_upload_their_own_cameras();
  test_frame_done_is_by_camera_across_a_reboot();
  test_retry_after_second_sparse_frame_registers_once();
  test_legacy_record_adopts_its_cameras_from_meta();
  test_slot_lists_are_validated();

  if (failures > 0) {
    printf("p4 roll-queue tests: %d/%d checks FAILED\n", failures, checks);
    return 1;
  }
  printf("p4 roll-queue tests: %d checks passed\n", checks);
  return 0;
}
