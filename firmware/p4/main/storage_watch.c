#include "storage_watch.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/task.h"
#include "klog.h"
#include "nvs.h"
#include "storage.h"

#define WATCH_PERIOD_MS 2000
#define REMOUNT_EVERY 5   /* periods: an empty slot is tried every 10 s */
#define LOG_FLUSH_EVERY 15 /* periods: 30 s */
#define LOG_DIR "/sdcard/KINO/LOGS"
#define LOG_KEEP 20
#define LOG_BUF 4096

static volatile uint8_t s_events[4];
static volatile int s_ev_head, s_ev_tail;

static void push(storage_event_t ev) {
  const int next = (s_ev_head + 1) % 4;
  if (next == s_ev_tail) return; /* the UI is two seconds behind; drop the oldest news */
  s_events[s_ev_head] = (uint8_t)ev;
  s_ev_head = next;
}

bool storage_watch_take(storage_event_t *out) {
  if (s_ev_tail == s_ev_head) return false;
  *out = (storage_event_t)s_events[s_ev_tail];
  s_ev_tail = (s_ev_tail + 1) % 4;
  return true;
}

/* ---------------------------------------------------------------- field log */

static uint32_t s_boot;
static uint32_t s_log_cursor;
static char s_log_path[48];
static char *s_log_buf; /* LOG_BUF, PSRAM */

static uint32_t boot_count(void) {
  nvs_handle_t nvs;
  uint32_t n = 0;
  if (nvs_open("kino", NVS_READONLY, &nvs) == ESP_OK) {
    nvs_get_u32(nvs, "boot", &n);
    nvs_close(nvs);
  }
  return n;
}

/* Keep the newest LOG_KEEP files. Names sort by boot number, so the oldest
 * is the smallest name; one pass finds it, repeated while there are too
 * many. Twenty files is a handful of directory reads. */
static void prune_logs(void) {
  for (int round = 0; round < 8; round++) {
    DIR *d = opendir(LOG_DIR);
    if (d == NULL) return;
    int n = 0;
    char oldest[32] = "";
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
      if (strncmp(e->d_name, "BOOT-", 5) != 0) continue;
      n++;
      if (oldest[0] == '\0' || strcmp(e->d_name, oldest) < 0) {
        strlcpy(oldest, e->d_name, sizeof oldest);
      }
    }
    closedir(d);
    if (n <= LOG_KEEP || oldest[0] == '\0') return;
    char path[64];
    snprintf(path, sizeof path, LOG_DIR "/%s", oldest);
    unlink(path);
  }
}

static void flush_log(void) {
  if (s_log_buf == NULL) return;
  if (!storage_acquire(STORAGE_USER_UI, 0)) return; /* someone is using the card; next time */
  mkdir("/sdcard/KINO", 0775);
  mkdir(LOG_DIR, 0775);
  static bool pruned;
  if (!pruned) {
    prune_logs();
    pruned = true;
  }
  FILE *f = fopen(s_log_path, "a");
  if (f != NULL) {
    static bool announced;
    if (!announced) {
      announced = true;
      klog("SD", "field log: %s", s_log_path); /* once, so the file is findable from the log */
    }
    for (;;) {
      const size_t n = klog_export(&s_log_cursor, s_log_buf, LOG_BUF);
      if (n == 0) break;
      fwrite(s_log_buf, 1, n, f);
    }
    fclose(f);
  }
  storage_release(STORAGE_USER_UI);
}

/* ---------------------------------------------------------------- the task */

static void watch_task(void *arg) {
  (void)arg;
  bool was_mounted = storage_present();
  bool tested = false;
  int tick = 0;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(WATCH_PERIOD_MS));
    tick++;
    if (storage_present()) {
      if (!storage_card_alive()) {
        /* Gone. storage_card_alive() has unmounted it and set the removed
         * flag the conditions read. */
        was_mounted = false;
        tested = false;
        push(STORAGE_EV_REMOVED);
        klog("SD", "card removed while running");
        continue;
      }
      if (!was_mounted) {
        was_mounted = true;
        push(STORAGE_EV_MOUNTED);
      }
      if (!tested) {
        /* Once per card: the write test, so a card that cannot hold a
         * photograph is named before one is lost to it. */
        tested = true;
        if (storage_acquire(STORAGE_USER_UI, 3000)) {
          storage_selftest_result_t st;
          storage_self_test(&st);
          storage_release(STORAGE_USER_UI);
        }
      }
      if (tick % LOG_FLUSH_EVERY == 0) flush_log();
    } else if (tick % REMOUNT_EVERY == 0) {
      /* Quietly: a slot that stays empty would otherwise log a failed mount
       * every ten seconds for the whole session. */
      if (storage_remount() == ESP_OK) {
        klog("SD", "card mounted while running");
        /* The next pass sees it present and announces it. */
      }
    }
  }
}

esp_err_t storage_watch_start(void) {
  s_boot = boot_count();
  snprintf(s_log_path, sizeof s_log_path, LOG_DIR "/BOOT-%05lu.TXT", (unsigned long)s_boot);
  s_log_buf = heap_caps_malloc(LOG_BUF, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  /* The stack in PSRAM: this task touches the card and the log, never flash. */
  if (xTaskCreateWithCaps(watch_task, "cardwatch", 6144, NULL, 2, NULL, MALLOC_CAP_SPIRAM) !=
      pdPASS) {
    return ESP_ERR_NO_MEM;
  }
  return ESP_OK;
}
