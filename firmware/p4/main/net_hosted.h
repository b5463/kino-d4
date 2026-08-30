/**
 * The ESP-Hosted radio host: the C6's enable line, the SDIO transport, the
 * version gate, and the Wi-Fi stack that sits on top of them.
 *
 * ## This file is a build-time opt-in and it is OFF by default
 *
 * Enabling ESP-Hosted drives GPIO14-19 and GPIO54 toward the C6. The Guition
 * carrier's routing is corroborated pin-for-pin against Espressif's own P4
 * host defaults (`firmware/C6_HARDWARE_MAP.md`, evidence E2/E3/E4) but has
 * never been measured on a board, and GPIO54's polarity is unconfirmed —
 * ESP-Hosted itself carries an active-high override because boards get that
 * one wrong. Espressif's own host configuration also calls
 * `esp_hosted_init()` from a constructor *before* `app_main()`, so a default
 * build with the component enabled would drive unproven pins on every
 * power-up of every unit, before any of this firmware's own code runs.
 *
 * So:
 *
 *   - the default build does not compile `net_hosted.c`, does not link
 *     esp_hosted or esp_wifi_remote, and drives no pin. `net_link` reports
 *     `NET_C6_NOT_ROUTED`, exactly as it did before this file existed;
 *   - the radio build is
 *     `idf.py -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.radio" build`,
 *     which sets `CONFIG_ESP_HOSTED=y` and, deliberately,
 *     `CONFIG_ESP_HOSTED_AUTO_CALL_INIT_BEFORE_APP_MAIN=n` — so even there,
 *     nothing is driven until `net_hosted_start()` says so, after the UI and
 *     the capture pipeline are already usable.
 *
 * `C6_BRINGUP.md` step 4 is the procedure. Nothing below has been run on
 * hardware.
 *
 * ## What it reports and what it does not
 *
 * Everything this module learns goes into `net_link` through
 * `net_link_report_*()`, so `NETWORK_STATUS`, the RADIO screen and Studio need
 * no change. `net_link` stays free of ESP-IDF beyond `esp_err.h` and stays
 * host-tested; this file is where esp_wifi and esp_hosted are allowed to be.
 *
 * Reaching `C6_LINK_READY` is not `WIFI_CONNECTED`, and neither is
 * `WIFI_ASSOCIATED`. `net_link_can_upload()` accepts `NET_IP_READY` alone.
 */
#ifndef P4_NET_HOSTED_H
#define P4_NET_HOSTED_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef KINO_RADIO

/**
 * Bring the radio up, asynchronously.
 *
 * Registers the driver with `net_link` first, so a `NETWORK_STATUS` read
 * during bring-up says BOOTING rather than claiming there is no route, then
 * spawns one supervisor task and returns. Never blocks the boot path: a radio
 * that cannot come up must cost the camera nothing.
 *
 * Returns `ESP_ERR_NO_MEM` when the task could not be created, which is the
 * only failure this call itself can have. Every other failure is reported
 * through `net_link` with a reason, because that is what a user can act on.
 */
esp_err_t net_hosted_start(void);

/*
 * Bench only (-DKINO_C6_RESET_BENCH=1): one reset pulse to the C6 on its
 * enable line, with the same timing bring-up uses, then the link is reported
 * down. The P4 is untouched. Nothing here re-establishes the transport: that
 * is what the bench measures. Not compiled otherwise.
 */
#if KINO_C6_RESET_BENCH
bool net_hosted_bench_c6_reset(void);
#endif

/** Bytes this firmware has moved through the transport, and errors observed.
 * Counted here rather than read from the bus: esp_hosted 3.0.6 exposes no
 * public byte counters, so these are the HTTP client's own totals. */
void net_hosted_counters(uint64_t *rx_bytes, uint64_t *tx_bytes, uint32_t *errors);

/** Add `n` received and `m` transmitted bytes to the totals. Called by the
 * HTTP client, which is the only thing on this device that moves bulk. */
void net_hosted_count_bytes(uint64_t rx, uint64_t tx);

#else /* !KINO_RADIO */

/* The default build. Inline so main.c needs no #ifdef and the call costs a
 * single return: the camera's boot path must read the same either way. */
static inline esp_err_t net_hosted_start(void) { return ESP_ERR_NOT_SUPPORTED; }
static inline void net_hosted_counters(uint64_t *rx_bytes, uint64_t *tx_bytes,
                                       uint32_t *errors) {
  if (rx_bytes != NULL) *rx_bytes = 0;
  if (tx_bytes != NULL) *tx_bytes = 0;
  if (errors != NULL) *errors = 0;
}
static inline void net_hosted_count_bytes(uint64_t rx, uint64_t tx) {
  (void)rx;
  (void)tx;
}

#endif /* KINO_RADIO */

#endif /* P4_NET_HOSTED_H */
