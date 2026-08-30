/*
 * Host tests for cam_sched.c - who may talk to the camera nodes.
 *
 *   make -C firmware/p4/host_tests test-sched
 *
 * The bench found CAMERA_CAPTURE refused BUSY while the node sweep was
 * probing empty sockets (2026-08-30: 14 of 20 idle requests, then 5 of 41).
 * These cases pin the policy that replaces the sweep's hold on capture_lock:
 * a real capture wins, a probe defers, a probe already on the wire finishes
 * its one bounded transaction and the capture starts right after, and the
 * only BUSY left is a capture already running. Whether the wire agrees is a
 * bench question, answered in HARDWARE_VALIDATION.md.
 */
#include "cam_sched.h"

#include <stdio.h>

static int fails = 0;
static int checks = 0;

#define CHECK(cond, ...)                          \
  do {                                            \
    checks++;                                     \
    if (!(cond)) {                                \
      fails++;                                    \
      printf("FAIL %s:%d: ", __FILE__, __LINE__); \
      printf(__VA_ARGS__);                        \
      printf("\n");                               \
    }                                             \
  } while (0)

/* A. no probe active -> capture starts normally, and nothing is pending. */
static void test_a_capture_starts_when_idle(void) {
  cam_sched_t s;
  cam_sched_init(&s);
  CHECK(cam_sched_capture_admit(&s), "idle: the shutter is admitted");
  CHECK(s.capture_active, "capture is active");
  CHECK(!s.capture_pending, "nothing to wait for");
  CHECK(cam_sched_capture_ready(&s), "ready at once");
  CHECK(s.capture_waits == 0, "no wait counted, got %lu", (unsigned long)s.capture_waits);
  cam_sched_capture_started(&s);
  cam_sched_capture_done(&s);
  CHECK(!s.capture_active && !s.capture_pending, "released cleanly");
}

/* B. probe requested while a capture is active -> deferred, on every channel. */
static void test_b_probe_defers_during_capture(void) {
  cam_sched_t s;
  cam_sched_init(&s);
  CHECK(cam_sched_capture_admit(&s), "admitted");
  cam_sched_capture_started(&s);
  for (int cam = 0; cam < CAM_SCHED_CAMS; cam++) {
    CHECK(!cam_sched_probe_begin(&s, cam), "cam%d probe defers during a capture", cam + 1);
    CHECK(!s.probe_active[cam], "cam%d not marked active", cam + 1);
  }
  CHECK(s.probes_deferred == CAM_SCHED_CAMS, "four deferrals counted, got %lu",
        (unsigned long)s.probes_deferred);
  CHECK(s.probes_run == 0, "no probe ran");
  cam_sched_capture_done(&s);
  CHECK(cam_sched_probe_begin(&s, 0), "after the capture the probe may run");
  CHECK(!cam_sched_probe_end(&s, 0), "no capture was waiting on it");
}

/* C. capture arrives while a probe has not started -> capture wins; the probe
 * that then asks is deferred. */
static void test_c_capture_wins_before_probe(void) {
  cam_sched_t s;
  cam_sched_init(&s);
  CHECK(cam_sched_capture_admit(&s), "admitted with no probe on the wire");
  CHECK(!s.capture_pending, "not pending: nothing in flight");
  CHECK(!cam_sched_probe_begin(&s, 2), "the sweep arriving a moment later defers");
  CHECK(cam_sched_capture_ready(&s), "still ready");
}

/* D. capture arrives during an abortable probe: the policy has no abort - the
 * probe's transaction is already bounded - so the capture is pending until the
 * probe ends, then ready; no new probe may begin meanwhile. */
static void test_d_capture_during_probe_waits_then_proceeds(void) {
  cam_sched_t s;
  cam_sched_init(&s);
  CHECK(cam_sched_probe_begin(&s, 1), "probe on cam2 begins");
  CHECK(cam_sched_capture_admit(&s), "the shutter is admitted, not refused");
  CHECK(s.capture_active, "it owns the cameras from now on");
  CHECK(s.capture_pending, "and waits for the probe boundary");
  CHECK(!cam_sched_capture_ready(&s), "not ready while cam2 is on the wire");
  CHECK(s.capture_waits == 1, "one wait counted");
  CHECK(!cam_sched_probe_begin(&s, 0), "no other probe may start in the gap");
  CHECK(!cam_sched_probe_begin(&s, 1), "nor a second on the same channel");
  CHECK(cam_sched_probe_end(&s, 1), "probe ends: the caller must wake the capture");
  CHECK(cam_sched_capture_ready(&s), "ready now");
  cam_sched_capture_started(&s);
  CHECK(!s.capture_pending && s.capture_active, "running");
  cam_sched_capture_done(&s);
}

/* E. capture arrives during a non-abortable short transaction on one channel
 * while another channel's probe is also in flight: both finish at their own
 * boundaries; the capture is woken exactly once, when the last one ends. */
static void test_e_two_probes_in_flight_one_wake(void) {
  cam_sched_t s;
  cam_sched_init(&s);
  CHECK(cam_sched_probe_begin(&s, 0), "cam1 probe");
  CHECK(cam_sched_probe_begin(&s, 3), "cam4 probe - independent UART, allowed");
  CHECK(cam_sched_probes_active(&s) == 2, "two in flight");
  CHECK(cam_sched_capture_admit(&s), "admitted");
  CHECK(s.capture_pending, "pending on two boundaries");
  CHECK(!cam_sched_probe_end(&s, 0), "first boundary: not yet - cam4 still on the wire");
  CHECK(!cam_sched_capture_ready(&s), "still not ready");
  CHECK(cam_sched_probe_end(&s, 3), "last boundary: wake");
  CHECK(cam_sched_capture_ready(&s), "ready immediately afterward");
  CHECK(!cam_sched_probe_end(&s, 3), "ending it again is a no-op, no second wake");
}

/* F. many probe requests never starve a capture: whatever the sweep does, the
 * shutter is admitted at once and waits at most for what was already in
 * flight. */
static void test_f_probe_storm_does_not_starve_capture(void) {
  cam_sched_t s;
  cam_sched_init(&s);
  int ran = 0, deferred = 0;
  for (int i = 0; i < 1000; i++) {
    const int cam = i % CAM_SCHED_CAMS;
    if (cam_sched_probe_begin(&s, cam)) {
      ran++;
      /* the sweep's shape: one transaction, then release */
      cam_sched_probe_end(&s, cam);
    } else {
      deferred++;
    }
  }
  CHECK(ran == 1000, "an idle body runs every probe, ran %d", ran);
  CHECK(deferred == 0, "and defers none, got %d", deferred);
  CHECK(cam_sched_capture_admit(&s), "the shutter is admitted after the storm");
  CHECK(!s.capture_pending, "with nothing to wait for");
  /* Now the sweep keeps asking while the capture runs. */
  for (int i = 0; i < 1000; i++) CHECK(!cam_sched_probe_begin(&s, i % CAM_SCHED_CAMS), "defers");
  CHECK(s.probes_deferred == 1000, "all deferred, got %lu", (unsigned long)s.probes_deferred);
  cam_sched_capture_done(&s);
  CHECK(cam_sched_probe_begin(&s, 0), "maintenance resumes afterwards");
}

/* G. a second capture while one is active is the real BUSY, unchanged. */
static void test_g_real_concurrent_capture_is_busy(void) {
  cam_sched_t s;
  cam_sched_init(&s);
  CHECK(cam_sched_capture_admit(&s), "first admitted");
  CHECK(!cam_sched_capture_admit(&s), "second is BUSY");
  cam_sched_capture_started(&s);
  CHECK(!cam_sched_capture_admit(&s), "still BUSY while running");
  cam_sched_capture_done(&s);
  CHECK(cam_sched_capture_admit(&s), "admitted once the first is done");
  cam_sched_capture_done(&s);
}

/* H. maintenance never masquerades as a capture: a probe in flight leaves
 * capture_active false, and admits the shutter. */
static void test_h_probe_is_not_a_capture(void) {
  cam_sched_t s;
  cam_sched_init(&s);
  CHECK(cam_sched_probe_begin(&s, 0), "probe begins");
  CHECK(!s.capture_active, "probe_active is not capture_active");
  CHECK(!s.capture_pending, "nor pending");
  CHECK(cam_sched_capture_admit(&s), "the shutter is admitted over a probe - not BUSY");
  cam_sched_probe_end(&s, 0);
  cam_sched_capture_done(&s);
}

/* I. one transaction per channel: a probe cannot begin on a channel that is
 * already being probed, so two commands never overlap on one UART from this
 * side. (The transaction itself is serialised by cam_link's channel mutex.) */
static void test_i_one_transaction_per_channel(void) {
  cam_sched_t s;
  cam_sched_init(&s);
  CHECK(cam_sched_probe_begin(&s, 2), "cam3 probe begins");
  CHECK(!cam_sched_probe_begin(&s, 2), "a second on cam3 defers");
  CHECK(cam_sched_probe_begin(&s, 1), "cam2 is a different wire");
  CHECK(cam_sched_probes_active(&s) == 2, "two channels, one transaction each");
  cam_sched_probe_end(&s, 2);
  cam_sched_probe_end(&s, 1);
  CHECK(cam_sched_probes_active(&s) == 0, "both released");
}

/* J. online/offline state is the caller's (cam_link's HELLO result); the
 * scheduler only decides when the HELLO may run. What it must guarantee is
 * that the decision leaves no flag behind: after any sequence the struct is
 * back to idle. */
static void test_j_state_returns_to_idle(void) {
  cam_sched_t s;
  cam_sched_init(&s);
  cam_sched_probe_begin(&s, 0);
  cam_sched_capture_admit(&s);
  cam_sched_probe_end(&s, 0);
  cam_sched_capture_started(&s);
  cam_sched_capture_done(&s);
  CHECK(!s.capture_active && !s.capture_pending, "idle");
  CHECK(cam_sched_probes_active(&s) == 0, "no probe marked");
  for (int cam = 0; cam < CAM_SCHED_CAMS; cam++) {
    CHECK(cam_sched_probe_begin(&s, cam), "cam%d may be probed again", cam + 1);
    cam_sched_probe_end(&s, cam);
  }
}

/* K. absent-node probing still occurs eventually: captures come and go, and
 * between them every channel gets its probe. */
static void test_k_probes_happen_between_captures(void) {
  cam_sched_t s;
  cam_sched_init(&s);
  int probed[CAM_SCHED_CAMS] = {0};
  int cam = 0;
  for (int round = 0; round < 50; round++) {
    /* a capture */
    CHECK(cam_sched_capture_admit(&s), "round %d admitted", round);
    CHECK(!cam_sched_probe_begin(&s, cam), "sweep defers during it");
    cam_sched_capture_started(&s);
    cam_sched_capture_done(&s);
    /* the sweep's next turn */
    if (cam_sched_probe_begin(&s, cam)) {
      probed[cam]++;
      cam_sched_probe_end(&s, cam);
    }
    cam = (cam + 1) % CAM_SCHED_CAMS;
  }
  for (int i = 0; i < CAM_SCHED_CAMS; i++) {
    CHECK(probed[i] >= 12, "cam%d probed %d times in 50 rounds", i + 1, probed[i]);
  }
}

/* L. the same object schedules CAM1-CAM4: a capture defers all four, a probe
 * on any one of them makes an admitted capture pending, invalid channels are
 * refused without touching state. */
static void test_l_scales_across_four_channels(void) {
  cam_sched_t s;
  cam_sched_init(&s);
  CHECK(!cam_sched_probe_begin(&s, -1), "cam -1 refused");
  CHECK(!cam_sched_probe_begin(&s, CAM_SCHED_CAMS), "cam %d refused", CAM_SCHED_CAMS + 1);
  CHECK(!cam_sched_probe_end(&s, 7), "ending an invalid channel is a no-op");
  CHECK(s.probes_deferred == 0 && s.probes_run == 0,
        "an invalid channel is refused, not counted as maintenance: deferred %lu run %lu",
        (unsigned long)s.probes_deferred, (unsigned long)s.probes_run);
  for (int cam = 0; cam < CAM_SCHED_CAMS; cam++) {
    cam_sched_init(&s);
    CHECK(cam_sched_probe_begin(&s, cam), "cam%d probe", cam + 1);
    CHECK(cam_sched_capture_admit(&s), "admitted over cam%d", cam + 1);
    CHECK(s.capture_pending, "pending on cam%d", cam + 1);
    CHECK(cam_sched_probe_end(&s, cam), "wake from cam%d", cam + 1);
    cam_sched_capture_done(&s);
  }
  /* NULL is tolerated everywhere. */
  cam_sched_init(NULL);
  CHECK(!cam_sched_capture_admit(NULL), "NULL admits nothing");
  CHECK(!cam_sched_capture_ready(NULL), "NULL is never ready");
  CHECK(!cam_sched_probe_begin(NULL, 0), "NULL probes nothing");
  CHECK(!cam_sched_probe_end(NULL, 0), "NULL wakes nothing");
  CHECK(cam_sched_probes_active(NULL) == 0, "NULL has no probes");
  cam_sched_capture_started(NULL);
  cam_sched_capture_done(NULL);
}

int main(void) {
  test_a_capture_starts_when_idle();
  test_b_probe_defers_during_capture();
  test_c_capture_wins_before_probe();
  test_d_capture_during_probe_waits_then_proceeds();
  test_e_two_probes_in_flight_one_wake();
  test_f_probe_storm_does_not_starve_capture();
  test_g_real_concurrent_capture_is_busy();
  test_h_probe_is_not_a_capture();
  test_i_one_transaction_per_channel();
  test_j_state_returns_to_idle();
  test_k_probes_happen_between_captures();
  test_l_scales_across_four_channels();
  if (fails == 0) {
    printf("p4 cam-sched tests: %d checks passed\n", checks);
    return 0;
  }
  printf("p4 cam-sched tests: %d of %d checks FAILED\n", fails, checks);
  return 1;
}
