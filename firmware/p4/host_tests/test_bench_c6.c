/*
 * Host tests for bench_c6.c - the bench-only C6 reset request.
 *
 *   make -C firmware/p4/host_tests test-bench
 *
 * What is proven here is the decision, not the pin: with the actuator built
 * in, one request is exactly one pulse and never a P4 restart; without it,
 * nothing is called at all. Whether the pulse really resets the C6 and leaves
 * the P4 running is a bench question, answered in HARDWARE_VALIDATION.md.
 */
#include "bench_c6.h"

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

static int s_pulses;
static int s_reboots;
static void count_pulse(void) { s_pulses++; }
static void count_reboot(void) { s_reboots++; }

static void reset_counts(void) {
  s_pulses = 0;
  s_reboots = 0;
}

static void test_bench_build_pulses_once(void) {
  reset_counts();
  const bench_c6_ops_t ops = {.pulse = count_pulse, .reboot = count_reboot};
  CHECK(bench_c6_reset_request(true, &ops) == BENCH_C6_DONE, "bench build accepts the request");
  CHECK(s_pulses == 1, "exactly one pulse, got %d", s_pulses);
  CHECK(s_reboots == 0, "the P4 restart is never reached, got %d", s_reboots);

  /* A second request is a second pulse - each one is deliberate. */
  CHECK(bench_c6_reset_request(true, &ops) == BENCH_C6_DONE, "second request accepted");
  CHECK(s_pulses == 2, "one pulse per request, got %d", s_pulses);
  CHECK(s_reboots == 0, "still no restart, got %d", s_reboots);
}

static void test_normal_build_moves_nothing(void) {
  reset_counts();
  const bench_c6_ops_t ops = {.pulse = count_pulse, .reboot = count_reboot};
  /* The production answer: the actuator exists as a function pointer here so
   * the test can prove it is NOT called when the build flag is absent. */
  CHECK(bench_c6_reset_request(false, &ops) == BENCH_C6_UNAVAILABLE,
        "normal build reports the command unavailable");
  CHECK(s_pulses == 0, "no pulse in a normal build, got %d", s_pulses);
  CHECK(s_reboots == 0, "no restart in a normal build, got %d", s_reboots);
}

static void test_no_actuator_is_unavailable(void) {
  reset_counts();
  /* The flag set but no radio build linked: kdp_server passes a NULL pulse. */
  const bench_c6_ops_t no_pulse = {.pulse = NULL, .reboot = count_reboot};
  CHECK(bench_c6_reset_request(true, &no_pulse) == BENCH_C6_UNAVAILABLE,
        "no actuator means unavailable, not a crash");
  CHECK(bench_c6_reset_request(true, NULL) == BENCH_C6_UNAVAILABLE, "NULL ops is unavailable");
  CHECK(bench_c6_reset_request(false, NULL) == BENCH_C6_UNAVAILABLE,
        "NULL ops in a normal build is unavailable");
  CHECK(s_reboots == 0, "no restart on any refused request, got %d", s_reboots);
}

int main(void) {
  test_bench_build_pulses_once();
  test_normal_build_moves_nothing();
  test_no_actuator_is_unavailable();
  if (fails) {
    printf("p4 bench-c6 tests: %d of %d checks FAILED\n", fails, checks);
    return 1;
  }
  printf("p4 bench-c6 tests: %d checks passed\n", checks);
  return 0;
}
