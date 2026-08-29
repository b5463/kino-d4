/*
 * The NETWORK_* / ROLL_* / UPLOAD_* KDP replies. See kdp_net.h for which of
 * these answer for real today and which refuse, and why ROLL_JOIN works with
 * no radio.
 *
 * Field names here are normative from apps/studio/src/roll/rollTypes.ts. That
 * file is the only contract this command group has — its shapes were never
 * frozen into @kino/kdp — so a rename there and a rename here have to happen
 * together, and the host tests in test_kdp_net.c are what notice if they do
 * not.
 */
#include "kdp_net.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "clock.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "klog.h"
#include "net_link.h"
#include "pure.h"
#include "roll_api.h"
#include "roll_queue.h"
#include "roll_state.h"
#include "storage.h"
#include "upload_queue.h"
#include "wifi_creds.h"

/* The mask NETWORK_LIST reports in place of a stored passphrase. Must match
 * MASKED_PASSWORD in apps/studio/src/roll/rollTypes.ts exactly — Studio
 * compares against it to decide whether the field it holds is a real
 * passphrase or a placeholder it must not send back. Four U+2022 bullets. */
#define MASKED_PASSWORD "\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2"

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

/* ------------------------------------------------------------------ */
/* Reply helpers                                                      */
/* ------------------------------------------------------------------ */

static kdp_net_reply_t ok_reply(cJSON *json) {
  kdp_net_reply_t r;
  memset(&r, 0, sizeof r);
  if (json == NULL) {
    /* Out of memory building a reply. Say so rather than sending an empty
     * object that reads as a successful answer with no content. */
    r.ok = false;
    r.code = "INTERNAL_ERROR";
    snprintf(r.message, sizeof r.message, "Could not build the reply");
    return r;
  }
  r.ok = true;
  r.json = json;
  return r;
}

static kdp_net_reply_t err_reply(const char *code, const char *fmt, ...) {
  kdp_net_reply_t r;
  memset(&r, 0, sizeof r);
  r.ok = false;
  r.code = code;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(r.message, sizeof r.message, fmt, ap);
  va_end(ap);
  return r;
}

/**
 * The refusal for anything that needs the radio.
 *
 * Carries the reason from net_link rather than a generic "no network", so
 * Studio and the logs can tell "no route to the C6" from "wrong passphrase"
 * from "DHCP timed out". A refusal that does not say which of those it is
 * costs a bench cycle to diagnose.
 */
static kdp_net_reply_t no_network(const char *what) {
  /* roll_api answers first when it has something more specific to say. Once
   * the radio is up, "radio routed, IP_READY, NONE" is a useless refusal — the
   * obstacle is then the clock, or the missing API base URL, and those are the
   * two a bench operator can actually act on. */
  char why[RQ_ERROR_LEN];
  if (!roll_api_ready(why, sizeof why)) {
    return err_reply("NETWORK_UNAVAILABLE", "%s needs the network: %s", what, why);
  }

  net_status_t net;
  net_link_status(&net, now_ms());
  return err_reply("NETWORK_UNAVAILABLE", "%s needs the network: radio %s, %s (%s)", what,
                   net.radio_routed ? "routed" : "NOT routed", net_state_name(net.state),
                   net_reason_name(net.reason));
}


/* Read a trimmed string field, or NULL. */
static const char *str_field(const cJSON *req, const char *key) {
  const cJSON *v = cJSON_GetObjectItem(req, key);
  return (cJSON_IsString(v) && v->valuestring != NULL) ? v->valuestring : NULL;
}

/* ------------------------------------------------------------------ */
/* Shared sub-objects                                                 */
/* ------------------------------------------------------------------ */

/* `{networks: [...]}` — the payload NETWORK_LIST returns and NETWORK_SET and
 * NETWORK_DELETE echo, so a host never has to re-read after a write. */
static cJSON *networks_array(void) {
  cJSON *arr = cJSON_CreateArray();
  if (arr == NULL) return NULL;

  wifi_cred_view_t views[WIFI_CREDS_MAX];
  const size_t n = wifi_creds_list(views, WIFI_CREDS_MAX);

  for (size_t i = 0; i < n; i++) {
    cJSON *o = cJSON_CreateObject();
    if (o == NULL) break;
    cJSON_AddStringToObject(o, "ssid", views[i].ssid);
    /* Never the passphrase. `hasPassword` is the only way a host learns one
     * is stored, and the mask is what it must send back unchanged when it
     * edits something else about the network. */
    cJSON_AddStringToObject(o, "password", views[i].has_password ? MASKED_PASSWORD : "");
    cJSON_AddBoolToObject(o, "hasPassword", views[i].has_password);
    cJSON_AddStringToObject(o, "security", net_security_name(views[i].security));
    cJSON_AddBoolToObject(o, "autoJoin", views[i].auto_join);
    if (views[i].last_connected_ms > 0) {
      cJSON_AddNumberToObject(o, "lastSeen", (double)views[i].last_connected_ms);
    } else {
      /* null, not 0. 1970 is not a time this camera has ever been. */
      cJSON_AddNullToObject(o, "lastSeen");
    }
    cJSON_AddItemToArray(arr, o);
  }
  return arr;
}

/* `UploadQueueReport`. Real counts from the durable queue. */
static cJSON *queue_object(void) {
  upload_queue_report_t q;
  upload_queue_status(&q);

  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return NULL;
  cJSON_AddNumberToObject(o, "pending", q.pending);
  cJSON_AddNumberToObject(o, "uploading", q.uploading);
  cJSON_AddNumberToObject(o, "failed", q.failed);
  cJSON_AddNumberToObject(o, "uploaded", q.uploaded);
  cJSON_AddBoolToObject(o, "draining", q.draining);
  /* Beyond the Studio interface, and deliberately: `halted` is not `failed`.
   * The jobs are fine and the device's credentials are not, and a user who
   * cannot tell those apart retries the wrong thing. */
  cJSON_AddBoolToObject(o, "halted", q.halted);
  if (q.last_error[0] != '\0') {
    /* Already redacted by the queue. Passing it through rq_redact() again is
     * cheap and means this file does not have to trust that. */
    char safe[RQ_ERROR_LEN];
    cJSON_AddStringToObject(o, "lastError", rq_redact(safe, sizeof safe, q.last_error));
  } else {
    cJSON_AddNullToObject(o, "lastError");
  }
  return o;
}

/* `RollView` — `{active, roll, queue}` plus the two fields the reference
 * device adds (`serverReachable`, `tokenStatus`). */
static cJSON *roll_view(void) {
  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return NULL;

  roll_state_t roll;
  const bool active = roll_state_get(&roll);
  cJSON_AddBoolToObject(o, "active", active);

  if (!active) {
    /* null rather than omitted — `RollView.roll` is documented as null when
     * the camera is not on a Roll, and an absent key would read as an older
     * firmware rather than an empty state. */
    cJSON_AddNullToObject(o, "roll");
  } else {
    cJSON *r = cJSON_CreateObject();
    if (r != NULL) {
      cJSON_AddStringToObject(r, "rollId", roll.roll_id);
      cJSON_AddStringToObject(r, "slug", roll.slug);
      cJSON_AddStringToObject(r, "guestUrl", roll.guest_url);
      cJSON_AddStringToObject(r, "name", roll.name);
      cJSON_AddStringToObject(r, "role", roll_role_name(roll.role));
      cJSON_AddNumberToObject(r, "joinedAt", (double)roll.joined_at_ms);
      cJSON_AddItemToObject(o, "roll", r);
    }
  }

  cJSON_AddItemToObject(o, "queue", queue_object());

  /* The camera cannot reach the server, so it must not claim the server is
   * reachable. This is a fact about the radio, not about the server. */
  net_status_t net;
  net_link_status(&net, now_ms());
  cJSON_AddBoolToObject(o, "serverReachable", net_link_can_upload(&net));

  /* `ok` | `token-expired`. A token the camera has never obtained is not
   * expired — the honest third value is that there is none, and reporting
   * `token-expired` for it would send someone to re-authenticate something
   * that was never authenticated. */
  cJSON_AddStringToObject(o, "tokenStatus",
                          roll_state_has_credential() ? "ok" : "no-credential");
  return o;
}

/* ------------------------------------------------------------------ */
/* NETWORK_*                                                          */
/* ------------------------------------------------------------------ */

/* An active scan on the C6 takes a second or two per the esp_wifi defaults.
 * Six seconds is far past any real scan and well inside the host's 15 s
 * command timeout, so a radio that never reports back still gets an answer. */
#define SCAN_WAIT_MS 6000
#define SCAN_POLL_MS 50

static cJSON *available_array(void) {
  cJSON *arr = cJSON_CreateArray();
  if (arr == NULL) return NULL;
  /* Static, not on the stack: twenty entries are ~1.3 KB, and this runs on
   * the KDP server task, which has been measured with as little as 1.1 KB to
   * spare while building large replies. The first scan request on hardware
   * put this array on that stack and the P4 panicked. One scan at a time is
   * already guaranteed by the server task being the only caller. */
  static net_scan_entry_t found[NET_SCAN_MAX];
  const size_t n = net_link_scan_results(found, NET_SCAN_MAX);
  for (size_t i = 0; i < n; i++) {
    cJSON *o = cJSON_CreateObject();
    if (o == NULL) break;
    cJSON_AddStringToObject(o, "ssid", found[i].ssid);
    cJSON_AddStringToObject(o, "bssid", found[i].bssid);
    cJSON_AddNumberToObject(o, "rssi", found[i].rssi);
    cJSON_AddNumberToObject(o, "channel", found[i].channel);
    cJSON_AddStringToObject(o, "security", net_security_name(found[i].security));
    cJSON_AddBoolToObject(o, "hidden", found[i].hidden);
    cJSON_AddItemToArray(arr, o);
  }
  return arr;
}

kdp_net_reply_t kdp_net_list(const cJSON *req) {
  const cJSON *scan = req != NULL ? cJSON_GetObjectItem(req, "scan") : NULL;
  const bool want_scan = cJSON_IsTrue(scan);

  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return err_reply("INTERNAL_ERROR", "Could not build the reply");
  cJSON_AddItemToObject(o, "networks", networks_array());
  if (!want_scan) return ok_reply(o);

  /*
   * The scan is the first thing the radio does for a host, and nothing else on
   * this surface triggers one - the driver's scan_start had no caller at all
   * until the bench needed it. It runs inline: start, wait for the state to
   * leave SCANNING (handle_scan_done publishes and returns it to IDLE), then
   * read what was published. The wait is bounded and the reply says what
   * happened rather than timing out at the host.
   */
  const int64_t t0 = now_ms();
  if (!net_link_scan_start(t0)) {
    net_status_t st;
    net_link_status(&st, now_ms());
    cJSON_Delete(o);
    return no_network(st.detail[0] != '\0' ? st.detail : "the radio refused the scan");
  }
  net_status_t st;
  do {
    vTaskDelay(pdMS_TO_TICKS(SCAN_POLL_MS));
    net_link_status(&st, now_ms());
  } while (st.state == NET_WIFI_SCANNING && now_ms() - t0 < SCAN_WAIT_MS);

  cJSON_AddNumberToObject(o, "scanMs", (double)(now_ms() - t0));
  cJSON_AddBoolToObject(o, "scanComplete", st.state != NET_WIFI_SCANNING);
  cJSON *avail = available_array();
  if (avail != NULL) cJSON_AddItemToObject(o, "available", avail);
  return ok_reply(o);
}

kdp_net_reply_t kdp_net_set(const cJSON *req) {
  const char *ssid = str_field(req, "ssid");
  if (ssid == NULL || !pure_wifi_ssid_valid(ssid)) {
    return err_reply("INVALID_ARGUMENT", "SSID must be 1-%d characters, no control codes",
                     PURE_SSID_MAX);
  }

  const char *sec_name = str_field(req, "security");
  const net_security_t security = net_security_parse(sec_name);
  const char *passphrase = str_field(req, "password");

  /* The keep-what-is-stored case. NETWORK_LIST only ever handed the host a
   * mask, so an edit that changes autoJoin has nothing to put in `password`.
   * A host that echoes the mask back is doing the same thing, and must not
   * have the mask stored as a passphrase. */
  const bool masked = passphrase != NULL && strcmp(passphrase, MASKED_PASSWORD) == 0;
  if (masked) passphrase = NULL;

  const bool keeps_stored = wifi_creds_has_password(ssid);
  if (!pure_wifi_passphrase_ok(passphrase, security == NET_SEC_OPEN, keeps_stored)) {
    if (security == NET_SEC_OPEN) {
      return err_reply("INVALID_ARGUMENT", "An open network takes no passphrase");
    }
    return err_reply("INVALID_ARGUMENT", "WPA passphrase must be %d-%d characters",
                     PURE_WPA_PASSPHRASE_MIN, PURE_WPA_PASSPHRASE_MAX);
  }

  const cJSON *jauto = cJSON_GetObjectItem(req, "autoJoin");
  const bool auto_join = cJSON_IsBool(jauto) ? cJSON_IsTrue(jauto) : true;

  const esp_err_t err = wifi_creds_set(ssid, passphrase, security, auto_join);
  if (err == ESP_ERR_NO_MEM) {
    return err_reply("STORAGE_ERROR", "The camera remembers at most %d networks",
                     WIFI_CREDS_MAX);
  }
  if (err != ESP_OK) return err_reply("STORAGE_ERROR", "Could not store the network");

  /* Deliberately no passphrase and no length in the log line. A length is
   * not nothing. */
  klog("P4", "wifi network saved: %s", ssid);

  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return err_reply("INTERNAL_ERROR", "Could not build the reply");
  cJSON_AddBoolToObject(o, "ok", true);
  cJSON_AddItemToObject(o, "networks", networks_array());
  return ok_reply(o);
}

kdp_net_reply_t kdp_net_delete(const cJSON *req) {
  const char *ssid = str_field(req, "ssid");
  if (ssid == NULL) return err_reply("INVALID_ARGUMENT", "Expected {\"ssid\":\"...\"}");

  const esp_err_t err = wifi_creds_delete(ssid);
  if (err == ESP_ERR_NOT_FOUND) {
    /* Say so rather than reporting a success that removed nothing — a host
     * that believes it forgot a network the camera will still auto-join has
     * been told something false. */
    return err_reply("INVALID_ARGUMENT", "No saved network %s", ssid);
  }
  if (err != ESP_OK) return err_reply("STORAGE_ERROR", "Could not remove the network");

  klog("P4", "wifi network removed: %s", ssid);

  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return err_reply("INTERNAL_ERROR", "Could not build the reply");
  cJSON_AddBoolToObject(o, "ok", true);
  cJSON_AddItemToObject(o, "networks", networks_array());
  return ok_reply(o);
}

/*
 * The end-to-end probe: DNS, then a certificate-verified HTTPS exchange with
 * the real API, without touching Roll registration.
 *
 * GET /api/healthz, unauthenticated, through roll_http_perform() - the same
 * client, bundle and clock rule every Roll request will use, so a pass here is
 * the transport Roll will inherit and a failure here is one Roll would have
 * met on its first call. The DNS lookup is done separately first so its time
 * and address family are known; the client then resolves again on its own,
 * which costs a few milliseconds and keeps the two measurements independent.
 */
#if KINO_RADIO
#include "lwip/netdb.h"
#include "roll_http.h"

#ifndef KINO_ROLL_API_BASE
#define KINO_ROLL_API_BASE ""
#endif

/* Host name out of "https://host[:port]", into `out`, from the base in effect. */
static bool api_host(char *base, size_t base_cap, char *out, size_t cap) {
  if (!roll_http_api_base(base, base_cap)) return false;
  const char *s = base;
  const char *p = strstr(s, "://");
  s = p != NULL ? p + 3 : s;
  size_t n = 0;
  while (s[n] != '\0' && s[n] != '/' && s[n] != ':' && n + 1 < cap) n++;
  if (n == 0) return false;
  memcpy(out, s, n);
  out[n] = '\0';
  return true;
}

static cJSON *probe_object(void) {
  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return NULL;
  char base[PURE_API_BASE_MAX + 1];
  char host[80];
  if (!api_host(base, sizeof base, host, sizeof host)) {
    cJSON_AddStringToObject(o, "detail", "no API base URL in this build or its config");
    return o;
  }
  cJSON_AddStringToObject(o, "base", base);
  cJSON_AddStringToObject(o, "host", host);

  char why[RQ_ERROR_LEN];
  if (!roll_http_ready(why, sizeof why)) {
    cJSON_AddStringToObject(o, "detail", why);
    return o;
  }

  /* DNS, timed and reported on its own. */
  const int64_t t0 = now_ms();
  struct addrinfo hints = {.ai_socktype = SOCK_STREAM};
  struct addrinfo *res = NULL;
  const char *colon = strchr(host, ':'); /* api_host strips the port; default by scheme */
  (void)colon;
  const int rc = getaddrinfo(host, strncmp(base, "https://", 8) == 0 ? "443" : "80", &hints, &res);
  const int64_t t_dns = now_ms() - t0;
  cJSON_AddNumberToObject(o, "dnsMs", (double)t_dns);
  if (rc != 0 || res == NULL) {
    cJSON_AddBoolToObject(o, "dnsOk", false);
    cJSON_AddNumberToObject(o, "dnsRc", rc);
    if (res != NULL) freeaddrinfo(res);
    return o;
  }
  cJSON_AddBoolToObject(o, "dnsOk", true);
  cJSON_AddStringToObject(o, "family", res->ai_family == AF_INET6 ? "inet6" : "inet");
  freeaddrinfo(res);

  /* Connect + TLS + request + response, through the Roll client. */
  static char body[192];
  const roll_http_req_t req = {.method = "GET",
                               .path = "/api/healthz",
                               .json_body = NULL,
                               .authenticate = false,
                               .response = body,
                               .response_cap = sizeof body};
  roll_http_out_t out;
  const int64_t t1 = now_ms();
  roll_http_perform(&req, &out);
  const int64_t t_http = now_ms() - t1;
  cJSON_AddNumberToObject(o, "httpMs", (double)t_http);
  cJSON_AddNumberToObject(o, "httpStatus", out.status);
  cJSON_AddNumberToObject(o, "totalMs", (double)(now_ms() - t0));
  cJSON_AddBoolToObject(o, "tls", strncmp(base, "https://", 8) == 0);
  if (out.detail[0] != '\0') cJSON_AddStringToObject(o, "detail", out.detail);
  if (out.status >= 200 && out.status < 300 && out.body_len > 0) {
    /* The health document is small and public; keep the reply bounded. */
    body[sizeof body - 1] = '\0';
    cJSON_AddStringToObject(o, "body", body);
  }
  return o;
}
#endif /* KINO_RADIO */

kdp_net_reply_t kdp_net_status(const cJSON *req) {
  net_status_t net;
  net_link_status(&net, now_ms());

  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return err_reply("INTERNAL_ERROR", "Could not build the reply");

  /* The three-value field Studio's NetworkStatus already reads. Only
   * IP_READY is `connected`; association without an address is `connecting`,
   * because a camera that says connected while DNS would fail has lied to
   * both the user and its own upload queue. */
  cJSON_AddStringToObject(o, "state", net_wire_state(net.state));
  if (net.ssid[0] != '\0') {
    cJSON_AddStringToObject(o, "ssid", net.ssid);
  } else {
    cJSON_AddNullToObject(o, "ssid");
  }
  if (net.ip[0] != '\0') {
    cJSON_AddStringToObject(o, "ip", net.ip);
  } else {
    cJSON_AddNullToObject(o, "ip");
  }
  /* null, not 0. 0 dBm is a real and excellent signal level, so reporting it
   * for "unknown" would show a full-strength bar with no radio. */
  if (net.rssi != 0) {
    cJSON_AddNumberToObject(o, "rssi", net.rssi);
  } else {
    cJSON_AddNullToObject(o, "rssi");
  }
  if (net.since_ms > 0) {
    cJSON_AddNumberToObject(o, "since", (double)net.since_ms);
  } else {
    cJSON_AddNullToObject(o, "since");
  }
  /* `internet` means a request would actually reach the API. Association is
   * not that. */
  cJSON_AddBoolToObject(o, "internet", net_link_can_upload(&net));

  /* Beyond the Studio interface. Extra keys are safe — the group's consumers
   * read known fields — and these are what make the difference between "no
   * radio" and "radio fitted, no route to it" visible instead of collapsed
   * into `disconnected`. This is the whole point of the D4 V1 UI fix. */
  cJSON_AddBoolToObject(o, "radioFitted", net.radio_fitted);
  cJSON_AddBoolToObject(o, "radioRouted", net.radio_routed);
  cJSON_AddStringToObject(o, "radioState", net_state_name(net.state));
  cJSON_AddStringToObject(o, "reason", net_reason_name(net.reason));
  if (net.channel != 0) {
    cJSON_AddNumberToObject(o, "channel", net.channel);
  } else {
    cJSON_AddNullToObject(o, "channel");
  }
  if (net.c6_version[0] != '\0') {
    cJSON_AddStringToObject(o, "c6Firmware", net.c6_version);
  } else {
    /* null rather than "unknown": nothing has ever answered a handshake, so
     * there is no version to be unsure about. */
    cJSON_AddNullToObject(o, "c6Firmware");
  }
  cJSON_AddNumberToObject(o, "transportErrors", net.transport_errors);
  cJSON_AddNumberToObject(o, "reconnects", net.reconnects);
  cJSON_AddNumberToObject(o, "savedNetworks", (double)wifi_creds_count());
  if (net.detail[0] != '\0') {
    char safe[NET_DETAIL_LEN];
    cJSON_AddStringToObject(o, "detail", rq_redact(safe, sizeof safe, net.detail));
  } else {
    cJSON_AddNullToObject(o, "detail");
  }
#if KINO_RADIO
  if (cJSON_IsTrue(req != NULL ? cJSON_GetObjectItem(req, "probe") : NULL)) {
    cJSON *probe = probe_object();
    if (probe != NULL) cJSON_AddItemToObject(o, "probe", probe);
  }
#else
  (void)req;
#endif
  return ok_reply(o);
}

/* ------------------------------------------------------------------ */
/* ROLL_*                                                             */
/* ------------------------------------------------------------------ */

kdp_net_reply_t kdp_net_roll_status(void) {
  cJSON *o = roll_view();
  return ok_reply(o);
}

/**
 * Store what the server said and answer with the resulting RollView.
 *
 * Shared by ROLL_CREATE and the slug-only ROLL_JOIN because the two differ
 * only in which endpoint produced the assignment and which role it gives this
 * camera. Validation is roll_state_assign()'s, deliberately: a server reply
 * gets exactly the same shape checks as one Studio hands over, so a malformed
 * guestUrl cannot reach the QR code by arriving over the radio instead.
 */
static kdp_net_reply_t adopt_assoc(const roll_api_assoc_t *assoc, roll_role_t role) {
  const esp_err_t err = roll_state_assign(assoc->roll_id, assoc->slug, assoc->guest_url,
                                          assoc->name, role, clock_now_ms());
  if (err == ESP_ERR_INVALID_ARG) {
    return err_reply("INVALID_ARGUMENT", "The roll the server returned is not usable");
  }
  if (err != ESP_OK) return err_reply("STORAGE_ERROR", "Could not store the roll");

  klog("P4", "roll %s: %s", role == ROLL_ROLE_HOST ? "created" : "joined", assoc->slug);
  return ok_reply(roll_view());
}

/** Turn a failed API call into the reply a host can act on. The HTTP status is
 * what distinguishes "wrong code" from "server down", and inventing one code
 * for both is how a guest at a party retypes a correct slug ten times. */
static kdp_net_reply_t assoc_failed(const roll_api_assoc_t *assoc, const char *what) {
  if (assoc->status == 0) return no_network(what);
  if (assoc->status == 401 || assoc->status == 403) {
    return err_reply("UNAUTHORIZED", "The camera's device credential was refused (%d)",
                     assoc->status);
  }
  if (assoc->status == 404) return err_reply("NOT_FOUND", "No such roll");
  if (assoc->status == 429) {
    /* The API locks joining after ten wrong slugs. Saying so beats a generic
     * failure that invites the eleventh. */
    return err_reply("RATE_LIMITED", "Too many attempts; joining is locked for a while");
  }
  return err_reply("SERVER_ERROR", "%s failed: %d %s", what, assoc->status, assoc->detail);
}

kdp_net_reply_t kdp_net_roll_create(const cJSON *req) {
  if (roll_state_active()) {
    roll_state_t roll;
    roll_state_get(&roll);
    return err_reply("INVALID_STATE", "Already on roll %s", roll.slug);
  }

  char why[RQ_ERROR_LEN];
  if (!roll_api_ready(why, sizeof why)) {
    /* No route to `POST /api/device/rolls`. Refusing with the actual obstacle
     * is the honest answer; inventing a rollId the server has never heard of
     * would produce a QR code that sends a guest at a party to a 404. */
    return no_network("ROLL_CREATE");
  }

  const char *title = str_field(req, "title");
  if (title == NULL) title = str_field(req, "name");

  /* Blocks the KDP task for as long as the API takes. Accepted: this is a
   * deliberate user action with a spinner in front of it, and the alternative
   * is a job model for one call. The capture path is untouched — it never
   * waits on the KDP task. */
  roll_api_assoc_t assoc;
  if (!roll_api_create(title, &assoc)) return assoc_failed(&assoc, "ROLL_CREATE");
  return adopt_assoc(&assoc, ROLL_ROLE_HOST);
}

kdp_net_reply_t kdp_net_roll_join(const cJSON *req) {
  if (roll_state_active()) {
    roll_state_t roll;
    roll_state_get(&roll);
    return err_reply("INVALID_STATE", "Already on roll %s", roll.slug);
  }

  /* Two forms, and the difference is whether the camera has to resolve
   * anything itself.
   *
   * A published assignment carries rollId, guestUrl and role already
   * resolved: Studio has internet, so it asked the API and is handing the
   * camera the answer. That needs no radio and is the path that works today.
   *
   * A bare {slug} requires POST /api/device/rolls/join to turn a slug into a
   * rollId and a guestUrl. The camera cannot do that, and must not guess. */
  const char *slug = str_field(req, "slug");
  if (slug == NULL) slug = str_field(req, "code"); /* `code` is an accepted alias */
  const char *roll_id = str_field(req, "rollId");
  const char *guest_url = str_field(req, "guestUrl");

  if (slug == NULL) {
    return err_reply("INVALID_ARGUMENT", "Expected {\"slug\":\"...\"}");
  }
  if (!roll_slug_valid(slug)) {
    return err_reply("INVALID_ARGUMENT", "Roll code must be a 6-character code or a slug");
  }

  if (roll_id == NULL || guest_url == NULL) {
    /* A bare {slug}: the camera has to resolve it itself through
     * `POST /api/device/rolls/join`, which is the call that turns a slug into a
     * rollId and a guestUrl. Studio hands the resolved form over when it has
     * internet; this is the path for when it does not. */
    char why[RQ_ERROR_LEN];
    if (!roll_api_ready(why, sizeof why)) return no_network("Resolving a roll code");

    roll_api_assoc_t assoc;
    if (!roll_api_join(slug, &assoc)) return assoc_failed(&assoc, "ROLL_JOIN");
    return adopt_assoc(&assoc, ROLL_ROLE_GUEST);
  }

  roll_role_t role = ROLL_ROLE_GUEST;
  const char *role_name = str_field(req, "role");
  if (role_name != NULL && !roll_role_parse(role_name, &role)) {
    return err_reply("INVALID_ARGUMENT", "role must be \"host\" or \"guest\"");
  }

  const char *name = str_field(req, "name");
  const esp_err_t err = roll_state_assign(roll_id, slug, guest_url, name == NULL ? "" : name,
                                          role, clock_now_ms());
  if (err == ESP_ERR_INVALID_ARG) {
    return err_reply("INVALID_ARGUMENT", "The roll assignment is not usable");
  }
  if (err != ESP_OK) return err_reply("STORAGE_ERROR", "Could not store the roll");

  klog("P4", "roll joined: %s", slug);
  return ok_reply(roll_view());
}

kdp_net_reply_t kdp_net_roll_leave(void) {
  const esp_err_t err = roll_state_leave();
  if (err == ESP_ERR_NOT_FOUND) {
    return err_reply("INVALID_STATE", "Not on a roll");
  }
  if (err != ESP_OK) return err_reply("STORAGE_ERROR", "Could not clear the roll");

  klog("P4", "roll left");

  cJSON *o = roll_view();
  if (o != NULL) cJSON_AddBoolToObject(o, "ok", true);
  return ok_reply(o);
}

/* ------------------------------------------------------------------ */
/* UPLOAD_*                                                           */
/* ------------------------------------------------------------------ */

kdp_net_reply_t kdp_net_upload_status(void) { return ok_reply(queue_object()); }

kdp_net_reply_t kdp_net_upload_retry(void) {
  const int retried = upload_queue_retry_all();
  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return err_reply("INTERNAL_ERROR", "Could not build the reply");
  cJSON_AddBoolToObject(o, "ok", true);
  cJSON_AddNumberToObject(o, "retried", retried);
  cJSON_AddItemToObject(o, "queue", queue_object());
  return ok_reply(o);
}

/* Count the frames a capture actually holds, and whether it has a thumbnail.
 * Read from the card rather than from META.JSON's `frameCount`: the queue must
 * upload what is there, and a document that disagrees with the directory is
 * exactly the case where fabricating a missing frame would happen. */
static int capture_frames_on_card(const char *uuid, bool *thumb_out) {
  char path[200];
  struct stat st;

  snprintf(path, sizeof path, "/sdcard/KINO/CAPTURES/%s/THUMB.JPG", uuid);
  *thumb_out = stat(path, &st) == 0 && st.st_size > 0;

  int frames = 0;
  for (int i = 1; i <= STORAGE_CAPTURE_FRAMES; i++) {
    snprintf(path, sizeof path, "/sdcard/KINO/CAPTURES/%s/C%d.JPG", uuid, i);
    if (stat(path, &st) == 0 && st.st_size > 0) frames++;
  }
  return frames;
}

kdp_net_reply_t kdp_net_upload_enqueue(const cJSON *req) {
  const char *id = str_field(req, "captureId");
  /* The gallery's capture id IS the folder name, which is the capture UUID.
   * Reject anything that is not that shape before it reaches a path: this
   * value is concatenated into a filesystem path. */
  if (id == NULL || !pure_is_capture_dirname(id)) {
    return err_reply("INVALID_ARGUMENT", "Expected {\"captureId\":\"<capture uuid>\"}");
  }

  if (!roll_state_active()) {
    /* The contract's own words: only meaningful while the device is on a
     * Roll, because there is nowhere else for the bytes to go. */
    return err_reply("INVALID_STATE", "Not on a roll — there is nowhere to upload to");
  }

  char meta[200];
  snprintf(meta, sizeof meta, "/sdcard/KINO/CAPTURES/%s/META.JSON", id);
  struct stat st;
  if (stat(meta, &st) != 0) {
    /* No META.JSON means the commit never finished, so this is not a capture
     * yet. storage.c's orphan sweep owns that folder, not the queue. */
    return err_reply("NOT_FOUND", "No committed capture %s", id);
  }

  bool thumb = false;
  const int frames = capture_frames_on_card(id, &thumb);

  const esp_err_t err = upload_queue_enqueue(id, frames, thumb);
  if (err != ESP_OK) return err_reply("STORAGE_ERROR", "Could not queue the capture");

  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return err_reply("INTERNAL_ERROR", "Could not build the reply");
  cJSON_AddBoolToObject(o, "ok", true);
  cJSON_AddStringToObject(o, "captureId", id);
  cJSON_AddItemToObject(o, "queue", queue_object());
  return ok_reply(o);
}
