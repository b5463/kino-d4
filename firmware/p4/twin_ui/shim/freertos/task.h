// Twin (wasm) shim: a delay advances the virtual clock (see esp_timer.h).
// Tasks are never created - the harness steps ui_pass() itself.
#pragma once
#include "freertos/FreeRTOS.h"
void kui_delay_ms(uint32_t ms);
static inline void vTaskDelay(uint32_t t) { kui_delay_ms(t); }
static inline BaseType_t xTaskCreate(void (*fn)(void *), const char *name, uint32_t stack,
                                     void *arg, int prio, TaskHandle_t *out) {
  (void)fn; (void)name; (void)stack; (void)arg; (void)prio;
  if (out) *out = (TaskHandle_t)1;
  return pdPASS;
}
static inline BaseType_t xTaskCreatePinnedToCore(void (*fn)(void *), const char *name,
                                                 uint32_t stack, void *arg, int prio,
                                                 TaskHandle_t *out, int core) {
  (void)core;
  return xTaskCreate(fn, name, stack, arg, prio, out);
}
static inline void vTaskDelete(TaskHandle_t h) { (void)h; }
/* Notifications, as in the host shim: nothing waits on anything here. */
static inline TaskHandle_t xTaskGetCurrentTaskHandle(void) { return (TaskHandle_t)1; }
static inline uint32_t ulTaskNotifyTake(int clear, uint32_t wait) {
  (void)clear; (void)wait;
  return 0;
}
static inline void xTaskNotifyGive(TaskHandle_t t) { (void)t; }
