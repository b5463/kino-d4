#ifndef P4_KDP_SERVER_H
#define P4_KDP_SERVER_H

#include <stdbool.h>

#include "esp_err.h"

typedef struct {
  char serial[16];    /* "KD4-3A2B1C" — stable, from the factory MAC */
  char device_id[16]; /* "kino-3a2b1c" */
  char session_id[16];/* "boot-N" — new every boot */
} kdp_identity_t;

esp_err_t kdp_server_start(const kdp_identity_t *identity);

/**
 * The favourite flag inside a capture's META.JSON, as MEDIA_FAVORITE writes it.
 *
 * Exposed so the body's own photograph screen can set the same flag the host
 * sets, through the same code. The alternative was a second META.JSON rewrite
 * in ui.c, which is how the two would eventually have disagreed about the
 * document's shape.
 *
 * THE CALLER MUST HOLD THE CARD - storage_acquire(STORAGE_USER_UI, ...) - for
 * the whole call. These read and rewrite a file on the SD bus, and they parse
 * through buffers whose only protection is that one lock.
 *
 * Returns ESP_ERR_INVALID_ARG for an id that is not a capture id,
 * ESP_ERR_NOT_FOUND when the capture has no META.JSON, ESP_ERR_NO_MEM, or
 * ESP_FAIL for a write that did not complete. There is deliberately no
 * media_favorite_get: readers take the flag from the gallery item or from
 * MEDIA_INFO, both of which come off the same META read that already happens.
 */
esp_err_t media_favorite_set(const char *id, bool fav);

#endif
