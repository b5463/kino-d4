#include "klog.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#define KLOG_CAPACITY 200
#define KLOG_MSG_MAX 96

typedef struct {
  int64_t t_ms;
  char src[6];
  char msg[KLOG_MSG_MAX];
} klog_entry_t;

static klog_entry_t s_ring[KLOG_CAPACITY];
static uint32_t s_count; /* total entries ever written */
static SemaphoreHandle_t s_lock;
static klog_emit_fn s_emit;

void klog_init(void) { s_lock = xSemaphoreCreateMutex(); }

void klog_set_emitter(klog_emit_fn fn) { s_emit = fn; }

static int64_t now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

void klog(const char *src, const char *fmt, ...) {
  char msg[KLOG_MSG_MAX];
  va_list args;
  va_start(args, fmt);
  vsnprintf(msg, sizeof msg, fmt, args);
  va_end(args);

  int64_t t = now_ms();
  ESP_LOGI("kino", "[%s] %s", src, msg);

  if (s_lock != NULL) {
    xSemaphoreTake(s_lock, portMAX_DELAY);
    klog_entry_t *slot = &s_ring[s_count % KLOG_CAPACITY];
    slot->t_ms = t;
    strncpy(slot->src, src, sizeof slot->src - 1);
    slot->src[sizeof slot->src - 1] = '\0';
    strncpy(slot->msg, msg, sizeof slot->msg - 1);
    slot->msg[sizeof slot->msg - 1] = '\0';
    s_count++;
    xSemaphoreGive(s_lock);
  }

  klog_emit_fn emit = s_emit;
  if (emit != NULL) emit(t, src, msg);
}

void klog_clear(void) {
  if (s_lock == NULL) return;
  xSemaphoreTake(s_lock, portMAX_DELAY);
  s_count = 0;
  xSemaphoreGive(s_lock);
}

cJSON *klog_entries_json(void) {
  cJSON *entries = cJSON_CreateArray();
  if (s_lock == NULL) return entries;
  xSemaphoreTake(s_lock, portMAX_DELAY);
  uint32_t available = s_count < KLOG_CAPACITY ? s_count : KLOG_CAPACITY;
  uint32_t start = s_count - available;
  for (uint32_t i = 0; i < available; i++) {
    const klog_entry_t *entry = &s_ring[(start + i) % KLOG_CAPACITY];
    cJSON *item = cJSON_CreateObject();
    cJSON_AddNumberToObject(item, "t", (double)entry->t_ms);
    cJSON_AddStringToObject(item, "src", entry->src);
    cJSON_AddStringToObject(item, "msg", entry->msg);
    cJSON_AddItemToArray(entries, item);
  }
  xSemaphoreGive(s_lock);
  return entries;
}
