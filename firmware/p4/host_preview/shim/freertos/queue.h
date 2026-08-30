// Host shim. ui.c posts physical key presses onto a queue for the UI task to
// drain; there are no tasks and no keys here, so the queue exists only so the
// same code compiles. Create succeeds, send accepts and discards, receive
// always reports empty - which is exactly what a workstation with no shutter
// button has to say.
#pragma once
#include "freertos/FreeRTOS.h"

typedef void *QueueHandle_t;

static inline QueueHandle_t xQueueCreate(uint32_t len, uint32_t item_size) {
  (void)len;
  (void)item_size;
  /* Not NULL: ui.c logs an error on a failed create, and a preview run is not
   * the place to report an out-of-memory that did not happen. */
  return (QueueHandle_t)1;
}
static inline BaseType_t xQueueSend(QueueHandle_t q, const void *item, uint32_t wait) {
  (void)q;
  (void)item;
  (void)wait;
  return pdTRUE;
}
static inline BaseType_t xQueueReceive(QueueHandle_t q, void *out, uint32_t wait) {
  (void)q;
  (void)out;
  (void)wait;
  return pdFALSE;
}
