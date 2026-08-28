/**
 * The authenticated JSON client the Roll procedures sit on, and the device
 * credential that authenticates them.
 *
 * INTERNAL to the Roll API module. `roll_api.h` is the surface the rest of the
 * firmware uses; nothing outside `roll_api.c` should include this.
 *
 * The split is by concern rather than by line count. Two questions live here —
 * "how does a request get made and parsed" and "who is this camera" — and both
 * are answered once for every procedure above them. What stays in `roll_api.c`
 * is the procedures themselves: the capture document, the three upload steps,
 * and Roll association. Those change when the contract changes; this changes
 * when the transport or the credential model does.
 *
 * Everything below exists only in the radio build. In the default build there
 * is no HTTP client to wrap, and `roll_client.c` compiles to the one honest
 * answer `roll_api_ready()` can give.
 */
#ifndef P4_ROLL_CLIENT_H
#define P4_ROLL_CLIENT_H

#include "roll_api.h"

#ifdef KINO_RADIO

#include "cJSON.h"
#include "roll_http.h"

/**
 * POST or GET with a JSON body, returning the parsed reply or NULL.
 *
 * The caller always gets a status in `out` whether or not the body parsed, so a
 * NULL return is never ambiguous between "the request failed" and "the reply
 * was not JSON" — `out->status` distinguishes them, and
 * `rq_classify_status()` is what decides what either means.
 */
cJSON *roll_client_call(const char *method, const char *path, const char *body,
                        roll_http_out_t *out);

/** A string field, or NULL when absent or not a string. */
const char *roll_client_str(const cJSON *o, const char *key);

/** Copy a string field into a fixed buffer, empty when absent. */
void roll_client_copy(char *dst, size_t cap, const cJSON *o, const char *key);

/**
 * Register this body once and store the credential, or confirm one is already
 * stored.
 *
 * Idempotent and cheap on the common path: a stored credential returns 200
 * without a request. Every authenticated procedure calls this first, because a
 * camera that has never registered has nothing to authenticate with and the
 * failure should name that rather than surfacing as a 401.
 *
 * The token comes back exactly once — the server keeps only its SHA-256 — so
 * the write to NVS is the whole point, and failing to store it is worse than
 * failing to obtain it.
 */
bool roll_client_ensure_registered(roll_http_out_t *out);

#endif /* KINO_RADIO */

#endif /* P4_ROLL_CLIENT_H */
