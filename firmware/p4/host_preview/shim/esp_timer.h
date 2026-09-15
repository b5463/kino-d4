// The preview's clock is a variable, not the wall: a scene sets it, steps it,
// and photographs the screen at chosen instants, so a 300 ms transition can
// be reviewed frame by frame and compared in CI. vTaskDelay advances it too.
//
// Cost is the exception. The scene runtime measures how long a frame took to
// step and draw, and on a clock the harness winds forward by hand that came
// out as zero every time - the perf report has been printing zeros for as
// long as it has existed. `preview_now_us()` is the wall, and kscene.h's
// KS_PERF_NOW is pointed at it so the one figure that has to be measured on a
// running clock is. It says nothing about what the P4 will do; it says
// whether a change made the work five times bigger.
#pragma once
#include <stdint.h>
#include <time.h>

extern int64_t g_preview_clock_us;
static inline int64_t esp_timer_get_time(void) { return g_preview_clock_us; }

static inline int64_t preview_now_us(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}
#define KS_PERF_NOW() preview_now_us()

/* WORLD.md's last test: the interface with every word taken out of it. The
 * firmware compiles this away; here it is a flag the shot block turns on. */
extern int g_mute_words;
#define KS_TEXT_MUTED g_mute_words
