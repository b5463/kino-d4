#include "kdp_sounds.h"

#include <ctype.h>
#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#include "audio.h"
#include "config_store.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "kdp/protocol.h"
#include "klog.h"
#include "storage.h"
#include "wav_probe.h"

static const char *TAG = "sounds";

#define SOUNDS_DIR "/sdcard/KINO/SOUNDS"

/* The limits GET_SOUNDS reports, and the ones every other command enforces.
 * They are the mock's (packages/test-fixtures/src/MockKinoDevice.ts) because
 * Studio's transfer manager sizes its loop from them: a device that answered
 * a different chunkSize than the host was told would still work, and a device
 * that accepted a clip larger than it said it would is a card filling up. */
#define MAX_CUSTOM 8
#define MAX_SOUND_KB 128
#define MAX_SOUND_BYTES (MAX_SOUND_KB * 1024)
/* 44 bytes is the shortest thing that can carry a canonical RIFF/WAVE header,
 * i.e. a clip with no samples at all. Anything under it cannot be a WAV. */
#define MIN_SOUND_BYTES WAV_HEADER_MIN
#define CHUNK_SIZE 8192

/* How long a sound command waits for the card before answering BUSY. Same
 * reasoning as MEDIA_CARD_WAIT_MS in kdp_server.c, one third of it: a chunk
 * write is 8 KB and the host has fifteen more waiting, so failing fast and
 * letting it retry beats queueing sixteen writes behind a capture. */
#define CARD_WAIT_MS 2000

/* An upload with no chunk for this long is dead. The host that opened it went
 * away - unplugged, crashed, or a Studio tab closed mid-transfer - and the
 * next BEGIN must not be told BUSY by a session nobody will ever finish. */
#define SESSION_IDLE_MS 30000

/* Enough of the temp file to reach the data chunk. A canonical header is 44
 * bytes; ffmpeg and Audacity add LIST/INFO blocks in front of the samples and
 * 4 KB clears any of them by a wide margin. Read on SOUND_END only, so the
 * cost is one 4 KB read per upload.
 *
 * It lands in s_read_buf rather than on the stack: the KDP server task has
 * 12 KB and a third of it for a header read that happens once per upload is
 * not a trade worth making. Nothing else is using the buffer - SOUND_END
 * answers with JSON, and one command is answered before the next is decoded. */
#define PROBE_BYTES 4096

/* ------------------------------------------------------------------ */
/* The stored clips                                                    */
/* ------------------------------------------------------------------ */

typedef struct {
  char id[KDP_SOUND_ID_MAX];
  char name[KDP_SOUND_NAME_MAX];
  uint32_t size_bytes;
  uint32_t duration_ms;
} sound_t;

/* Rebuilt from the card at init and maintained by SOUND_END and SOUND_DELETE.
 * In RAM because kdp_sounds_count()/_info() are called from the UI draw and
 * kdp_sounds_path() from the audio task - neither may open a directory, and
 * neither may block on the card lock while a capture holds it. Eight entries
 * of about 60 bytes; the card stays the source of truth across a reboot. */
static sound_t s_index[MAX_CUSTOM];
static int s_count;
static bool s_ready;

/* The SOUND_READ reply buffer. One request is answered before the next is
 * decoded (kdp_module.h), so one buffer for the module is enough.
 *
 * PSRAM rather than a plain static array: 8 KB of internal DRAM held for the
 * life of the device to serve a command a host issues a handful of times per
 * upload is the wrong place to spend it, and send_raw() copies out of it into
 * the TX frame before returning. */
static uint8_t *s_read_buf;

/* ------------------------------------------------------------------ */
/* The upload session                                                  */
/* ------------------------------------------------------------------ */

typedef struct {
  bool open;
  uint32_t id; /* what SOUND_CHUNK must quote back */
  char sound_id[KDP_SOUND_ID_MAX];
  char name[KDP_SOUND_NAME_MAX];
  uint32_t size_bytes;   /* announced by SOUND_BEGIN */
  uint32_t duration_ms;  /* announced; the probe's own figure wins at END */
  uint32_t received;     /* highest offset+len seen, not a byte count */
  int64_t last_ms;       /* for SESSION_IDLE_MS */
} session_t;

static session_t s_session;
static uint32_t s_session_counter;

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

/* ------------------------------------------------------------------ */
/* Paths and ids                                                       */
/* ------------------------------------------------------------------ */

static void path_of(char *out, size_t cap, const char *id, const char *ext) {
  snprintf(out, cap, SOUNDS_DIR "/%s.%s", id, ext);
}

/* The five ids the contract reserves (packages/kdp/src/protocol/types.ts,
 * BUILTIN_SHUTTER_SOUNDS). audio.c renders these; a custom clip may not take
 * one of their names or selecting it would be ambiguous. */
static const char *const BUILTIN_IDS[] = {"click", "cheap-digi", "tiny-beep", "mechanical",
                                          "silent"};

static bool id_is_builtin(const char *id) {
  for (size_t i = 0; i < sizeof BUILTIN_IDS / sizeof BUILTIN_IDS[0]; i++)
    if (strcmp(id, BUILTIN_IDS[i]) == 0) return true;
  return false;
}

/**
 * ^snd-[a-z0-9-]{1,19}$ - the shape Studio generates.
 *
 * This is a filename on a FAT card assembled from a string a host sent, so it
 * is an allow-list rather than a search for "..": lowercase, digits and the
 * dash, nothing else, and a fixed prefix. A dot, a slash or a backslash never
 * reaches snprintf, so no id can name a path outside SOUNDS_DIR.
 */
static bool id_ok(const char *id) {
  if (id == NULL) return false;
  if (strncmp(id, "snd-", 4) != 0) return false;
  const size_t n = strlen(id + 4);
  if (n < 1 || n > 19) return false;
  for (const char *p = id + 4; *p; p++) {
    const bool allowed = (*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9') || *p == '-';
    if (!allowed) return false;
  }
  return true;
}

/* The index is written on the KDP task and read on the audio task
 * (kdp_sounds_path) and the UI task (kdp_sounds_count/_info). A delete compacts
 * the array, and a reader between two of those struct copies would see a torn
 * id - a failed fopen and the built-in click, not a crash, but still a lie. The
 * writes are a handful of 60-byte copies, so a critical section is the cheapest
 * exclusion there is.
 *
 * It covers the readers on the other two tasks as well, which it claimed to and
 * did not: index_find() below takes no lock, so kdp_sounds_path() on the audio
 * task walked the array while a delete was shifting it (audit, low). The
 * readers that run off the KDP task take it explicitly now - index_has() and
 * kdp_sounds_info(). The unlocked walk is kept for this file's own handlers,
 * which run on the writer task and cannot race themselves. */
static portMUX_TYPE s_index_mux = portMUX_INITIALIZER_UNLOCKED;

/* Unlocked, and correct ONLY on the KDP task - the single writer. Anything
 * else must go through index_has(). */
static int index_find(const char *id) {
  for (int i = 0; i < s_count; i++)
    if (strcmp(s_index[i].id, id) == 0) return i;
  return -1;
}

/** Does the index hold `id`? Safe from any task. */
static bool index_has(const char *id) {
  portENTER_CRITICAL(&s_index_mux);
  const bool found = index_find(id) >= 0;
  portEXIT_CRITICAL(&s_index_mux);
  return found;
}

static void index_drop(int slot) {
  if (slot < 0 || slot >= s_count) return;
  portENTER_CRITICAL(&s_index_mux);
  for (int i = slot; i < s_count - 1; i++) s_index[i] = s_index[i + 1];
  s_count--;
  memset(&s_index[s_count], 0, sizeof s_index[s_count]);
  portEXIT_CRITICAL(&s_index_mux);
}

static void index_put(const sound_t *s) {
  portENTER_CRITICAL(&s_index_mux);
  const int slot = index_find(s->id);
  if (slot >= 0) s_index[slot] = *s;
  else if (s_count < MAX_CUSTOM) s_index[s_count++] = *s;
  portEXIT_CRITICAL(&s_index_mux);
}

/* ------------------------------------------------------------------ */
/* Init: the directory, and the index rebuilt from what is on the card */
/* ------------------------------------------------------------------ */

/* The sidecar carries what a WAV header cannot: the name someone typed. It is
 * written after the rename, so a missing one means the clip landed and the
 * sidecar did not - the WAV still plays, and the id stands in for the name
 * rather than the clip disappearing from the list. */
static void read_sidecar(sound_t *s) {
  char path[128];
  path_of(path, sizeof path, s->id, "JSON");
  FILE *f = fopen(path, "rb");
  if (f == NULL) return;
  char text[256];
  const size_t got = fread(text, 1, sizeof text - 1, f);
  fclose(f);
  text[got] = '\0';
  cJSON *doc = cJSON_ParseWithLength(text, got);
  if (doc == NULL) return;
  const cJSON *jname = cJSON_GetObjectItem(doc, "name");
  const cJSON *jdur = cJSON_GetObjectItem(doc, "durationMs");
  if (cJSON_IsString(jname) && jname->valuestring)
    snprintf(s->name, sizeof s->name, "%s", jname->valuestring);
  if (cJSON_IsNumber(jdur) && jdur->valuedouble > 0) s->duration_ms = (uint32_t)jdur->valuedouble;
  cJSON_Delete(doc);
}

/**
 * Walk SOUNDS_DIR and rebuild the index.
 *
 * The WAV is what is scanned, not the sidecar: the clip is the thing that
 * plays, and a sidecar with no WAV describes nothing. Temp files from an
 * upload that never finished are deleted here - this is the only place they
 * can be, since the session that owned them died with the last boot.
 *
 * The card lock is held by the caller.
 */
static void scan_dir(void) {
  s_count = 0;
  DIR *d = opendir(SOUNDS_DIR);
  if (d == NULL) return;
  struct dirent *e;
  while ((e = readdir(d)) != NULL && s_count < MAX_CUSTOM) {
    /* Long filenames are up to 255 bytes here (CONFIG_FATFS_MAX_LFN). Nothing
     * this module writes comes close, so a name that does not fit is one
     * somebody else put in the directory - skipped rather than truncated into
     * a name that might collide with a real clip. */
    char base[64];
    const size_t name_len = strlen(e->d_name);
    if (name_len == 0 || name_len >= sizeof base) continue;
    memcpy(base, e->d_name, name_len + 1);
    char *dot = strrchr(base, '.');
    if (dot == NULL) continue;
    *dot = '\0';
    const char *ext = dot + 1;

    /* Long filenames are on (CONFIG_FATFS_LFN_HEAP), so an id round-trips
     * unchanged; lowercased anyway so a card written by something that only
     * kept 8.3 names does not silently hide a clip. */
    for (char *p = base; *p; p++) *p = (char)tolower((unsigned char)*p);

    if (strcasecmp(ext, "TMP") == 0) {
      char path[128];
      path_of(path, sizeof path, base, "TMP");
      if (unlink(path) == 0) ESP_LOGI(TAG, "removed an unfinished upload: %s.TMP", base);
      continue;
    }
    if (strcasecmp(ext, "WAV") != 0) continue;
    if (!id_ok(base)) {
      ESP_LOGW(TAG, "ignoring %s: not an id this firmware writes", e->d_name);
      continue;
    }

    char path[128];
    path_of(path, sizeof path, base, "WAV");
    struct stat st;
    if (stat(path, &st) != 0 || st.st_size < MIN_SOUND_BYTES) continue;

    /* id_ok() has already bounded this to 5..23 characters; the check is here
     * so the copy is provably in range at the point it happens rather than
     * three functions away. */
    const size_t id_len = strlen(base);
    if (id_len >= sizeof s_index[0].id) continue;

    sound_t *s = &s_index[s_count];
    memset(s, 0, sizeof *s);
    memcpy(s->id, base, id_len + 1);
    memcpy(s->name, base, id_len + 1);
    s->size_bytes = (uint32_t)st.st_size;
    /* A floor from the file itself, so a clip whose sidecar is gone still
     * reports a length: everything past the 44-byte header is samples at 32
     * bytes per millisecond. read_sidecar() replaces it when it can. */
    s->duration_ms = (uint32_t)((st.st_size - WAV_HEADER_MIN) / 32);
    read_sidecar(s);
    s_count++;
  }
  closedir(d);
}

esp_err_t kdp_sounds_init(void) {
  storage_status_t st;
  storage_get_status(&st);
  if (!st.mounted) {
    ESP_LOGW(TAG, "no card mounted - custom sounds are off this session");
    return ESP_ERR_NOT_FOUND;
  }
  if (s_read_buf == NULL) s_read_buf = heap_caps_malloc(CHUNK_SIZE, MALLOC_CAP_SPIRAM);
  if (s_read_buf == NULL) {
    ESP_LOGW(TAG, "no PSRAM for the read buffer - custom sounds are off");
    return ESP_ERR_NO_MEM;
  }
  if (!storage_acquire(STORAGE_USER_UI, CARD_WAIT_MS)) {
    ESP_LOGW(TAG, "card busy at boot - custom sounds are off this session");
    return ESP_ERR_TIMEOUT;
  }
  /* Both, because /KINO exists on a card that has taken a picture and does
   * not on a freshly formatted one. EEXIST is the normal answer to the first. */
  mkdir("/sdcard/KINO", 0775);
  const bool made = mkdir(SOUNDS_DIR, 0775) == 0;
  DIR *probe = opendir(SOUNDS_DIR);
  if (probe == NULL) {
    storage_release(STORAGE_USER_UI);
    ESP_LOGW(TAG, "cannot open " SOUNDS_DIR " - custom sounds are off");
    return ESP_FAIL;
  }
  closedir(probe);
  scan_dir();
  storage_release(STORAGE_USER_UI);

  s_ready = true;
  ESP_LOGI(TAG, "SOUNDS_READY %d of %d clips%s", s_count, MAX_CUSTOM,
           made ? " (directory created)" : "");
  klog("P4", "custom sounds up");
  return ESP_OK;
}

bool kdp_sounds_capable(void) { return s_ready; }

int kdp_sounds_count(void) { return s_count; }

bool kdp_sounds_info(int index, char *id, size_t id_cap, char *name, size_t name_cap) {
  /* The bound and the copy under one lock: a delete between them would shift
   * the entry this index named. Copied into locals rather than snprintf'd
   * inside the critical section - a critical section on this part disables
   * interrupts, and formatting inside one is longer than it needs to be. */
  sound_t row = {0};
  portENTER_CRITICAL(&s_index_mux);
  const bool ok = index >= 0 && index < s_count;
  if (ok) row = s_index[index];
  portEXIT_CRITICAL(&s_index_mux);
  if (!ok) return false;
  if (id && id_cap) snprintf(id, id_cap, "%s", row.id);
  if (name && name_cap) snprintf(name, name_cap, "%s", row.name);
  return true;
}

bool kdp_sounds_path(const char *id, char *path, size_t cap) {
  if (!s_ready || id == NULL || path == NULL || cap == 0) return false;
  /* The audio task, not the writer task: locked. */
  if (!index_has(id)) return false;
  snprintf(path, cap, SOUNDS_DIR "/%s.WAV", id);
  return true;
}

/* ------------------------------------------------------------------ */
/* Replies                                                             */
/* ------------------------------------------------------------------ */

static cJSON *sound_json(const sound_t *s) {
  cJSON *o = cJSON_CreateObject();
  if (o == NULL) return NULL;
  cJSON_AddStringToObject(o, "id", s->id);
  cJSON_AddStringToObject(o, "name", s->name);
  cJSON_AddNumberToObject(o, "sizeBytes", s->size_bytes);
  cJSON_AddNumberToObject(o, "durationMs", s->duration_ms);
  return o;
}

static kdp_module_reply_t oom(void) {
  return kdp_module_fail("INTERNAL_ERROR", "Out of memory building the reply");
}

/* The holder, not a guess at one. This said "Card is busy with a capture" on
 * any card-lock timeout; storage.c owns the wording now because it is the only
 * thing that knows who actually holds the card. */
static kdp_module_reply_t busy_card(void) {
  char msg[96];
  storage_card_busy_message(msg, sizeof msg);
  return kdp_module_fail("BUSY", msg);
}

/* ------------------------------------------------------------------ */
/* Session lifetime                                                    */
/* ------------------------------------------------------------------ */

/** Drop the session and its temp file. The card lock is held by the caller. */
static void session_abort(const char *why) {
  if (!s_session.open) return;
  char path[128];
  path_of(path, sizeof path, s_session.sound_id, "TMP");
  unlink(path);
  ESP_LOGW(TAG, "upload %s abandoned: %s", s_session.sound_id, why);
  memset(&s_session, 0, sizeof s_session);
}

/* ------------------------------------------------------------------ */
/* The six commands                                                    */
/* ------------------------------------------------------------------ */

static kdp_module_reply_t handle_get_sounds(void) {
  cJSON *root = cJSON_CreateObject();
  cJSON *custom = cJSON_CreateArray();
  if (root == NULL || custom == NULL) {
    cJSON_Delete(root);
    cJSON_Delete(custom);
    return oom();
  }
  for (int i = 0; i < s_count; i++) {
    cJSON *item = sound_json(&s_index[i]);
    if (item != NULL) cJSON_AddItemToArray(custom, item);
  }
  cJSON_AddItemToObject(root, "custom", custom);
  cJSON_AddNumberToObject(root, "maxCustom", MAX_CUSTOM);
  cJSON_AddNumberToObject(root, "maxSoundKB", MAX_SOUND_KB);
  return kdp_module_json(root);
}

static kdp_module_reply_t handle_begin(const cJSON *req) {
  const cJSON *jid = cJSON_GetObjectItem(req, "id");
  const cJSON *jname = cJSON_GetObjectItem(req, "name");
  const cJSON *jsize = cJSON_GetObjectItem(req, "sizeBytes");
  const cJSON *jdur = cJSON_GetObjectItem(req, "durationMs");
  const char *id = (cJSON_IsString(jid) && jid->valuestring) ? jid->valuestring : "";

  if (!storage_acquire(STORAGE_USER_UI, CARD_WAIT_MS)) return busy_card();

  /* A session whose host went away must not lock the slot out forever, and a
   * live one must not be stolen by a second host mid-transfer. The clock is
   * the only thing that tells the two apart. */
  if (s_session.open && now_ms() - s_session.last_ms > SESSION_IDLE_MS)
    session_abort("no chunk for 30 s");
  if (s_session.open) {
    storage_release(STORAGE_USER_UI);
    return kdp_module_fail("BUSY", "A sound upload is already in progress");
  }
  if (id_is_builtin(id)) {
    storage_release(STORAGE_USER_UI);
    return kdp_module_fail("BAD_ID", "Builtin sound ids cannot be overwritten");
  }
  if (!id_ok(id)) {
    storage_release(STORAGE_USER_UI);
    return kdp_module_fail("BAD_ID", "Sound ids look like snd-<lowercase-slug>");
  }

  const double size = cJSON_IsNumber(jsize) ? jsize->valuedouble : 0.0;
  if (size < MIN_SOUND_BYTES || size > MAX_SOUND_BYTES) {
    storage_release(STORAGE_USER_UI);
    char msg[KDP_MODULE_MSG_LEN];
    snprintf(msg, sizeof msg, "Sound must be %d bytes to %d KB", MIN_SOUND_BYTES, MAX_SOUND_KB);
    return kdp_module_fail("BAD_SIZE", msg);
  }
  /* Replacing an existing id reuses its slot, so re-uploading the eighth clip
   * is not refused by the eighth clip. */
  if (index_find(id) < 0 && s_count >= MAX_CUSTOM) {
    storage_release(STORAGE_USER_UI);
    char msg[KDP_MODULE_MSG_LEN];
    snprintf(msg, sizeof msg, "All %d sound slots are used. Delete one first.", MAX_CUSTOM);
    return kdp_module_fail("SOUND_SLOTS_FULL", msg);
  }

  /* The bytes go to <id>.TMP and become <id>.WAV only at SOUND_END, after the
   * header has been read and the length checked. An upload straight into the
   * final name would leave a truncated clip that GET_SOUNDS lists and the
   * shutter tries to play. */
  char path[128];
  path_of(path, sizeof path, id, "TMP");
  FILE *f = fopen(path, "wb");
  if (f == NULL) {
    storage_release(STORAGE_USER_UI);
    return kdp_module_fail("INTERNAL_ERROR", "Cannot open the upload temp file");
  }
  fclose(f);
  storage_release(STORAGE_USER_UI);

  memset(&s_session, 0, sizeof s_session);
  s_session.open = true;
  s_session.id = ++s_session_counter;
  snprintf(s_session.sound_id, sizeof s_session.sound_id, "%s", id);
  snprintf(s_session.name, sizeof s_session.name, "%s",
           (cJSON_IsString(jname) && jname->valuestring && jname->valuestring[0])
               ? jname->valuestring
               : id);
  s_session.size_bytes = (uint32_t)size;
  s_session.duration_ms = (cJSON_IsNumber(jdur) && jdur->valuedouble > 0)
                              ? (uint32_t)jdur->valuedouble
                              : 0;
  s_session.last_ms = now_ms();

  cJSON *root = cJSON_CreateObject();
  if (root == NULL) return oom();
  cJSON_AddNumberToObject(root, "sessionId", s_session.id);
  cJSON_AddNumberToObject(root, "chunkSize", CHUNK_SIZE);
  return kdp_module_json(root);
}

/**
 * One chunk of the upload.
 *
 * The body is binary, not JSON: u32 sessionId little-endian, u32 offset
 * little-endian, then the bytes. That is what Studio writes
 * (apps/studio/src/device/KinoDevice.ts, soundChunk) and what the mock reads,
 * and it is why this module is handed the raw frame payload rather than a
 * parsed object.
 *
 * The file is opened and closed per chunk rather than held open across the
 * session. A session lasts up to 30 s and the mount has eight descriptors;
 * holding one for a host that walked away spends a descriptor on nothing.
 * Sixteen open/write/close pairs for a 128 KB clip is a few milliseconds
 * against a transfer measured in seconds.
 */
static kdp_module_reply_t handle_chunk(const uint8_t *payload, size_t payload_len) {
  if (!s_session.open) return kdp_module_fail("NO_SESSION", "No sound upload active");
  if (payload == NULL || payload_len < 8)
    return kdp_module_fail("BAD_REQUEST", "Chunk is shorter than its 8-byte header");

  const uint32_t session_id = (uint32_t)payload[0] | ((uint32_t)payload[1] << 8) |
                              ((uint32_t)payload[2] << 16) | ((uint32_t)payload[3] << 24);
  const uint32_t offset = (uint32_t)payload[4] | ((uint32_t)payload[5] << 8) |
                          ((uint32_t)payload[6] << 16) | ((uint32_t)payload[7] << 24);
  const uint8_t *data = payload + 8;
  const size_t len = payload_len - 8;

  if (session_id != s_session.id) return kdp_module_fail("BAD_SESSION", "Stale sound upload session");

  if (!storage_acquire(STORAGE_USER_UI, CARD_WAIT_MS)) return busy_card();
  /* Past what SOUND_BEGIN announced. The session dies with it: a host that has
   * lost track of its own offsets will not recover by sending the next chunk,
   * and the temp file is already wrong. */
  if ((uint64_t)offset + len > s_session.size_bytes) {
    session_abort("chunk past the announced size");
    storage_release(STORAGE_USER_UI);
    return kdp_module_fail("BAD_OFFSET", "Chunk past the announced sound size");
  }

  char path[128];
  path_of(path, sizeof path, s_session.sound_id, "TMP");
  FILE *f = fopen(path, "r+b");
  if (f == NULL) {
    session_abort("temp file disappeared");
    storage_release(STORAGE_USER_UI);
    return kdp_module_fail("INTERNAL_ERROR", "The upload temp file is gone");
  }
  bool wrote = fseek(f, (long)offset, SEEK_SET) == 0 && (len == 0 || fwrite(data, 1, len, f) == len);
  if (fclose(f) != 0) wrote = false;
  if (!wrote) {
    session_abort("write failed");
    storage_release(STORAGE_USER_UI);
    return kdp_module_fail("INTERNAL_ERROR", "Card write failed");
  }
  storage_release(STORAGE_USER_UI);

  /* The highest byte written, not a running total: a host may resend a chunk
   * and counting it twice would let a short upload pass the SOUND_END check. */
  const uint32_t end = offset + (uint32_t)len;
  if (end > s_session.received) s_session.received = end;
  s_session.last_ms = now_ms();

  cJSON *root = cJSON_CreateObject();
  if (root == NULL) return oom();
  cJSON_AddBoolToObject(root, "ok", true);
  cJSON_AddNumberToObject(root, "received", s_session.received);
  return kdp_module_json(root);
}

static kdp_module_reply_t handle_end(void) {
  if (!s_session.open) return kdp_module_fail("NO_SESSION", "No sound upload active");
  /* Before the card, because a short upload is the host's arithmetic and not
   * a question about the file. The session stays open so the host can send
   * what it missed rather than starting again. */
  if (s_session.received < s_session.size_bytes) {
    char msg[KDP_MODULE_MSG_LEN];
    snprintf(msg, sizeof msg, "Received %u of %u bytes", (unsigned)s_session.received,
             (unsigned)s_session.size_bytes);
    return kdp_module_fail("SHORT_SOUND", msg);
  }

  if (!storage_acquire(STORAGE_USER_UI, CARD_WAIT_MS)) return busy_card();

  char tmp[128], wav[128], side[128];
  path_of(tmp, sizeof tmp, s_session.sound_id, "TMP");
  path_of(wav, sizeof wav, s_session.sound_id, "WAV");
  path_of(side, sizeof side, s_session.sound_id, "JSON");

  uint8_t *head = s_read_buf;
  FILE *f = fopen(tmp, "rb");
  if (f == NULL) {
    session_abort("temp file disappeared");
    storage_release(STORAGE_USER_UI);
    return kdp_module_fail("INTERNAL_ERROR", "The upload temp file is gone");
  }
  const size_t got = fread(head, 1, PROBE_BYTES, f);
  fseek(f, 0, SEEK_END);
  const long file_bytes = ftell(f);
  fclose(f);

  /* The format check is here and not at SOUND_BEGIN because BEGIN sees only a
   * size and a name. Rejecting on the wire means the clip never becomes a
   * .WAV the shutter would later try to play as if it were samples. */
  wav_info_t info;
  char why[96];
  if (!wav_probe(head, got, &info, why, sizeof why)) {
    unlink(tmp);
    memset(&s_session, 0, sizeof s_session);
    storage_release(STORAGE_USER_UI);
    char msg[KDP_MODULE_MSG_LEN];
    /* %.80s, not %s: the reason plus the format line has to fit the NACK
     * message field, and a truncated reason still names the problem. */
    snprintf(msg, sizeof msg, "%.80s - need 16 kHz mono 16-bit PCM WAV", why);
    return kdp_module_fail("BAD_FORMAT", msg);
  }

  if (rename(tmp, wav) != 0) {
    /* FAT has no atomic replace over an existing name. Removing first opens a
     * window where neither file exists, which is why the old clip goes only
     * once the new one is complete and validated. */
    unlink(wav);
    if (rename(tmp, wav) != 0) {
      /* The old clip is gone and the new one never landed: the index must
       * not keep listing an id whose file no longer exists. */
      index_drop(index_find(s_session.sound_id));
      session_abort("rename failed");
      storage_release(STORAGE_USER_UI);
      return kdp_module_fail("INTERNAL_ERROR", "Cannot store the clip on the card");
    }
  }

  sound_t stored;
  memset(&stored, 0, sizeof stored);
  snprintf(stored.id, sizeof stored.id, "%s", s_session.sound_id);
  snprintf(stored.name, sizeof stored.name, "%s", s_session.name);
  stored.size_bytes = file_bytes > 0 ? (uint32_t)file_bytes : s_session.size_bytes;
  /* The clip's own length, clamped to what is actually on the card: the
   * header's data size is a claim, and a host that announced a durationMs did
   * so from a file this device has not seen. What plays is what is measured. */
  {
    const uint32_t usable = stored.size_bytes > info.data_offset
                                ? stored.size_bytes - info.data_offset
                                : 0;
    const uint32_t pcm = info.data_bytes < usable ? info.data_bytes : usable;
    stored.duration_ms = pcm / 32;
    if (stored.duration_ms == 0) stored.duration_ms = s_session.duration_ms;
  }

  /* The sidecar exists for the name alone - a WAV header has nowhere to put
   * one. Written after the rename so a failure here costs the label and not
   * the clip. */
  FILE *sf = fopen(side, "wb");
  if (sf != NULL) {
    cJSON *doc = sound_json(&stored);
    char *text = doc ? cJSON_PrintUnformatted(doc) : NULL;
    cJSON_Delete(doc);
    if (text != NULL) {
      fwrite(text, 1, strlen(text), sf);
      cJSON_free(text);
    }
    fclose(sf);
  } else {
    ESP_LOGW(TAG, "%s stored without its sidecar - the name will read as the id", stored.id);
  }
  storage_release(STORAGE_USER_UI);

  index_put(&stored);
  /* The WAV under this id is a different file now. audio.c caches the expanded
   * samples keyed on the id, which does not change on a re-upload - so without
   * this the shutter kept playing the clip that was there before the upload
   * until the next reboot (audit FW-2). */
  audio_forget_custom(stored.id);
  memset(&s_session, 0, sizeof s_session);

  ESP_LOGI(TAG, "sound stored: %s (%u B, %u ms)", stored.name, (unsigned)stored.size_bytes,
           (unsigned)stored.duration_ms);
  klog("P4", "sound stored");

  cJSON *root = cJSON_CreateObject();
  cJSON *item = sound_json(&stored);
  if (root == NULL || item == NULL) {
    cJSON_Delete(root);
    cJSON_Delete(item);
    return oom();
  }
  cJSON_AddBoolToObject(root, "ok", true);
  cJSON_AddItemToObject(root, "sound", item);
  return kdp_module_json(root);
}

/* Bytes back out, raw, with KDP_FLAG_BINARY - the same shape and the same
 * reasoning as MEDIA_READ in kdp_server.c. A short reply means end of file;
 * a zero-length one is the honest answer to a read that starts at the end,
 * and is how Studio's readSound() knows it has the whole clip. */
static kdp_module_reply_t handle_read(const cJSON *req) {
  const cJSON *jid = cJSON_GetObjectItem(req, "id");
  const cJSON *joff = cJSON_GetObjectItem(req, "offset");
  const cJSON *jlen = cJSON_GetObjectItem(req, "length");
  const char *id = (cJSON_IsString(jid) && jid->valuestring) ? jid->valuestring : "";
  if (!id_ok(id) || index_find(id) < 0) {
    char msg[KDP_MODULE_MSG_LEN];
    snprintf(msg, sizeof msg, "No sound %.40s", id);
    return kdp_module_fail("NOT_FOUND", msg);
  }
  if (s_read_buf == NULL) return kdp_module_fail("INTERNAL_ERROR", "No read buffer");

  double off = cJSON_IsNumber(joff) ? joff->valuedouble : 0.0;
  if (off < 0 || off > MAX_SOUND_BYTES) off = MAX_SOUND_BYTES;
  double want = cJSON_IsNumber(jlen) ? jlen->valuedouble : CHUNK_SIZE;
  if (want < 1) want = 1;
  if (want > CHUNK_SIZE) want = CHUNK_SIZE;

  if (!storage_acquire(STORAGE_USER_UI, CARD_WAIT_MS)) return busy_card();
  char path[128];
  path_of(path, sizeof path, id, "WAV");
  FILE *f = fopen(path, "rb");
  if (f == NULL) {
    storage_release(STORAGE_USER_UI);
    return kdp_module_fail("NOT_FOUND", "The clip is listed but not on the card");
  }
  size_t got = 0;
  if (fseek(f, (long)off, SEEK_SET) == 0) got = fread(s_read_buf, 1, (size_t)want, f);
  fclose(f);
  storage_release(STORAGE_USER_UI);
  return kdp_module_bytes(s_read_buf, got);
}

static kdp_module_reply_t handle_delete(const cJSON *req) {
  const cJSON *jid = cJSON_GetObjectItem(req, "id");
  const char *id = (cJSON_IsString(jid) && jid->valuestring) ? jid->valuestring : "";
  const int slot = id_ok(id) ? index_find(id) : -1;
  if (slot < 0) {
    char msg[KDP_MODULE_MSG_LEN];
    snprintf(msg, sizeof msg, "No sound %.40s", id);
    return kdp_module_fail("NOT_FOUND", msg);
  }

  if (!storage_acquire(STORAGE_USER_UI, CARD_WAIT_MS)) return busy_card();
  char path[128];
  path_of(path, sizeof path, id, "WAV");
  unlink(path);
  path_of(path, sizeof path, id, "JSON");
  unlink(path);
  storage_release(STORAGE_USER_UI);

  index_drop(slot);
  /* The samples in PSRAM outlive the file otherwise: a delete followed by an
   * upload of the same id, or a delete alone, would keep playing a clip that
   * is no longer on the card. */
  audio_forget_custom(id);

  /* A deleted clip cannot stay selected. audio.c would fall back to the click
   * on its own, but leaving the setting pointing at nothing means Studio and
   * the SOUND screen both show a shutter sound that does not exist. */
  if (strcmp(config_str("shoot.shutterSound", "click"), id) == 0) {
    cJSON *patch = cJSON_CreateObject();
    cJSON *shoot = cJSON_CreateObject();
    if (patch != NULL && shoot != NULL) {
      cJSON_AddStringToObject(shoot, "shutterSound", "click");
      cJSON_AddItemToObject(patch, "shoot", shoot);
      if (config_merge(patch) == ESP_OK) config_save();
      ESP_LOGI(TAG, "shutter sound reset to click - %s deleted", id);
    } else {
      cJSON_Delete(shoot);
    }
    cJSON_Delete(patch);
  }

  ESP_LOGI(TAG, "sound deleted: %s", id);
  cJSON *root = cJSON_CreateObject();
  if (root == NULL) return oom();
  cJSON_AddBoolToObject(root, "ok", true);
  return kdp_module_json(root);
}

kdp_module_reply_t kdp_sounds_handle(uint8_t cmd, const cJSON *req, const uint8_t *payload,
                                     size_t payload_len) {
  /* One refusal for the whole family when the store never came up, rather
   * than six different failures further in. UNSUPPORTED_COMMAND is what
   * GET_CAPABILITIES already told the host to expect: customSounds is false
   * for exactly the same reason. */
  if (!s_ready)
    return kdp_module_fail("UNSUPPORTED_COMMAND", "Custom sounds need a mounted card");

  switch (cmd) {
    case KDP_CMD_GET_SOUNDS: return handle_get_sounds();
    case KDP_CMD_SOUND_BEGIN: return handle_begin(req);
    case KDP_CMD_SOUND_CHUNK: return handle_chunk(payload, payload_len);
    case KDP_CMD_SOUND_END: return handle_end();
    case KDP_CMD_SOUND_READ: return handle_read(req);
    case KDP_CMD_SOUND_DELETE: return handle_delete(req);
    default: break;
  }
  return kdp_module_fail("UNSUPPORTED_COMMAND", "Not a sound command");
}
