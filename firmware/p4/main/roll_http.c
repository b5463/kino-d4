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

#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "mbedtls/sha256.h"
#include "net_hosted.h"
#include "net_link.h"
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

bool roll_http_ready(char *why, size_t cap) {
  if (KINO_ROLL_API_BASE[0] == '\0') {
    snprintf(why, cap, "no Roll API base URL in this build");
    return false;
  }

  net_status_t st;
  net_link_status(&st, esp_timer_get_time() / 1000);
  if (!net_link_can_upload(&st)) {
    snprintf(why, cap, "no address: %s", net_state_name(st.state));
    return false;
  }

  /* Third and separate, because "the network is up but the camera does not
   * know what year it is" is a different problem from both of the above and
   * the fix is different too. */
  if (st.reason == NET_REASON_CLOCK_UNTRUSTED) {
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
  char url[256];
  const int n = snprintf(url, sizeof url, "%s%s", KINO_ROLL_API_BASE, path);
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

  if (status >= 400) {
    /* The API's own `{code, message}` is the most useful thing a user can be
     * shown, and it is also the most likely place a URL with a token in it
     * would be echoed back — so it goes through rq_redact() like everything
     * else. Truncated to the error field rather than kept whole. */
    char text[RQ_ERROR_LEN];
    snprintf(text, sizeof text, "%s %s -> %d %s", req->method, req->path, status,
             req->response != NULL ? req->response : "");
    rq_redact(out->detail, sizeof out->detail, text);
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
  if (body_len > 0) {
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, req->json_body, (int)body_len);
  }

  const esp_err_t err = esp_http_client_perform(client);
  if (err != ESP_OK) {
    char text[RQ_ERROR_LEN];
    snprintf(text, sizeof text, "%s %s: %s", req->method, req->path, esp_err_to_name(err));
    fail_out(out, text);
    esp_http_client_cleanup(client);
    return;
  }
  net_hosted_count_bytes(0, (uint64_t)body_len);
  finish(client, req, out);
  esp_http_client_cleanup(client);
}

/* ------------------------------------------------------------------ */
/* The card                                                           */
/* ------------------------------------------------------------------ */

size_t roll_http_file_size(const char *file_path) {
  if (!storage_acquire(STORAGE_USER_UPLOAD, CARD_WAIT_MS)) return 0;
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
  if (cap < 65) return false;
  if (!storage_acquire(STORAGE_USER_UPLOAD, CARD_WAIT_MS)) return false;

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
