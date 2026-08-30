/*
 * Host tests for radio_recovery.c - what the P4 does when the C6 goes away.
 *
 *   make -C firmware/p4/host_tests test-recovery
 *
 * A scripted "world" stands in for net_hosted.c: it performs the actions the
 * machine asks for by flipping the flags a real bench would flip, and it
 * counts what it was asked to do. The cases follow the bench brief of
 * 2026-08-30: healthy radio untouched (A); the full happy path (B); SDIO
 * never enumerates (C); rx without tx (D); version RPC unanswered (E);
 * version incompatible (F); association fails (G); DHCP fails (H); success
 * after one failed attempt (I); a stale generation cannot write (J); the
 * dependents' wake-up happens exactly once (K); no reboot and no IO9 action
 * exist (L, M). Whether the real coprocessor comes back is a bench question,
 * answered in HARDWARE_VALIDATION.md.
 */
#include "radio_recovery.h"

#include <stdio.h>
#include <string.h>

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

/* ------------------------------------------------------------------ */
/* A scripted bench                                                   */
/* ------------------------------------------------------------------ */

typedef struct {
  /* what the world will do when asked */
  int teardown_rc, reset_rc, hosted_rc, wifi_init_rc, wifi_join_rc;
  rr_version_t version_answer;
  bool sdio_enumerates;   /* rx_ready appears after hosted-up */
  bool handshake_completes; /* tx_ready follows rx_ready */
  bool associates;        /* association follows the join */
  bool leases;            /* DHCP follows association */
  bool auth_fails;        /* the AP refuses the passphrase */
  int64_t sdio_delay_ms, hs_delay_ms, assoc_delay_ms, dhcp_delay_ms;

  /* live state, as the glue would read it */
  rr_obs_t obs;
  int64_t t_hosted_up, t_rx, t_join;

  /* counters */
  int teardowns, resets, hosted_ups, version_rpcs, wifi_inits, wifi_joins, recovered;
  int reboots, io9_touches; /* must stay 0: there is no such action */
} world_t;

static void world_init(world_t *w) {
  memset(w, 0, sizeof *w);
  w->version_answer = RR_VER_OK;
  w->sdio_enumerates = true;
  w->handshake_completes = true;
  w->associates = true;
  w->leases = true;
  w->sdio_delay_ms = 900;
  w->hs_delay_ms = 400;
  w->assoc_delay_ms = 3000;
  w->dhcp_delay_ms = 1200;
}

/* Perform one action the way net_hosted.c would, and report it. */
static void perform(world_t *w, rr_t *r, rr_action_t a, int64_t now) {
  switch (a) {
    case RR_ACT_NONE: return;
    case RR_ACT_TEARDOWN:
      w->teardowns++;
      w->obs.rx_ready = w->obs.tx_ready = false;
      w->obs.associated = w->obs.has_ip = w->obs.auth_failed = false;
      rr_action_done(r, a, w->teardown_rc, now);
      return;
    case RR_ACT_RESET_C6:
      w->resets++;
      rr_action_done(r, a, w->reset_rc, now);
      return;
    case RR_ACT_HOSTED_UP:
      w->hosted_ups++;
      w->t_hosted_up = now;
      rr_action_done(r, a, w->hosted_rc, now);
      return;
    case RR_ACT_VERSION_RPC:
      w->version_rpcs++;
      rr_action_done(r, a, (int)w->version_answer, now);
      return;
    case RR_ACT_WIFI_INIT:
      w->wifi_inits++;
      rr_action_done(r, a, w->wifi_init_rc, now);
      return;
    case RR_ACT_WIFI_JOIN:
      w->wifi_joins++;
      w->t_join = now;
      rr_action_done(r, a, w->wifi_join_rc, now);
      return;
    case RR_ACT_RECOVERED:
      w->recovered++;
      return;
  }
  /* Anything else would be an action this machine does not have. */
  w->reboots++;
}

/* The world evolves with time: enumeration, handshake, association, lease. */
static void evolve(world_t *w, int64_t now) {
  if (w->t_hosted_up && w->sdio_enumerates && !w->obs.rx_ready &&
      now >= w->t_hosted_up + w->sdio_delay_ms) {
    w->obs.rx_ready = true;
    w->t_rx = now;
  }
  if (w->obs.rx_ready && w->handshake_completes && !w->obs.tx_ready &&
      now >= w->t_rx + w->hs_delay_ms) {
    w->obs.tx_ready = true;
  }
  if (w->t_join && !w->obs.associated) {
    if (w->auth_fails && now >= w->t_join + 1000) w->obs.auth_failed = true;
    else if (w->associates && now >= w->t_join + w->assoc_delay_ms) w->obs.associated = true;
  }
  if (w->obs.associated && w->leases && !w->obs.has_ip &&
      now >= w->t_join + w->assoc_delay_ms + w->dhcp_delay_ms) {
    w->obs.has_ip = true;
  }
}

/* Run the machine for `ms` of simulated time in 100 ms ticks. */
static int64_t run(world_t *w, rr_t *r, int64_t from, int64_t ms) {
  int64_t now = from;
  for (int64_t t = 0; t < ms; t += 100) {
    now = from + t;
    evolve(w, now);
    const rr_action_t a = rr_step(r, &w->obs, r->generation, now);
    perform(w, r, a, now);
  }
  return now;
}

/* ------------------------------------------------------------------ */
/* Cases                                                              */
/* ------------------------------------------------------------------ */

static void test_a_healthy_radio_is_left_alone(void) {
  world_t w;
  world_init(&w);
  rr_t r;
  rr_init(&r);
  w.obs.rx_ready = w.obs.tx_ready = w.obs.associated = w.obs.has_ip = true;
  run(&w, &r, 0, 60000);
  CHECK(r.state == RR_HEALTHY, "healthy stays healthy");
  CHECK(w.teardowns == 0 && w.resets == 0 && w.hosted_ups == 0 && w.recovered == 0,
        "nothing was done to a healthy radio");
  CHECK(!rr_active(&r), "not active");
  CHECK(r.generation == 0, "no generation consumed");
}

static void test_b_full_recovery(void) {
  world_t w;
  world_init(&w);
  rr_t r;
  rr_init(&r);
  rr_link_lost(&r, 1000);
  CHECK(r.state == RR_TEARDOWN, "loss starts with the teardown");
  CHECK(r.generation == 1, "a new generation");
  CHECK(rr_active(&r), "active");
  run(&w, &r, 1000, 30000);
  CHECK(r.state == RR_HEALTHY, "recovered to healthy, got %s", rr_state_name(r.state));
  CHECK(w.teardowns == 1, "one teardown, got %d", w.teardowns);
  CHECK(w.resets == 1, "one reset pulse, got %d", w.resets);
  CHECK(w.hosted_ups == 1, "one hosted init, got %d", w.hosted_ups);
  CHECK(w.version_rpcs == 1, "one version RPC, got %d", w.version_rpcs);
  CHECK(w.wifi_inits == 1, "one wifi init, got %d", w.wifi_inits);
  CHECK(w.wifi_joins == 1, "one join, got %d", w.wifi_joins);
  CHECK(w.recovered == 1, "recovered reported once, got %d", w.recovered);
  CHECK(r.recoveries == 1, "one recovery counted");
  CHECK(r.attempts == 0, "attempts reset after success");
  /* Order: rx before tx before version before association before address. */
  CHECK(r.t_release > 0 && r.t_rx >= r.t_release && r.t_tx >= r.t_rx && r.t_version >= r.t_tx &&
            r.t_assoc >= r.t_version && r.t_ip >= r.t_assoc,
        "timing is monotonic: release %lld rx %lld tx %lld ver %lld assoc %lld ip %lld",
        (long long)r.t_release, (long long)r.t_rx, (long long)r.t_tx, (long long)r.t_version,
        (long long)r.t_assoc, (long long)r.t_ip);
  /* And it never reached for anything it does not have. */
  CHECK(w.reboots == 0 && w.io9_touches == 0, "no reboot, no IO9");
}

static void test_c_sdio_never_enumerates(void) {
  world_t w;
  world_init(&w);
  w.sdio_enumerates = false;
  rr_t r;
  rr_init(&r);
  rr_link_lost(&r, 0);
  /* Hosted init at ~200 ms, SDIO deadline 5 s later, first backoff 2 s: at
   * 6 s the machine is inside that backoff. */
  run(&w, &r, 0, 6000);
  CHECK(r.state == RR_BACKOFF, "no enumeration -> backoff, got %s", rr_state_name(r.state));
  CHECK(r.attempts == 1, "one failed attempt");
  CHECK(w.version_rpcs == 0 && w.wifi_inits == 0 && w.recovered == 0,
        "nothing past the transport was attempted");
  CHECK(strstr(r.detail, "SDIO") != NULL, "detail names the transport: '%s'", r.detail);
  /* Keep failing: bounded, backs off, parks - never a tight loop, never ready. */
  run(&w, &r, 6000, 600000);
  CHECK(r.state == RR_PARKED, "parked after the budget, got %s", rr_state_name(r.state));
  CHECK(r.attempts == RR_MAX_ATTEMPTS, "%u attempts, got %u", RR_MAX_ATTEMPTS, r.attempts);
  CHECK(w.hosted_ups == (int)RR_MAX_ATTEMPTS, "one hosted init per attempt, got %d", w.hosted_ups);
  CHECK(w.recovered == 0, "never reported ready");
  CHECK(!rr_active(&r), "parked is not active");
  /* Parked means quiet: more time changes nothing. */
  const int before = w.hosted_ups;
  run(&w, &r, 700000, 300000);
  CHECK(w.hosted_ups == before, "parked radio is left alone");
}

static void test_d_rx_without_tx(void) {
  world_t w;
  world_init(&w);
  w.handshake_completes = false;
  rr_t r;
  rr_init(&r);
  rr_link_lost(&r, 0);
  run(&w, &r, 0, 12000);
  CHECK(w.version_rpcs == 0, "rx alone is not a handshake: no version RPC");
  CHECK(r.state == RR_BACKOFF || r.state == RR_TEARDOWN || r.state == RR_RESET_C6 ||
            r.state == RR_HOSTED_UP || r.state == RR_SDIO_WAIT || r.state == RR_HANDSHAKE_WAIT,
        "retrying, not ready: %s", rr_state_name(r.state));
  CHECK(r.attempts >= 1, "the half-handshake counted as a failure");
  CHECK(w.recovered == 0, "no false ready");
}

static void test_e_version_rpc_unanswered(void) {
  world_t w;
  world_init(&w);
  w.version_answer = RR_VER_NO_RESPONSE;
  rr_t r;
  rr_init(&r);
  rr_link_lost(&r, 0);
  run(&w, &r, 0, 10000);
  CHECK(w.version_rpcs >= 1, "the RPC was tried");
  CHECK(w.wifi_inits == 0, "no Wi-Fi without a version answer");
  CHECK(w.recovered == 0, "no ready");
  CHECK(r.attempts >= 1 && (r.state == RR_BACKOFF || rr_active(&r)),
        "counted and retrying: %s", rr_state_name(r.state));
}

static void test_f_version_incompatible_parks(void) {
  world_t w;
  world_init(&w);
  w.version_answer = RR_VER_INCOMPATIBLE;
  rr_t r;
  rr_init(&r);
  rr_link_lost(&r, 0);
  run(&w, &r, 0, 120000);
  CHECK(r.state == RR_PARKED, "incompatible parks, got %s", rr_state_name(r.state));
  CHECK(w.version_rpcs == 1, "asked once, got %d", w.version_rpcs);
  CHECK(w.wifi_inits == 0 && w.recovered == 0, "fail closed: no Wi-Fi, no ready");
  CHECK(strstr(r.detail, "reflash") != NULL, "detail says what to do: '%s'", r.detail);
}

static void test_g_association_fails(void) {
  world_t w;
  world_init(&w);
  w.associates = false;
  rr_t r;
  rr_init(&r);
  rr_link_lost(&r, 0);
  run(&w, &r, 0, 40000);
  CHECK(w.wifi_joins >= 1, "a join was tried");
  CHECK(w.recovered == 0, "no ready without association");
  CHECK(r.attempts >= 1, "the failed association counted");
  CHECK(r.state == RR_BACKOFF || rr_active(&r), "bounded retry, got %s", rr_state_name(r.state));
  CHECK(w.wifi_joins <= 2, "not hammering the AP: %d joins in 40 s", w.wifi_joins);

  /* A wrong passphrase is not retried, as at first boot. */
  world_init(&w);
  w.auth_fails = true;
  rr_init(&r);
  rr_link_lost(&r, 0);
  run(&w, &r, 0, 60000);
  CHECK(r.state == RR_PARKED, "auth failure parks, got %s", rr_state_name(r.state));
  CHECK(w.wifi_joins == 1, "one join only, got %d", w.wifi_joins);
}

static void test_h_dhcp_fails(void) {
  world_t w;
  world_init(&w);
  w.leases = false;
  rr_t r;
  rr_init(&r);
  rr_link_lost(&r, 0);
  run(&w, &r, 0, 40000);
  CHECK(w.recovered == 0, "associated without an address is not ready");
  CHECK(r.attempts >= 1, "the missing lease counted");
  CHECK(r.state == RR_BACKOFF || rr_active(&r), "retrying, got %s", rr_state_name(r.state));
}

static void test_i_success_after_one_failure(void) {
  world_t w;
  world_init(&w);
  w.sdio_enumerates = false;
  rr_t r;
  rr_init(&r);
  rr_link_lost(&r, 0);
  int64_t now = run(&w, &r, 0, 7000);
  CHECK(r.state == RR_BACKOFF && r.attempts == 1, "first attempt failed, backing off");
  const uint32_t gen1 = r.generation;
  w.sdio_enumerates = true; /* the C6 is there this time */
  run(&w, &r, now, 40000);
  CHECK(r.state == RR_HEALTHY, "second attempt recovered, got %s", rr_state_name(r.state));
  CHECK(r.generation == gen1 + 1, "the retry is a new generation");
  CHECK(w.resets == 2 && w.hosted_ups == 2, "two attempts, two pulses, two inits");
  CHECK(w.recovered == 1, "ready reported once");
  CHECK(r.attempts == 0, "attempts cleared on success");
  CHECK(r.recoveries == 1, "one recovery counted");
}

static void test_j_stale_generation_cannot_write(void) {
  world_t w;
  world_init(&w);
  w.sdio_enumerates = false; /* hold the machine in SDIO_WAIT */
  rr_t r;
  rr_init(&r);
  rr_link_lost(&r, 0);
  run(&w, &r, 0, 2000);
  CHECK(r.state == RR_SDIO_WAIT, "waiting on SDIO, got %s", rr_state_name(r.state));
  /* An observation from the previous coprocessor claims everything is fine. */
  rr_obs_t stale = {.rx_ready = true, .tx_ready = true, .associated = true, .has_ip = true};
  const rr_action_t a = rr_step(&r, &stale, r.generation - 1, 2100);
  CHECK(a == RR_ACT_NONE, "stale observation yields no action");
  CHECK(r.state == RR_SDIO_WAIT, "stale observation changed nothing: %s", rr_state_name(r.state));
  CHECK(r.recoveries == 0, "no recovery from a stale ready");
  /* The current generation with the same content is believed. */
  rr_step(&r, &stale, r.generation, 2200);
  CHECK(r.state == RR_VERSION_GATE, "current observation advances: %s", rr_state_name(r.state));

  /* And after a backoff bumps the generation, the old one is stale too. */
  world_init(&w);
  w.sdio_enumerates = false;
  rr_init(&r);
  rr_link_lost(&r, 0);
  int64_t now = run(&w, &r, 0, 7000);
  const uint32_t old_gen = r.generation;
  w.sdio_enumerates = true;
  now = run(&w, &r, now, 3000); /* into the second attempt */
  CHECK(r.generation == old_gen + 1, "generation moved on");
  rr_obs_t late = {.rx_ready = true, .tx_ready = true};
  const rr_state_t before = r.state;
  rr_step(&r, &late, old_gen, now);
  CHECK(r.state == before, "a late observation from the failed attempt is ignored");
}

static void test_k_dependents_woken_once(void) {
  world_t w;
  world_init(&w);
  rr_t r;
  rr_init(&r);
  rr_link_lost(&r, 0);
  run(&w, &r, 0, 30000);
  CHECK(w.recovered == 1, "one wake-up for the queue, got %d", w.recovered);
  /* Healthy afterwards: more steps, more time, no more wake-ups. */
  run(&w, &r, 30000, 60000);
  CHECK(w.recovered == 1, "still one after a minute healthy, got %d", w.recovered);
  /* A second loss is a second recovery and a second wake-up - not zero, not two. */
  rr_link_lost(&r, 90000);
  w.obs.rx_ready = w.obs.tx_ready = w.obs.associated = w.obs.has_ip = false;
  w.t_hosted_up = w.t_rx = w.t_join = 0;
  run(&w, &r, 90000, 30000);
  CHECK(w.recovered == 2, "second recovery, second wake-up, got %d", w.recovered);
  CHECK(r.recoveries == 2, "two recoveries counted");
  /* A loss reported while a recovery is running is the same loss. */
  rr_link_lost(&r, 120000);
  rr_link_lost(&r, 120001);
  const uint32_t gen = r.generation;
  rr_link_lost(&r, 120002);
  CHECK(r.generation == gen, "repeated loss reports do not restart the attempt");
}

static void test_l_m_no_reboot_no_io9_in_the_action_set(void) {
  /* The machine's whole vocabulary. Every action it can return is listed here
   * with a name; a reboot or an IO9/download-mode action would have to be
   * added to the enum, and this test is where that would show. */
  static const rr_action_t all[] = {RR_ACT_NONE,        RR_ACT_TEARDOWN,  RR_ACT_RESET_C6,
                                    RR_ACT_HOSTED_UP,   RR_ACT_VERSION_RPC, RR_ACT_WIFI_INIT,
                                    RR_ACT_WIFI_JOIN,   RR_ACT_RECOVERED};
  for (size_t i = 0; i < sizeof all / sizeof all[0]; i++) {
    const char *n = rr_action_name(all[i]);
    CHECK(strstr(n, "reboot") == NULL && strstr(n, "restart") == NULL,
          "no reboot action: %s", n);
    CHECK(strstr(n, "io9") == NULL && strstr(n, "download") == NULL && strstr(n, "flash") == NULL,
          "no IO9 / download-mode / flash action: %s", n);
  }
  CHECK(rr_action_name((rr_action_t)99)[0] == '?', "unknown actions have no name");
  /* Exercised end to end across every scripted failure: the world counted
   * every action it was asked for, and the two it must never be asked for. */
  world_t w;
  rr_t r;
  const rr_version_t answers[] = {RR_VER_OK, RR_VER_NO_RESPONSE, RR_VER_INCOMPATIBLE};
  for (int v = 0; v < 3; v++) {
    for (int sdio = 0; sdio < 2; sdio++) {
      world_init(&w);
      w.version_answer = answers[v];
      w.sdio_enumerates = sdio != 0;
      rr_init(&r);
      rr_link_lost(&r, 0);
      run(&w, &r, 0, 400000);
      CHECK(w.reboots == 0 && w.io9_touches == 0, "no reboot / IO9 (version %d sdio %d)", v, sdio);
    }
  }
}

static void test_backoff_curve_and_names(void) {
  CHECK(rr_backoff_ms(0) == 0, "no backoff before a failure");
  CHECK(rr_backoff_ms(1) == 2000, "2 s first");
  CHECK(rr_backoff_ms(2) == 4000, "4 s");
  CHECK(rr_backoff_ms(5) == 32000, "32 s");
  CHECK(rr_backoff_ms(6) == RR_BACKOFF_CAP_MS, "capped");
  CHECK(rr_backoff_ms(40) == RR_BACKOFF_CAP_MS, "shift bounded");
  for (int s = 0; s <= RR_PARKED; s++) CHECK(rr_state_name((rr_state_t)s)[0] != '?', "state %d named", s);
  rr_t r;
  rr_init(&r);
  rr_init(NULL);
  rr_link_lost(NULL, 0);
  CHECK(rr_step(NULL, NULL, 0, 0) == RR_ACT_NONE, "NULLs are inert");
  rr_action_done(NULL, RR_ACT_TEARDOWN, 0, 0);
  rr_action_done(&r, RR_ACT_TEARDOWN, 0, 0);
  CHECK(r.state == RR_HEALTHY, "a done with nothing pending changes nothing");
}

int main(void) {
  test_a_healthy_radio_is_left_alone();
  test_b_full_recovery();
  test_c_sdio_never_enumerates();
  test_d_rx_without_tx();
  test_e_version_rpc_unanswered();
  test_f_version_incompatible_parks();
  test_g_association_fails();
  test_h_dhcp_fails();
  test_i_success_after_one_failure();
  test_j_stale_generation_cannot_write();
  test_k_dependents_woken_once();
  test_l_m_no_reboot_no_io9_in_the_action_set();
  test_backoff_curve_and_names();
  if (fails) {
    printf("p4 radio-recovery tests: %d of %d checks FAILED\n", fails, checks);
    return 1;
  }
  printf("p4 radio-recovery tests: %d checks passed\n", checks);
  return 0;
}
