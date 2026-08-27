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
  /*
   * ---- APPEND ONLY BELOW THIS LINE ----
   *
   * Statuses persist in NVS keyed by the enum's *index* ("v.%d"/"d.%d", see
   * hwv_status_key). Inserting an item anywhere above shifts every index after
   * it, and a unit flashed across that change would read its old evidence
   * against the wrong rows - a panel that lit would come back as a camera UART
   * that answered. Silently reattributing bench evidence is the one failure
   * this registry must never have, so new items go at the end. Reordering for
   * tidiness is not worth a corrupted record.
   *
   * CAM2-4 get one UART row each rather than the separate TX/RX rows CAM1
   * carries. The split is CAM1's history, not a better model: one successful
   * frame exchange proves both directions at once, and nothing can prove TX
   * alone. The asymmetry is deliberate and stays for the index reason above.
   */
  HWV_CAM2_UART,
  HWV_CAM2_NODE_LINK,
  HWV_CAM2_SENSOR_DETECT,
  HWV_CAM2_JPEG_TRANSFER,
  HWV_CAM2_SD_WRITE,
  HWV_CAM3_UART,
  HWV_CAM3_NODE_LINK,
  HWV_CAM3_SENSOR_DETECT,
  HWV_CAM3_JPEG_TRANSFER,
  HWV_CAM3_SD_WRITE,
  HWV_CAM4_UART,
  HWV_CAM4_NODE_LINK,
  HWV_CAM4_SENSOR_DETECT,
  HWV_CAM4_JPEG_TRANSFER,
  HWV_CAM4_SD_WRITE,
  /* The shared trigger trace. Driven by capture.c today; this row is earned
   * only when a node reports having *seen* the edge, which needs the node-side
   * ISR that M0 deliberately does not implement. It exists so the bring-up has
   * somewhere to record the answer. */
  HWV_SYNC_TRIGGER_GPIO32,
  /* GPIO28. Earned when something measurably responds to the pin - a scope
   * trace or a lit bench LED - not when the pin is merely driven. */
  HWV_FLASH_EN_GPIO28,
  /* Earned on the first debounced press of a real fitted switch. Cannot flip
   * while BOARD_BTN_SHUTTER is BOARD_BTN_NONE, which is the current state. */
  HWV_BTN_SHUTTER,
  HWV_COUNT,
} hwv_item_t;

/** Convenience for the per-camera rows: maps cam 0..3 to its own item, so
 * cam_link/capture can mark the right row without a switch at every site.
 * Returns HWV_COUNT for an out-of-range camera, which hwv_mark_validated
 * ignores. */
hwv_item_t hwv_cam_item(int cam, hwv_item_t cam1_equivalent);

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
