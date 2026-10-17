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
/* ui_start() pins the compositor to CPU1. Declared here rather than left to
 * an implicit declaration, which is what it was: the preview never calls
 * ui_start(), so the call only had to compile, and it did - with a warning
 * nobody read and a return value nobody could check. */
static inline BaseType_t xTaskCreatePinnedToCore(void (*fn)(void *), const char *name,
                                                 uint32_t stack, void *arg, int prio,
                                                 TaskHandle_t *out, int core) {
  (void)fn;
  (void)name;
  (void)stack;
  (void)arg;
  (void)prio;
  (void)core;
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
/* A move raises the UI task while it runs (ui.c, UI_MOVE_PRIO); no tasks here. */
static inline void vTaskPrioritySet(TaskHandle_t t, int prio) {
  (void)t;
  (void)prio;
}
static inline void vTaskDelete(TaskHandle_t t) { (void)t; }

/* The calibration task parks itself and the UI task deletes it (ui.c
 * calib_task). Nothing is created here, so nothing is ever parked. */
typedef enum { eRunning = 0, eReady, eBlocked, eSuspended, eDeleted, eInvalid } eTaskState;
static inline void vTaskSuspend(TaskHandle_t t) { (void)t; }
static inline eTaskState eTaskGetState(TaskHandle_t t) {
  (void)t;
  return eSuspended;
}
static inline void vTaskDeleteWithCaps(TaskHandle_t t) { (void)t; }
