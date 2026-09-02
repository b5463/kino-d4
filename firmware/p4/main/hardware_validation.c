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
    "CAM1_TX_GPIO52",   "CAM1_RX_GPIO51",  "CAM1_BAUD_921600", "CAM1_NODE_LINK",
    "CAM1_SENSOR_DETECT", "CAM1_CAPTURE", "CAM1_JPEG_TRANSFER", "CAM1_SD_WRITE",
    "DSI_PANEL_ST7701", "BACKLIGHT_GPIO23", "I2C_SHARED_BUS", "TOUCH_GT911",
    "AUDIO_ES8311",     "AUDIO_AMP_GPIO11",
    /* CAM_PWR_EN_GPIO31 is one of two rows nothing in this firmware marks -
     * the other is SYNC_TRIGGER_GPIO32 below. Not because the pins are
     * missing: both are on JP1 (GPIO31 pin 10, GPIO32 pin 19), power.c drives
     * 31 and capture.c drives 32. They are unmarked because driving an output
     * proves the P4 end and nothing past it - the MOSFET bank, the node's
     * SYNC_IN. Each waits on a meter or a scope on the header pin, recorded by
     * hand in firmware/HARDWARE_VALIDATION.md.
     *
     * FLASH_EN_GPIO28 used to be counted here. It is now unmarkable for a
     * different reason: ECN-0003 gave GPIO28 to the shutter button and left
     * the flash with no P4 pin at all. */
    "CAM_PWR_EN_GPIO31",
    /* Append-only, in lockstep with hwv_item_t - see the note there. These ids
     * exceed NVS_KEY_NAME_MAX_SIZE, which is harmless: the primary keys are
     * indexed ("v.%d") and only the pre-fix legacy lookup used the id, so it
     * simply misses for these rows and falls back to UNVALIDATED. */
    "CAM2_UART", "CAM2_NODE_LINK", "CAM2_SENSOR_DETECT", "CAM2_JPEG_TRANSFER",
    "CAM2_SD_WRITE",
    "CAM3_UART", "CAM3_NODE_LINK", "CAM3_SENSOR_DETECT", "CAM3_JPEG_TRANSFER",
    "CAM3_SD_WRITE",
    "CAM4_UART", "CAM4_NODE_LINK", "CAM4_SENSOR_DETECT", "CAM4_JPEG_TRANSFER",
    "CAM4_SD_WRITE",
    /* SYNC_TRIGGER_GPIO32: the pin is BOARD_SYNC_OUT, JP1 19, and capture.c
     * toggles it on every shot. Waiting on the far end - a node that says it
     * saw the edge, or a scope on pin 19.
     * FLASH_EN_GPIO28: a dead row, kept for its NVS index. Since ECN-0003
     * BOARD_FLASH_EN is BOARD_GPIO_NONE and JP1 21 carries the shutter, so
     * there is no line to assert and nothing to measure on a D4-V1 body.
     * BTN_SHUTTER is the live one: buttons.c marks it on the first debounced
     * press of the switch on that same pin. */
    "SYNC_TRIGGER_GPIO32", "FLASH_EN_GPIO28", "BTN_SHUTTER",
    /* ESP32-C6 radio, in bring-up order. None can flip in the default build,
     * which links no radio. See hardware_validation.h for what earns each. */
    "SD_SLOT0", "C6_EN_GPIO54", "C6_SDIO_PINS", "C6_LINK_HANDSHAKE",
    "C6_SLAVE_VERSION", "C6_WIFI_SCAN", "C6_WIFI_ASSOCIATE", "C6_DHCP",
    "C6_DNS", "C6_SNTP", "C6_TLS", "SD_C6_COEXIST", "C6_ROLL_UPLOAD",
    "ROLL_DEVICE_REGISTER", "ROLL_RECONNECT",
};

/* Compile-time guard: the id table and the enum must not drift. A missing
 * string here would read off the end of the array in hwv_item_id(). */
_Static_assert(sizeof(ITEM_IDS) / sizeof(ITEM_IDS[0]) == HWV_COUNT,
               "ITEM_IDS and hwv_item_t are out of step");

/*
 * Per-camera row lookup.
 *
 * CAM1's rows were written one at a time when one camera was all there was.
 * Rather than renumber them - which the NVS index rule forbids - this maps a
 * camera index onto the row that means the same thing for that camera.
 * CAM1_TX/RX collapse onto themselves: cam 0 keeps its historical rows.
 */
hwv_item_t hwv_cam_item(int cam, hwv_item_t cam1_equivalent) {
  if (cam < 0 || cam >= 4) return HWV_COUNT;
  if (cam == 0) return cam1_equivalent;

  /* cam 1..3 -> the CAM2/3/4 block, five rows each, in enum order. */
  const int base = HWV_CAM2_UART + (cam - 1) * 5;
  switch (cam1_equivalent) {
    case HWV_CAM1_TX_GPIO52:
    case HWV_CAM1_RX_GPIO51:
    case HWV_CAM1_BAUD_921600:  return (hwv_item_t)(base + 0); /* ..._UART */
    case HWV_CAM1_NODE_LINK:    return (hwv_item_t)(base + 1);
    case HWV_CAM1_SENSOR_DETECT:return (hwv_item_t)(base + 2);
    case HWV_CAM1_JPEG_TRANSFER:return (hwv_item_t)(base + 3);
    case HWV_CAM1_SD_WRITE:     return (hwv_item_t)(base + 4);
    default:                    return HWV_COUNT;
  }
}

static uint8_t s_status[HWV_COUNT];
static char s_detail[HWV_COUNT][48];
/* Marked in RAM, not yet in NVS. See hwv_mark_validated for why the write is
 * somebody else's job. */
static volatile bool s_dirty[HWV_COUNT];

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
  strlcpy(s_detail[item], detail != NULL ? detail : "", sizeof s_detail[item]);
  ESP_LOGI(TAG, "VALIDATED %s: %s", ITEM_IDS[item], s_detail[item]);
  /*
   * Not written to NVS here. This is called from eight tasks, three of them on
   * 3-4 KB stacks, and an NVS write is a flash write: the caller's task must
   * have its stack in cacheable DRAM or spi_flash's cache_utils asserts and the
   * board reboots - which happened on 2026-09-02 when internal RAM ran dry and
   * a task stack landed in TCM. The write is queued for hwv_persist(), which
   * one task with a known-good stack calls from its own loop.
   */
  s_dirty[item] = true;
  if (lock) xSemaphoreGive(lock);
}

void hwv_persist(void) {
  bool any = false;
  for (int i = 0; i < HWV_COUNT && !any; i++) any = s_dirty[i];
  if (!any) return;

  nvs_handle_t nvs;
  if (nvs_open("hwv", NVS_READWRITE, &nvs) != ESP_OK) return;
  for (int i = 0; i < HWV_COUNT; i++) {
    if (!s_dirty[i]) continue;
    s_dirty[i] = false;
    char key[24];
    hwv_status_key(i, key, sizeof key);
    esp_err_t err = nvs_set_u8(nvs, key, HWV_VALIDATED);
    if (err != ESP_OK) ESP_LOGW(TAG, "persist %s failed: %s", ITEM_IDS[i], esp_err_to_name(err));
    snprintf(key, sizeof key, "d.%d", i);
    err = nvs_set_str(nvs, key, s_detail[i]);
    if (err != ESP_OK) ESP_LOGW(TAG, "persist detail %s failed: %s", ITEM_IDS[i], esp_err_to_name(err));
  }
  nvs_commit(nvs);
  nvs_close(nvs);
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
