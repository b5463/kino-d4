/*
 * The P4's view of the ESP32-C6 radio. See net_link.h for the state
 * vocabulary, why NOT ROUTED exists, and where the radio actually lives.
 *
 * Reaches only esp_err.h from ESP-IDF, so the host tests exercise this state
 * machine rather than a copy of it. Time is injected; there is no esp_timer
 * here. Same discipline as roll_queue.c.
 *
 * There is deliberately no esp_wifi call, no esp_hosted call and no #ifdef on
 * the radio build anywhere below. net_hosted.c registers a driver and reports
 * facts in; with nothing registered this module answers NOT ROUTED. That is
 * the whole of the build-time gate as far as this file is concerned.
 */
#include "net_link.h"

#include <string.h>

/* Whether the carrier has a C6 fitted. A fact about the board, not a
 * measurement: the chip is on the Guition module. Kept as a named constant so
 * the one place it is decided is visible, and so a future body without a
 * radio flips one line rather than every caller. */
#define BOARD_C6_FITTED true

/* All runtime state. Static because there is exactly one radio. */
static struct {
  const net_link_driver_t *driver;
  net_state_t state;
  net_reason_t reason;
  char ssid[NET_SSID_LEN];
  char bssid[NET_BSSID_LEN];
  char ip[NET_IP_LEN];
  int rssi;
  int channel;
  int64_t entered_ms;
  bool c6_present;
  bool sdio_link_up;
  char c6_version[NET_VERSION_LEN];
  char host_version[NET_VERSION_LEN];
  char protocol_version[NET_VERSION_LEN];
  uint32_t transport_errors;
  uint32_t c6_resets;
  uint32_t reconnects;
  uint64_t rx_bytes;
  uint64_t tx_bytes;
  char detail[NET_DETAIL_LEN];
  net_scan_entry_t scan[NET_SCAN_MAX];
  size_t scan_count;
  bool initialised;
} s_net;

/* True when a radio implementation has registered itself. This replaced a
 * compile-time BOARD_C6_ROUTED constant: the gate is now which sources the
 * build links, and this file must not know which build it is in. */
static bool routed(void) { return s_net.driver != NULL; }

static void copy_str(char *dst, size_t cap, const char *src) {
  if (cap == 0) return;
  if (src == NULL) {
    dst[0] = '\0';
    return;
  }
  size_t i = 0;
  for (; i + 1 < cap && src[i] != '\0'; i++) dst[i] = src[i];
  dst[i] = '\0';
}

/* Move to `state`, stamping the time so `since_ms` means something. Reason is
 * set separately: a reason outlives the state that caused it, so a later
 * transition must not silently erase why the previous attempt failed. */
static void enter(net_state_t state, int64_t now_ms) {
  if (s_net.state != state) {
    s_net.state = state;
    s_net.entered_ms = now_ms;
  }
}

static void fail(net_state_t state, net_reason_t reason, const char *detail, int64_t now_ms) {
  enter(state, now_ms);
  s_net.reason = reason;
  if (detail != NULL) copy_str(s_net.detail, sizeof s_net.detail, detail);
}

void net_link_init(int64_t now_ms) {
  memset(&s_net, 0, sizeof s_net);
  s_net.initialised = true;
  s_net.entered_ms = now_ms;

  if (!BOARD_C6_FITTED) {
    /* No radio on this body at all. Not the D4 V1's case, but the state has
     * to exist or a future body without a C6 would report NOT_ROUTED, which
     * would send someone looking for a wiring fault instead of a part. */
    fail(NET_C6_ABSENT, NET_REASON_C6_NO_RESPONSE, "no radio fitted to this body", now_ms);
    return;
  }

  /* No driver yet. In the default build none ever registers, and this is the
   * final answer: no pin is driven, no SDIO host is opened, and the reason
   * points at the evidence rather than shrugging. In the radio build
   * net_hosted_start() registers in the same boot step, so the window in
   * which this is reported is not observable from KDP. */
  fail(NET_C6_NOT_ROUTED, NET_REASON_TRANSPORT_UNKNOWN,
       "no P4-C6 transport in this build; see firmware/C6_HARDWARE_MAP.md", now_ms);
}

void net_link_status(net_status_t *out, int64_t now_ms) {
  if (out == NULL) return;
  memset(out, 0, sizeof *out);

  out->radio_fitted = BOARD_C6_FITTED;
  out->radio_routed = routed();

  if (!s_net.initialised) {
    /* Asked before net_link_init(). Say so rather than implying a probe has
     * happened and found nothing — during boot the UI can render this. */
    out->state = NET_C6_NOT_ROUTED;
    out->reason = NET_REASON_TRANSPORT_UNKNOWN;
    return;
  }

  out->state = s_net.state;
  out->reason = s_net.reason;
  out->c6_present = s_net.c6_present;
  out->sdio_link_up = s_net.sdio_link_up;
  out->rssi = s_net.rssi;
  out->channel = s_net.channel;
  out->transport_errors = s_net.transport_errors;
  out->c6_resets = s_net.c6_resets;
  out->reconnects = s_net.reconnects;
  out->transport_rx_bytes = s_net.rx_bytes;
  out->transport_tx_bytes = s_net.tx_bytes;
  out->since_ms = now_ms > s_net.entered_ms ? now_ms - s_net.entered_ms : 0;

  memcpy(out->ssid, s_net.ssid, sizeof out->ssid);
  memcpy(out->ip, s_net.ip, sizeof out->ip);
  memcpy(out->c6_version, s_net.c6_version, sizeof out->c6_version);
  memcpy(out->host_version, s_net.host_version, sizeof out->host_version);
  memcpy(out->protocol_version, s_net.protocol_version, sizeof out->protocol_version);
  memcpy(out->detail, s_net.detail, sizeof out->detail);
}

bool net_link_can_upload(const net_status_t *status) {
  /* IP_READY only. Association without an address is the state that makes a
   * device claim it is online while nothing resolves. */
  return status != NULL && status->state == NET_IP_READY;
}

/* ------------------------------------------------------------------ */
/* Operations                                                         */
/* ------------------------------------------------------------------ */

bool net_link_scan_start(int64_t now_ms) {
  if (!routed()) {
    fail(NET_C6_NOT_ROUTED, NET_REASON_TRANSPORT_UNKNOWN,
         "cannot scan: no P4-C6 transport in this build", now_ms);
    return false;
  }
  if (s_net.state < NET_RADIO_READY) {
    fail(s_net.state, NET_REASON_RADIO_FAILURE, "cannot scan: radio not ready", now_ms);
    return false;
  }
  if (s_net.driver->scan_start == NULL || !s_net.driver->scan_start()) {
    fail(s_net.state, NET_REASON_RADIO_FAILURE, "the radio refused the scan", now_ms);
    return false;
  }
  enter(NET_WIFI_SCANNING, now_ms);
  return true;
}

size_t net_link_scan_results(net_scan_entry_t *out, size_t cap) {
  /* Zero is a real answer from a radio in a shielded room as well as from a
   * build with no radio, and callers are required to treat it as an answer
   * rather than an error. */
  if (out == NULL) return 0;
  size_t n = s_net.scan_count < cap ? s_net.scan_count : cap;
  for (size_t i = 0; i < n; i++) out[i] = s_net.scan[i];
  return n;
}

bool net_link_connect(const char *ssid, int64_t now_ms) {
  if (ssid == NULL || ssid[0] == '\0') return false;

  if (!routed()) {
    /* Deliberately does not record the SSID as "connecting to". A status that
     * named a network it never attempted would read as a failed join rather
     * than an absent transport. */
    fail(NET_C6_NOT_ROUTED, NET_REASON_TRANSPORT_UNKNOWN,
         "cannot join: no P4-C6 transport in this build", now_ms);
    return false;
  }
  if (s_net.state < NET_RADIO_READY) {
    fail(s_net.state, NET_REASON_RADIO_FAILURE, "cannot join: radio not ready", now_ms);
    return false;
  }

  /* The passphrase is NOT fetched here. net_hosted.c reads it from wifi_creds
   * at the moment of use, so it never appears in this file's frame nor in a
   * caller's. */
  if (s_net.driver->connect == NULL || !s_net.driver->connect(ssid)) {
    fail(s_net.state, NET_REASON_RADIO_FAILURE, "the radio refused the join", now_ms);
    return false;
  }

  copy_str(s_net.ssid, sizeof s_net.ssid, ssid);
  s_net.reason = NET_REASON_NONE;
  s_net.detail[0] = '\0';
  enter(NET_WIFI_CONNECTING, now_ms);
  return true;
}

bool net_link_disconnect(int64_t now_ms) {
  if (!routed()) return false;
  if (s_net.driver->disconnect != NULL) (void)s_net.driver->disconnect();
  s_net.ip[0] = '\0';
  s_net.rssi = 0;
  s_net.channel = 0;
  enter(NET_WIFI_IDLE, now_ms);
  return true;
}

/* ------------------------------------------------------------------ */
/* The radio seam                                                     */
/* ------------------------------------------------------------------ */

void net_link_set_driver(const net_link_driver_t *driver, int64_t now_ms) {
  s_net.driver = driver;
  if (driver == NULL) {
    fail(NET_C6_NOT_ROUTED, NET_REASON_TRANSPORT_UNKNOWN, "the radio driver withdrew",
         now_ms);
    return;
  }
  /* From here the firmware HAS a transport, so NOT_ROUTED would be false.
   * BOOTING is the honest state before a pin has settled. */
  s_net.reason = NET_REASON_NONE;
  s_net.detail[0] = '\0';
  enter(NET_C6_BOOTING, now_ms);
}

void net_link_report_state(net_state_t state, net_reason_t reason, const char *detail,
                           int64_t now_ms) {
  enter(state, now_ms);
  s_net.reason = reason;
  if (detail != NULL) copy_str(s_net.detail, sizeof s_net.detail, detail);
  if (state >= NET_C6_LINK_READY) s_net.c6_present = true;
  if (state < NET_WIFI_ASSOCIATED) {
    /* Nothing above association may be claimed once the radio has dropped
     * back below it. A stale address in NETWORK_STATUS is how a queue ends up
     * retrying against a network it is no longer on. */
    s_net.ip[0] = '\0';
    s_net.rssi = 0;
    s_net.channel = 0;
  }
}

void net_link_report_versions(const char *host_version, const char *c6_version,
                              const char *protocol_version) {
  if (host_version != NULL) {
    copy_str(s_net.host_version, sizeof s_net.host_version, host_version);
  }
  if (c6_version != NULL) copy_str(s_net.c6_version, sizeof s_net.c6_version, c6_version);
  if (protocol_version != NULL) {
    copy_str(s_net.protocol_version, sizeof s_net.protocol_version, protocol_version);
  }
  /* Something answered a version exchange, so the chip is there whatever the
   * compatibility decision turns out to be. */
  if (c6_version != NULL && c6_version[0] != '\0') s_net.c6_present = true;
}

void net_link_report_scan(const net_scan_entry_t *entries, size_t count) {
  if (entries == NULL) count = 0;
  if (count > NET_SCAN_MAX) count = NET_SCAN_MAX;
  for (size_t i = 0; i < count; i++) s_net.scan[i] = entries[i];
  s_net.scan_count = count;
}

void net_link_report_association(const char *ssid, const char *bssid, int rssi, int channel) {
  if (ssid != NULL && ssid[0] != '\0') copy_str(s_net.ssid, sizeof s_net.ssid, ssid);
  if (bssid != NULL) copy_str(s_net.bssid, sizeof s_net.bssid, bssid);
  s_net.rssi = rssi;
  s_net.channel = channel;
}

void net_link_report_ip(const char *ip, int64_t now_ms) {
  if (ip == NULL || ip[0] == '\0') {
    s_net.ip[0] = '\0';
    return;
  }
  copy_str(s_net.ip, sizeof s_net.ip, ip);
  s_net.reason = NET_REASON_NONE;
  s_net.detail[0] = '\0';
  enter(NET_IP_READY, now_ms);
}

void net_link_report_transport(uint64_t rx_bytes, uint64_t tx_bytes, uint32_t errors,
                               bool link_up) {
  s_net.rx_bytes = rx_bytes;
  s_net.tx_bytes = tx_bytes;
  s_net.transport_errors = errors;
  s_net.sdio_link_up = link_up;
}

void net_link_report_reset(void) {
  s_net.c6_resets++;
  s_net.sdio_link_up = false;
}

void net_link_report_reconnect(void) { s_net.reconnects++; }

/* ------------------------------------------------------------------ */
/* Naming                                                             */
/* ------------------------------------------------------------------ */

const char *net_state_name(net_state_t state) {
  switch (state) {
    case NET_C6_NOT_ROUTED: return "C6_NOT_ROUTED";
    case NET_C6_ABSENT: return "C6_ABSENT";
    case NET_C6_BOOTING: return "C6_BOOTING";
    case NET_C6_LINK_READY: return "C6_LINK_READY";
    case NET_RADIO_READY: return "RADIO_READY";
    case NET_WIFI_IDLE: return "WIFI_IDLE";
    case NET_WIFI_SCANNING: return "WIFI_SCANNING";
    case NET_WIFI_CONNECTING: return "WIFI_CONNECTING";
    case NET_WIFI_ASSOCIATED: return "WIFI_ASSOCIATED";
    case NET_IP_WAIT: return "IP_WAIT";
    case NET_IP_READY: return "IP_READY";
    case NET_ERROR: return "NETWORK_ERROR";
  }
  return "UNKNOWN";
}

const char *net_reason_name(net_reason_t reason) {
  switch (reason) {
    case NET_REASON_NONE: return "NONE";
    case NET_REASON_TRANSPORT_UNKNOWN: return "TRANSPORT_UNKNOWN";
    case NET_REASON_C6_NO_RESPONSE: return "C6_NO_RESPONSE";
    case NET_REASON_C6_BAD_FIRMWARE: return "C6_BAD_FIRMWARE";
    case NET_REASON_C6_LINK_LOST: return "C6_LINK_LOST";
    case NET_REASON_RADIO_FAILURE: return "RADIO_FAILURE";
    case NET_REASON_AUTH_FAILED: return "AUTH_FAILED";
    case NET_REASON_NETWORK_NOT_FOUND: return "NETWORK_NOT_FOUND";
    case NET_REASON_ASSOC_FAILED: return "ASSOC_FAILED";
    case NET_REASON_DHCP_TIMEOUT: return "DHCP_TIMEOUT";
    case NET_REASON_DNS_FAILURE: return "DNS_FAILURE";
    case NET_REASON_NO_CREDENTIALS: return "NO_CREDENTIALS";
    case NET_REASON_CLOCK_UNTRUSTED: return "CLOCK_UNTRUSTED";
  }
  return "UNKNOWN";
}

const char *net_wire_state(net_state_t state) {
  switch (state) {
    case NET_IP_READY:
      return "connected";
    case NET_WIFI_CONNECTING:
    case NET_WIFI_ASSOCIATED:
    case NET_IP_WAIT:
      /* Associated is `connecting`, not `connected`. The coarse field must
       * not claim usable while DNS would fail. */
      return "connecting";
    default:
      return "disconnected";
  }
}

const char *net_security_name(net_security_t security) {
  switch (security) {
    case NET_SEC_OPEN: return "open";
    case NET_SEC_WPA2: return "wpa2";
    case NET_SEC_WPA3: return "wpa3";
  }
  return "wpa2";
}

net_security_t net_security_parse(const char *name) {
  if (name == NULL) return NET_SEC_WPA2;
  if (strcmp(name, "open") == 0) return NET_SEC_OPEN;
  if (strcmp(name, "wpa3") == 0) return NET_SEC_WPA3;
  /* Anything else, including unknown future modes, is treated as WPA2.
   * Defaulting to `open` would attempt an unencrypted join against a network
   * whose mode we failed to parse. */
  return NET_SEC_WPA2;
}
