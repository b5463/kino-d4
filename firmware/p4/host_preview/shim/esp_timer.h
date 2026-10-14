// Host shim.
#pragma once
#include <stdint.h>
#include <time.h>

/*
 * A clock the renderer owns, never the wall.
 *
 * A transition in ui.c runs off this clock and emits frames until the
 * duration is up, so on wall time the renderer would spit out as many frames
 * as the host could manage - hundreds, and a different number every run. With
 * `prev_vclock_us` non-zero the renderer owns the clock and advances it once
 * per presented frame, which makes a transition a fixed, reviewable sequence
 * of pictures rather than a thing that can only be watched.
 *
 * Outside a transition it was the host's CLOCK_MONOTONIC, which made the
 * stills depend on the machine: ABOUT printed the workstation's uptime, and
 * ROLL's "8 s ago" read 9 s whenever a second boundary fell between setting
 * the stamp and drawing it. The golden hashes (make check) cannot hold over
 * that. So the idle clock is `prev_idle_clock_us`, which starts at a fixed
 * uptime and creeps 1 ms per read: deterministic, and still moving, so a
 * loop that waits for time to pass ends.
 */
extern int64_t prev_vclock_us;
extern int64_t prev_vclock_step_us;
extern int64_t prev_idle_clock_us;

static inline int64_t esp_timer_get_time(void) {
  if (prev_vclock_us != 0) return prev_vclock_us;
  prev_idle_clock_us += 1000;
  return prev_idle_clock_us;
}
