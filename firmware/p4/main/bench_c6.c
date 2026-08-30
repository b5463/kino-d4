/*
 * Bench-only C6 reset request. See bench_c6.h.
 *
 * No ESP-IDF here on purpose: firmware/p4/host_tests/test_bench_c6.c compiles
 * this file with a plain C compiler and proves both arms - one pulse when
 * built in, nothing at all when not.
 */
#include "bench_c6.h"

#include <stddef.h>

bench_c6_result_t bench_c6_reset_request(bool built_in, const bench_c6_ops_t *ops) {
  if (!built_in) return BENCH_C6_UNAVAILABLE;
  if (ops == NULL || ops->pulse == NULL) return BENCH_C6_UNAVAILABLE;
  ops->pulse();
  return BENCH_C6_DONE;
}
