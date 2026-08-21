#ifndef P4_KDP_SERVER_H
#define P4_KDP_SERVER_H

#include "esp_err.h"

typedef struct {
  char serial[16];    /* "KD4-3A2B1C" — stable, from the factory MAC */
  char device_id[16]; /* "kino-3a2b1c" */
  char session_id[16];/* "boot-N" — new every boot */
} kdp_identity_t;

esp_err_t kdp_server_start(const kdp_identity_t *identity);

#endif
