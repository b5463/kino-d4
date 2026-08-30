/*
 * Radio recovery state machine. See radio_recovery.h.
 *
 * No ESP-IDF here on purpose: firmware/p4/host_tests/test_radio_recovery.c
 * compiles this file with a plain C compiler and walks every arm.
 */
#include "radio_recovery.h"

#include <stddef.h>
#include <stdio.h>
#include <string.h>

static void set_detail(rr_t *r, const char *why) {
  snprintf(r->detail, sizeof r->detail, "%s", why != NULL ? why : "");
}

static void clear_timing(rr_t *r) {
  r->t_release = r->t_rx = r->t_tx = r->t_version = r->t_assoc = r->t_ip = 0;
}

static void enter(rr_t *r, rr_state_t s, int64_t deadline_ms) {
  r->state = s;
  r->deadline_ms = deadline_ms;
  r->action_pending = false;
}

/* One more failed attempt: back off, or park when the budget is spent. */
static void fail(rr_t *r, const char *why, int64_t now_ms) {
  r->attempts++;
  if (r->attempts >= RR_MAX_ATTEMPTS) {
    char d[RR_DETAIL_LEN];
    snprintf(d, sizeof d, "parked after %u attempts: %.40s", (unsigned)r->attempts, why);
    set_detail(r, d);
    enter(r, RR_PARKED, 0);
    return;
  }
  set_detail(r, why);
  enter(r, RR_BACKOFF, now_ms + (int64_t)rr_backoff_ms(r->attempts));
}

static void park(rr_t *r, const char *why) {
  set_detail(r, why);
  enter(r, RR_PARKED, 0);
}

static rr_action_t issue(rr_t *r, rr_action_t a) {
  if (r->action_pending) return RR_ACT_NONE;
  r->action_pending = true;
  return a;
}

static rr_action_t recovered(rr_t *r, int64_t now_ms) {
  r->t_ip = now_ms;
  r->recoveries++;
  r->attempts = 0;
  set_detail(r, "recovered");
  enter(r, RR_HEALTHY, 0);
  return RR_ACT_RECOVERED;
}

void rr_init(rr_t *r) {
  if (r == NULL) return;
  memset(r, 0, sizeof *r);
  r->state = RR_HEALTHY;
}

uint32_t rr_backoff_ms(uint32_t attempts) {
  if (attempts == 0) return 0;
  const uint32_t shift = attempts - 1u;
  if (shift >= 16u) return RR_BACKOFF_CAP_MS;
  const uint32_t ms = RR_BACKOFF_BASE_MS << shift;
  return ms > RR_BACKOFF_CAP_MS ? RR_BACKOFF_CAP_MS : ms;
}

bool rr_active(const rr_t *r) {
  return r != NULL && r->state != RR_HEALTHY && r->state != RR_PARKED;
}

void rr_link_lost(rr_t *r, int64_t now_ms) {
  if (r == NULL) return;
  if (rr_active(r)) return; /* already on it; the loss is the same loss */
  r->generation++;
  r->attempts = 0;
  r->t_lost = now_ms;
  clear_timing(r);
  set_detail(r, "link lost; recovering");
  enter(r, RR_TEARDOWN, 0);
}

rr_action_t rr_step(rr_t *r, const rr_obs_t *obs, uint32_t obs_generation, int64_t now_ms) {
  if (r == NULL || obs == NULL) return RR_ACT_NONE;
  /* An observation taken under a previous coprocessor says nothing about this
   * one. Dropping it here is what keeps a late "ready" or "down" from an old
   * generation out of the new one's state. */
  if (obs_generation != r->generation) return RR_ACT_NONE;

  switch (r->state) {
    case RR_HEALTHY:
    case RR_PARKED:
      return RR_ACT_NONE;

    case RR_TEARDOWN: return issue(r, RR_ACT_TEARDOWN);
    case RR_RESET_C6: return issue(r, RR_ACT_RESET_C6);
    case RR_HOSTED_UP: return issue(r, RR_ACT_HOSTED_UP);

    case RR_SDIO_WAIT:
      if (obs->rx_ready) {
        r->t_rx = now_ms;
        if (obs->tx_ready) {
          r->t_tx = now_ms;
          enter(r, RR_VERSION_GATE, 0);
          return issue(r, RR_ACT_VERSION_RPC);
        }
        enter(r, RR_HANDSHAKE_WAIT, now_ms + RR_HANDSHAKE_TIMEOUT_MS);
        return RR_ACT_NONE;
      }
      if (now_ms >= r->deadline_ms) fail(r, "SDIO did not enumerate after the reset", now_ms);
      return RR_ACT_NONE;

    case RR_HANDSHAKE_WAIT:
      if (!obs->rx_ready) {
        fail(r, "SDIO rx dropped before the handshake", now_ms);
        return RR_ACT_NONE;
      }
      if (obs->tx_ready) {
        r->t_tx = now_ms;
        enter(r, RR_VERSION_GATE, 0);
        return issue(r, RR_ACT_VERSION_RPC);
      }
      if (now_ms >= r->deadline_ms) fail(r, "transport rx only; tx never became ready", now_ms);
      return RR_ACT_NONE;

    case RR_VERSION_GATE: return issue(r, RR_ACT_VERSION_RPC);
    case RR_WIFI_INIT: return issue(r, RR_ACT_WIFI_INIT);

    case RR_WIFI_JOIN:
      if (!r->action_pending) return issue(r, RR_ACT_WIFI_JOIN);
      /* Join issued; the radio's own events drive the rest. */
      if (obs->has_ip) {
        if (r->t_assoc == 0) r->t_assoc = now_ms;
        return recovered(r, now_ms);
      }
      if (obs->auth_failed) {
        park(r, "wifi auth failed after recovery; not retrying until asked");
        return RR_ACT_NONE;
      }
      if (obs->associated) {
        r->t_assoc = now_ms;
        enter(r, RR_DHCP_WAIT, now_ms + RR_DHCP_TIMEOUT_MS);
        return RR_ACT_NONE;
      }
      if (now_ms >= r->deadline_ms) fail(r, "no association after the reset", now_ms);
      return RR_ACT_NONE;

    case RR_DHCP_WAIT:
      if (obs->has_ip) return recovered(r, now_ms);
      if (!obs->associated) {
        fail(r, "association dropped before an address", now_ms);
        return RR_ACT_NONE;
      }
      if (now_ms >= r->deadline_ms) fail(r, "no DHCP lease after the reset", now_ms);
      return RR_ACT_NONE;

    case RR_BACKOFF:
      if (now_ms >= r->deadline_ms) {
        r->generation++;
        clear_timing(r);
        set_detail(r, "retrying recovery");
        enter(r, RR_TEARDOWN, 0);
      }
      return RR_ACT_NONE;
  }
  return RR_ACT_NONE;
}

void rr_action_done(rr_t *r, rr_action_t action, int rc, int64_t now_ms) {
  if (r == NULL || !r->action_pending) return;

  switch (r->state) {
    case RR_TEARDOWN:
      if (action != RR_ACT_TEARDOWN) return;
      if (rc == 0) enter(r, RR_RESET_C6, 0);
      else fail(r, "host-side teardown failed", now_ms);
      return;

    case RR_RESET_C6:
      if (action != RR_ACT_RESET_C6) return;
      r->t_release = now_ms;
      if (rc == 0) enter(r, RR_HOSTED_UP, 0);
      else fail(r, "could not pulse the C6 enable line", now_ms);
      return;

    case RR_HOSTED_UP:
      if (action != RR_ACT_HOSTED_UP) return;
      if (rc == 0) enter(r, RR_SDIO_WAIT, now_ms + RR_SDIO_TIMEOUT_MS);
      else fail(r, "ESP-Hosted would not initialise", now_ms);
      return;

    case RR_VERSION_GATE:
      if (action != RR_ACT_VERSION_RPC) return;
      switch ((rr_version_t)rc) {
        case RR_VER_OK:
          r->t_version = now_ms;
          enter(r, RR_WIFI_INIT, 0);
          return;
        case RR_VER_INCOMPATIBLE:
          /* Fail closed, as at first boot: an incompatible coprocessor is not
           * something a retry changes. */
          park(r, "C6 image incompatible with this host; reflash the C6");
          return;
        case RR_VER_NO_RESPONSE:
        case RR_VER_UNKNOWN:
        default:
          fail(r, "the C6 did not answer the version RPC", now_ms);
          return;
      }

    case RR_WIFI_INIT:
      if (action != RR_ACT_WIFI_INIT) return;
      if (rc == 0) enter(r, RR_WIFI_JOIN, 0);
      else fail(r, "the Wi-Fi stack would not initialise on the C6", now_ms);
      return;

    case RR_WIFI_JOIN:
      if (action != RR_ACT_WIFI_JOIN) return;
      if (rc == 0) {
        /* Stays pending on purpose: the join is in flight and must not be
         * issued again. Events settle it. */
        r->deadline_ms = now_ms + RR_ASSOC_TIMEOUT_MS;
        return;
      }
      /* Nothing saved to join. The transport is back, the radio is idle, and
       * that is not a failure of recovery - it is the same state a camera with
       * no saved network boots into. */
      set_detail(r, "transport recovered; no saved network to join");
      r->attempts = 0;
      enter(r, RR_HEALTHY, 0);
      return;

    default:
      return;
  }
}

const char *rr_state_name(rr_state_t s) {
  switch (s) {
    case RR_HEALTHY: return "HEALTHY";
    case RR_TEARDOWN: return "TEARDOWN";
    case RR_RESET_C6: return "RESET_C6";
    case RR_HOSTED_UP: return "HOSTED_UP";
    case RR_SDIO_WAIT: return "SDIO_WAIT";
    case RR_HANDSHAKE_WAIT: return "HANDSHAKE_WAIT";
    case RR_VERSION_GATE: return "VERSION_GATE";
    case RR_WIFI_INIT: return "WIFI_INIT";
    case RR_WIFI_JOIN: return "WIFI_JOIN";
    case RR_DHCP_WAIT: return "DHCP_WAIT";
    case RR_BACKOFF: return "BACKOFF";
    case RR_PARKED: return "PARKED";
  }
  return "?";
}

const char *rr_action_name(rr_action_t a) {
  switch (a) {
    case RR_ACT_NONE: return "none";
    case RR_ACT_TEARDOWN: return "teardown";
    case RR_ACT_RESET_C6: return "reset-c6";
    case RR_ACT_HOSTED_UP: return "hosted-up";
    case RR_ACT_VERSION_RPC: return "version-rpc";
    case RR_ACT_WIFI_INIT: return "wifi-init";
    case RR_ACT_WIFI_JOIN: return "wifi-join";
    case RR_ACT_RECOVERED: return "recovered";
  }
  return "?";
}
