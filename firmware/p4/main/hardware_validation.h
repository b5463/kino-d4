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
  /* CAM1 on UART1: TX GPIO52 (JP1 pin 7), RX GPIO51 (JP1 pin 9), which is
   * what board_d4v1.h holds and what the ECN-0002 walk measured - the P4 drove
   * each GPIO in turn and JP1 pin 7 answered as GPIO52. The row names match
   * the copper again; an intermediate revision of this comment claimed
   * GPIO1/GPIO2 from the JC-ESP32P4-M3-DEV map, which is a different carrier
   * and reaches nothing here. Names left alone, so the NVS indices hold. */
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
  /* BOARD_CAM_PWR_EN is GPIO31 on JP1 pin 10 (board_d4v1.h, ECN-0002), and
   * power.c configures it and drives it low when camIdleTimeoutS elapses. The
   * pin exists and is driven; an earlier version of this comment said it was
   * BOARD_GPIO_NONE and routed nowhere, which was the pre-measurement map.
   *
   * Nothing marks this row, on purpose. Driving a pin is not evidence that
   * the AO4407 channels downstream switched - a gate that never pulled, a
   * missing jumper and a working rail all look identical from the P4. Earned
   * when a meter on the bank's 3V3 shows it going off with the timeout and
   * back on with a capture, and recorded by hand. */
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
   *
   * Pins, from board_d4v1.h after ECN-0002: CAM2 UART2 TX GPIO50 / RX GPIO49
   * (JP1 11/13), CAM3 UART3 TX GPIO34 / RX GPIO33 (JP1 17/8), CAM4 UART4 TX
   * GPIO30 / RX GPIO29 (JP1 12/14). This list carried the pre-measurement
   * numbers (47/46, 32/33, 45/4) until 2026-08-30; none of those reach the
   * header. All three rows UNVALIDATED: no node has been jumpered.
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
  /* The shared trigger trace: BOARD_SYNC_OUT is GPIO32 on JP1 pin 19
   * (board_d4v1.h, ECN-0002), so the row name is correct. A middle revision
   * of this comment said GPIO20 on pin 17 and that GPIO32 had become CAM3_TX;
   * neither is true - CAM3_TX is GPIO34 on pin 17.
   *
   * capture.c drives this pin, and driving it is not the claim. The row is
   * earned when a node reports having *seen* the edge, which needs the
   * node-side ISR that M0 deliberately does not implement, or failing that a
   * scope on JP1 19 during a capture. It exists so the bring-up has somewhere
   * to record the answer. */
  HWV_SYNC_TRIGGER_GPIO32,
  /* Dead row, kept because this list is append-only and the NVS indices are
   * positional. GPIO28 on JP1 21 was FLASH_EN under ECN-0002; on 2026-08-30
   * ECN-0003 gave that pin to the shutter button and dropped the built-in
   * flash from D4-V1 for a separate external module, which has no P4 pin in
   * this revision. BOARD_FLASH_EN is BOARD_GPIO_NONE.
   *
   * So this row can never flip on a D4-V1 body: there is no line to assert and
   * nothing to measure. It stays UNVALIDATED as the record of an assignment
   * that was made and then abandoned. Deleting it would shift every index
   * below and reattribute this unit's bench evidence. The name still says
   * GPIO28 - read it as the pin the flash once had, not the pin it has. */
  HWV_FLASH_EN_GPIO28,
  /* BOARD_BTN_SHUTTER is GPIO28 on JP1 21 since ECN-0003. Earned by buttons.c
   * on the first debounced press: a 25 ms low on an internally pulled-up input
   * is the tactile switch to ground and nothing else. */
  HWV_BTN_SHUTTER,
  /*
   * ---- ESP32-C6 radio. Appended, for the index reason above. ----
   *
   * The routing these rows describe is corroborated and unmeasured: identified
   * from Guition documentation and matched pin-for-pin against Espressif's own
   * ESP-Hosted defaults for a P4 host with a C6 coprocessor
   * (firmware/C6_HARDWARE_MAP.md). Not one of them can flip in the default
   * build, which links no radio at all and drives no pin toward the C6.
   *
   * They exist now for the same reason the CAM2-4 rows do: the bring-up needs
   * somewhere to record its answers, and a registry that grows during a bench
   * session is a registry nobody trusts afterwards. Ordered the way the bench
   * has to proceed, so a run that stops halfway leaves an obvious high-water
   * mark.
   *
   * The one that matters most is SD_SLOT0. The card was on SDMMC slot 1 until
   * this work moved it to slot 0 — the slot ESP-Hosted needs — and the
   * 2026-08-26 mount that validated GPIO39-44 was on the old slot. Same pins,
   * and they are the chip's own SD pads, so this is expected to be a no-op.
   * "Expected" is not "observed", and it is a change to an already-validated
   * path, which makes it the first thing the next bench run has to check.
   */
  HWV_SD_SLOT0,
  /* The transport, in the order it has to come up. C6_EN_GPIO54 is earned by a
   * measurement of the enable line's behaviour, not by the pin being driven:
   * its polarity is unconfirmed and ESP-Hosted ships an active-high override
   * for boards whose EN is buffered through an inverting transistor. */
  HWV_C6_EN_GPIO54,
  HWV_C6_SDIO_PINS,
  /* Earned when the hosted handshake completes AND the version comparison
   * passes. Deliberately one row: a link that enumerates and then reports an
   * incompatible RPC version is not a working transport, and this board is
   * reported to ship a factory C6 image older than current hosts expect. */
  HWV_C6_LINK_HANDSHAKE,
  HWV_C6_SLAVE_VERSION,
  /* The radio, above the transport. */
  HWV_C6_WIFI_SCAN,
  HWV_C6_WIFI_ASSOCIATE,
  /* IP_READY, not association. Association without an address is the state
   * that makes a device claim it is online while nothing resolves, so this row
   * is earned by a DHCP lease and nothing less. */
  HWV_C6_DHCP,
  HWV_C6_DNS,
  /* Trustworthy wall time from the network, which TLS depends on: a
   * certificate checked against a persisted lower bound either fails or, worse,
   * passes for the wrong reason. */
  HWV_C6_SNTP,
  /* A certificate-VERIFIED HTTPS response. Never earned by a request that
   * succeeded with verification disabled, because nothing in this firmware can
   * disable it. */
  HWV_C6_TLS,
  /* Both buses up at once — the coexistence check. Earned when a scan succeeds
   * before and after card I/O with the radio associated, which is what
   * esp_hosted's own combined SDIO/SDMMC example exists to prove. */
  HWV_SD_C6_COEXIST,
  /* One capture reaching a Roll from this body over Wi-Fi. The end of the
   * chain, and the only row that means the product works. */
  HWV_C6_ROLL_UPLOAD,
  /* Registration is its own row because it is the first thing that has to work
   * against the real API and the last thing that can be faked locally: a body
   * that cannot register has no identity to upload under, and the failure looks
   * like an upload problem if the two share a row. */
  HWV_ROLL_DEVICE_REGISTER,
  /* Recovery, which is a different claim from "it worked once". Earned only by
   * a link that actually went down and came back without a reboot. */
  HWV_ROLL_RECONNECT,
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
