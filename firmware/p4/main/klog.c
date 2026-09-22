#include "klog.h"

#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "clock.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

/* 600, not 200. At the rate the ring was actually being written - 1.07 lines
 * a second on a body sitting on the viewfinder - 200 entries was 3.1 minutes,
 * which is shorter than the gap between a fault happening and somebody being
 * asked about it. With the telemetry channel off the steady rate is a small
 * fraction of that, and 600 entries of PSRAM is 72 KB of a pool with tens of
 * megabytes spare. Internal SRAM, the scarce one, is untouched (#162). */
#define KLOG_CAPACITY 600
#define KLOG_MSG_MAX 96

typedef struct {
  int64_t t_ms; /* epoch ms - wall clock, may jump when a host sets the time */
  int64_t t_us; /* monotonic us since boot - ordering and deltas */
  char src[6];
  char msg[KLOG_MSG_MAX];
} klog_entry_t;

/* 24 KB in PSRAM. Written under a mutex, so never from an ISR or with the
 * flash cache off; internal SRAM is reserved for what must be internal (#162). */
static EXT_RAM_BSS_ATTR klog_entry_t s_ring[KLOG_CAPACITY];
static uint32_t s_count; /* total entries ever written, monotonic for the life of the boot */
/*
 * The first entry a reader may still see.
 *
 * klog_clear() used to set s_count back to 0, which is what stopped the field
 * log: storage_watch.c holds its own cursor into this ring, klog_export()
 * walks `while (*cursor < s_count)`, and a cursor of 3,400 against a count of
 * 0 exports nothing, for ever. One CLEAR_LOGS in Studio therefore killed
 * /KINO/LOGS for the rest of the boot, silently, which is the one file a
 * customer is asked to send. A clear now moves this line instead, so the count
 * stays monotonic and no cursor anybody holds can be left past the end.
 */
static uint32_t s_base;
static SemaphoreHandle_t s_lock;
static klog_emit_fn s_emit;
/*
 * Telemetry: a number that is worth having on a bench and worth nothing in a
 * fault report. Off unless somebody asks for it.
 *
 * Measured before this existed: 158 entries over 148 s on a body on the SHOOT
 * screen, of which 121 were per-camera preview timings and 37 were cover
 * brightness means. Not one line was anything else. The ring is for the thing
 * a person needs when a camera misbehaved, and that thing was being pushed out
 * by numbers nobody reads.
 */
static volatile bool s_telemetry;

void klog_init(void) { s_lock = xSemaphoreCreateMutex(); }

void klog_set_emitter(klog_emit_fn fn) { s_emit = fn; }

void klog_set_telemetry(bool on) { s_telemetry = on; }
bool klog_telemetry(void) { return s_telemetry; }

/* One wall clock, owned by clock.c. This used to call gettimeofday() directly,
 * which was the same reading only by accident and stopped being the same the
 * moment a host set the time: clock_set() moved KINO's epoch and left the
 * system clock alone, so `t` kept counting from power-on while capturedAt
 * reported 2026. Going through clock_now_ms() means there is one definition of
 * what time it is and `t` cannot drift away from it again. */
static int64_t now_ms(void) { return clock_now_ms(); }

int64_t klog_now_us(void) { return esp_timer_get_time(); }

/* The write itself, once, so klog() and klog_tel() cannot drift apart about
 * what an entry is. */
static void klog_put(const char *src, const char *msg) {
  /* Both clocks sampled here, before the ESP_LOGI: the console write is a
   * serial transaction and stamping after it would attribute its latency to
   * the event being logged. */
  const int64_t t = now_ms();
  const int64_t t_us = esp_timer_get_time();
  ESP_LOGI("kino", "[%s] %s", src, msg);

  if (s_lock != NULL) {
    xSemaphoreTake(s_lock, portMAX_DELAY);
    klog_entry_t *slot = &s_ring[s_count % KLOG_CAPACITY];
    slot->t_ms = t;
    slot->t_us = t_us;
    /* strlcpy, not strncpy + terminator: at -O2 GCC proves the strncpy form
     * may truncate and -Werror=stringop-truncation stops the build. */
    strlcpy(slot->src, src, sizeof slot->src);
    strlcpy(slot->msg, msg, sizeof slot->msg);
    s_count++;
    xSemaphoreGive(s_lock);
  }

  klog_emit_fn emit = s_emit;
  if (emit != NULL) emit(t, t_us, src, msg);
}

void klog(const char *src, const char *fmt, ...) {
  char msg[KLOG_MSG_MAX];
  va_list args;
  va_start(args, fmt);
  vsnprintf(msg, sizeof msg, fmt, args);
  va_end(args);
  klog_put(src, msg);
}

void klog_tel(const char *src, const char *fmt, ...) {
  if (!s_telemetry) return;
  char msg[KLOG_MSG_MAX];
  va_list args;
  va_start(args, fmt);
  vsnprintf(msg, sizeof msg, fmt, args);
  va_end(args);
  klog_put(src, msg);
}

size_t klog_export(uint32_t *cursor, char *buf, size_t cap) {
  if (s_lock == NULL || buf == NULL || cursor == NULL || cap < 128) return 0;
  size_t used = 0;
  xSemaphoreTake(s_lock, portMAX_DELAY);
  uint32_t first = s_count > KLOG_CAPACITY ? s_count - KLOG_CAPACITY : 0;
  if (first < s_base) first = s_base; /* cleared: what came before is not shown */
  if (*cursor < first) *cursor = first; /* the ring moved on; what fell out is gone */
  while (*cursor < s_count) {
    const klog_entry_t *e = &s_ring[*cursor % KLOG_CAPACITY];
    const int n = snprintf(buf + used, cap - used, "%6lld.%03lld %-5s %s\n",
                           (long long)(e->t_us / 1000000), (long long)((e->t_us / 1000) % 1000),
                           e->src, e->msg);
    if (n < 0 || (size_t)n >= cap - used) break;
    used += (size_t)n;
    (*cursor)++;
  }
  xSemaphoreGive(s_lock);
  return used;
}

void klog_clear(void) {
  if (s_lock == NULL) return;
  xSemaphoreTake(s_lock, portMAX_DELAY);
  s_base = s_count;
  xSemaphoreGive(s_lock);
}

/* Exact cJSON-encoded byte length of a string: quote, backslash and the
 * short control escapes cost 2, other control chars print as \uXXXX. */
static size_t json_string_len(const char *s) {
  size_t n = 0;
  for (; *s != '\0'; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\' || c == '\b' || c == '\f' || c == '\n' || c == '\r' || c == '\t')
      n += 2;
    else if (c < 0x20)
      n += 6;
    else
      n += 1;
  }
  return n;
}

/* Serialized cost of one entry including its separating comma. The exact
 * format is in the body - this used to describe a one-timestamp entry
 * ({"t":...} = 24 fixed chars) while the code has written both t and us for a
 * while, so the number here disagreed with the number returned. */
static size_t entry_json_cost(const klog_entry_t *entry) {
  char buf[24];
  const int t_len = snprintf(buf, sizeof buf, "%lld", (long long)entry->t_ms);
  const int us_len = snprintf(buf, sizeof buf, "%lld", (long long)entry->t_us);
  /* {"t":N,"us":N,"src":"S","msg":"M"} plus the separating comma. Exact, not
   * approximate: this decides how many real log lines survive the 16 KB
   * payload cap, and an underestimate produces a reply the client cannot
   * decode. */
  return 32 + (size_t)t_len + (size_t)us_len + json_string_len(entry->src) +
         json_string_len(entry->msg);
}

cJSON *klog_entries_json(size_t budget) {
  cJSON *entries = cJSON_CreateArray();
  if (s_lock == NULL) return entries;
  xSemaphoreTake(s_lock, portMAX_DELAY);
  const uint32_t live = s_count - s_base;
  uint32_t available = live < KLOG_CAPACITY ? live : KLOG_CAPACITY;
  uint32_t start = s_count - available;
  /* Newest entries win the budget: walk backward to the cutoff, then emit
   * forward so the array stays oldest-first. */
  size_t used = 0;
  uint32_t first = available;
  while (first > 0) {
    size_t cost = entry_json_cost(&s_ring[(start + first - 1) % KLOG_CAPACITY]);
    if (used + cost > budget) break;
    used += cost;
    first--;
  }
  for (uint32_t i = first; i < available; i++) {
    const klog_entry_t *entry = &s_ring[(start + i) % KLOG_CAPACITY];
    cJSON *item = cJSON_CreateObject();
    cJSON_AddNumberToObject(item, "t", (double)entry->t_ms);
    cJSON_AddNumberToObject(item, "us", (double)entry->t_us);
    cJSON_AddStringToObject(item, "src", entry->src);
    cJSON_AddStringToObject(item, "msg", entry->msg);
    cJSON_AddItemToArray(entries, item);
  }
  xSemaphoreGive(s_lock);
  return entries;
}
