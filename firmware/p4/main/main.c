// KINO D4 P4 main controller — Milestone 1. Boots, mounts SD, serves KDP on
// USB-Serial-JTAG, probes CAM1 in the background. Capture priority over
// background work arrives with the capture coordinator in milestone 2.
#include <stdio.h>

#include "cam_link.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hardware_validation.h"
#include "kdp_server.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "storage.h"

static const char *TAG = "kino_p4";

static uint32_t next_boot_count(void) {
  nvs_handle_t nvs;
  uint32_t count = 0;
  if (nvs_open("kino", NVS_READWRITE, &nvs) == ESP_OK) {
    nvs_get_u32(nvs, "boot", &count);
    count++;
    nvs_set_u32(nvs, "boot", count);
    nvs_commit(nvs);
    nvs_close(nvs);
  }
  return count;
}

// Keep CAM1 identity fresh: probe every 2 s while offline, every 10 s while
// online. GET_CAMERA_INFO reads the cached result instead of blocking.
static void cam_probe_task(void *arg) {
  (void)arg;
  for (;;) {
    esp_err_t err = camlink_hello();
    vTaskDelay(pdMS_TO_TICKS(err == ESP_OK ? 10000 : 2000));
  }
}

void app_main(void) {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ESP_ERROR_CHECK(nvs_flash_init());
  }

  kdp_identity_t id;
  uint8_t mac[6] = {0};
  esp_efuse_mac_get_default(mac);
  snprintf(id.serial, sizeof id.serial, "KD4-%02X%02X%02X", mac[3], mac[4], mac[5]);
  snprintf(id.device_id, sizeof id.device_id, "kino-%02x%02x%02x", mac[3], mac[4], mac[5]);
  snprintf(id.session_id, sizeof id.session_id, "boot-%lu",
           (unsigned long)next_boot_count());

  ESP_LOGI(TAG, "P4_BOOT %s serial %s session %s transport usb-serial-jtag",
           KINO_FW_VERSION, id.serial, id.session_id);
  hwv_init();
  storage_init(); /* mount failure is a reported state, not a boot failure */
  ESP_ERROR_CHECK(camlink_init());
  esp_err_t kdp_err = kdp_server_start(&id);
  if (kdp_err != ESP_OK) {
    // No silent boot hang: the device keeps running, the console says why
    // Studio cannot connect, and the camera/SD paths stay debuggable.
    ESP_LOGE(TAG, "KDP server unavailable: %s", esp_err_to_name(kdp_err));
  } else {
    ESP_LOGI(TAG, "KDP_READY session %s", id.session_id);
  }
  xTaskCreate(cam_probe_task, "cam_probe", 4096, NULL, 5, NULL);

  ESP_LOGI(TAG, "KINO D4 P4 %s up: serial %s, session %s, sd %s", KINO_FW_VERSION,
           id.serial, id.session_id, storage_present() ? "mounted" : "absent");
}
