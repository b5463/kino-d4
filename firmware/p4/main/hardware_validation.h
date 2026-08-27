// Runtime hardware-validation registry for this D4-V1 unit.
//
// Compile-time configuration is never validation. An item flips to VALIDATED
// only when the corresponding real event happens on this device — a host
// frame decoded over USB, the card actually mounted, the node actually
// answered. The device never auto-marks FAILED: it cannot attribute a
// failure to a pin versus a missing card or an unplugged harness, so
// negative diagnosis stays a human bench judgment recorded in
// firmware/HARDWARE_VALIDATION.md. Statuses persist in NVS per unit.
#ifndef P4_HARDWARE_VALIDATION_H
#define P4_HARDWARE_VALIDATION_H

#include <stdint.h>

typedef enum {
  HWV_UNVALIDATED = 0,
  HWV_VALIDATED = 1,
  HWV_FAILED = 2,
  HWV_NOT_APPLICABLE = 3,
} hwv_status_t;

typedef enum {
  HWV_USB_SERIAL_JTAG = 0,
  HWV_SD_CLK_GPIO43,
  HWV_SD_CMD_GPIO44,
  HWV_SD_D0_GPIO39,
  HWV_SD_D1_GPIO40,
  HWV_SD_D2_GPIO41,
  HWV_SD_D3_GPIO42,
  HWV_SD_LDO_CH4,
  HWV_CAM1_TX_GPIO52,
  HWV_CAM1_RX_GPIO51,
  HWV_CAM1_BAUD_921600,
  HWV_CAM1_NODE_LINK,
  HWV_CAM1_SENSOR_DETECT,
  HWV_CAM1_CAPTURE,
  HWV_CAM1_JPEG_TRANSFER,
  HWV_CAM1_SD_WRITE,
  /* The body: everything the camera is made of besides the camera. Each of
   * these flips on the same terms as the rest - the real event, on this
   * unit. A panel that initialised is not a panel that lit; a codec that
   * answered on I2C is not an amplifier that drove a speaker. */
  HWV_DSI_PANEL_ST7701,
  HWV_BACKLIGHT_GPIO23,
  HWV_I2C_SHARED_BUS,
  HWV_TOUCH_GT911,
  HWV_AUDIO_ES8311,
  HWV_AUDIO_AMP_GPIO11,
  HWV_CAM_PWR_EN_GPIO31,
  HWV_COUNT,
} hwv_item_t;

/** Load persisted statuses from NVS. Safe to call before any marking. */
void hwv_init(void);

/** Record positive evidence: UNVALIDATED -> VALIDATED with a short detail of
 * what actually happened. No-op when already validated. Logged and persisted
 * on transition. */
void hwv_mark_validated(hwv_item_t item, const char *detail);

hwv_status_t hwv_status(hwv_item_t item);
const char *hwv_item_id(hwv_item_t item);
const char *hwv_status_str(hwv_status_t status);
/** Detail recorded at validation time, "" when none. */
const char *hwv_detail(hwv_item_t item);

#endif
