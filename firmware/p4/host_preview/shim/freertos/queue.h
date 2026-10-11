// Host shim. ui.c posts physical key presses onto a queue for the UI task to
// drain; there are no tasks and no keys here, so the queue exists only so the
// same code compiles - and holds one item, so check_wake_into_move() in
// preview.c can queue a shutter press and let ui_pass() drain it. Nothing in
// the scenes sends, so for them receive always reports empty, which is what a
// workstation with no shutter button has to say.
#pragma once
#include <string.h>
#include "freertos/FreeRTOS.h"

typedef void *QueueHandle_t;

static unsigned char shim_q_item[32];
static uint32_t shim_q_size;
static uint32_t shim_q_n;

static inline QueueHandle_t xQueueCreate(uint32_t len, uint32_t item_size) {
  (void)len;
  shim_q_size = item_size <= sizeof shim_q_item ? item_size : (uint32_t)sizeof shim_q_item;
  shim_q_n = 0;
  /* Not NULL: ui.c logs an error on a failed create, and a preview run is not
   * the place to report an out-of-memory that did not happen. */
  return (QueueHandle_t)1;
}
static inline BaseType_t xQueueSend(QueueHandle_t q, const void *item, uint32_t wait) {
  (void)q;
  (void)wait;
  if (shim_q_n != 0 || item == NULL) return pdFALSE;
  memcpy(shim_q_item, item, shim_q_size);
  shim_q_n = 1;
  return pdTRUE;
}
static inline BaseType_t xQueueReceive(QueueHandle_t q, void *out, uint32_t wait) {
  (void)q;
  (void)wait;
  if (shim_q_n == 0 || out == NULL) return pdFALSE;
  memcpy(out, shim_q_item, shim_q_size);
  shim_q_n = 0;
  return pdTRUE;
}
static inline uint32_t uxQueueMessagesWaiting(QueueHandle_t q) {
  (void)q;
  return shim_q_n;
}
