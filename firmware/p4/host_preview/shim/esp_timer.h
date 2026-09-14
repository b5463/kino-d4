// The preview's clock is a variable, not the wall: a scene sets it, steps it,
// and photographs the screen at chosen instants, so a 300 ms transition can
// be reviewed frame by frame and compared in CI. vTaskDelay advances it too.
#pragma once
#include <stdint.h>

extern int64_t g_preview_clock_us;
static inline int64_t esp_timer_get_time(void) { return g_preview_clock_us; }
