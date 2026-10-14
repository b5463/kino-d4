/* Host shim: a FreeRTOS mutex is a pthread mutex here. */
#pragma once

#include <pthread.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"

typedef pthread_mutex_t *SemaphoreHandle_t;

static inline SemaphoreHandle_t xSemaphoreCreateMutex(void) {
  pthread_mutex_t *m = malloc(sizeof *m);
  if (m != NULL) pthread_mutex_init(m, NULL);
  return m;
}
static inline BaseType_t xSemaphoreTake(SemaphoreHandle_t m, TickType_t wait) {
  (void)wait;
  pthread_mutex_lock(m);
  return pdTRUE;
}
static inline BaseType_t xSemaphoreGive(SemaphoreHandle_t m) {
  pthread_mutex_unlock(m);
  return pdTRUE;
}
