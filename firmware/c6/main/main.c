// KINO D4 radio coprocessor — ESP32-C6.
//
// This image is a radio and nothing else. No capture, no Roll, no KDP, no
// product logic: all of that is the P4's, and duplicating any of it here
// would give the camera two places to disagree with itself. What lives here
// is the Wi-Fi radio and the host link (transport.h), in that order, because
// the radio can be proved on the bench and the link cannot yet.
//
// State on hardware: unexercised. The P4 has no established route to this chip
// (firmware/C6_HARDWARE_MAP.md), so this image has never run on a D4.
#include <stdio.h>

#include "esp_log.h"
#include "identity.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "radio.h"
#include "transport.h"

static const char *TAG = "kino-c6";

void app_main(void) {
  // Wi-Fi calibration data (PHY) is kept in NVS by the driver. Without this
  // the radio still starts, but every boot re-runs full calibration.
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ESP_ERROR_CHECK(nvs_flash_init());
  }

  // Radio first, link second. If the radio fails the banner still has to go
  // out: a C6 that says nothing is indistinguishable from a C6 that is not
  // powered, and on this board the console is the only thing that can tell
  // those apart.
  uint16_t ap_count = 0;
  const char *radio_status = "up";
  if (radio_init() != ESP_OK) {
    radio_status = "init-failed";
  } else if (radio_scan(&ap_count) != ESP_OK) {
    radio_status = "scan-failed";
  }

  // Returns ESP_ERR_NOT_SUPPORTED until the P4 routing is resolved. Not
  // checked, because there is nothing to do about it here — the state goes
  // into the banner and the image keeps running so the console stays useful.
  (void)transport_start();

  printf("%s fw=%s role=%s mac=%s radio=%s aps=%u link=%s\n", KINO_C6_BANNER_PREFIX,
         KINO_C6_FW_VERSION, KINO_C6_ROLE, radio_mac_str(), radio_status, (unsigned)ap_count,
         transport_state_str());

  ESP_LOGI(TAG, "kino-c6 %s up, radio %s, %u AP(s), host link %s", KINO_C6_FW_VERSION,
           radio_status, (unsigned)ap_count, transport_state_str());
}
