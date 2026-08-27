// Wi-Fi radio bring-up for the KINO D4 coprocessor.
//
// This is the radio only. No association, no DHCP, no TCP/IP: on a hosted
// coprocessor those belong to the P4, which owns the IP stack and drives this
// chip's Wi-Fi through RPC. Everything here exists to prove the radio comes
// up and hears the air.
#ifndef RADIO_H
#define RADIO_H

#include "esp_err.h"
#include <stdint.h>

// Starts the Wi-Fi driver in station mode. Idempotent per boot.
esp_err_t radio_init(void);

// Runs one blocking all-channel scan. On success writes the number of access
// points found to *ap_count. Takes roughly 1.5 s per band.
esp_err_t radio_scan(uint16_t *ap_count);

// The station MAC, as a 17-character "aa:bb:cc:dd:ee:ff" string. This is the
// only identity the C6 has that is not compiled in, so it is what a bench
// record can use to tell two units apart. Returns "unknown" before
// radio_init() succeeds.
const char *radio_mac_str(void);

#endif  // RADIO_H
