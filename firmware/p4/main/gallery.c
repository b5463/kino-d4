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
static volatile bool s_rescan; /* a caller asked for a fresh scan */

static gallery_item_t s_slot[GALLERY_PAGE];
static uint16_t *s_pixels[GALLERY_PAGE];

static void lock(void) { xSemaphoreTake(s_lock, portMAX_DELAY); }
static void unlock(void) { xSemaphoreGive(s_lock); }

/* ---------------------------------------------------------------- */
/* scanning                                                          */
/* ---------------------------------------------------------------- */

/*
 * File scratch, deliberately not on any stack.
 *
 * Two owners, and they must stay two separate buffers because they run at the
 * same time on different tasks:
 *
 *   s_scan_*  belongs to whoever calls gallery_refresh(), which is the UI task
 *             (8 KB, from go() when the gallery screen opens), the capture
 *             task (6 KB, from the capture-done callback) and the delete
 *             dialog. gallery_refresh() holds s_lock across the whole of
 *             scan(), and scan() is capture_taken_ms()'s only caller, so one
 *             scan at a time is guaranteed by that mutex, not by convention.
 *
 *   s_tile_*  belongs to the gallery task alone. gallery_task() is the only
 *             caller of read_meta() and load_tile(), and it calls them one
 *             tile at a time, so nothing else can be in them.
 *
 * As locals these were 200 + 512 bytes per capture folder in capture_taken_ms
 * and 200 + 1024 in read_meta, on top of the ~600 bytes the newlib/VFS/FatFs
 * fopen chain needs below them. That overflowed the UI task's 8 KB the moment
 * the gallery screen opened, and the canary panic rebooted the camera before
 * a single tile drew. 5008 bytes of .bss against that is cheap, and none of it
 * is on a stack that a deeper VFS call could push over.
 */
static char s_scan_path[200];
static char s_scan_head[512];
static char s_tile_path[200];
/*
 * 4096, not 1024.
 *
 * A META.JSON measures ~879 B with one frame, ~1076 with two and ~1470 with
 * four, so every capture with more than one camera in it was read as a
 * truncated document. cJSON_Parse then returned NULL, read_meta() gave up
 * silently, and the tile showed the first eight characters of a UUID with mode
 * "-" and no frame count - a gallery that got less informative the more
 * cameras were fitted. 4096 is roughly 2.8x the measured four-frame document,
 * and the truncation is now reported rather than inferred.
 */
#define TILE_META_MAX 4096
static char s_tile_meta[TILE_META_MAX];

/* Whether the truncation warning has already been logged. Once per boot: a
 * document that does not fit is a fact about the firmware, not about the
 * capture, so the second hundred lines say nothing the first did not. */
static bool s_meta_truncated_logged;

/** The capture's own timestamp out of a META.JSON text, 0 when not found. */
static uint64_t captured_at_ms_in(const char *json) {
  const char *k = strstr(json, "capturedAtMs");
  if (k == NULL) return 0;
  k = strchr(k, ':');
  if (k == NULL) return 0;
  return strtoull(k + 1, NULL, 10);
}

/*
 * When a capture was taken, from its META.JSON.
 *
 * stat() was tried first, on both the folder and its META.JSON, and both came
 * back with times that sorted every capture equal - so the list stayed in
 * readdir order, which for UUID names is meaningless. capturedAtMs is written
 * by the capture itself and is demonstrably right.
 *
 * A bounded fread and a strstr, not a cJSON parse: this runs once per capture
 * on the card purely to order them, and the six on the page a person is
 * looking at still get a full parse in read_meta().
 */
static uint64_t capture_taken_ms(const char *dir_name) {
  snprintf(s_scan_path, sizeof s_scan_path, "%s/%s/META.JSON", CAPTURES_DIR, dir_name);
  FILE *f = fopen(s_scan_path, "rb");
  if (f == NULL) return 0;
  const size_t got = fread(s_scan_head, 1, sizeof s_scan_head - 1, f);
  s_scan_head[got] = 0;
  uint64_t when = captured_at_ms_in(s_scan_head);

  /*
   * The head is a fast path, not a limit.
   *
   * capturedAtMs sits in the first 512 bytes of every document this firmware
   * writes (host-tested in test_meta.c), so the fread above almost always
   * answers. But a document from another firmware version, or one whose key
   * order differs, would have sorted at time 0 - and a capture at time 0 sorts
   * last, so the newest picture on the card could land off the end of the
   * list. Only reached when the head filled AND the key was not in it, so the
   * cost is paid by the capture that needs it and by nothing else.
   */
  if (when == 0 && got == sizeof s_scan_head - 1) {
    char *whole = heap_caps_malloc(TILE_META_MAX, MALLOC_CAP_SPIRAM);
    if (whole != NULL) {
      rewind(f);
      const size_t all = fread(whole, 1, TILE_META_MAX - 1, f);
      whole[all] = '\0';
      when = captured_at_ms_in(whole);
      heap_caps_free(whole);
    }
  }
  /* One close, on every path: 240 of these run back to back and max_files
   * is 8, so a leaked handle costs the eighth capture its date and the ninth
   * its tile. */
  fclose(f);
  return when;
}

/** Newest first. Filled by scan(), read through s_order. */
static uint64_t s_mtime[MAX_SCAN];
static uint16_t s_order[MAX_SCAN];

static int by_newest(const void *a, const void *b) {
  const uint64_t ta = s_mtime[*(const uint16_t *)a];
  const uint64_t tb = s_mtime[*(const uint16_t *)b];
  if (ta < tb) return 1; /* descending: newest first */
  if (ta > tb) return -1;
  return 0;
}

/**
 * Capture folder names, newest FIRST.
 *
 * Folder names are UUIDs, so readdir order is neither chronological nor
 * stable, and the old code took whatever FAT handed back and hoped the newest
 * landed last. On the bench it did not: the card came back ordered 007f5d03,
 * 049c0c3e, 05089a35 - alphabetical - so the first page showed the oldest
 * pictures and a shot just taken could be pages away.
 *
 * The time comes from stat() on the capture's META.JSON - one stat per
 * capture against a JSON parse per capture, and the page a person opens still
 * reads META for its own six. It is the file rather than the folder because
 * stat() on the directory came back with no usable mtime through
 * esp_vfs_fat and every capture sorted equal, which left the order exactly as
 * wrong as before. FAT stores mtime at 2-second
 * resolution, which cannot separate two captures in the same 2 s window - the
 * shutter cannot fire that fast, so it does not arise.
 *
 * Returns the number of names collected, or -1 when it gave the card back to a
 * capture before finishing. -1 is not an error and not an empty card: the
 * caller keeps the list it has and asks again.
 */
static int scan(void) {
  /* Arbitrated like every other reader. load_tile() takes this and the scan
   * that precedes it did not, so the contention load_tile exists to avoid was
   * reintroduced by the 86 META.JSON reads in front of it. Same 2 s budget: a
   * capture holds the card and a gallery that cannot read it says so rather
   * than fighting for it. */
  if (!storage_acquire(STORAGE_USER_UI, 2000)) return 0;
  DIR *d = opendir(CAPTURES_DIR);
  if (d == NULL) {
    storage_release(STORAGE_USER_UI);
    return 0;
  }
  int count = 0;
  int total = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    /*
     * Let go the moment photography wants the card.
     *
     * This walk is one META.JSON read per capture folder - up to 240 of them,
     * 5-15 ms each - and it held STORAGE_USER_UI for all of it. A shutter press
     * landing mid-scan waited out the whole walk, which is precisely the stall
     * storage_yield_requested() exists to end: the lock is priority-ordered,
     * but only for a holder that asks. Checked per entry, so the capture waits
     * for one folder rather than for the card.
     *
     * The scan is abandoned, not truncated - a partial list sorted by a partial
     * set of timestamps is a gallery in the wrong order. The caller keeps the
     * list it already had and comes back on the next tick.
     */
    if (storage_yield_requested(STORAGE_USER_UI)) {
      closedir(d);
      storage_release(STORAGE_USER_UI);
      return -1;
    }
    if (e->d_name[0] == '.') continue;
    const size_t len = strlen(e->d_name);
    if (len == 0 || len >= 40) continue;
    total++;

    const uint64_t when = capture_taken_ms(e->d_name);

    if (count < MAX_SCAN) {
      memcpy(s_names[count], e->d_name, len + 1);
      s_mtime[count] = when;
      count++;
      continue;
    }
    /* Past the cap, evict the oldest rather than the first seen - a full card
     * would otherwise show only history. */
    int oldest = 0;
    for (int i = 1; i < MAX_SCAN; i++) {
      if (s_mtime[i] < s_mtime[oldest]) oldest = i;
    }
    if (when > s_mtime[oldest]) {
      memcpy(s_names[oldest], e->d_name, len + 1);
      s_mtime[oldest] = when;
    }
  }
  closedir(d);
  if (total > MAX_SCAN) {
    ESP_LOGW(TAG, "%d captures on the card; showing the newest %d", total, MAX_SCAN);
  }

  /* s_order[0..count-1] is a permutation of 0..count-1 and count never exceeds
   * MAX_SCAN, so by_newest cannot index s_mtime past the entries filled above,
   * whatever order qsort visits them in. Entries past count are stale from a
   * previous scan and are never read: gallery_task() bounds idx by s_total,
   * which is this return value. */
  for (int i = 0; i < count; i++) s_order[i] = (uint16_t)i;
  qsort(s_order, (size_t)count, sizeof s_order[0], by_newest);
  storage_release(STORAGE_USER_UI);
  return count;
}

/** Fill in what META.JSON says about one capture. */
static void read_meta(gallery_item_t *it) {
  snprintf(it->label, sizeof it->label, "%.*s", 8, it->id);
  snprintf(it->mode, sizeof it->mode, "%s", "-");
  it->frames = 0;
  it->partial = false;

  snprintf(s_tile_path, sizeof s_tile_path, "%s/%s/META.JSON", CAPTURES_DIR, it->id);
  FILE *f = fopen(s_tile_path, "rb");
  if (f == NULL) return;
  const size_t got = fread(s_tile_meta, 1, sizeof s_tile_meta - 1, f);
  fclose(f);
  s_tile_meta[got] = '\0';
  if (got == sizeof s_tile_meta - 1 && !s_meta_truncated_logged) {
    /* A full buffer means the document may have been cut, and a cut document
     * fails cJSON_Parse silently below. Said once, with the size, because the
     * fix is a bigger buffer here rather than anything about this capture. */
    s_meta_truncated_logged = true;
    ESP_LOGW(TAG, "META.JSON for %s filled the %d-byte buffer; the tile may be incomplete",
             it->id, (int)sizeof s_tile_meta);
  }

  cJSON *m = cJSON_Parse(s_tile_meta);
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
  /* Take the card as the UI user for the read. A tile decode that runs while
   * four frames are being written shares the SDMMC bus with them and widens
   * the spread between frames, which is the one number the capture pipeline
   * exists to keep small. Bounded wait, and on a timeout the page is marked
   * dirty again so the task comes back to it once the capture has let go,
   * instead of showing a NO IMAGE tile for a picture that is on the card. */
  if (!storage_acquire(STORAGE_USER_UI, 2000)) {
    s_dirty = true;
    return false;
  }
  bool ok = false;
  for (size_t i = 0; i < sizeof TRY / sizeof TRY[0] && !ok; i++) {
    snprintf(s_tile_path, sizeof s_tile_path, "%s/%s/%s", CAPTURES_DIR, it->id, TRY[i]);
    ok = thumb_load(s_tile_path, pixels, GALLERY_TILE_W, GALLERY_TILE_H, 0x0000) == ESP_OK;
  }
  storage_release(STORAGE_USER_UI);
  return ok;
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

    /* The scan the callers asked for, on this task rather than theirs. */
    if (s_rescan) {
      s_rescan = false;
      lock();
      const int found = storage_present() ? scan() : 0;
      if (found >= 0) {
        s_total = found;
        const int pages = gallery_pages();
        if (s_page >= pages) s_page = pages > 0 ? pages - 1 : 0;
        for (int i = 0; i < GALLERY_PAGE; i++) {
          /* Everything is pending until the tiles below say otherwise, so the
           * screen never shows a stale picture under a new capture's label. */
          memset(&s_slot[i], 0, sizeof s_slot[i]);
          if (s_page * GALLERY_PAGE + i < s_total) s_slot[i].state = TILE_PENDING;
        }
      }
      unlock();
      if (found < 0) {
        /* A capture wanted the card and the scan gave it back. Ask again next
         * pass; the screen keeps showing the list it had and gallery_loading()
         * stays true, so it says READING CARD rather than going empty. */
        s_rescan = true;
        s_dirty = true;
        vTaskDelay(pdMS_TO_TICKS(80));
        continue;
      }
    }

    /* Take a copy of what to decode, then work outside the lock: a decode is
     * tens of milliseconds and the draw loop reads these slots every frame. */
    char want[GALLERY_PAGE][40];
    int n = 0;
    lock();
    const int base = s_page * GALLERY_PAGE;
    for (int i = 0; i < GALLERY_PAGE; i++) {
      const int idx = base + i;
      if (idx < s_total) {
        snprintf(want[i], sizeof want[i], "%s", s_names[s_order[idx]]);
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
      /* strlcpy: at -O2 GCC bounds want[i] by the whole 2-D array and flags
       * the snprintf as a possible 239-byte write into 40. */
      strlcpy(it.id, want[i], sizeof it.id);
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
  /* s_names too, not just s_lock: gallery_init() creates the mutex before it
   * allocates the name table, so a failed SPIRAM allocation leaves s_lock
   * non-NULL and s_names NULL. main.c logs that init failure and carries on
   * running the camera, so this is reachable, and scan() would memcpy into
   * NULL on the first capture folder it found. */
  if (s_lock == NULL || s_names == NULL) return;
  /*
   * Ask; do not scan here.
   *
   * The three callers are all on the UI task - go(), the delete dialog, the
   * post-capture repaint - and one is on the capture task via
   * gallery_on_capture. Scanning inline meant 86 fopen/fread/fclose calls,
   * ~5-15 ms each, running inside a touch handler while holding s_lock:
   * 0.4-1.3 s of frozen screen on every gallery entry, and a capture landing
   * during one parked the capture task on the mutex.
   *
   * gallery.h has always promised the work happens on a task of its own. The
   * scan is now on the right side of that promise, and gallery_loading()
   * already covers s_dirty so the screen says READING CARD meanwhile.
   */
  s_rescan = true;
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
  /* 64-byte aligned, because this is a PPA destination and the PPA is a DMA
   * engine: a plain heap_caps_malloc gave 4-byte alignment and every scale
   * returned ESP_ERR_INVALID_ARG, including a 1:1 one, so the gallery drew
   * nothing for every capture ever taken. viewfinder.c allocates its own
   * tiles this way already; this is the same rule, applied where it was
   * missed. */
    s_pixels[i] = heap_caps_aligned_calloc(64, 1, THUMB_TILE_BYTES(GALLERY_TILE_W, GALLERY_TILE_H),
                                   MALLOC_CAP_SPIRAM);
    if (s_pixels[i] == NULL) return ESP_ERR_NO_MEM;
  }

  /* 4 KB: cJSON's recursive descent over a metadata object runs on this stack,
   * but the document it parses is s_tile_meta in .bss and not a local, the
   * pictures are in PSRAM and the decode buffers belong to thumb.c. The
   * recursion is bounded by the document's nesting - three levels in a
   * kino.capture - not by its size, so raising that buffer to 4096 does not
   * deepen this stack. */
  if (xTaskCreate(gallery_task, "gallery", 4096, NULL, 4, &s_task) != pdPASS) {
    return ESP_ERR_NO_MEM;
  }
  taskmon_register("gallery", s_task);
  ESP_LOGI(TAG, "ready — %dx%d tiles, %d per page", GALLERY_TILE_W, GALLERY_TILE_H,
           GALLERY_PAGE);
  return ESP_OK;
}
