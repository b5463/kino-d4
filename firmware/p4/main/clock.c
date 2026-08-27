#include "clock.h"

#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "esp_log.h"
#include "klog.h"
#include "nvs.h"
#include "pure.h"

static const char *TAG = "clock";
static const char *NVS_NS = "clock";

/* KINO's wall time IS the ESP-IDF system clock.
 *
 * It used to be a private epoch base plus esp_timer, which meant the device
 * carried two unrelated wall clocks: clock_set() moved this one and left
 * settimeofday() alone, so klog's timestamps, FAT's file dates and anything
 * else reading gettimeofday() went on counting from power-on while
 * capturedAt reported the host's date. The bring-up log caught it in the
 * plainest possible form — the entry announcing "clock set to
 * 2026-08-27T19:38:44+02:00 by host" carried t=526536, about nine minutes
 * past 1970.
 *
 * So there is one wall clock now and this module owns the policy around it
 * rather than a second copy of the time. What stays here is the metadata the
 * system clock cannot hold: where the time came from, and the UTC offset to
 * print it in.
 *
 * esp_timer_get_time() is untouched and remains the monotonic clock for
 * klog.us, capture timing and every performance measurement. That separation
 * is the point: a wall-clock correction must be free to jump, and durations
 * must be free of it. */
static int s_offset_min;
static clock_source_t s_source = CLOCK_UNSET;

static int64_t wall_now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (int64_t)tv.tv_sec * 1000 + (int64_t)tv.tv_usec / 1000;
}

static void wall_set_ms(int64_t epoch_ms) {
  struct timeval tv = {
      .tv_sec = (time_t)(epoch_ms / 1000),
      .tv_usec = (suseconds_t)((epoch_ms % 1000) * 1000),
  };
  settimeofday(&tv, NULL);
}

esp_err_t clock_init(void) {
  int64_t saved = 0;
  bool have_saved = false;
  nvs_handle_t nvs;
  if (nvs_open(NVS_NS, NVS_READONLY, &nvs) == ESP_OK) {
    have_saved = nvs_get_i64(nvs, "epoch_ms", &saved) == ESP_OK;
    int32_t off = 0;
    /* The offset is metadata and is restored either way: it says how to print
     * a time, not what the time is. */
    if (nvs_get_i32(nvs, "off_min", &off) == ESP_OK) s_offset_min = (int)off;
    nvs_close(nvs);
  }

  /* Assume no time passed while the camera was off. That is certainly wrong
   * and deliberately so: it is the only assumption that cannot date a capture
   * *earlier* than one taken before the power cycle, which is the property a
   * gallery actually depends on. */
  const int64_t system_now = wall_now_ms();
  switch (pure_clock_restore_action(have_saved, saved, system_now)) {
    case PURE_CLOCK_RESTORE_SAVED:
      wall_set_ms(saved);
      s_source = CLOCK_PERSISTED;
      break;
    case PURE_CLOCK_KEEP_SYSTEM:
      /* The RTC kept running across the reset and already reads later than the
       * snapshot in NVS. Moving it back would date the next capture before one
       * already on the card. */
      s_source = CLOCK_PERSISTED;
      break;
    case PURE_CLOCK_UNSET:
    default:
      s_source = CLOCK_UNSET;
      break;
  }

  if (s_source == CLOCK_PERSISTED) {
    char iso[40];
    clock_iso8601(iso, sizeof iso);
    ESP_LOGI(TAG, "restored %s (persisted, drifts)", iso);
  } else {
    if (have_saved) {
      ESP_LOGW(TAG, "ignoring stored time %lld ms — outside 2020..2100",
               (long long)saved);
    }
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
  wall_set_ms(epoch_ms);
  s_offset_min = utc_offset_min;
  const bool was_unset = s_source == CLOCK_UNSET;
  s_source = CLOCK_HOST;

  /* Host time is authoritative, so it survives the reboot rather than waiting
   * for whatever else happens to call clock_persist(). This is also what makes
   * the never-move-backwards rule in clock_init() meaningful: NVS now holds a
   * real host-derived time to compare the RTC against. */
  clock_persist();

  char iso[40];
  clock_iso8601(iso, sizeof iso);
  if (was_unset) {
    klog("P4", "clock set to %s by host", iso);
  } else {
    klog("P4", "clock set to %s by host (moved %+lld s)", iso,
         (long long)((epoch_ms - before) / 1000));
  }
}

int64_t clock_now_ms(void) { return wall_now_ms(); }

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
