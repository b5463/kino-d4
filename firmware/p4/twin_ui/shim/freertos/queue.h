// Twin (wasm) shim: a real, single-threaded queue.
//
// host_preview's queue is a stub that stores nothing, which is right for a
// renderer. The Twin needs the physical keys to work - the SHUTTER button on
// the panel goes through ui.c's on_button() -> queue -> drain_buttons() path,
// exactly as the buttons task feeds it on the camera - so this one keeps its
// items. One queue is enough: ui.c creates one.
#pragma once
#include <string.h>
#include "freertos/FreeRTOS.h"

typedef struct kui_queue *QueueHandle_t;
QueueHandle_t kui_queue_create(uint32_t len, uint32_t item_size);
BaseType_t kui_queue_send(QueueHandle_t q, const void *item);
BaseType_t kui_queue_receive(QueueHandle_t q, void *out);
uint32_t kui_queue_waiting(QueueHandle_t q);

static inline QueueHandle_t xQueueCreate(uint32_t len, uint32_t item_size) {
  return kui_queue_create(len, item_size);
}
static inline BaseType_t xQueueSend(QueueHandle_t q, const void *item, uint32_t wait) {
  (void)wait;
  return kui_queue_send(q, item);
}
static inline BaseType_t xQueueReceive(QueueHandle_t q, void *out, uint32_t wait) {
  (void)wait;
  return kui_queue_receive(q, out);
}
/* ui.c peeks at the queue to let a key cut the splash short. */
static inline uint32_t uxQueueMessagesWaiting(QueueHandle_t q) { return kui_queue_waiting(q); }
