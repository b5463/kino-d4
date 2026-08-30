/*
 * The wire under the Roll upload procedure: one HTTPS request, and streaming
 * a capture off the card into a part PUT. See roll_http.h for the rules that
 * are not negotiable.
 *
 * Nothing here has been run on hardware.
 */
#include "roll_http.h"

#ifdef KINO_RADIO

#include <stdio.h>
#include <string.h>

#include "clock.h"
#include "config_store.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "hardware_validation.h"
#include "hwv_rules.h"
#include "mbedtls/sha256.h"
#include "net_hosted.h"
#include "net_link.h"
#include "pure.h"
#include "roll_state.h"
#include "storage.h"

static const char *TAG = "rollhttp";

/*
 * Where the API is.
 *
 * A build-time value with no default, because there is no public KINO API
 * hostname recorded anywhere in this repository and inventing one would put a
 * plausible wrong address in a shipped binary. The bench passes
 * `-DKINO_ROLL_API_BASE=https://...`; without it every call refuses with a
 * reason that says exactly that, which is a better failure than a DNS timeout
 * against a hostname nobody chose.
 */
#ifndef KINO_ROLL_API_BASE
#define KINO_ROLL_API_BASE ""
#endif

/*
 * Whether an `http://` base may be used at all.
 *
 * 1 by default, so the LAN bench keeps working: there is no certificate for a
 * laptop on a party's Wi-Fi, and the base is a value an operator sets
 * deliberately.
 *
 * A PRODUCTION BUILD SETS THIS TO 0 — `-DKINO_ALLOW_HTTP_API_BASE=0`. The
 * device token travels in an `Authorization` header on every request, so an
 * http base puts the credential on the air in cleartext for anyone in the
 * room; and `network.apiBase` lives in NVS, not in the image, so a bench value
 * survives a reflash and would ship that way silently. With this at 0 an http
 * base is refused and the reason says so, rather than being quietly upgraded
 * to https against a server that has none.
 */
#ifndef KINO_ALLOW_HTTP_API_BASE
#define KINO_ALLOW_HTTP_API_BASE 1
#endif

/** Bytes moved per card read and per socket write. 16 KiB is a compromise:
 * large enough that a 300 KB frame is twenty round trips rather than three
 * hundred, small enough that a capture waiting for the card waits one read. */
#define CHUNK_BYTES 16384

/** Network timeout for one request. The queue's own backoff is what handles a
 * server that is slow or gone, so this only has to be long enough for a TLS
 * handshake on a party's Wi-Fi and short enough that a wedged connection does
 * not hold the worker for a minute. */
#define HTTP_TIMEOUT_MS 15000

/** How long the worker waits for the card before giving up on a step. Same
 * value and the same reason as upload_queue.c's: ride out the holders that
 * finish, never queue behind a four-camera capture. */
#define CARD_WAIT_MS 200

/* ------------------------------------------------------------------ */
/* Preconditions                                                      */
/* ------------------------------------------------------------------ */

/**
 * Whether `base`'s scheme is allowed in this build. Warns once either way, so
 * a log from a unit says which policy it was running under.
 */
static bool scheme_allowed(const char *base) {
  if (strncmp(base, "http://", 7) != 0) return true;
#if KINO_ALLOW_HTTP_API_BASE
  static bool warned;
  if (!warned) {
    warned = true;
    ESP_LOGW(TAG,
             "API base is http://; the device token travels in cleartext. "
             "A production build sets KINO_ALLOW_HTTP_API_BASE=0");
  }
  return true;
#else
  static bool refused;
  if (!refused) {
    refused = true;
    ESP_LOGE(TAG, "http:// API base refused: this build allows https:// only");
  }
  return false;
#endif
}

bool roll_http_api_base(char *out, size_t cap) {
  if (out == NULL || cap == 0) return false;
  out[0] = '\0';

  /*
   * Copied WITH THE LENGTH CHECKED, not just copied.
   *
   * This used to read through config_str(), which hands back a slot in a
   * shared 48-byte ring: a stored value longer than 47 characters came back
   * ALREADY CUT SHORT, and a cut-short URL still validates.
   * "https://kino.example.internal:3000" arrived as
   * "https://kino.example.internal:30" — a legal base pointing at a port
   * nobody configured, and the camera would have spent the party connecting to
   * it. config_str_copy() reports the STORED length instead, so a value that
   * does not fit is refused rather than half-believed. Refused, not truncated
   * further: there is no shorter URL that is the right one.
   */
  const size_t stored_len = config_str_copy("network.apiBase", out, cap);
  if (stored_len >= cap) {
    static bool warned;
    if (!warned) {
      warned = true;
      ESP_LOGW(TAG, "network.apiBase is %u characters and does not fit in %u; using the "
                    "compiled default",
               (unsigned)stored_len, (unsigned)cap);
    }
    out[0] = '\0';
  } else if (out[0] != '\0' && pure_api_base_ok(out) && scheme_allowed(out)) {
    return true;
  }

  /* A stored value that does not validate is ignored, not repaired: a
   * half-right URL silently fixed up is a request to the wrong server. */
  pure_strcopy(out, cap, KINO_ROLL_API_BASE);
  return out[0] != '\0' && pure_api_base_ok(out) && scheme_allowed(out);
}

bool roll_http_ready(char *why, size_t cap) {
  char base[PURE_API_BASE_MAX + 1];
  if (!roll_http_api_base(base, sizeof base)) {
    snprintf(why, cap, "no Roll API base URL in this build or its config");
    return false;
  }

  net_status_t st;
  net_link_status(&st, esp_timer_get_time() / 1000);
  if (!net_link_can_upload(&st)) {
    snprintf(why, cap, "no address: %s", net_state_name(st.state));
    return false;
  }

  /*
   * Third and separate, because "the network is up but the camera does not
   * know what year it is" is a different problem from both of the above and
   * the fix is different too.
   *
   * Asked of the clock, not of the cached network reason. The reason is a
   * DISPLAY field: net_time.c sets it when it holds TLS and clears it when the
   * hold comes off, and it is the wrong thing to make a decision from — a
   * clock set by a host over KDP outranks the network, so SNTP never runs, so
   * for a whole boot nothing was ever going to clear a reason that had already
   * stopped being true. clock_trustworthy_for_tls() is the same question with
   * no cache in front of it.
   */
  if (!clock_trustworthy_for_tls()) {
    snprintf(why, cap, "no trustworthy clock yet; TLS not attempted");
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* The bearer header                                                  */
/* ------------------------------------------------------------------ */

/** The one frame that holds the device token. roll_state wipes its copy
 * before returning and this builds the header and nothing else. */
static esp_err_t attach_bearer(const char *device_id, const char *device_token, void *ctx) {
  (void)device_id;
  esp_http_client_handle_t client = ctx;
  char header[16 + ROLL_DEVICE_TOKEN_LEN];
  snprintf(header, sizeof header, "Bearer %s", device_token);
  const esp_err_t err = esp_http_client_set_header(client, "Authorization", header);
  memset(header, 0, sizeof header);
  return err;
}

/* ------------------------------------------------------------------ */
/* One request                                                        */
/* ------------------------------------------------------------------ */

static void fail_out(roll_http_out_t *out, const char *text) {
  out->status = 0;
  out->body_len = 0;
  rq_redact(out->detail, sizeof out->detail, text);
}

/** Build the client for `path`. NULL on any failure, with `out` filled. */
static esp_http_client_handle_t open_client(const char *method, const char *path,
                                           bool authenticate, roll_http_out_t *out) {
  char base[PURE_API_BASE_MAX + 1];
  if (!roll_http_api_base(base, sizeof base)) {
    fail_out(out, "no Roll API base");
    return NULL;
  }
  char url[256];
  const int n = snprintf(url, sizeof url, "%s%s", base, path);
  if (n < 0 || (size_t)n >= sizeof url) {
    fail_out(out, "the request URL does not fit");
    return NULL;
  }

  esp_http_client_config_t cfg = {
      .url = url,
      .timeout_ms = HTTP_TIMEOUT_MS,
      /* Verification, always. See roll_http.h. */
      .crt_bundle_attach = esp_crt_bundle_attach,
      .method = HTTP_METHOD_GET,
      .disable_auto_redirect = true,
  };
  if (strcmp(method, "POST") == 0) cfg.method = HTTP_METHOD_POST;
  if (strcmp(method, "PUT") == 0) cfg.method = HTTP_METHOD_PUT;

  esp_http_client_handle_t client = esp_http_client_init(&cfg);
  if (client == NULL) {
    fail_out(out, "could not open an HTTP client");
    return NULL;
  }

  if (authenticate) {
    const esp_err_t err = roll_state_apply_credential_to(attach_bearer, client);
    if (err != ESP_OK) {
      esp_http_client_cleanup(client);
      /* 401 rather than 0, so rq_classify_status() halts the queue instead of
       * retrying forever: no credential and a dead credential need the same
       * action from the user, and neither is transient. */
      out->status = 401;
      out->body_len = 0;
      rq_redact(out->detail, sizeof out->detail, "no device credential stored");
      return NULL;
    }
  }
  return client;
}

/**
 * True when `host` (with an optional `:port`) is four dotted decimal numbers
 * rather than a name. Used to keep a bare-IP bench base from claiming the
 * resolver works.
 */
static bool dotted_quad(const char *host) {
  int groups = 0;
  const char *p = host;
  while (*p >= '0' && *p <= '9') {
    while (*p >= '0' && *p <= '9') p++;
    groups++;
    if (*p != '.') break;
    p++;
  }
  return groups == 4 && (*p == '\0' || *p == ':');
}

/** Read the body into `req->response`, then record what happened. */
static void finish(esp_http_client_handle_t client, const roll_http_req_t *req,
                   roll_http_out_t *out) {
  const int status = esp_http_client_get_status_code(client);
  int read = 0;
  if (req->response != NULL && req->response_cap > 1) {
    read = esp_http_client_read_response(client, req->response, (int)req->response_cap - 1);
    if (read < 0) read = 0;
    req->response[read] = '\0';
  }
  out->status = status;
  out->body_len = (size_t)read;
  net_hosted_count_bytes((uint64_t)read, 0);

  /*
   * Two rows earn themselves on any completed exchange, whatever the caller
   * wanted from it.
   *
   * DNS: the request reached a server, so the host NAME resolved — but only if
   * the base carried a name. A base of `http://192.168.1.5:3000`, which is
   * what a LAN bench is pointed at, uses no resolver at all, and marking
   * C6_DNS on one records DNS as working on the one bench run that never
   * exercised it. The resolved address is not kept anywhere by the time we get
   * here, so the rule is fed the fact that a connection was made.
   *
   * TLS: the base URL is compiled in, and esp_http_client was handed
   * esp_crt_bundle_attach with no way to switch verification off. So an
   * https base plus a real response is a certificate-verified exchange. It is
   * checked against the scheme rather than the status alone, because a 200
   * over plain http proves nothing about certificates.
   */
  char base[PURE_API_BASE_MAX + 1];
  const bool have_base = roll_http_api_base(base, sizeof base);
  const bool over_tls = have_base && strncmp(base, "https://", 8) == 0;
  const char *host = base;
  if (over_tls) {
    host += 8;
  } else if (have_base && strncmp(base, "http://", 7) == 0) {
    host += 7;
  }
  if (have_base && !dotted_quad(host) && hwv_rule_dns(true, 1u)) {
    hwv_mark_validated(HWV_C6_DNS, "API host name resolved");
  }
  if (hwv_rule_tls(over_tls, status)) {
    hwv_mark_validated(HWV_C6_TLS, "certificate-verified HTTPS response");
  }

  if (status >= 400) {
    /*
     * The API's own `{code, message}` is the most useful thing a user can be
     * shown, and it is also the most likely place a URL with a token in it
     * would be echoed back — so it goes through rq_redact() like everything
     * else. Truncated to the error field rather than kept whole.
     *
     * Then sanitised, and in that order. The body is bytes off a socket: a
     * server that answers a 502 with a gzip page, or a proxy that answers with
     * nothing useful at all, puts control bytes in here. They travel into the
     * job's last_error, upload_store.c writes that through cJSON, and cJSON
     * escapes each one as six characters — 95 of them is 570 bytes of a record
     * bounded at 768, so the record then exceeds the bound and
     * upload_store_decode() refuses it for the rest of its life. Sanitising
     * last, after redaction, also means a multi-byte sequence that redaction's
     * own truncation cut in half does not survive either.
     */
    char text[RQ_ERROR_LEN];
    snprintf(text, sizeof text, "%s %s -> %d %s", req->method, req->path, status,
             req->response != NULL ? req->response : "");
    char safe[RQ_ERROR_LEN];
    rq_redact(safe, sizeof safe, text);
    rq_sanitise_detail(out->detail, sizeof out->detail, safe);
  }
}

void roll_http_perform(const roll_http_req_t *req, roll_http_out_t *out) {
  memset(out, 0, sizeof *out);

  char why[RQ_ERROR_LEN];
  if (!roll_http_ready(why, sizeof why)) {
    fail_out(out, why);
    return;
  }

  esp_http_client_handle_t client =
      open_client(req->method, req->path, req->authenticate, out);
  if (client == NULL) return;

  const size_t body_len = req->json_body != NULL ? strlen(req->json_body) : 0;
  if (body_len > 0) esp_http_client_set_header(client, "Content-Type", "application/json");

  /*
   * open / write / fetch_headers, not esp_http_client_perform().
   *
   * perform() reads the whole response itself and, with no event handler
   * registered to receive it, discards the body; a read_response() after it
   * returns nothing. Measured on KD4-D121BC against the local API: every reply
   * arrived with body_len 0, so a 200 carrying {deviceId, deviceToken} was
   * parsed as an empty document and reported as "the register reply had no
   * credential". The upload path (roll_http_put_file) already used this
   * sequence, which is why it was the only one that could have worked.
   */
  char text[RQ_ERROR_LEN];
  esp_err_t err = esp_http_client_open(client, (int)body_len);
  if (err != ESP_OK) {
    snprintf(text, sizeof text, "%s %s: open %s", req->method, req->path, esp_err_to_name(err));
    fail_out(out, text);
    esp_http_client_cleanup(client);
    return;
  }
  if (body_len > 0) {
    const int wrote = esp_http_client_write(client, req->json_body, (int)body_len);
    if (wrote != (int)body_len) {
      snprintf(text, sizeof text, "%s %s: short write %d/%u", req->method, req->path, wrote,
               (unsigned)body_len);
      fail_out(out, text);
      esp_http_client_close(client);
      esp_http_client_cleanup(client);
      return;
    }
  }
  if (esp_http_client_fetch_headers(client) < 0) {
    snprintf(text, sizeof text, "%s %s: no response headers", req->method, req->path);
    fail_out(out, text);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return;
  }
  net_hosted_count_bytes(0, (uint64_t)body_len);
  finish(client, req, out);
  esp_http_client_close(client);
  esp_http_client_cleanup(client);
}

/* ------------------------------------------------------------------ */
/* The card                                                           */
/* ------------------------------------------------------------------ */

size_t roll_http_file_size(const char *file_path) { return roll_http_file_size_ex(file_path, NULL); }

size_t roll_http_file_size_ex(const char *file_path, bool *card_busy) {
  if (card_busy != NULL) *card_busy = false;
  if (!storage_acquire(STORAGE_USER_UPLOAD, CARD_WAIT_MS)) {
    if (card_busy != NULL) *card_busy = true;
    return 0;
  }
  size_t bytes = 0;
  FILE *f = fopen(file_path, "rb");
  if (f != NULL) {
    if (fseek(f, 0, SEEK_END) == 0) {
      const long end = ftell(f);
      if (end > 0) bytes = (size_t)end;
    }
    fclose(f);
  }
  storage_release(STORAGE_USER_UPLOAD);
  return bytes;
}

bool roll_http_sha256_file(const char *file_path, size_t offset, size_t len, char *hex,
                           size_t cap) {
  return roll_http_sha256_file_ex(file_path, offset, len, hex, cap, NULL);
}

bool roll_http_sha256_file_ex(const char *file_path, size_t offset, size_t len, char *hex,
                              size_t cap, bool *card_busy) {
  if (card_busy != NULL) *card_busy = false;
  if (cap < 65) return false;
  if (!storage_acquire(STORAGE_USER_UPLOAD, CARD_WAIT_MS)) {
    if (card_busy != NULL) *card_busy = true;
    return false;
  }

  bool ok = false;
  uint8_t *buf = malloc(CHUNK_BYTES);
  FILE *f = buf != NULL ? fopen(file_path, "rb") : NULL;
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);

  if (f != NULL && fseek(f, (long)offset, SEEK_SET) == 0 &&
      mbedtls_sha256_starts(&ctx, 0) == 0) {
    size_t left = len;
    ok = true;
    while (left > 0) {
      /* Yielding mid-hash costs the whole hash, which is why the check is
       * here rather than only in the PUT: a capture must not wait for a
       * megabyte to be hashed, and re-hashing later is cheap. */
      if (storage_yield_requested(STORAGE_USER_UPLOAD)) {
        ok = false;
        if (card_busy != NULL) *card_busy = true;
        break;
      }
      const size_t want = left < CHUNK_BYTES ? left : CHUNK_BYTES;
      const size_t got = fread(buf, 1, want, f);
      if (got == 0 || mbedtls_sha256_update(&ctx, buf, got) != 0) {
        ok = false;
        break;
      }
      left -= got;
    }
  }

  uint8_t digest[32];
  if (ok && mbedtls_sha256_finish(&ctx, digest) == 0) {
    for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", digest[i]);
    hex[64] = '\0';
  } else {
    ok = false;
  }

  mbedtls_sha256_free(&ctx);
  if (f != NULL) fclose(f);
  free(buf);
  storage_release(STORAGE_USER_UPLOAD);
  return ok;
}

void roll_http_put_file(const char *path, const char *file_path, size_t offset, size_t len,
                        roll_http_out_t *out) {
  memset(out, 0, sizeof *out);

  char why[RQ_ERROR_LEN];
  if (!roll_http_ready(why, sizeof why)) {
    fail_out(out, why);
    return;
  }

  uint8_t *buf = malloc(CHUNK_BYTES);
  if (buf == NULL) {
    fail_out(out, "no memory for an upload buffer");
    return;
  }

  const roll_http_req_t req = {.method = "PUT", .path = path, .authenticate = true};
  esp_http_client_handle_t client = open_client("PUT", path, true, out);
  if (client == NULL) {
    free(buf);
    return;
  }
  esp_http_client_set_header(client, "Content-Type", "application/octet-stream");

  if (esp_http_client_open(client, (int)len) != ESP_OK) {
    fail_out(out, "could not open the part upload");
    esp_http_client_cleanup(client);
    free(buf);
    return;
  }

  bool ok = storage_acquire(STORAGE_USER_UPLOAD, CARD_WAIT_MS);
  FILE *f = ok ? fopen(file_path, "rb") : NULL;
  if (f == NULL || fseek(f, (long)offset, SEEK_SET) != 0) {
    if (f != NULL) fclose(f);
    if (ok) storage_release(STORAGE_USER_UPLOAD);
    fail_out(out, ok ? "the capture file would not open" : "card busy");
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    free(buf);
    return;
  }

  size_t left = len;
  size_t sent = 0;
  const char *stopped = NULL;
  while (left > 0) {
    /* Photography wins, immediately. Abandoning a part costs nothing: the
     * contract's part PUT is idempotent and the asset init replays. */
    if (storage_yield_requested(STORAGE_USER_UPLOAD)) {
      stopped = "yielded the card to a capture";
      break;
    }
    const size_t want = left < CHUNK_BYTES ? left : CHUNK_BYTES;
    const size_t got = fread(buf, 1, want, f);
    if (got == 0) {
      stopped = "the capture file is shorter than its record";
      break;
    }
    const int wrote = esp_http_client_write(client, (const char *)buf, (int)got);
    if (wrote < 0 || (size_t)wrote != got) {
      stopped = "the connection dropped mid-part";
      break;
    }
    sent += got;
    left -= got;
  }
  fclose(f);
  storage_release(STORAGE_USER_UPLOAD);
  net_hosted_count_bytes(0, (uint64_t)sent);

  if (stopped != NULL) {
    fail_out(out, stopped);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    free(buf);
    return;
  }

  if (esp_http_client_fetch_headers(client) < 0) {
    fail_out(out, "no response to the part upload");
  } else {
    finish(client, &req, out);
  }
  esp_http_client_close(client);
  esp_http_client_cleanup(client);
  free(buf);
  ESP_LOGI(TAG, "part %s: %u bytes -> %d", path, (unsigned)sent, out->status);
}

#endif /* KINO_RADIO */
