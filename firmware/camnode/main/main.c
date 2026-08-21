// KINO D4 camera node — Milestone 1. Boots, detects its sensor, serves the
// node link. Identity (CAM1..CAM4) is physical: it comes from which P4 UART
// this node hangs off, never from stored state.
#include <stdio.h>

#include "camera.h"
#include "esp_log.h"
#include "node_server.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "camnode";

// Boot counter → session id, new value every boot (contract §Session change).
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

void app_main(void) {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ESP_ERROR_CHECK(nvs_flash_init());
  }

  char session_id[16];
  snprintf(session_id, sizeof session_id, "boot-%lu", (unsigned long)next_boot_count());

  node_server_set_state("initializing-sensor");
  if (camsensor_init() != ESP_OK) {
    ESP_LOGE(TAG, "camera init failed — serving link in error state");
  }

  ESP_ERROR_CHECK(node_server_start(session_id));
  ESP_LOGI(TAG, "camnode %s up, session %s, sensor %s", KINO_FW_VERSION, session_id,
           camsensor_detected() ? camsensor_name() : "none");
}
