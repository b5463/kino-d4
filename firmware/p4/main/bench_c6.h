#pragma once
/*
 * Bench-only: reset the C6 coprocessor and nothing else.
 *
 * ROLL-C test 3 asks what the upload queue does when the radio chip reboots
 * under it while the P4 keeps running. Nothing in the product resets the C6
 * on its own after boot (net_hosted.c's supervisor reports a lost link and
 * does not pulse the enable line), so the bench needs an actuator.
 *
 * This file is the decision, kept free of ESP-IDF so it is host-tested:
 * given whether the actuator was compiled in and the operations available,
 * either exactly one C6 reset pulse happens or nothing does. There is no
 * reboot arm. `reboot` is in the operations table so a test can prove the
 * request never reaches for it, not because any path calls it.
 *
 * The pulse itself is net_hosted.c's own enable-line sequence with its own
 * timing; the KDP handler in kdp_server.c wires it in only when the build
 * was configured with -DKINO_C6_RESET_BENCH=1 on top of the radio fragment.
 * Every other build answers UNSUPPORTED_COMMAND and moves no pin.
 */

#include <stdbool.h>

typedef struct {
  /** One C6 reset pulse on the enable line. NULL when not built in. */
  void (*pulse)(void);
  /** The P4's own restart. Never called by this module; here to be proven so. */
  void (*reboot)(void);
} bench_c6_ops_t;

typedef enum {
  BENCH_C6_DONE = 0,       /* one pulse was issued */
  BENCH_C6_UNAVAILABLE = 1 /* not in this build, or no actuator: nothing moved */
} bench_c6_result_t;

/**
 * Handle one C6_RESET_BENCH request.
 *
 * `built_in` is the compile-time answer (KINO_RADIO && KINO_C6_RESET_BENCH).
 * When it is false, or `ops`/`ops->pulse` is NULL, nothing is called and
 * BENCH_C6_UNAVAILABLE is returned. Otherwise `ops->pulse` is called exactly
 * once and BENCH_C6_DONE is returned. `ops->reboot` is never called.
 */
bench_c6_result_t bench_c6_reset_request(bool built_in, const bench_c6_ops_t *ops);
