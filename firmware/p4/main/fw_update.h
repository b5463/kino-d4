// Firmware update: the P4's own image, and the four camera nodes' images
// through the P4 (contract FW_* 0x61..0x65, M8).
//
// One session at a time. A host sends FW_BEGIN naming a target, streams the
// image in FW_CHUNK frames, and sends FW_END; the target verifies the whole
// image against the SHA-256 the host named before anything is switched. For
// the P4 the bytes go into the OTA slot that is not running and the device
// restarts into it; for a node they go down its UART as NL_CMD_FW_* frames
// and the node restarts itself. Both sides boot with rollback armed: an image
// that does not reach a healthy state (the P4 UI up; a node answering HELLO)
// is rolled back by the bootloader on the next reset, which the P4 forces on
// a node by cycling the camera bank.
#ifndef KINO_FW_UPDATE_H
#define KINO_FW_UPDATE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

typedef enum {
  FW_T_P4 = 0,
  FW_T_CAM1,
  FW_T_CAM2,
  FW_T_CAM3,
  FW_T_CAM4,
  FW_T_COUNT,
} fw_target_t;

/** A refusal in the contract's words: a reason code and one sentence. */
typedef struct {
  const char *code;
  const char *message;
} fw_refusal_t;

/** "p4", "cam1".."cam4" -> target; false for anything else (including "c6"). */
bool fw_update_target_parse(const char *s, fw_target_t *out);
const char *fw_update_target_name(fw_target_t t);

/**
 * Open a session. `sha256_hex` is 64 hex characters of the whole image;
 * `version` is what the target should report afterwards (may be ""). On
 * ESP_OK, *session_id and *chunk_size are set; otherwise *why says what to
 * NACK with.
 */
esp_err_t fw_update_begin(fw_target_t t, uint32_t size, const char *sha256_hex,
                          const char *version, uint32_t *session_id, uint32_t *chunk_size,
                          fw_refusal_t *why);

/** One in-order slice of the image. */
esp_err_t fw_update_chunk(uint32_t session_id, uint32_t offset, const uint8_t *data, size_t len,
                          fw_refusal_t *why);

/**
 * Verify and apply. On the P4 the reply goes out first and the restart
 * follows a moment later; *verified is true only when the hash matched and
 * the image validated. A node target moves to "rebooting" and is watched by
 * fw_update_state().
 */
esp_err_t fw_update_end(bool *verified, fw_refusal_t *why);

/** Drop the open session, if any. Nothing is switched. */
void fw_update_abort(void);

/** True while a session is open: captures and a second BEGIN wait. */
bool fw_update_busy(void);

/** The contract's FwTargetState for a target: idle | receiving | verifying |
 *  applying | rebooting | ready | error. Polling a rebooting node is what
 *  moves it on, so call this from FW_STATUS. */
const char *fw_update_state(fw_target_t t);
/** The last error for a target, or "" when there is none. */
const char *fw_update_error(fw_target_t t);

/**
 * The running image is good: the UI is up and the host link answers. With
 * rollback enabled this is what stops the bootloader returning to the
 * previous slot on the next reset. Call once boot has reached that point.
 */
void fw_update_mark_healthy(void);

#endif
