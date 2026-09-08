/**
 * One HTTPS request to the KINO Roll API, and the file streaming a part PUT
 * needs.
 *
 * roll_api.h owns the procedure — which call comes after which, and what a
 * response means. This file owns the wire: esp_http_client, esp-tls, the
 * certificate bundle, the bearer header, and reading a capture off the card
 * without holding it away from a photograph.
 *
 * Radio build only. In the default build nothing here is compiled and
 * roll_api.c answers "no transport", which is what `rq_classify_status(0)`
 * calls transient.
 *
 * ## Certificate verification is not optional
 *
 * Every request verifies against ESP-IDF's certificate bundle. There is no
 * flag in this file to turn that off, and adding one would be the wrong
 * answer to the two problems that tempt people into it:
 *
 *   - a clock that is wrong by years cannot validate anything. That is
 *     `clock_trustworthy_for_tls()`'s job, and the queue reports
 *     `NET_REASON_CLOCK_UNTRUSTED` instead of trying;
 *   - a private API host with its own certificate authority needs its root
 *     added to the bundle, which is a build-time decision with a reviewable
 *     diff.
 *
 * ## The token
 *
 * The bearer token reaches this module only through
 * `roll_state_apply_credential_to()`, inside the one frame that builds the
 * header. It is never a parameter here, never logged, and every error string
 * that leaves goes through `rq_redact()`.
 */
#ifndef P4_ROLL_HTTP_H
#define P4_ROLL_HTTP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "roll_queue.h"

#ifdef KINO_RADIO

/** Largest response body this module keeps. The API's device replies are a
 * handful of fields; anything larger is not a reply we understand and is
 * truncated rather than allocated for. */
#define ROLL_HTTP_MAX_RESPONSE 1024

/** One request's outcome. `status` 0 means no response at all — DNS, TLS, the
 * connection, a timeout, or the card being taken away mid-PUT. That is the
 * value `rq_classify_status()` treats as transient. */
typedef struct {
  int status;
  size_t body_len;
  char detail[RQ_ERROR_LEN]; /* already redacted */
  /** The API's `code` on a >= 400 reply, empty otherwise or when the body did
   * not carry one. It is a fixed vocabulary of A-Z and underscores
   * (rq_error_code), so no secret can reach it and it is not redacted;
   * `detail` beside it still is. */
  char code[RQ_ERROR_CODE_LEN];
} roll_http_out_t;

/** What to send. `json_body` and the file streaming below are exclusive. */
typedef struct {
  const char *method; /* "GET", "POST", "PUT" */
  const char *path;   /* "/api/device/rolls", leading slash */
  const char *json_body;
  bool authenticate; /* attach the device bearer token */
  char *response;    /* may be NULL to discard the body */
  size_t response_cap;
} roll_http_req_t;

/**
 * True when a request could be attempted at all, with `why` filled in when
 * not. Three separate reasons and they need separate words: no address, no
 * trustworthy clock, or no API base URL in this build.
 */
/**
 * The API base in effect, into `out`. The stored development override
 * `network.apiBase` when it is set and passes pure_api_base_ok(); otherwise the
 * compiled production default. Returns false when neither yields a base.
 *
 * This is the one place an `http://` base can come from, and only from the
 * stored value: the compiled default is never anything but https. So HTTP is
 * reachable only by an explicit, visible configuration - GET_CONFIG shows it,
 * SET_CONFIG sets it, SAVE_CONFIG keeps it - and never by default.
 *
 * Whether it is reachable AT ALL is `KINO_ALLOW_HTTP_API_BASE` in roll_http.c.
 * It is 1 by default so the LAN bench works, and A PRODUCTION BUILD SETS IT TO
 * 0: the bearer token travels in a header on every request, and `apiBase` is
 * in NVS rather than in the image, so a bench value set once outlives the
 * reflash that was supposed to remove it. At 0 an http base is refused, an
 * ESP_LOGE says so, and this returns false rather than falling back to a
 * server that has no certificate.
 *
 * A stored value LONGER than `cap - 1` is refused rather than used. config_str
 * would hand back a truncated copy that still validates, and a base cut short
 * at a port number points somewhere nobody configured.
 */
bool roll_http_api_base(char *out, size_t cap);

bool roll_http_ready(char *why, size_t cap);

/**
 * The `detail` a step sets when the CARD, not the network, stopped it.
 *
 * ONE constant, compared against by roll_api.c and emitted by roll_http.c,
 * because it was two literals: "card busy" when the lock could not be taken
 * and "yielded the card to a capture" when it was given up mid-part, while
 * roll_api.c compared against only the first. A deliberate yield - the case
 * the design is proudest of - therefore burned an attempt from the retry
 * budget, and twelve of them parked the photograph as failed. A string
 * compared in one file and written in another has to be a symbol.
 *
 * Its meaning: transient, ours, and not the server's. The queue must retry
 * without spending the budget.
 */
#define ROLL_HTTP_CARD_YIELD_DETAIL "the card went to a capture"

/** Perform a request with a JSON or empty body. Blocks the calling task. */
void roll_http_perform(const roll_http_req_t *req, roll_http_out_t *out);

/**
 * PUT `len` bytes of `file_path` starting at `offset` as an octet-stream.
 *
 * Takes `STORAGE_USER_UPLOAD` for each card READ and gives it back before the
 * socket write, so the longest this can hold the card is one 16 KiB read and
 * never a network operation. It used to hold it across the whole part - every
 * `esp_http_client_write()` included - and a single write can block for
 * `HTTP_TIMEOUT_MS`, 15 s, so the real bound was the network's and not the
 * card's.
 *
 * Each pass also polls `storage_yield_requested()`, and a lock it cannot get
 * within `CARD_WAIT_MS` is treated the same way. Either abandons the request
 * and returns `status` 0 with `ROLL_HTTP_CARD_YIELD_DETAIL`, which the queue
 * treats as transient and retries WITHOUT spending an attempt. That is correct
 * rather than merely acceptable: the contract's part re-PUT is idempotent, and
 * an abandoned upload costs nothing while a dropped frame costs a photograph.
 *
 * The file handle is closed with each release, not kept open across it. The
 * lock is not only about the SDMMC bus: the FAT mount has `max_files = 4`
 * (storage.h), so a handle held while the lock is free can be the descriptor
 * a capture cannot get.
 */
void roll_http_put_file(const char *path, const char *file_path, size_t offset, size_t len,
                        roll_http_out_t *out);

/**
 * SHA-256 of `len` bytes of `file_path` from `offset`, as 64 lowercase hex
 * characters plus a terminator.
 *
 * Streamed, under the storage lock, because the file is up to a few megabytes
 * and this runs on the upload worker. Returns false when the card refused or
 * the file is short.
 */
bool roll_http_sha256_file(const char *file_path, size_t offset, size_t len, char *hex,
                           size_t cap);

/** Size of a file on the card, or 0. */
size_t roll_http_file_size(const char *file_path);
/** As above, and says whether 0 meant "could not take the card" rather than
 * "no such file or empty". The two were one number until Gate F showed a good
 * photograph parked as "not on the card" after a burst of shutters. */
size_t roll_http_file_size_ex(const char *file_path, bool *card_busy);
/** As roll_http_sha256_file, reporting a card yield (acquire refused, or a
 * capture asked for the card mid-hash) separately from a read failure. */
bool roll_http_sha256_file_ex(const char *file_path, size_t offset, size_t len, char *hex,
                              size_t cap, bool *card_busy);

#endif /* KINO_RADIO */

#endif /* P4_ROLL_HTTP_H */
