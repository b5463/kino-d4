// Host shim.
#pragma once
#include "freertos/FreeRTOS.h"

static inline void vTaskDelay(uint32_t t) { (void)t; }
static inline BaseType_t xTaskCreate(void (*fn)(void *), const char *name, uint32_t stack,
                                     void *arg, int prio, TaskHandle_t *out) {
  (void)fn;
  (void)name;
  (void)stack;
  (void)arg;
  (void)prio;
  if (out) *out = 0;
  return pdPASS;
}
static inline TaskHandle_t xTaskGetCurrentTaskHandle(void) { return 0; }
static inline uint32_t ulTaskNotifyTake(int clear, uint32_t wait) {
  (void)clear;
  (void)wait;
  return 0;
}
static inline void xTaskNotifyGive(TaskHandle_t t) { (void)t; }
static inline void vTaskDelete(TaskHandle_t t) { (void)t; }
