// The card, watched: is it still there, did one arrive, is it any good - and
// the log ring written to it, so a person can hand over a file.
//
// One task, its stack in PSRAM, waking every two seconds:
//   - a mounted card is asked for its status (CMD13); a card that does not
//     answer was pulled, and is unmounted so the rest of the firmware sees
//     "no card" instead of a stream of write errors;
//   - an empty slot gets a quiet mount attempt every ten seconds, so a card
//     put in while the camera runs is ready without a restart;
//   - a card that has just mounted gets the write self-test once, and its
//     result (fail, slow) reaches the conditions through storage_get_status;
//   - every thirty seconds the log lines since the last flush are appended
//     to /KINO/LOGS/BOOT-nnnnn.TXT, twenty boots kept.
// The UI drains the events with storage_watch_take() on its own pass.
#ifndef KINO_STORAGE_WATCH_H
#define KINO_STORAGE_WATCH_H

#include <stdbool.h>

#include "esp_err.h"

typedef enum {
  STORAGE_EV_MOUNTED = 1, /* a card is in and ready */
  STORAGE_EV_REMOVED,     /* the card was pulled while running */
} storage_event_t;

/** Start the watcher. After storage_init() and the upload queue. */
esp_err_t storage_watch_start(void);

/** The next pending event, oldest first; false when there is none. */
bool storage_watch_take(storage_event_t *out);

#endif
