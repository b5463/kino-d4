#include "hardware_validation.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "nvs.h"

static const char *TAG = "hwv";

static const char *ITEM_IDS[HWV_COUNT] = {
    "USB_SERIAL_JTAG", "SD_CLK_GPIO43",  "SD_CMD_GPIO44",   "SD_D0_GPIO39",
    "SD_D1_GPIO40",    "SD_D2_GPIO41",   "SD_D3_GPIO42",    "SD_LDO_CH4",
    "CAM1_TX_GPIO52",  "CAM1_RX_GPIO51", "CAM1_BAUD_921600", "CAM1_NODE_LINK",
    "CAM1_SENSOR_DETECT", "CAM1_CAPTURE", "CAM1_JPEG_TRANSFER", "CAM1_SD_WRITE",
};

static uint8_t s_status[HWV_COUNT];
static char s_detail[HWV_COUNT][48];

void hwv_init(void) {
  nvs_handle_t nvs;
  if (nvs_open("hwv", NVS_READONLY, &nvs) != ESP_OK) return;
  for (int i = 0; i < HWV_COUNT; i++) {
    uint8_t v = HWV_UNVALIDATED;
    if (nvs_get_u8(nvs, ITEM_IDS[i], &v) == ESP_OK) s_status[i] = v;
    size_t len = sizeof s_detail[i];
    char key[24];
    snprintf(key, sizeof key, "d.%d", i);
    nvs_get_str(nvs, key, s_detail[i], &len);
  }
  nvs_close(nvs);
}

void hwv_mark_validated(hwv_item_t item, const char *detail) {
  if (item >= HWV_COUNT || s_status[item] == HWV_VALIDATED) return;
  s_status[item] = HWV_VALIDATED;
  strncpy(s_detail[item], detail != NULL ? detail : "", sizeof s_detail[item] - 1);
  ESP_LOGI(TAG, "VALIDATED %s: %s", ITEM_IDS[item], s_detail[item]);

  nvs_handle_t nvs;
  if (nvs_open("hwv", NVS_READWRITE, &nvs) == ESP_OK) {
    nvs_set_u8(nvs, ITEM_IDS[item], HWV_VALIDATED);
    char key[24];
    snprintf(key, sizeof key, "d.%d", (int)item);
    nvs_set_str(nvs, key, s_detail[item]);
    nvs_commit(nvs);
    nvs_close(nvs);
  }
}

hwv_status_t hwv_status(hwv_item_t item) {
  return item < HWV_COUNT ? (hwv_status_t)s_status[item] : HWV_UNVALIDATED;
}

const char *hwv_item_id(hwv_item_t item) {
  return item < HWV_COUNT ? ITEM_IDS[item] : "";
}

const char *hwv_status_str(hwv_status_t status) {
  switch (status) {
    case HWV_VALIDATED: return "validated";
    case HWV_FAILED: return "failed";
    case HWV_NOT_APPLICABLE: return "not-applicable";
    default: return "unvalidated";
  }
}

const char *hwv_detail(hwv_item_t item) { return item < HWV_COUNT ? s_detail[item] : ""; }
