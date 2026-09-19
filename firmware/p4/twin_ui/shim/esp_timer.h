// Twin (wasm) shim: a virtual clock.
//
// The browser cannot sleep the module, so time is a value the harness owns:
// kui_pass() sets it from the host's clock at the start of a pass, and the
// two things that take time on the camera - vTaskDelay() and a present - move
// it forward. That is what lets ui.c's time-based loops (the splash bloom,
// the toast timeout, the wigglegram period) run to completion inside one
// pass and still come out at their real pace on screen: every frame the pass
// presents carries the virtual time it was presented at, and the host plays
// them back on that schedule (firmware/p4/twin_ui/twin_ui.c).
#pragma once
#include <stdint.h>

extern int64_t kui_now_us;
static inline int64_t esp_timer_get_time(void) { return kui_now_us; }
