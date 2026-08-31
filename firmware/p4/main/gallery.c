#include "gallery.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "cJSON.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "gallery_index.h"
#include "klog.h"
#include "storage.h"
#include "taskmon.h"
#include "thumb.h"

static const char *TAG = "gallery";

#define CAPTURES_DIR "/sdcard/KINO/CAPTURES"
#define INDEX_PATH CAPTURES_DIR "/" GIDX_FILE
#define INDEX_TMP_PATH CAPTURES_DIR "/" GIDX_TMP_FILE

/* How many capture folders the camera will page through. A 32 GB card holds
 * thousands, and holding every name would cost 40 KB for a list nobody scrolls
 * to the end of. The newest are what anyone is looking for, so the scan keeps
 * the last MAX_SCAN by name and says so when there are more. */
#define MAX_SCAN 240

/* The name table's row and the index's name field are the same field in two
 * files, and a mismatch would be a silent truncation into a path. */
_Static_assert(GIDX_NAME_MAX == 40, "gallery_index.h and s_names[40] must agree");

/* ---------------------------------------------------------------- */
/* State                                                             */
/* ---------------------------------------------------------------- */

/*
 * The list on screen. Written only by the gallery task, read by it and by the
 * draw loop, under s_lock.
 *
 * s_total_seen is NOT s_total on a card holding more than MAX_SCAN captures:
 * it is how many capture folders are actually there. It exists because the
 * cheap verify pass counts folders with readdir and has to compare against
 * something that does not disagree for ever on a full card - see
 * gallery_index.h.
 */
static char (*s_names)[40];
static uint64_t s_mtime[MAX_SCAN];
static uint16_t s_order[MAX_SCAN];
static int s_total;
static int s_total_seen;

/*
 * The rebuild in progress. Gallery task only, no lock.
 *
 * Separate from the live arrays above, and that separation is the whole reason
 * a rebuild can be resumed. The walk gives the card back to a capture mid-way
 * and comes back on a later pass; meanwhile the screen has to keep showing the
 * list it already had. One set of arrays cannot do both - the old scan()
 * abandoned everything it had collected and started from zero for exactly that
 * reason, so on a card busy with photography it could never finish at all.
 *
 * 9.6 KB of SPIRAM for the names, permanently allocated next to s_names rather
 * than taken and freed per rebuild: a rebuild that fails for want of memory
 * would happen precisely when the card is busiest, and it is the only thing
 * that can put a wrongly-ordered gallery right.
 */
static char (*s_walk_names)[40];
static uint64_t s_walk_mtime[MAX_SCAN];
static int s_walk_count; /* names collected so far, across passes */
static int s_walk_seen;  /* folders the last COMPLETED pass counted */
static bool s_walking;   /* a rebuild is part-way through */

static int s_page;
static SemaphoreHandle_t s_lock;
static TaskHandle_t s_task;

static volatile bool s_dirty;   /* the page needs decoding */
static volatile bool s_loading;
static volatile bool s_rescan;      /* a full walk is owed */
static volatile bool s_verify;      /* count the folders and check the index */
static volatile bool s_index_dirty; /* memory and the file on the card disagree */
static volatile bool s_have_list;   /* the list came from an index or a walk */
static volatile bool s_tile_fault;  /* an indexed capture had no META.JSON */
static volatile bool s_faulted;     /* the fault above already bought a rebuild */

/* DELETE ALL PHOTOS. -1 in s_wipe_total means the count pass has not run. */
static volatile bool s_wipe_req;
static volatile int s_wipe_done;
static volatile int s_wipe_total = -1;

static gallery_item_t s_slot[GALLERY_PAGE];
static uint16_t *s_pixels[GALLERY_PAGE];

/*
 * Notes from other tasks: one capture added, one capture removed.
 *
 * A queue and not a direct mutation, because the callers are the capture task
 * (immediately after a commit, with the next shutter press waiting behind it)
 * and the KDP server task (inside MEDIA_DELETE). Neither may block on s_lock
 * and neither may touch the card - the mutation has to happen on the gallery
 * task, which is the one place that already knows how to take the card
 * politely and how to give it back.
 *
 * Eight deep. The gallery task drains it every 80 ms and a capture takes
 * seconds, so nothing this camera can do fills it; a full queue falls back to
 * a full rebuild rather than dropping the note, because a dropped note is a
 * gallery in the wrong order and that is the one thing this file exists to
 * prevent.
 */
typedef struct {
  char id[40];
  uint64_t when;
  bool removed;
} note_t;
#define NOTE_QUEUE_DEPTH 8
static QueueHandle_t s_notes;

static void lock(void) { xSemaphoreTake(s_lock, portMAX_DELAY); }
static void unlock(void) { xSemaphoreGive(s_lock); }

/*
 * Lock order, once, so it cannot be rediscovered by deadlock: the card
 * (storage_acquire) is taken BEFORE s_lock, never after. index_write() needs
 * both. Nothing in this file holds s_lock across a storage_acquire any more -
 * the old code did (gallery_refresh held it across scan()), which was the
 * inversion, and it is gone because the walk now runs outside the lock and
 * publishes under it.
 */

/* ---------------------------------------------------------------- */
/* File scratch                                                      */
/* ---------------------------------------------------------------- */

/*
 * File scratch, deliberately not on any stack.
 *
 * Both pairs belong to the gallery task and nothing else. That used not to be
 * true - gallery_refresh() scanned inline on whichever task called it, and the
 * comment here described the mutex that made that safe - but the scan, the
 * index read, the index write and the wipe all run on gallery_task() now, one
 * at a time, so single ownership by task is what protects them rather than
 * s_lock. They stay two separate buffers because a tile decode and a walk are
 * two different points in the same loop and merging them would make the next
 * reordering of that loop a corruption instead of a compile error.
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
 *
 * 5-15 ms each, which is the number the whole index exists to avoid paying
 * ~500 times on every gallery open. This function is now reached only by a
 * rebuild.
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

/* ---------------------------------------------------------------- */
/* Ordering                                                          */
/* ---------------------------------------------------------------- */

static int by_newest(const void *a, const void *b) {
  const uint64_t ta = s_mtime[*(const uint16_t *)a];
  const uint64_t tb = s_mtime[*(const uint16_t *)b];
  if (ta < tb) return 1; /* descending: newest first */
  if (ta > tb) return -1;
  return 0;
}

/**
 * Rebuild s_order from s_mtime. s_lock held.
 *
 * s_order[0..s_total-1] is a permutation of 0..s_total-1 and s_total never
 * exceeds MAX_SCAN, so by_newest cannot index s_mtime past the entries filled
 * by the caller, whatever order qsort visits them in. Entries past s_total are
 * stale and are never read: gallery_task() bounds idx by s_total.
 */
static void resort(void) {
  for (int i = 0; i < s_total; i++) s_order[i] = (uint16_t)i;
  qsort(s_order, (size_t)s_total, sizeof s_order[0], by_newest);
}

/** Clamp the page and mark every tile on it as pending. s_lock held. */
static void reset_page(void) {
  const int pages = s_total > 0 ? (s_total + GALLERY_PAGE - 1) / GALLERY_PAGE : 1;
  if (s_page >= pages) s_page = pages > 0 ? pages - 1 : 0;
  for (int i = 0; i < GALLERY_PAGE; i++) {
    /* Everything is pending until the tiles below say otherwise, so the screen
     * never shows a stale picture under a new capture's label. */
    memset(&s_slot[i], 0, sizeof s_slot[i]);
    if (s_page * GALLERY_PAGE + i < s_total) s_slot[i].state = TILE_PENDING;
  }
}

/**
 * Is this readdir entry a capture folder this gallery can show?
 *
 * One predicate, used by the walk, the count pass and the wipe, so the three
 * cannot disagree about what is on the card. A disagreement between the walk
 * and the count is a rebuild on every gallery open - the exact cost the index
 * removes.
 *
 * gidx_name_ok() is stricter than the old length-and-dot test: it also refuses
 * a name that could not be written to the index and read back safely, because
 * every name here ends up snprintf'd into a path and opened. Capture folders
 * are UUIDs, so nothing this firmware writes is affected; a folder someone
 * dropped on the card by hand with a space or a slash in it is now skipped
 * rather than shown, which is the answer that keeps the index honest.
 */
static bool capture_name_ok(const char *name) {
  /* The index's own two files live in the captures directory, so every readdir
   * over it hands them back. Counted as a capture, the index would make the
   * card look like it holds one more than it does - and the verify pass would
   * then report a mismatch on every single gallery open. */
  if (gidx_is_index_file(name)) return false;
  return gidx_name_ok(name);
}

/* ---------------------------------------------------------------- */
/* The full walk, resumable                                          */
/* ---------------------------------------------------------------- */

/** Already collected by an earlier pass of this walk? */
static bool walk_has(const char *name) {
  for (int i = 0; i < s_walk_count; i++) {
    if (strcmp(s_walk_names[i], name) == 0) return true;
  }
  return false;
}

static void walk_add(const char *name, uint64_t when) {
  if (s_walk_count < MAX_SCAN) {
    strlcpy(s_walk_names[s_walk_count], name, 40);
    s_walk_mtime[s_walk_count] = when;
    s_walk_count++;
    return;
  }
  /* Past the cap, evict the oldest rather than the first seen - a full card
   * would otherwise show only history. Same rule as note_add()'s, and both
   * call the same function so they cannot drift. */
  const int oldest = gidx_oldest(s_walk_mtime, s_walk_count);
  if (oldest >= 0 && when > s_walk_mtime[oldest]) {
    strlcpy(s_walk_names[oldest], name, 40);
    s_walk_mtime[oldest] = when;
  }
}

#define WALK_YIELDED (-1)

/**
 * One pass of the full walk. Returns names collected when it finished, or
 * WALK_YIELDED when it gave the card back before finishing.
 *
 * ## Why a pass and not a scan
 *
 * The old scan() abandoned everything on a yield and started from zero, on the
 * reasoning that a partial list sorted by a partial set of timestamps is a
 * gallery in the wrong order. That is true of PUBLISHING a partial list and
 * not true of collecting one: the names and times already read are correct,
 * they just are not all of them. So they are kept, and the next pass readdirs
 * again and only reads META.JSON for names it has not seen. The walk finishes
 * across passes instead of restarting, which on a card being photographed is
 * the difference between finishing and never finishing.
 *
 * walk_has() is a linear strcmp against the collected set. 240 names against
 * 520 folders is 125,000 compares of 36 bytes - tens of microseconds, against
 * the 5-15 ms a single META.JSON read costs. There is nothing to index here.
 *
 * A card holding more than MAX_SCAN captures can re-read an evicted name on a
 * later pass and evict it again. Bounded (one META read per unknown folder per
 * pass) and self-correcting, and it only arises past the cap.
 */
static int walk_pass(void) {
  /* Arbitrated like every other reader, same 2 s budget: a capture holds the
   * card and a gallery that cannot read it says so rather than fighting for
   * it. A refusal is WALK_YIELDED and not 0 - returning 0 here used to empty
   * the gallery on a busy card, so a shot taken during a scan made the screen
   * say NO PHOTOS YET about a card with 500 pictures on it. */
  if (!storage_acquire(STORAGE_USER_UI, 2000)) return WALK_YIELDED;
  DIR *d = opendir(CAPTURES_DIR);
  if (d == NULL) {
    storage_release(STORAGE_USER_UI);
    /* No captures directory is an empty card, not a failure. */
    s_walking = false;
    s_walk_count = 0;
    s_walk_seen = 0;
    return 0;
  }
  if (!s_walking) {
    s_walking = true;
    s_walk_count = 0;
    s_walk_seen = 0;
  }
  int seen = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    /*
     * Let go the moment photography wants the card.
     *
     * This walk is one META.JSON read per unknown capture folder - up to 240
     * of them, 5-15 ms each. A shutter press landing mid-walk would otherwise
     * wait out the whole thing, which is precisely the stall
     * storage_yield_requested() exists to end: the lock is priority-ordered,
     * but only for a holder that asks. Checked per entry, so the capture waits
     * for one folder rather than for the card.
     */
    if (storage_yield_requested(STORAGE_USER_UI)) {
      closedir(d);
      storage_release(STORAGE_USER_UI);
      return WALK_YIELDED;
    }
    if (!capture_name_ok(e->d_name)) continue;
    seen++;
    /* capture_name_ok() has proved this is under 40 characters, but d_name is
     * declared up to NAME_MAX and the compiler reasons from the declaration -
     * so the bound has to be visible in the types or -O2 flags the path
     * capture_taken_ms builds as a possible 255-byte write into 178. Same
     * idiom, same reason, as upload_queue.c's reconciliation loop. */
    char name[40];
    strlcpy(name, e->d_name, sizeof name);
    if (walk_has(name)) continue;
    walk_add(name, capture_taken_ms(name));
  }
  closedir(d);
  storage_release(STORAGE_USER_UI);

  /* Only a pass that reached the end of the directory may set this: a partial
   * walk counts a subset, and total_seen is what the verify pass compares
   * against. */
  s_walk_seen = seen;
  s_walking = false;
  if (seen > MAX_SCAN) {
    ESP_LOGW(TAG, "%d captures on the card; showing the newest %d", seen, MAX_SCAN);
  }
  return s_walk_count;
}

/** Hand the finished walk to the screen. */
static void publish_walk(int count) {
  const int seen = s_walk_seen > count ? s_walk_seen : count;
  lock();
  /*
   * Did this walk actually find a different card?
   *
   * It decides whether the tile-fault latch is cleared, and getting that wrong
   * is an infinite rebuild. A capture-shaped folder holding no META.JSON - one
   * the boot sweep PRESERVED because it had something unexpected in it - is
   * collected by the walk, shown as a tile, and fails to open its META.JSON
   * every single time. Clearing the latch unconditionally meant: fault,
   * rebuild, identical list, latch cleared, fault, rebuild, for ever. So a
   * rebuild that changed nothing does not buy another one, and the same folder
   * costs exactly one walk per real change to the card.
   */
  const bool changed = count != s_total || seen != s_total_seen;
  if (count > 0) {
    memcpy(s_names, s_walk_names, (size_t)count * 40);
    memcpy(s_mtime, s_walk_mtime, (size_t)count * sizeof s_mtime[0]);
  }
  s_total = count;
  s_total_seen = seen;
  resort();
  reset_page();
  unlock();
  s_walk_count = 0;
  s_walk_seen = 0;
  s_have_list = true;
  /* A list that actually moved earns a fresh chance to notice a missing tile:
   * the latch exists to stop six failing tiles buying six rebuilds, not to
   * stop a card swap from ever being noticed. */
  if (changed) s_faulted = false;
}

/* ---------------------------------------------------------------- */
/* The index on the card                                             */
/* ---------------------------------------------------------------- */

#define INDEX_HIT 0
#define INDEX_MISS (-1)
#define INDEX_BUSY (-2)

/*
 * Attempts one owed index write gets before it is abandoned.
 *
 * Unbounded retries were a livelock: index_write() returns false whenever a
 * capture holds or wants the card, the task retried every 80 ms, and on a busy
 * camera that is for ever. Eight attempts spread over roughly a second is
 * plenty for a transient - a capture is seconds, not minutes, and a note or a
 * walk arriving later sets s_index_dirty again with a fresh budget.
 *
 * Giving up is safe and costs one rebuild: the file on the card is then older
 * than memory, the verify count pass notices on the next open, and the walk
 * puts it right. An index that is merely stale is exactly the case the count
 * check exists for.
 */
#define INDEX_WRITE_TRIES 8
static int s_index_tries;

/**
 * Load the whole index in one fread and publish it. INDEX_HIT, INDEX_MISS or
 * INDEX_BUSY.
 *
 * Both buffers are taken from SPIRAM here and freed before returning rather
 * than held for the life of the camera: this runs once when the gallery screen
 * first opens on a card, and 26 KB of PSRAM parked for a function that runs
 * once is 26 KB the framebuffers and the JPEG decoder could have had.
 * capture_taken_ms() above does the same thing for the same reason. Neither
 * buffer can go on the gallery task's 4 KB stack.
 *
 * A file larger than gidx_max_bytes(MAX_SCAN) is refused outright rather than
 * parsed as its own prefix - it is either an index from a firmware with a
 * bigger cap or a corrupt file, and both want a rebuild.
 */
static int index_load(void) {
  const size_t cap = gidx_max_bytes(MAX_SCAN) + 2;
  char *text = heap_caps_malloc(cap, MALLOC_CAP_SPIRAM);
  gidx_entry_t *rows = heap_caps_malloc(sizeof *rows * MAX_SCAN, MALLOC_CAP_SPIRAM);
  if (text == NULL || rows == NULL) {
    heap_caps_free(text);
    heap_caps_free(rows);
    ESP_LOGW(TAG, "no room to read the order index; walking the card instead");
    return INDEX_MISS;
  }

  int result = INDEX_MISS;
  if (!storage_acquire(STORAGE_USER_UI, 2000)) {
    heap_caps_free(text);
    heap_caps_free(rows);
    return INDEX_BUSY;
  }
  FILE *f = fopen(INDEX_PATH, "rb");
  size_t got = 0;
  if (f != NULL) {
    got = fread(text, 1, cap - 1, f);
    fclose(f);
  }
  storage_release(STORAGE_USER_UI);

  if (f == NULL) {
    /* No index yet: the first gallery open on this card, or one this firmware
     * has never written. Not a fault, and not logged as one. */
    heap_caps_free(text);
    heap_caps_free(rows);
    return INDEX_MISS;
  }
  if (got == cap - 1) {
    ESP_LOGW(TAG, "order index is larger than %u bytes; rebuilding", (unsigned)(cap - 1));
    heap_caps_free(text);
    heap_caps_free(rows);
    return INDEX_MISS;
  }
  text[got] = '\0';

  gidx_header_t h;
  int skipped = 0;
  const int n = gidx_parse(text, rows, MAX_SCAN, &h, &skipped);
  if (n < 0) {
    ESP_LOGW(TAG, "order index has no usable header; rebuilding");
  } else if (n != h.entries || skipped > 0) {
    /* The count is the detection mechanism, so it is checked and not trusted:
     * a power cut between two fwrites, or a card edited in a PC, leaves a file
     * that parses fine and describes the wrong card. */
    ESP_LOGW(TAG, "order index says %d entries, read %d (%d skipped); rebuilding", h.entries, n,
             skipped);
  } else {
    lock();
    for (int i = 0; i < n; i++) {
      strlcpy(s_names[i], rows[i].name, 40);
      s_mtime[i] = rows[i].captured_at_ms;
    }
    s_total = n;
    /* The header's own figure, which is the point of storing it: on a card
     * with more captures than the cap this is bigger than n, and the verify
     * pass compares folders against THIS. */
    s_total_seen = h.total_seen > n ? h.total_seen : n;
    /* Sorted again rather than trusted: the file is written newest-first, but
     * it lives on a removable card and a hand-edited one must not be able to
     * put the gallery in the wrong order. Sorting 240 entries is microseconds
     * and it makes the file's order advisory. */
    resort();
    reset_page();
    unlock();
    s_have_list = true;
    s_faulted = false;
    result = INDEX_HIT;
    ESP_LOGI(TAG, "order index: %d of %d captures, no META.JSON reads", n, s_total_seen);
  }

  heap_caps_free(text);
  heap_caps_free(rows);
  return result;
}

/**
 * Write the index to a temp name and rename it over the old one.
 *
 * True when the file on the card now matches memory. False means try again -
 * the card was busy or a capture asked for it back, and a stale index is
 * harmless because the verify pass catches it.
 *
 * s_lock is held across the whole write. 240 lines is about 12 KB through one
 * buffered stream, tens of milliseconds, and the only other taker of this
 * mutex is a page turn on the UI task - so the worst case is one page press
 * arriving late. The alternative was copying the name table out under the lock
 * first, which is 9.6 KB of memcpy plus a second copy of the table to hold it.
 */
static bool index_write(void) {
  if (!storage_present()) return true; /* nowhere to write it; nothing owed */
  if (s_walking) return false;         /* a rebuild is mid-flight; it will ask again */
  /*
   * Nothing is CREATED while photography wants the card.
   *
   * Checked before the acquire and before the fopen, not only inside the write
   * loop, and that ordering is the whole point. The yield poll below abandons
   * by unlink()ing the temp file, so a card being photographed cost a
   * directory-entry create plus a partial write plus a delete on every retry -
   * every 80 ms, indefinitely, in a directory that on the bench card
   * (KD4-D121BC) holds 527 entries. Refusing here costs one critical section.
   *
   * storage_capture_active() is the cheapest predicate storage.h offers for
   * this: a portMUX critical section over the holder and the CAPTURE waiter
   * count, no lock taken and no card touched. It answers "is anyone
   * photographing", which is exactly the question - storage_yield_requested()
   * answers "should I let go", which is the wrong question before you have
   * taken anything.
   */
  if (storage_capture_active()) return false;
  if (!storage_acquire(STORAGE_USER_UI, 2000)) return false;

  FILE *f = fopen(INDEX_TMP_PATH, "wb");
  if (f == NULL) {
    storage_release(STORAGE_USER_UI);
    return false;
  }

  char line[GIDX_LINE_MAX];
  lock();
  const int n = s_total;
  const int seen = s_total_seen > n ? s_total_seen : n;
  size_t len = gidx_render_header(line, sizeof line, n, seen);
  bool ok = len > 0 && fwrite(line, 1, len, f) == len;
  for (int i = 0; ok && i < n; i++) {
    /* Every 32 lines, not every line: a yield check is a lock read and this
     * loop is already short. 32 lines is under 2 KB, well inside the time a
     * capture can wait for a writer to finish a buffer. */
    if ((i & 31) == 0 && storage_yield_requested(STORAGE_USER_UI)) {
      ok = false;
      break;
    }
    const int at = s_order[i];
    len = gidx_render_line(line, sizeof line, s_mtime[at], s_names[at]);
    ok = len > 0 && fwrite(line, 1, len, f) == len;
  }
  unlock();

  const int closed = fclose(f);
  if (!ok || closed != 0) {
    unlink(INDEX_TMP_PATH);
    storage_release(STORAGE_USER_UI);
    return false;
  }

  /*
   * FatFs rename() refuses an existing target, so the old index goes first.
   *
   * That leaves a window with no index at all. A power cut inside it costs one
   * rebuild on the next gallery open - which is exactly what a half-written
   * index would have cost - and unlike a half-written one it cannot be
   * mistaken for a good file. Writing in place was tried first and rejected on
   * that ground: a stream interrupted half way through 240 lines leaves a file
   * whose header count is right and whose contents are not.
   */
  unlink(INDEX_PATH);
  if (rename(INDEX_TMP_PATH, INDEX_PATH) != 0) {
    unlink(INDEX_TMP_PATH);
    storage_release(STORAGE_USER_UI);
    ESP_LOGW(TAG, "could not rename the order index into place");
    return false;
  }
  storage_release(STORAGE_USER_UI);
  ESP_LOGI(TAG, "order index written: %d of %d captures", n, seen);
  return true;
}

/**
 * Count the capture folders. No META.JSON reads and no stat().
 *
 * The whole verification budget: one readdir over the directory, which is
 * milliseconds against the seconds a rebuild costs. It catches the two cases
 * an incremental index cannot know about - a card edited in a PC, and a crash
 * between a mutation and the rewrite - and it deliberately catches nothing
 * else. A count that agrees is not proof the order is right; it is the
 * cheapest evidence worth having, and the alternative is paying for a rebuild
 * to find out nothing changed.
 *
 * Returns the count, or -1 when the card was busy or a capture wanted it back.
 */
static int count_pass(void) {
  if (!storage_acquire(STORAGE_USER_UI, 2000)) return -1;
  DIR *d = opendir(CAPTURES_DIR);
  if (d == NULL) {
    storage_release(STORAGE_USER_UI);
    return 0;
  }
  int seen = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (storage_yield_requested(STORAGE_USER_UI)) {
      closedir(d);
      storage_release(STORAGE_USER_UI);
      return -1;
    }
    if (capture_name_ok(e->d_name)) seen++;
  }
  closedir(d);
  storage_release(STORAGE_USER_UI);
  return seen;
}

/* ---------------------------------------------------------------- */
/* Incremental maintenance                                           */
/* ---------------------------------------------------------------- */

/** s_lock held. True when the shown list or total_seen moved. */
static bool note_add(const char *id, uint64_t when) {
  for (int i = 0; i < s_total; i++) {
    if (strcmp(s_names[i], id) != 0) continue;
    /* Already known. A re-commit of the same UUID cannot happen on this
     * camera, but a note arriving twice can, and the index must not grow a
     * duplicate row for it. */
    if (s_mtime[i] == when) return false;
    s_mtime[i] = when;
    resort();
    return true;
  }
  s_total_seen++;
  if (s_total < MAX_SCAN) {
    strlcpy(s_names[s_total], id, 40);
    s_mtime[s_total] = when;
    s_total++;
    resort();
    return true;
  }
  const int oldest = gidx_oldest(s_mtime, s_total);
  if (oldest >= 0 && when > s_mtime[oldest]) {
    strlcpy(s_names[oldest], id, 40);
    s_mtime[oldest] = when;
    resort();
  }
  /* True either way: total_seen moved, so the file on the card is out of date
   * even when the shown list is not. */
  return true;
}

/** s_lock held. True when the shown list or total_seen moved. */
static bool note_remove(const char *id) {
  if (s_total_seen > 0) s_total_seen--;
  int at = -1;
  for (int i = 0; i < s_total; i++) {
    if (strcmp(s_names[i], id) == 0) {
      at = i;
      break;
    }
  }
  if (at < 0) {
    /* Not on the shown list. Ordinary on a card holding more than MAX_SCAN:
     * the capture was one of the older ones the gallery never held. */
    return true;
  }
  /* Fill the hole from the tail rather than shifting the table down: s_order
   * is rebuilt from scratch below, so nothing outside this function depends on
   * which slot a capture sits in. */
  s_total--;
  if (at != s_total) {
    memcpy(s_names[at], s_names[s_total], 40);
    s_mtime[at] = s_mtime[s_total];
  }
  resort();
  reset_page();
  if (s_total_seen > s_total) {
    /* The card holds captures the list does not, and one has just left it, so
     * the newest of those should appear. A delete cannot invent a name it
     * never read, so this is the one mutation that still costs a walk - and
     * only past the cap. */
    s_rescan = true;
    s_dirty = true;
  }
  return true;
}

/** Apply every queued note. True when the index needs rewriting. */
static bool drain_notes(void) {
  if (s_notes == NULL) return false;
  note_t n;
  bool changed = false;
  while (xQueueReceive(s_notes, &n, 0) == pdTRUE) {
    /*
     * No list yet, so this note waits - it is not consumed.
     *
     * It used to `continue`, which took the note off the queue and threw it
     * away, on the reasoning that the walk about to run would see the capture
     * on the card anyway. That reasoning depended on gallery_refresh() forcing
     * a walk, and it no longer does: on an index HIT no walk runs at all, so
     * the note was the only record that this capture existed and a photograph
     * just taken stayed out of the list until a count-mismatch rebuild
     * happened to notice. Requeued at the front and the drain stops, so the
     * order of the remaining notes is preserved too.
     */
    if (!s_have_list) {
      if (xQueueSendToFront(s_notes, &n, 0) != pdTRUE) {
        /* The queue had room a microsecond ago - this cannot happen. If it
         * does, the note is gone and a walk is the only thing that recovers
         * the capture. */
        s_rescan = true;
        s_dirty = true;
      }
      break;
    }
    if (!capture_name_ok(n.id)) continue;
    lock();
    const bool moved = n.removed ? note_remove(n.id) : note_add(n.id, n.when);
    if (moved && !n.removed) reset_page();
    unlock();
    changed = changed || moved;
  }
  if (changed) s_dirty = true;
  return changed;
}

/* ---------------------------------------------------------------- */
/* DELETE ALL PHOTOS                                                 */
/* ---------------------------------------------------------------- */

#define WIPE_YIELDED (-1)

/**
 * One pass of the wipe. Captures removed, or WIPE_YIELDED when it stopped
 * early.
 *
 * ## What it deletes, and how
 *
 * storage_capture_delete(), the same function the single-photo delete and the
 * boot orphan sweep use: it unlinks only the six names in
 * STORAGE_CAPTURE_FILES and then rmdir()s, which refuses a non-empty
 * directory. So a folder holding anything this firmware did not put there is
 * left standing, with whatever is in it. That is not a limitation to work
 * around - a recursive remove over names read off a removable card is how a
 * DELETE ALL PHOTOS takes something that was not a photo.
 *
 * Captures only. /sdcard/KINO/SOUNDS, /RECIPES, the config and the upload
 * queue's own files are all outside CAPTURES and are never opened here. The
 * index's two files are excluded by capture_name_ok() and rewritten empty when
 * the wipe finishes.
 *
 * ## Why passes
 *
 * Two reasons, and either alone would be enough. A shutter press mid-wipe has
 * to win, so the yield check is per entry and the pass returns the card. And
 * FatFs is being asked to walk a directory whose entries are being removed
 * underneath it, which can skip entries; the caller repeats until a complete
 * pass removes nothing, so a skipped folder is taken on the next one.
 *
 * A photograph taken during the wipe therefore gets deleted too - the wipe
 * goes round again and the new folder is in the directory. That is what DELETE
 * ALL PHOTOS says it does, and the alternative (a snapshot of names taken up
 * front) leaves photographs behind on a card the user was told is empty, which
 * is the worse of the two surprises. "The shutter wins" is about the card, not
 * about the picture surviving the operation the user just confirmed.
 *
 * ## What happens to a queued upload
 *
 * Verified against upload_queue.c and roll_queue.c rather than assumed.
 * UPLOAD.JSON lives INSIDE the capture's own folder and is NOT in
 * STORAGE_CAPTURE_FILES, so the rmdir above leaves the folder standing with
 * just that record in it. Boot reconciliation asks
 * rq_reconcile_action(has_meta=false, ...) about it and gets RQ_REC_IGNORE -
 * no META.JSON means "not a capture", which is exactly right here - so no
 * queue row is created and nothing is stranded. A job already in the RAM list
 * when the wipe runs re-reads the card on its next step, fails, and parks
 * within its retry budget; there is no queue-drop entry point in
 * upload_queue.h to call instead, and adding one is a change to the upload
 * queue's contract rather than to this screen. The folder that is left is not
 * shown in the gallery either: it has no META.JSON, so its tile would read
 * NO IMAGE - which is why the count pass, not the tile, is what decides
 * whether the list is right.
 */
static int wipe_pass(void) {
  if (!storage_present()) return 0;
  if (!storage_acquire(STORAGE_USER_UI, 2000)) return WIPE_YIELDED;
  DIR *d = opendir(CAPTURES_DIR);
  if (d == NULL) {
    storage_release(STORAGE_USER_UI);
    return 0;
  }
  int removed = 0;
  bool finished = true;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (storage_yield_requested(STORAGE_USER_UI)) {
      finished = false;
      break;
    }
    if (!capture_name_ok(e->d_name)) continue;
    /* Bounded in the types, like walk_pass above: d_name is declared up to
     * NAME_MAX and this path is a delete, so the bound had better be one the
     * compiler can see. */
    char name[40];
    strlcpy(name, e->d_name, sizeof name);
    snprintf(s_scan_path, sizeof s_scan_path, "%s/%s", CAPTURES_DIR, name);
    storage_capture_delete(s_scan_path);
    removed++;
    if (s_wipe_done < s_wipe_total) s_wipe_done = s_wipe_done + 1;
  }
  closedir(d);
  storage_release(STORAGE_USER_UI);
  return finished ? removed : WIPE_YIELDED;
}

/** One turn of the wipe on the gallery task. True when there is nothing left. */
static bool wipe_step(void) {
  if (s_wipe_total < 0) {
    const int n = count_pass();
    if (n < 0) return false; /* card busy; count again next turn */
    s_wipe_total = n;
    s_wipe_done = 0;
    klog("SD", "delete all photos: %d captures", n);
  }
  const int removed = wipe_pass();
  if (removed == WIPE_YIELDED) return false;
  if (removed > 0) return false; /* go round again; FatFs may have skipped some */

  /* A complete pass that removed nothing: the captures directory holds no
   * capture folders. */
  lock();
  s_total = 0;
  s_total_seen = 0;
  resort();
  reset_page();
  unlock();
  s_have_list = true;
  s_index_dirty = true; /* an empty index, so the next open is still one fread */
  s_dirty = true;
  ESP_LOGI(TAG, "delete all photos: %d removed", s_wipe_done);
  klog("SD", "delete all photos done: %d removed", s_wipe_done);
  return true;
}

/* ---------------------------------------------------------------- */
/* Tiles                                                             */
/* ---------------------------------------------------------------- */

/** Fill in what META.JSON says about one capture. */
static void read_meta(gallery_item_t *it) {
  snprintf(it->label, sizeof it->label, "%.*s", 8, it->id);
  snprintf(it->mode, sizeof it->mode, "%s", "-");
  it->frames = 0;
  it->partial = false;
  it->favorite = false;

  snprintf(s_tile_path, sizeof s_tile_path, "%s/%s/META.JSON", CAPTURES_DIR, it->id);
  FILE *f = fopen(s_tile_path, "rb");
  if (f == NULL) {
    /*
     * The index named a capture whose META.JSON is not there.
     *
     * Evidence, not a diagnosis: either the folder is gone (the card was
     * edited in a PC, or a delete landed that this gallery was not told
     * about) or the commit never finished. Both mean the list is describing a
     * card that has changed, so one rebuild is owed - and exactly one, which
     * is why the latch is in the task loop rather than here. A failed open is
     * not a busy card: nothing here waits on the storage lock, so a refusal
     * would not present as a missing file.
     */
    s_tile_fault = true;
    return;
  }
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
  /* Absent on every capture written before MEDIA_FAVORITE existed, and absent
   * is not a favourite - cJSON_IsTrue(NULL) is false, which is the answer we
   * want without a separate presence check. */
  it->favorite = cJSON_IsTrue(cJSON_GetObjectItem(m, "favorite"));
  cJSON_Delete(m);
}

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

/* ---------------------------------------------------------------- */
/* The task                                                          */
/* ---------------------------------------------------------------- */

static void decode_page(void) {
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
  ESP_LOGI(TAG, "page %d/%d, %d captures", s_page + 1, gallery_pages(), n);
}

static void gallery_task(void *arg) {
  (void)arg;
  for (;;) {
    /* DELETE ALL first and alone. It owns the card in bursts and there is
     * nothing worth decoding while the pictures are being removed. */
    if (s_wipe_req) {
      s_loading = true;
      if (wipe_step()) {
        s_wipe_req = false;
        s_wipe_total = -1;
      }
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    /* Captures added and deleted since the last turn. Cheap, and it may set
     * s_dirty, so it runs before the idle check. */
    if (drain_notes()) s_index_dirty = true;

    /* An indexed capture had no META.JSON. One rebuild per list, latched here
     * rather than in read_meta() so six failing tiles buy one walk. */
    if (s_tile_fault) {
      s_tile_fault = false;
      if (!s_faulted) {
        s_faulted = true;
        s_rescan = true;
        s_dirty = true;
        ESP_LOGW(TAG, "an indexed capture is not on the card; rebuilding the order");
      }
    }

    if (!s_dirty && !s_verify && !s_index_dirty) {
      s_loading = false;
      vTaskDelay(pdMS_TO_TICKS(80));
      continue;
    }

    /* Latched before anything below can set it again: a verify pass or an
     * index write on their own must not re-decode six JPEGs that have not
     * changed, and a walk that yields has to leave the flag set so the next
     * turn still decodes. */
    bool decode = false;
    if (s_dirty) {
      s_dirty = false;
      s_loading = true;
      decode = true;
    }

    /* No list yet: the index if there is one, the card if there is not. */
    if (!s_have_list && !s_rescan) {
      const int hit = storage_present() ? index_load() : INDEX_MISS;
      if (hit == INDEX_BUSY) {
        s_dirty = true;
        vTaskDelay(pdMS_TO_TICKS(80));
        continue;
      }
      if (hit == INDEX_HIT) {
        /* Served without reading a single META.JSON. Now prove cheaply that
         * the card still holds what the file says it does. */
        s_verify = true;
      } else {
        s_rescan = true;
      }
    }

    if (s_rescan) {
      const int found = storage_present() ? walk_pass() : 0;
      if (found == WALK_YIELDED) {
        /* A capture wanted the card and the walk gave it back, keeping what it
         * had collected. The screen keeps showing the list it had and
         * gallery_loading() stays true, so it says READING CARD rather than
         * going empty. */
        s_dirty = true;
        vTaskDelay(pdMS_TO_TICKS(80));
        continue;
      }
      s_rescan = false;
      publish_walk(found);
      s_index_dirty = true;
      /* The walk just did everything a count pass could and more. */
      s_verify = false;
    }

    if (decode) decode_page();

    /* Whether the card refused either piece of background work below. Both
     * carry a 2 s acquire budget, so retrying them back to back is a task
     * spinning against a capture that is holding the card - which is the one
     * thing this file is not allowed to do. */
    bool refused = false;

    if (s_verify) {
      const int seen = count_pass();
      if (seen < 0) {
        refused = true;
      } else {
        s_verify = false;
        lock();
        const int want = s_total_seen;
        unlock();
        if (seen != want) {
          ESP_LOGW(TAG, "card holds %d capture folders, the index says %d; rebuilding", seen, want);
          s_rescan = true;
          s_dirty = true;
        }
      }
    }

    if (s_index_dirty) {
      if (index_write()) {
        s_index_dirty = false;
        s_index_tries = 0;
      } else if (++s_index_tries >= INDEX_WRITE_TRIES) {
        /* Said out loud, because the next gallery open pays a full rebuild for
         * it and that is otherwise an unexplained slow open. Not an error: the
         * list in memory is right, only the file is behind. */
        ESP_LOGW(TAG, "could not write the order index in %d attempts; the next open rebuilds",
                 INDEX_WRITE_TRIES);
        s_index_dirty = false;
        s_index_tries = 0;
      } else {
        refused = true;
      }
    }

    if (!s_dirty) s_loading = false;
    /*
     * Every turn, unconditionally.
     *
     * There was no delay on this path at all, and load_tile() sets s_dirty
     * again when its acquire times out (see the comment there) - so a busy
     * card gave a turn that re-entered immediately, decoded nothing, and
     * re-queued as a STORAGE_USER_UI waiter. It blocked inside
     * storage_acquire() rather than burning CPU, but this task is priority 4
     * unpinned against a priority-4 UI task pinned to CPU1, and a loop with no
     * floor on its period has no business being that close to the compositor.
     * 80 ms when the card refused work, 20 ms otherwise.
     */
    vTaskDelay(pdMS_TO_TICKS(refused ? 80 : 20));
  }
}

/* ---------------------------------------------------------------- */
/* interface                                                         */
/* ---------------------------------------------------------------- */

void gallery_refresh(void) {
  /* s_names too, not just s_lock: gallery_init() creates the mutex before it
   * allocates the name table, so a failed SPIRAM allocation leaves s_lock
   * non-NULL and s_names NULL. main.c logs that init failure and carries on
   * running the camera, so this is reachable, and the walk would memcpy into
   * NULL on the first capture folder it found. */
  if (s_lock == NULL || s_names == NULL) return;
  /*
   * Not a rescan any more.
   *
   * Every caller of this - the gallery screen opening, a capture landing, a
   * delete, the shot report being acknowledged - used to mean "walk the card
   * again", which on a 500-capture card was 500 META.JSON reads at 5-15 ms
   * each: 2.5-7.5 s of card time for an order that had not changed, abandoned
   * and restarted from zero whenever a shutter press wanted the card.
   *
   * The order changes when a capture is written or deleted, and those two say
   * so exactly now (gallery_note_added / gallery_note_removed). What is left
   * for this function is: make sure there IS a list, redraw the page, and ask
   * for the cheap count check that catches the cases nothing told us about.
   */
  /* No list yet: just mark the page dirty. Setting s_rescan here would make
   * gallery_task() skip index_load() - its index branch runs only while
   * s_rescan is clear - so the FIRST open after boot, the one a full card
   * makes slow, would walk the card with a perfectly good index sitting on
   * it. The task tries the index and owes a walk only on a miss. */
  if (s_have_list) s_verify = true;
  s_dirty = true;
}

void gallery_note_added(const char *id, uint64_t captured_at_ms) {
  if (s_notes == NULL || id == NULL || id[0] == '\0') return;
  note_t n;
  memset(&n, 0, sizeof n);
  strlcpy(n.id, id, sizeof n.id);
  n.when = captured_at_ms;
  n.removed = false;
  /* Zero timeout, always: this is called from the capture task with the next
   * shutter press waiting behind it. */
  if (xQueueSend(s_notes, &n, 0) != pdTRUE) {
    /* The expensive correct thing rather than nothing: a dropped note is a
     * gallery in the wrong order, which is worse than a walk. */
    s_rescan = true;
    s_dirty = true;
  }
}

void gallery_note_removed(const char *id) {
  if (s_notes == NULL || id == NULL || id[0] == '\0') return;
  note_t n;
  memset(&n, 0, sizeof n);
  strlcpy(n.id, id, sizeof n.id);
  n.removed = true;
  if (xQueueSend(s_notes, &n, 0) != pdTRUE) {
    s_rescan = true;
    s_dirty = true;
  }
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

int gallery_scan_progress(void) {
  /* Only while a walk is owed. On an index hit this is zero for the whole of
   * the open, which is the honest number: nothing was counted because nothing
   * had to be. */
  return s_rescan ? s_walk_count : 0;
}

void gallery_delete_all(void) {
  if (s_lock == NULL || s_names == NULL) return;
  if (s_wipe_req) return;
  s_wipe_total = -1;
  s_wipe_done = 0;
  s_wipe_req = true;
}

bool gallery_deleting(void) { return s_wipe_req; }

void gallery_delete_progress(int *done, int *total) {
  if (done != NULL) *done = s_wipe_done;
  /* -1 while the count pass has not run. Reported as 0 rather than -1 so a
   * caller printing it cannot show "DELETING 0 OF -1". */
  if (total != NULL) *total = s_wipe_total < 0 ? 0 : s_wipe_total;
}

esp_err_t gallery_init(void) {
  if (s_lock != NULL) return ESP_OK;
  s_lock = xSemaphoreCreateMutex();
  if (s_lock == NULL) return ESP_ERR_NO_MEM;

  /* Before the task, so a note arriving on the first capture is queued rather
   * than dropped into a rebuild. */
  s_notes = xQueueCreate(NOTE_QUEUE_DEPTH, sizeof(note_t));
  if (s_notes == NULL) return ESP_ERR_NO_MEM;

  s_names = heap_caps_malloc((size_t)MAX_SCAN * 40, MALLOC_CAP_SPIRAM);
  if (s_names == NULL) return ESP_ERR_NO_MEM;
  s_walk_names = heap_caps_malloc((size_t)MAX_SCAN * 40, MALLOC_CAP_SPIRAM);
  if (s_walk_names == NULL) return ESP_ERR_NO_MEM;
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
   * deepen this stack. The index read and write add nothing: both buffers are
   * SPIRAM allocations and one rendered line is 72 bytes. */
  if (xTaskCreate(gallery_task, "gallery", 4096, NULL, 4, &s_task) != pdPASS) {
    return ESP_ERR_NO_MEM;
  }
  taskmon_register("gallery", s_task);
  ESP_LOGI(TAG, "ready — %dx%d tiles, %d per page, order index %s", GALLERY_TILE_W,
           GALLERY_TILE_H, GALLERY_PAGE, INDEX_PATH);
  return ESP_OK;
}
