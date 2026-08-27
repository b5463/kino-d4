/* Enough of esp_system.h for the preview.
 *
 * ui.c calls esp_restart() from the Power screen's confirm. A preview that
 * restarted the workstation would be a memorable bug, so the stand-in in
 * preview.c logs and returns instead. */
#pragma once

void esp_restart(void);
