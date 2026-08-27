#include "hardware_validation.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"

static const char *TAG = "hwv";

static const char *ITEM_IDS[HWV_COUNT] = {
    "USB_SERIAL_JTAG", "SD_CLK_GPIO43",  "SD_CMD_GPIO44",   "SD_D0_GPIO39",
    "SD_D1_GPIO40",    "SD_D2_GPIO41",   "SD_D3_GPIO42",    "SD_LDO_CH4",
    "CAM1_TX_GPIO52",  "CAM1_RX_GPIO51", "CAM1_BAUD_921600", "CAM1_NODE_LINK",
    "CAM1_SENSOR_DETECT", "CAM1_CAPTURE", "CAM1_JPEG_TRANSFER", "CAM1_SD_WRITE",
    "DSI_PANEL_ST7701", "BACKLIGHT_GPIO23", "I2C_SHARED_BUS", "TOUCH_GT911",
    "AUDIO_ES8311",     "AUDIO_AMP_GPIO11", "CAM_PWR_EN_GPIO31",
};

static uint8_t s_status[HWV_COUNT];
static char s_detail[HWV_COUNT][48];

/* Status keys are indexed, not named: item ids like CAM1_SENSOR_DETECT
 * exceed NVS_KEY_NAME_MAX_SIZE-1 (15), and nvs_set_u8 rejected them
 * silently — three items reverted to UNVALIDATED on every reboot
 * (issue #90). Detail strings were always indexed ("d.%d"). */
static void hwv_status_key(int item, char *key, size_t cap) {
  snprintf(key, cap, "v.%d", item);
}

void hwv_init(void) {
  nvs_handle_t nvs;
  if (nvs_open("hwv", NVS_READONLY, &nvs) != ESP_OK) return;
  for (int i = 0; i < HWV_COUNT; i++) {
    uint8_t v = HWV_UNVALIDATED;
    char key[24];
    hwv_status_key(i, key, sizeof key);
    if (nvs_get_u8(nvs, key, &v) == ESP_OK) s_status[i] = v;
    /* Pre-fix firmware wrote the short ids as keys; honour them so a bench
     * unit flashed across the fix keeps its evidence. */
    if (s_status[i] == HWV_UNVALIDATED && nvs_get_u8(nvs, ITEM_IDS[i], &v) == ESP_OK) s_status[i] = v;
    size_t len = sizeof s_detail[i];
    snprintf(key, sizeof key, "d.%d", i);
    nvs_get_str(nvs, key, s_detail[i], &len);
  }
  nvs_close(nvs);
}

void hwv_mark_validated(hwv_item_t item, const char *detail) {
  if (item >= HWV_COUNT || s_status[item] == HWV_VALIDATED) return;
  /* Marked from eight modules and as many tasks - display bring-up, the touch
   * poll, the audio path, power, the node link. Two of them transitioning at
   * once would interleave an NVS handle and two writes to the same detail
   * string. The early return above means the lock is only ever taken on the
   * one transition per item, never on the steady-state re-marking. */
  static SemaphoreHandle_t lock;
  if (lock == NULL) {
    static portMUX_TYPE init_mux = portMUX_INITIALIZER_UNLOCKED;
    portENTER_CRITICAL(&init_mux);
    if (lock == NULL) lock = xSemaphoreCreateMutex();
    portEXIT_CRITICAL(&init_mux);
  }
  if (lock) xSemaphoreTake(lock, portMAX_DELAY);
  if (s_status[item] == HWV_VALIDATED) {
    if (lock) xSemaphoreGive(lock);
    return;
  }
  s_status[item] = HWV_VALIDATED;
  strncpy(s_detail[item], detail != NULL ? detail : "", sizeof s_detail[item] - 1);
  ESP_LOGI(TAG, "VALIDATED %s: %s", ITEM_IDS[item], s_detail[item]);

  nvs_handle_t nvs;
  if (nvs_open("hwv", NVS_READWRITE, &nvs) == ESP_OK) {
    char key[24];
    hwv_status_key((int)item, key, sizeof key);
    esp_err_t err = nvs_set_u8(nvs, key, HWV_VALIDATED);
    if (err != ESP_OK) ESP_LOGW(TAG, "persist %s failed: %s", ITEM_IDS[item], esp_err_to_name(err));
    snprintf(key, sizeof key, "d.%d", (int)item);
    err = nvs_set_str(nvs, key, s_detail[item]);
    if (err != ESP_OK) ESP_LOGW(TAG, "persist detail %s failed: %s", ITEM_IDS[item], esp_err_to_name(err));
    nvs_commit(nvs);
    nvs_close(nvs);
  }
  if (lock) xSemaphoreGive(lock);
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
