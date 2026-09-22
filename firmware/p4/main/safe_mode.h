// Boot-loop guard.
//
// A body that panics every boot looks like a brick: the screen comes up, dies,
// comes up. Three crashes in a row and the next boot leaves out the parts
// that are not the camera - the radio host and the upload queue - and STATUS
// says so. A boot that stays up for three minutes clears the count, so the
// restart after that is an ordinary one. A clean reset (power, the restart
// dialog, REBOOT) clears it too: only crash after crash counts.
#ifndef KINO_SAFE_MODE_H
#define KINO_SAFE_MODE_H

#include <stdbool.h>

/** Read the reset reason and count. Once, early in app_main, after NVS and klog. */
void safe_mode_boot(void);

/** True when this boot runs without the radio and the upload queue. */
bool safe_mode_active(void);

/** Crashes in a row before this boot; 0 after a clean reset. */
int safe_mode_crashes(void);

#endif
