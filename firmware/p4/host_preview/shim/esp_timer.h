// Host shim.
#pragma once
#include <stdint.h>
#include <time.h>

/*
 * Wall clock, unless the renderer has taken over.
 *
 * A transition in ui.c runs off this clock and emits frames until the
 * duration is up, so on wall time the renderer would spit out as many frames
 * as the host could manage - hundreds, and a different number every run. With
 * `prev_vclock_us` non-zero the renderer owns the clock and advances it once
 * per presented frame, which makes a transition a fixed, reviewable sequence
 * of pictures rather than a thing that can only be watched.
 */
extern int64_t prev_vclock_us;
extern int64_t prev_vclock_step_us;

static inline int64_t esp_timer_get_time(void) {
  if (prev_vclock_us != 0) return prev_vclock_us;
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}
