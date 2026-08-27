// KINO D4 radio coprocessor — ESP32-C6, ESP-Hosted coprocessor image.
//
// There is deliberately almost nothing here. The image is Espressif's
// ESP-Hosted coprocessor firmware (espressif/esp_hosted, selected by the
// CONFIG_ESP_HOSTED_CP_* options in ../sdkconfig.defaults); it registers its
// own startup and owns the radio and the SDIO link to the P4. app_main() does
// the two things the component's own coprocessor example does — NVS and the
// default event loop — plus one line of console output so a bench operator can
// tell a running C6 from an unpowered one.
//
// What must NOT appear in this file: capture, Roll, KDP, camera state, or any
// Wi-Fi call. All of that is the P4's, which drives this chip's Wi-Fi over
// RPC. A coprocessor that also holds product logic gives the camera a second
// place to disagree with itself.
//
// Modelled on esp_hosted 3.0.6,
// examples/mcu_hosted_sdio_sdmmc_combined/cp/main/main.c.
//
// State on hardware: never flashed. See ../README.md before writing C6 flash.
#include <stdio.h>

#include "esp_event.h"
#include "esp_log.h"
#include "identity.h"
#include "nvs_flash.h"

static const char *TAG = "kino-c6";

void app_main(void) {
  // Wi-Fi PHY calibration data lives in NVS. Erase-and-retry on a version or
  // page failure rather than aborting: a coprocessor that will not boot is
  // invisible on this board, because the P4 cannot report on its behalf.
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    err = nvs_flash_init();
  }
  ESP_ERROR_CHECK(err);

  ESP_ERROR_CHECK(esp_event_loop_create_default());

  // One line, fixed keys, so a bench script can match it without a parser.
  // This is the KINO repo version, not the ESP-Hosted protocol version: the
  // host negotiates that one over RPC and it is not this string's business.
  printf("%s fw=%s role=%s image=%s\n", KINO_C6_BANNER_PREFIX, KINO_C6_FW_VERSION, KINO_C6_ROLE,
         KINO_C6_IMAGE);
  ESP_LOGI(TAG, "kino-c6 %s up, %s", KINO_C6_FW_VERSION, KINO_C6_IMAGE);
}
