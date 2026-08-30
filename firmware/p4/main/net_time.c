/*
 * SNTP, feeding clock.c's `network` source. See net_time.h for why TLS waits
 * on it.
 *
 * Nothing here has been run on hardware.
 */
#include "net_time.h"

#ifdef KINO_RADIO

#include <string.h>
#include <sys/time.h>

#include "clock.h"
#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "hardware_validation.h"
#include "hwv_rules.h"
#include "klog.h"
#include "net_link.h"

static const char *TAG = "sntp";

/* The pool, and nothing device-specific. Named rather than taken from DHCP
 * option 42 because a party's router is as likely to serve a wrong time as no
 * time, and a wrong time is the case this whole clock model exists to avoid.
 * Overridable at build time for a bench with no route to the public pool. */
#ifndef KINO_SNTP_SERVER
#define KINO_SNTP_SERVER "pool.ntp.org"
#endif

static bool s_configured;
static bool s_synced;

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

/*
 * ## Once per session, deliberately
 *
 * lwIP's SNTP moves the system clock itself and calls this afterwards, so a
 * refused answer would have to be undone — and clock.c holds no copy of the
 * time to undo it with, because there is exactly one wall clock on this device
 * and that is the point of its design.
 *
 * So the refusals are made impossible instead of handled:
 *
 *   - SNTP is not started at all while the clock is already `host`. A bench
 *     operator's time outranks the network and must not be quietly replaced.
 *   - SNTP is not started again once it has succeeded. The camera needs to
 *     learn what year it is, not to correct drift over an evening, and a
 *     second sync is the only way a network time could move the clock
 *     backwards — which would let one capture be dated before an earlier one.
 *
 * What is left is exactly the case the policy adopts: `unset` or `persisted`
 * becoming `network`.
 */
static void on_sync(struct timeval *tv) {
  if (tv == NULL) return;
  const int64_t offered = (int64_t)tv->tv_sec * 1000 + (int64_t)tv->tv_usec / 1000;

  if (!clock_set_network(offered)) {
    /* Unreachable given the two guards above; kept because "unreachable" is a
     * claim about today's callers and this one is cheap. */
    ESP_LOGW(TAG, "SNTP answer refused by clock policy; clock stays %s", clock_source_str());
    /* Refused because something outranks the network — a host that set the
     * clock over KDP. That clock is trustworthy, so the hold has to come off
     * here too. Skipping it is the case the audit found: a host-set clock
     * released nothing, because the only release sat past this return. */
    if (clock_trustworthy_for_tls()) net_link_clear_clock_hold(now_ms());
    return;
  }

  s_synced = true;
  /* Accepted by the clock policy AND plausibly a real epoch. An answer of zero
   * would be "accepted" and is the state TLS then fails against, or worse
   * passes against for the wrong reason. */
  if (hwv_rule_sntp(true, offered)) {
    hwv_mark_validated(HWV_C6_SNTP, "wall clock adopted from the network");
  }
  esp_netif_sntp_deinit();
  s_configured = false;
  ESP_LOGI(TAG, "wall clock now from the network; SNTP stopped");

  /* The hold is released where it was placed. net_time_sync_now() reported
   * IP_READY with CLOCK_UNTRUSTED so the UI could say why TLS was not being
   * attempted; nothing cleared it once the clock was trustworthy. Measured on
   * KD4-D121BC: clockSource "network", C6_SNTP validated, and NETWORK_STATUS
   * still saying CLOCK_UNTRUSTED.
   *
   * The test and the write happen inside net_link, under its lock. Doing it
   * here - read the status, compare, report back - left the event task free to
   * report a disconnect between the read and the write, and the write then put
   * IP_READY back over it. */
  net_link_clear_clock_hold(now_ms());
  klog("P4", "TLS hold cleared: clock trusted (source %s)", clock_source_str());
}

void net_time_start(void) {
  if (s_configured || s_synced) return;
  if (clock_source() == CLOCK_HOST) {
    /* Nothing to fetch: the answer we would get is worth less than the one we
     * have. Said out loud because a silent no-op here reads as a broken
     * resolver at the bench. */
    ESP_LOGI(TAG, "clock already set by a host; not starting SNTP");
    return;
  }

  esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG(KINO_SNTP_SERVER);
  cfg.start = false; /* no address yet when this is called */
  cfg.sync_cb = on_sync;
  /* Smooth sync would slew the clock over minutes, which is wrong here: the
   * camera is not correcting drift, it is finding out what year it is. */
  cfg.smooth_sync = false;
  /* No semaphore. The callback is the whole interface and nothing on this
   * device waits for the time — the shutter least of all. */
  cfg.wait_for_sync = false;

  if (esp_netif_sntp_init(&cfg) != ESP_OK) {
    ESP_LOGW(TAG, "SNTP would not initialise; the clock stays %s", clock_source_str());
    return;
  }
  s_configured = true;
}

void net_time_sync_now(void) {
  if (!s_synced) {
    net_time_start();
    if (s_configured && esp_netif_sntp_start() != ESP_OK) {
      ESP_LOGW(TAG, "SNTP start failed");
    }
  }

  if (!clock_trustworthy_for_tls()) {
    /* Reported, not looped. The upload queue reads this reason and stops
     * rather than retrying TLS against a clock that cannot validate a
     * certificate — which would fail identically forever and read as a server
     * outage. The state stays IP_READY because the network really is up. */
    net_link_report_state(NET_IP_READY, NET_REASON_CLOCK_UNTRUSTED,
                          "waiting for a trustworthy clock before TLS", now_ms());
    klog("P4", "TLS held: no trustworthy clock yet (source %s)", clock_source_str());
  } else {
    /* The clock became trustworthy some other way — a host set it over KDP,
     * or an earlier boot's persisted time was adopted — and this is the next
     * moment anything asks. A reason left saying CLOCK_UNTRUSTED after that
     * sends someone looking at the clock for a fault that is elsewhere. */
    net_link_clear_clock_hold(now_ms());
  }
}

#endif /* KINO_RADIO */
