#include "clock.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "klog.h"
#include "nvs.h"
#include "pure.h"

static const char *TAG = "clock";
static const char *NVS_NS = "clock";

/* Epoch milliseconds at the moment esp_timer read zero. Adding the timer to
 * this is the whole clock: one addition, no drift correction, no tick task. */
static int64_t s_base_ms;
static int s_offset_min;
static clock_source_t s_source = CLOCK_UNSET;

static int64_t uptime_ms(void) { return esp_timer_get_time() / 1000; }

esp_err_t clock_init(void) {
  nvs_handle_t nvs;
  if (nvs_open(NVS_NS, NVS_READONLY, &nvs) != ESP_OK) return ESP_OK; /* never set */

  int64_t saved = 0;
  int32_t off = 0;
  if (nvs_get_i64(nvs, "epoch_ms", &saved) == ESP_OK && saved > 0) {
    /* Assume no time passed while the camera was off. That is certainly wrong
     * and deliberately so: it is the only assumption that cannot date a
     * capture *earlier* than one taken before the power cycle, which is the
     * property a gallery actually depends on. */
    s_base_ms = saved - uptime_ms();
    s_source = CLOCK_PERSISTED;
    if (nvs_get_i32(nvs, "off_min", &off) == ESP_OK) s_offset_min = (int)off;
  }
  nvs_close(nvs);

  if (s_source == CLOCK_PERSISTED) {
    char iso[40];
    clock_iso8601(iso, sizeof iso);
    ESP_LOGI(TAG, "restored %s (persisted, drifts)", iso);
  } else {
    ESP_LOGW(TAG, "no stored time; captures are dated from boot until a host sets it");
  }
  return ESP_OK;
}

void clock_set(int64_t epoch_ms, int utc_offset_min) {
  /* Sanity-bound the host. 2020-01-01 is comfortably before this product
   * existed and 2100 is comfortably after it matters; anything outside is a
   * unit mix-up (seconds sent as milliseconds is the classic) and taking it
   * would date every later capture wrongly and persist that across boots. */
  if (!pure_epoch_plausible(epoch_ms)) {
    ESP_LOGW(TAG, "rejecting host time %lld ms — outside 2020..2100", (long long)epoch_ms);
    return;
  }
  utc_offset_min = pure_clamp_utc_offset_min(utc_offset_min);

  const int64_t before = clock_now_ms();
  s_base_ms = epoch_ms - uptime_ms();
  s_offset_min = utc_offset_min;
  const bool was_unset = s_source == CLOCK_UNSET;
  s_source = CLOCK_HOST;

  char iso[40];
  clock_iso8601(iso, sizeof iso);
  if (was_unset) {
    klog("P4", "clock set to %s by host", iso);
  } else {
    klog("P4", "clock set to %s by host (moved %+lld s)", iso,
         (long long)((epoch_ms - before) / 1000));
  }
}

int64_t clock_now_ms(void) { return s_base_ms + uptime_ms(); }

clock_source_t clock_source(void) { return s_source; }

const char *clock_source_str(void) {
  switch (s_source) {
    case CLOCK_HOST: return "host";
    case CLOCK_PERSISTED: return "persisted";
    default: return "unset";
  }
}

void clock_iso8601(char *out, size_t cap) {
  pure_format_iso8601(clock_now_ms(), s_offset_min, out, cap);
}

void clock_persist(void) {
  if (s_source == CLOCK_UNSET) return;

  nvs_handle_t nvs;
  if (nvs_open(NVS_NS, NVS_READWRITE, &nvs) != ESP_OK) return;
  if (nvs_set_i64(nvs, "epoch_ms", clock_now_ms()) == ESP_OK &&
      nvs_set_i32(nvs, "off_min", (int32_t)s_offset_min) == ESP_OK) {
    nvs_commit(nvs);
  }
  nvs_close(nvs);
}
