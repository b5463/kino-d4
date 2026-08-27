/*
 * The P4's view of the ESP32-C6 radio. See net_link.h for why this reports
 * NOT ROUTED on the D4 V1 carrier and where the transport lands.
 *
 * Reaches only esp_err.h from ESP-IDF, so the host tests exercise this state
 * machine rather than a copy of it. Time is injected; there is no esp_timer
 * here. Same discipline as roll_queue.c.
 */
#include "net_link.h"

#include <string.h>

/* Whether the carrier has a C6 fitted. A fact about the board, not a
 * measurement: the chip is on the Guition module. Kept as a named constant so
 * the one place it is decided is visible, and so a future body without a
 * radio flips one line rather than every caller. */
#define BOARD_C6_FITTED true

/*
 * Whether this firmware knows how to reach it.
 *
 * FALSE until firmware/C6_HARDWARE_MAP.md's table has P4-side GPIO numbers in
 * it. The gate is not a preference — the repo records no transport pin for
 * this carrier, and driving a guessed SDIO bus into the C6's strap region can
 * leave the board unable to boot. See C6_BRINGUP.md step 5 for what turns
 * this on: a BOARD_C6_* pin block and a transport implementation.
 *
 * Everything above this line is already written against the full state set,
 * so flipping it is the last step of bring-up rather than the first.
 */
#define BOARD_C6_ROUTED false

/* All runtime state. Static because there is exactly one radio. */
static struct {
  net_state_t state;
  net_reason_t reason;
  char ssid[NET_SSID_LEN];
  char ip[NET_IP_LEN];
  int rssi;
  int channel;
  int64_t entered_ms;
  char c6_version[24];
  uint32_t transport_errors;
  uint32_t reconnects;
  char detail[NET_DETAIL_LEN];
  bool initialised;
} s_net;

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
  if (detail != NULL) {
    strncpy(s_net.detail, detail, sizeof s_net.detail - 1);
    s_net.detail[sizeof s_net.detail - 1] = '\0';
  }
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

  if (!BOARD_C6_ROUTED) {
    /* The honest answer for D4 V1. Note what this does NOT do: it does not
     * reset the C6, drive a strap, or open an SDIO host. There is no pin to
     * drive, and guessing one is how a camera stops booting. */
    fail(NET_C6_NOT_ROUTED, NET_REASON_TRANSPORT_UNKNOWN,
         "no P4-C6 transport routing recorded; see firmware/C6_HARDWARE_MAP.md", now_ms);
    return;
  }

  /* ---- Transport bring-up lands here. ----------------------------------
   *
   * The sequence, from C6_BRINGUP.md:
   *
   *   assert C6 reset  ->  NET_C6_BOOTING
   *   release, open the transport, handshake
   *   version exchange ->  NET_C6_LINK_READY   (fill s_net.c6_version)
   *   esp_wifi_remote init ->  NET_RADIO_READY
   *   then NET_WIFI_IDLE and the ordinary Wi-Fi path.
   *
   * Every failure below maps onto a reason that already exists above, so the
   * UI and NETWORK_STATUS need no change when this fills in. Nothing here may
   * block: net_link_init() runs after the UI is usable, and a radio that
   * cannot come up must cost the camera nothing.
   */
  enter(NET_C6_BOOTING, now_ms);
}

void net_link_status(net_status_t *out, int64_t now_ms) {
  if (out == NULL) return;
  memset(out, 0, sizeof *out);

  out->radio_fitted = BOARD_C6_FITTED;
  out->radio_routed = BOARD_C6_ROUTED;

  if (!s_net.initialised) {
    /* Asked before net_link_init(). Say so rather than implying a probe has
     * happened and found nothing — during boot the UI can render this. */
    out->state = BOARD_C6_ROUTED ? NET_C6_BOOTING : NET_C6_NOT_ROUTED;
    out->reason = BOARD_C6_ROUTED ? NET_REASON_NONE : NET_REASON_TRANSPORT_UNKNOWN;
    return;
  }

  out->state = s_net.state;
  out->reason = s_net.reason;
  out->rssi = s_net.rssi;
  out->channel = s_net.channel;
  out->transport_errors = s_net.transport_errors;
  out->reconnects = s_net.reconnects;
  out->since_ms = now_ms > s_net.entered_ms ? now_ms - s_net.entered_ms : 0;

  memcpy(out->ssid, s_net.ssid, sizeof out->ssid);
  memcpy(out->ip, s_net.ip, sizeof out->ip);
  memcpy(out->c6_version, s_net.c6_version, sizeof out->c6_version);
  memcpy(out->detail, s_net.detail, sizeof out->detail);
}

bool net_link_can_upload(const net_status_t *status) {
  /* IP_READY only. Association without an address is the state that makes a
   * device claim it is online while nothing resolves. */
  return status != NULL && status->state == NET_IP_READY;
}

bool net_link_scan_start(int64_t now_ms) {
  if (!BOARD_C6_ROUTED) {
    fail(NET_C6_NOT_ROUTED, NET_REASON_TRANSPORT_UNKNOWN,
         "cannot scan: no P4-C6 transport routing recorded", now_ms);
    return false;
  }
  if (s_net.state < NET_RADIO_READY) {
    fail(s_net.state, NET_REASON_RADIO_FAILURE, "cannot scan: radio not ready", now_ms);
    return false;
  }
  enter(NET_WIFI_SCANNING, now_ms);
  return true;
}

size_t net_link_scan_results(net_scan_entry_t *out, size_t cap) {
  /* Nothing has ever scanned on this board. Zero is the true answer, and
   * callers are required to treat it as an answer rather than an error. */
  (void)out;
  (void)cap;
  return 0;
}

bool net_link_connect(const char *ssid, int64_t now_ms) {
  if (ssid == NULL || ssid[0] == '\0') return false;

  if (!BOARD_C6_ROUTED) {
    /* Deliberately does not record the SSID as "connecting to". A status that
     * named a network it never attempted would read as a failed join rather
     * than an absent transport. */
    fail(NET_C6_NOT_ROUTED, NET_REASON_TRANSPORT_UNKNOWN,
         "cannot join: no P4-C6 transport routing recorded", now_ms);
    return false;
  }
  if (s_net.state < NET_RADIO_READY) {
    fail(s_net.state, NET_REASON_RADIO_FAILURE, "cannot join: radio not ready", now_ms);
    return false;
  }

  strncpy(s_net.ssid, ssid, sizeof s_net.ssid - 1);
  s_net.ssid[sizeof s_net.ssid - 1] = '\0';
  s_net.reason = NET_REASON_NONE;
  s_net.detail[0] = '\0';
  enter(NET_WIFI_CONNECTING, now_ms);

  /* The passphrase is fetched from wifi_creds at the moment of use, inside
   * the transport layer, so it never appears in this file's frame and never
   * in a caller's. */
  return true;
}

bool net_link_disconnect(int64_t now_ms) {
  if (!BOARD_C6_ROUTED) return false;
  s_net.ip[0] = '\0';
  s_net.rssi = 0;
  s_net.channel = 0;
  enter(NET_WIFI_IDLE, now_ms);
  return true;
}

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
