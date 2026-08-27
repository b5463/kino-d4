/**
 * The Wi-Fi half of the radio: scan, association, DHCP, and the events that
 * drive them.
 *
 * Split out of net_hosted.c, which owns the transport and the version gate.
 * The boundary is what fails independently: a link that came up and a radio
 * that will not initialise are different faults with different reasons, and a
 * scan that returns nothing is neither.
 *
 * Radio build only — see net_hosted.h. Every function here reports into
 * net_link rather than returning state, because `NETWORK_STATUS` reads
 * net_link and there must be one answer.
 */
#ifndef P4_NET_WIFI_H
#define P4_NET_WIFI_H

#include <stdbool.h>

#include "esp_err.h"

#ifdef KINO_RADIO

/**
 * Initialise netif, the default event loop, the STA interface and the Wi-Fi
 * stack on the coprocessor, then start it.
 *
 * Called once, after the version gate has passed. Returns the first error;
 * net_hosted.c maps that onto `NET_REASON_RADIO_FAILURE`.
 */
esp_err_t net_wifi_start(void);

/** Begin an all-channel scan. Asynchronous: the results arrive through
 * `net_link_report_scan()` on WIFI_EVENT_SCAN_DONE. False when the radio
 * refused, which net_link turns into a reason. */
bool net_wifi_scan_start(void);

/**
 * Associate with `ssid` using the stored passphrase.
 *
 * The passphrase is NOT a parameter and never appears in this module's
 * callers: `wifi_creds_apply_to()` hands it to one callback which builds the
 * `wifi_config_t`, and the buffer holding it is wiped before that returns.
 * That callback is the only frame on the device in which it exists.
 */
bool net_wifi_connect(const char *ssid);

/** Drop the association and stop retrying until asked again. */
bool net_wifi_disconnect(void);

/** Try the stored auto-join network, if there is one. Reports
 * `NET_REASON_NO_CREDENTIALS` and stops when there is not — a camera with no
 * saved network is not broken, it has not been told anything yet. */
void net_wifi_auto_join(void);

#endif /* KINO_RADIO */

#endif /* P4_NET_WIFI_H */
