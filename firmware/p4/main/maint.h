// Maintenance mode: the body set aside for a firmware update (contract
// ENTER_MAINTENANCE 0x50, EXIT_MAINTENANCE 0x51; #242).
//
// Entering takes the capture lock and keeps it, so neither the shutter nor
// CAMERA_CAPTURE nor a background node probe runs while the links carry an
// image. Uploads stop starting new work. A save already in flight lands in
// NVS first (config_flush). Maintenance ends on EXIT_MAINTENANCE, on a
// restart, or by itself PURE_MAINT_HOLD_MS (600 s) after the last
// ENTER_MAINTENANCE or FW_* command. That deadline is checked by maint_poll()
// on the UI task and on kdp_server's 100 ms read loop, never in an esp_timer
// callback, so a body with a dead panel still leaves maintenance.
#ifndef KINO_MAINT_H
#define KINO_MAINT_H

#include <stdbool.h>

#include "esp_err.h"

/**
 * Enter, or refresh the deadline when already in. ESP_ERR_INVALID_STATE when
 * the capture lock is not free within 2 s: a capture or a bench command is
 * running. The KDP task only.
 */
esp_err_t maint_enter(void);

/** Leave, if in. `why` goes to the log. Safe from any task, and twice. */
void maint_exit(const char *why);

/** True while in maintenance. A plain read, for the glass and the gates. */
bool maint_active(void);

/** Push the deadline out and count as activity (the camera bank stays on,
 *  the screen awake): every FW_* command calls this. No-op when out. */
void maint_touch(void);

/** Leave when the deadline has passed. The UI task and kdp_server's loop. */
void maint_poll(void);

#endif
