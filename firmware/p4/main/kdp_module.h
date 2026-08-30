/*
 * The reply a KDP feature module hands back to the dispatcher.
 *
 * kdp_server.c owns the wire: framing, sequence numbers, the TX lock. A
 * module (recipes, sounds, the network in kdp_net.c) owns one command family
 * and knows nothing about frames. It answers with this struct and the
 * dispatcher sends it - JSON, raw bytes, or a NACK - so two modules can be
 * written in parallel without either touching kdp_server.c.
 *
 * Ownership: `json` passes to the sender, which deletes it. `bytes` stays
 * with the module and must remain valid until the module's next call; a
 * static buffer is the intended shape, since one request is answered before
 * the next is decoded. A failed reply allocates nothing.
 */
#ifndef P4_KDP_MODULE_H
#define P4_KDP_MODULE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#include "cJSON.h"

#define KDP_MODULE_MSG_LEN 128

typedef struct {
  bool ok;
  cJSON *json;          /* response body when ok and bytes is NULL */
  const uint8_t *bytes; /* KDP_FLAG_BINARY body when ok and json is NULL */
  size_t bytes_len;
  const char *code;                 /* NACK code when !ok; a string literal */
  char message[KDP_MODULE_MSG_LEN]; /* NACK message when !ok */
} kdp_module_reply_t;

static inline kdp_module_reply_t kdp_module_json(cJSON *json) {
  kdp_module_reply_t r = {.ok = true, .json = json};
  return r;
}

static inline kdp_module_reply_t kdp_module_bytes(const uint8_t *bytes, size_t len) {
  kdp_module_reply_t r = {.ok = true, .bytes = bytes, .bytes_len = len};
  return r;
}

static inline kdp_module_reply_t kdp_module_fail(const char *code, const char *message) {
  kdp_module_reply_t r = {.ok = false, .code = code};
  snprintf(r.message, sizeof r.message, "%s", message ? message : "");
  return r;
}

#endif
