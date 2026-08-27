#include "gallery.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "storage.h"
#include "taskmon.h"
#include "thumb.h"

static const char *TAG = "gallery";

#define CAPTURES_DIR "/sdcard/KINO/CAPTURES"

/* How many capture folders the camera will page through. A 32 GB card holds
 * thousands, and holding every name would cost 40 KB for a list nobody scrolls
 * to the end of. The newest are what anyone is looking for, so the scan keeps
 * the last MAX_SCAN by name and says so when there are more. */
#define MAX_SCAN 240

static char (*s_names)[40];
static int s_total;
static int s_page;
static SemaphoreHandle_t s_lock;
static TaskHandle_t s_task;
static volatile bool s_dirty;   /* the page needs decoding */
static volatile bool s_loading;

static gallery_item_t s_slot[GALLERY_PAGE];
static uint16_t *s_pixels[GALLERY_PAGE];

static void lock(void) { xSemaphoreTake(s_lock, portMAX_DELAY); }
static void unlock(void) { xSemaphoreGive(s_lock); }

/* ---------------------------------------------------------------- */
/* scanning                                                          */
/* ---------------------------------------------------------------- */

/**
 * Capture folder names, newest last.
 *
 * Names are UUIDs, so they do not sort by time — the order here is directory
 * order made stable by sorting, not chronological. What makes the newest
 * findable is that a capture's META.JSON carries its own id and time; the
 * page a person wants is the last one, and that is where a fresh capture
 * appears because FAT appends.
 */
static int scan(void) {
  DIR *d = opendir(CAPTURES_DIR);
  if (d == NULL) return 0;
  int count = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (e->d_name[0] == '.') continue;
    const size_t len = strlen(e->d_name);
    if (len == 0 || len >= 40) continue;
    if (count < MAX_SCAN) {
      memcpy(s_names[count], e->d_name, len + 1);
    } else {
      /* Past the cap, keep shifting so the newest survive rather than the
       * oldest — a full card would otherwise show only history. */
      memmove(s_names[0], s_names[1], (size_t)(MAX_SCAN - 1) * 40);
      memcpy(s_names[MAX_SCAN - 1], e->d_name, len + 1);
    }
    count++;
  }
  closedir(d);
  if (count > MAX_SCAN) {
    ESP_LOGW(TAG, "%d captures on the card; showing the last %d", count, MAX_SCAN);
    count = MAX_SCAN;
  }
  return count;
}

/** Fill in what META.JSON says about one capture. */
static void read_meta(gallery_item_t *it) {
  snprintf(it->label, sizeof it->label, "%.*s", 8, it->id);
  snprintf(it->mode, sizeof it->mode, "%s", "-");
  it->frames = 0;
  it->partial = false;

  char path[200];
  snprintf(path, sizeof path, "%s/%s/META.JSON", CAPTURES_DIR, it->id);
  FILE *f = fopen(path, "rb");
  if (f == NULL) return;
  char buf[1024];
  const size_t got = fread(buf, 1, sizeof buf - 1, f);
  fclose(f);
  buf[got] = '\0';

  cJSON *m = cJSON_Parse(buf);
  if (m == NULL) return;
  const cJSON *id = cJSON_GetObjectItem(m, "id");
  if (cJSON_IsString(id) && id->valuestring) {
    snprintf(it->label, sizeof it->label, "%s", id->valuestring);
  }
  const cJSON *mode = cJSON_GetObjectItem(m, "mode");
  if (cJSON_IsString(mode) && mode->valuestring) {
    snprintf(it->mode, sizeof it->mode, "%s", mode->valuestring);
  }
  const cJSON *n = cJSON_GetObjectItem(m, "frameCount");
  if (cJSON_IsNumber(n)) it->frames = (int)n->valuedouble;
  const cJSON *st = cJSON_GetObjectItem(m, "status");
  it->partial = cJSON_IsString(st) && st->valuestring && strcmp(st->valuestring, "partial") == 0;
  cJSON_Delete(m);
}

/* ---------------------------------------------------------------- */
/* decoding                                                          */
/* ---------------------------------------------------------------- */

/** THUMB.JPG first, then the frames. A capture from firmware without
 * thumbnails still shows, just slower — and one whose CAM1 failed shows
 * whichever camera did work. */
static bool load_tile(gallery_item_t *it, uint16_t *pixels) {
  static const char *TRY[] = {"THUMB.JPG", "C1.JPG", "C2.JPG", "C3.JPG", "C4.JPG"};
  char path[200];
  for (size_t i = 0; i < sizeof TRY / sizeof TRY[0]; i++) {
    snprintf(path, sizeof path, "%s/%s/%s", CAPTURES_DIR, it->id, TRY[i]);
    if (thumb_load(path, pixels, GALLERY_TILE_W, GALLERY_TILE_H, 0x0000) == ESP_OK) return true;
  }
  return false;
}

static void gallery_task(void *arg) {
  (void)arg;
  for (;;) {
    if (!s_dirty) {
      vTaskDelay(pdMS_TO_TICKS(80));
      continue;
    }
    s_dirty = false;
    s_loading = true;

    /* Take a copy of what to decode, then work outside the lock: a decode is
     * tens of milliseconds and the draw loop reads these slots every frame. */
    char want[GALLERY_PAGE][40];
    int n = 0;
    lock();
    const int base = s_page * GALLERY_PAGE;
    for (int i = 0; i < GALLERY_PAGE; i++) {
      const int idx = base + i;
      if (idx < s_total) {
        snprintf(want[i], sizeof want[i], "%s", s_names[idx]);
        n++;
      } else {
        want[i][0] = '\0';
      }
    }
    unlock();

    for (int i = 0; i < GALLERY_PAGE; i++) {
      if (s_dirty) break; /* the page changed under us; start again */
      gallery_item_t it;
      memset(&it, 0, sizeof it);
      if (want[i][0] == '\0') {
        lock();
        s_slot[i] = it; /* TILE_EMPTY, no pixels */
        unlock();
        continue;
      }
      snprintf(it.id, sizeof it.id, "%s", want[i]);
      read_meta(&it);
      const bool ok = load_tile(&it, s_pixels[i]);
      it.state = ok ? TILE_READY : TILE_NO_IMAGE;
      it.pixels = ok ? s_pixels[i] : NULL;
      lock();
      s_slot[i] = it;
      unlock();
    }
    s_loading = false;
    ESP_LOGI(TAG, "page %d/%d, %d captures", s_page + 1, gallery_pages(), n);
  }
}

/* ---------------------------------------------------------------- */
/* interface                                                         */
/* ---------------------------------------------------------------- */

void gallery_refresh(void) {
  if (s_lock == NULL) return;
  lock();
  s_total = storage_present() ? scan() : 0;
  const int pages = gallery_pages();
  if (s_page >= pages) s_page = pages > 0 ? pages - 1 : 0;
  for (int i = 0; i < GALLERY_PAGE; i++) {
    /* Everything is pending until the task says otherwise, so the screen
     * never shows a stale picture under a new capture's label. */
    memset(&s_slot[i], 0, sizeof s_slot[i]);
    if (s_page * GALLERY_PAGE + i < s_total) s_slot[i].state = TILE_PENDING;
  }
  unlock();
  s_dirty = true;
}

int gallery_total(void) { return s_total; }
int gallery_page(void) { return s_page; }

int gallery_pages(void) {
  return s_total > 0 ? (s_total + GALLERY_PAGE - 1) / GALLERY_PAGE : 1;
}

void gallery_turn(int delta) {
  if (s_lock == NULL) return;
  const int pages = gallery_pages();
  int want = s_page + delta;
  if (want < 0) want = 0;
  if (want >= pages) want = pages - 1;
  if (want == s_page) return;
  lock();
  s_page = want;
  for (int i = 0; i < GALLERY_PAGE; i++) {
    memset(&s_slot[i], 0, sizeof s_slot[i]);
    if (s_page * GALLERY_PAGE + i < s_total) s_slot[i].state = TILE_PENDING;
  }
  unlock();
  s_dirty = true;
}

const gallery_item_t *gallery_slots(void) { return s_slot; }

bool gallery_loading(void) { return s_loading || s_dirty; }

esp_err_t gallery_init(void) {
  if (s_lock != NULL) return ESP_OK;
  s_lock = xSemaphoreCreateMutex();
  if (s_lock == NULL) return ESP_ERR_NO_MEM;

  s_names = heap_caps_malloc((size_t)MAX_SCAN * 40, MALLOC_CAP_SPIRAM);
  if (s_names == NULL) return ESP_ERR_NO_MEM;
  for (int i = 0; i < GALLERY_PAGE; i++) {
    s_pixels[i] = heap_caps_malloc((size_t)GALLERY_TILE_W * GALLERY_TILE_H * 2,
                                   MALLOC_CAP_SPIRAM);
    if (s_pixels[i] == NULL) return ESP_ERR_NO_MEM;
  }

  /* 4 KB: cJSON parses a 1 KB metadata file on this stack; the pictures are
   * in PSRAM and the decode buffers belong to thumb.c. */
  if (xTaskCreate(gallery_task, "gallery", 4096, NULL, 4, &s_task) != pdPASS) {
    return ESP_ERR_NO_MEM;
  }
  taskmon_register("gallery", s_task);
  ESP_LOGI(TAG, "ready — %dx%d tiles, %d per page", GALLERY_TILE_W, GALLERY_TILE_H,
           GALLERY_PAGE);
  return ESP_OK;
}
