#include "config_store.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "klog.h"
#include "pure.h"
#include "meta.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "config";

#define NVS_NAMESPACE "kino"
#define NVS_KEY "config"
#define CONFIG_SCHEMA_VERSION 1

/**
 * The largest document NVS will take, including the terminating NUL.
 *
 * nvs_set_str tops out at 4000 bytes on a 4096-byte page; the value is
 * ESP-IDF's, not ours. The load guard used to accept anything under 16384,
 * which meant a document that grew past 4000 loaded fine and then failed
 * every single save - logged once at ESP_LOGE and otherwise invisible, so
 * Studio showed the setting applied and the camera forgot it on the next
 * boot. One limit, checked on both sides.
 *
 * The current defaults serialise to roughly 1.1 KB, so the headroom is real;
 * a document that reaches this has grown a way it was not meant to and moving
 * to a blob is the answer, not a bigger string.
 */
#define CONFIG_MAX_BYTES 4000u

static cJSON *s_root;     /* the whole envelope */
static cJSON *s_config;   /* the `config` member of it, for convenience */
static uint32_t s_revision;

/**
 * One lock over the whole document.
 *
 * This is read from four tasks - power every half second for its timeouts,
 * the UI while drawing, the audio task for the volume of every sound, and the
 * KDP task - and written from the KDP task whenever Studio saves a setting.
 * A cJSON write relinks the child list, so a reader walking it with
 * cJSON_GetObjectItem at that moment follows a pointer that has just been
 * freed. Rare, because writes are rare; a crash in the middle of a party
 * because someone changed a setting is not an acceptable rare.
 */
static SemaphoreHandle_t s_lock;

static void lock(void) {
  if (s_lock) xSemaphoreTake(s_lock, portMAX_DELAY);
}
static void unlock(void) {
  if (s_lock) xSemaphoreGive(s_lock);
}

const cJSON *config_get(void) { return s_config; }
uint32_t config_revision(void) { return s_revision; }

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/*                                                                     */
/* Values are the contract's own ranges, chosen for a party camera that */
/* lives on a battery: dim in half a minute, sleep in two, and power    */
/* the camera bank down after five. Studio overwrites all of it the     */
/* first time anyone touches a setting; these only have to be sane on   */
/* a card-less, never-configured unit.                                 */
/* ------------------------------------------------------------------ */

static cJSON *default_config(void) {
  cJSON *c = cJSON_CreateObject();
  cJSON_AddStringToObject(c, "mode", "wiggle");

  cJSON *w = cJSON_AddObjectToObject(c, "wiggle");
  cJSON_AddStringToObject(w, "resolution", "1600x1200");
  cJSON_AddBoolToObject(w, "flash", false);
  /* 10 fps, continuous: measured off a reference wigglegram reel (firmware
   * HARDWARE_VALIDATION.md, 0.4.23) - a frame every 100 ms, one-way 1-2-3-4
   * then snap to 1. Also what MockKinoDevice and packages/media default to;
   * the firmware's 8 was the odd one out. */
  cJSON_AddNumberToObject(w, "fps", 10);
  cJSON_AddStringToObject(w, "loop", "continuous");
  cJSON_AddStringToObject(w, "direction", "ltr");
  /* "party-neg", not "": the first factory look, and what MockKinoDevice and
   * Studio both default to. An empty id showed as an unnamed look on the LOOK
   * screen and as a blank activeRecipe in GET_DEVICE_INFO, which reads as a
   * camera that has lost its setting rather than one that has never been
   * configured. */
  cJSON_AddStringToObject(w, "recipeId", "party-neg");
  cJSON_AddStringToObject(w, "previewCam", "cam2");
  cJSON_AddNumberToObject(w, "jpegQuality", 85);
  cJSON_AddNumberToObject(w, "denoise", 1);
  cJSON_AddNumberToObject(w, "sharpness", 1);
  cJSON_AddBoolToObject(w, "saveOriginals", true);

  cJSON *q = cJSON_AddObjectToObject(c, "quad");
  cJSON_AddBoolToObject(q, "flash", false);
  cJSON *slots = cJSON_AddObjectToObject(q, "slots");
  static const char *CAMS[4] = {"cam1", "cam2", "cam3", "cam4"};
  for (int i = 0; i < 4; i++) {
    cJSON *s = cJSON_AddObjectToObject(slots, CAMS[i]);
    cJSON_AddStringToObject(s, "recipeId", "party-neg");
    cJSON_AddNumberToObject(s, "exposureBias", 0);
    cJSON_AddStringToObject(s, "gain", "auto");
    cJSON_AddStringToObject(s, "flash", "fire");
    cJSON_AddStringToObject(s, "colorMode", "recipe");
    cJSON_AddStringToObject(s, "note", "");
  }

  cJSON *sh = cJSON_AddObjectToObject(c, "shoot");
  cJSON_AddStringToObject(sh, "flashMode", "auto");
  cJSON_AddStringToObject(sh, "viewfinder", "cam2");
  cJSON_AddStringToObject(sh, "previewQuality", "normal");
  cJSON_AddStringToObject(sh, "shutterSound", "click");
  cJSON_AddNumberToObject(sh, "volume", 6);
  cJSON_AddNumberToObject(sh, "displayAfterShotS", 2);

  cJSON *b = cJSON_AddObjectToObject(c, "body");
  /* What someone calls this camera, 0..24 characters. Empty by default and
   * deliberately not the serial: `device` in the envelope is already the
   * serial, and pre-filling this with it would make every camera look named
   * when none of them is. The About screen simply omits the row while it is
   * empty. Length is enforced where it is written (kdp_server.c's SET_CONFIG),
   * not here - defaults cannot violate it. */
  cJSON_AddStringToObject(b, "name", "");
  cJSON_AddNumberToObject(b, "brightness", 10);
  cJSON_AddNumberToObject(b, "autoDimS", 30);
  cJSON_AddNumberToObject(b, "sleepS", 120);
  cJSON_AddNumberToObject(b, "camIdleTimeoutS", 300);
  cJSON *snd = cJSON_AddObjectToObject(b, "sounds");
  cJSON_AddBoolToObject(snd, "startup", true);
  cJSON_AddBoolToObject(snd, "ui", true);
  cJSON_AddBoolToObject(snd, "save", true);
  cJSON_AddBoolToObject(snd, "warning", true);
  cJSON *btn = cJSON_AddObjectToObject(b, "buttons");
  cJSON_AddStringToObject(btn, "fn", "flash");
  cJSON_AddStringToObject(btn, "slide", "power-lock");

  return c;
}

static void build_default_envelope(const char *device) {
  if (s_root) cJSON_Delete(s_root);
  s_root = cJSON_CreateObject();
  cJSON_AddNumberToObject(s_root, "schemaVersion", CONFIG_SCHEMA_VERSION);
  cJSON_AddStringToObject(s_root, "device", device ? device : "");
  cJSON_AddNumberToObject(s_root, "configRevision", 0);
  s_config = default_config();
  cJSON_AddItemToObject(s_root, "config", s_config);
  s_revision = 0;
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

/**
 * Recursively merge `patch` into `dst`.
 *
 * Objects recurse; everything else replaces. An array is replaced whole
 * rather than merged element-wise, because there is no key to match elements
 * on and a half-merged array is worse than either outcome.
 */
static void merge_into(cJSON *dst, const cJSON *patch) { meta_merge_into(dst, patch); }

/* ------------------------------------------------------------------ */
/* Migration                                                           */
/* ------------------------------------------------------------------ */

/**
 * Bring a stored envelope up to CONFIG_SCHEMA_VERSION.
 *
 * The decision and the backfill live in meta.c so they can be host-tested
 * against real cJSON; this is the part that needs the module's own state.
 */
static bool migrate_envelope(void) {
  cJSON *defaults = default_config();
  if (defaults == NULL) return false;

  const meta_migrate_result_t res =
      meta_migrate_config(s_root, defaults, CONFIG_SCHEMA_VERSION);
  switch (res) {
    case META_MIGRATE_OK:
      /* meta_migrate_config took ownership of `defaults` and it is now the
       * envelope's `config`. */
      s_config = cJSON_GetObjectItem(s_root, "config");
      return s_config != NULL;

    case META_MIGRATE_FROM_FUTURE:
      cJSON_Delete(defaults);
      ESP_LOGW(TAG, "stored config is newer than schema v%d - keeping it as-is "
                    "rather than downgrading", CONFIG_SCHEMA_VERSION);
      klog("P4", "config from newer firmware kept unmigrated");
      return true;

    default:
      cJSON_Delete(defaults);
      ESP_LOGE(TAG, "no migration path to schema v%d; using defaults",
               CONFIG_SCHEMA_VERSION);
      return false;
  }
}

esp_err_t config_merge(const cJSON *patch) {
  if (patch == NULL || !cJSON_IsObject(patch)) return ESP_ERR_INVALID_ARG;
  lock();
  if (s_config == NULL) {
    unlock();
    return ESP_ERR_INVALID_STATE;
  }
  merge_into(s_config, patch);
  s_revision++;
  cJSON *rev = cJSON_GetObjectItem(s_root, "configRevision");
  if (rev) cJSON_SetNumberValue(rev, (double)s_revision);
  unlock();
  return ESP_OK;
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

esp_err_t config_save(void) {
  lock();
  if (s_root == NULL) {
    unlock();
    return ESP_ERR_INVALID_STATE;
  }
  /* Serialised under the lock, then written to NVS outside it: printing walks
   * the whole tree and must not race a merge, but an NVS commit is slow and
   * has no business blocking the audio task's next volume lookup. */
  char *text = cJSON_PrintUnformatted(s_root);
  const uint32_t rev = s_revision;
  unlock();
  if (text == NULL) return ESP_ERR_NO_MEM;

  /* Refused here rather than by NVS, and with a size error rather than
   * whatever nvs_set_str returns, so the SET_CONFIG handler has something it
   * can NACK with: the write is too big is a different answer to Studio from
   * the flash is broken. */
  const size_t bytes = strlen(text) + 1;
  if (bytes > CONFIG_MAX_BYTES) {
    ESP_LOGE(TAG, "config is %u bytes, NVS takes %u; not saved", (unsigned)bytes,
             (unsigned)CONFIG_MAX_BYTES);
    klog("P4", "config too large to save: %u bytes", (unsigned)bytes);
    cJSON_free(text);
    return ESP_ERR_INVALID_SIZE;
  }

  nvs_handle_t h;
  esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h);
  if (err == ESP_OK) {
    err = nvs_set_str(h, NVS_KEY, text);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
  }
  if (err == ESP_OK) {
    ESP_LOGI(TAG, "saved revision %lu, %u bytes", (unsigned long)rev, (unsigned)strlen(text));
    klog("P4", "config saved rev %lu", (unsigned long)rev);
  } else {
    ESP_LOGE(TAG, "save failed: %s", esp_err_to_name(err));
  }
  cJSON_free(text);
  return err;
}

esp_err_t config_reset(void) {
  lock();
  char device[40] = "";
  const cJSON *d = s_root ? cJSON_GetObjectItem(s_root, "device") : NULL;
  if (cJSON_IsString(d) && d->valuestring) snprintf(device, sizeof device, "%s", d->valuestring);
  build_default_envelope(device);
  unlock();
  ESP_LOGW(TAG, "reset to defaults");
  klog("P4", "config reset");
  return config_save();
}

esp_err_t config_init(void) {
  if (s_root != NULL) return ESP_OK;
  if (s_lock == NULL) {
    s_lock = xSemaphoreCreateMutex();
    if (s_lock == NULL) return ESP_ERR_NO_MEM;
  }

  /* NVS is already started by main before this runs; opening a namespace that
   * has never been written is not an error, it just has no key. */
  nvs_handle_t h;
  esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h);
  if (err == ESP_OK) {
    size_t len = 0;
    /* `len` from nvs_get_str counts the NUL, which is the same unit
     * CONFIG_MAX_BYTES is in, so the two guards agree by construction. */
    if (nvs_get_str(h, NVS_KEY, NULL, &len) == ESP_OK && len > 2 &&
        len <= CONFIG_MAX_BYTES) {
      char *text = malloc(len);
      if (text != NULL && nvs_get_str(h, NVS_KEY, text, &len) == ESP_OK &&
          /* On app_main's 3.5 KB stack. A saved envelope that nests deeper than
           * anything this firmware writes is treated as no config, which boots;
           * parsing it would overflow into a reboot loop that only an NVS erase
           * ends. SET_CONFIG refuses such a document before it can be saved. */
          pure_json_depth_ok(text, PURE_JSON_MAX_DEPTH)) {
        cJSON *parsed = cJSON_Parse(text);
        cJSON *cfg = parsed ? cJSON_GetObjectItem(parsed, "config") : NULL;
        if (cJSON_IsObject(cfg)) {
          s_root = parsed;
          s_config = cfg;
          const cJSON *rev = cJSON_GetObjectItem(s_root, "configRevision");
          s_revision = cJSON_IsNumber(rev) ? (uint32_t)rev->valuedouble : 0;

          /* Migrate before anything reads a setting. A partially-migrated
           * envelope handed to the power task or the audio task is worse than
           * defaults, so a failed migration discards and starts clean rather
           * than serving half an envelope. */
          if (migrate_envelope()) {
            ESP_LOGI(TAG, "loaded revision %lu from NVS, schema v%d",
                     (unsigned long)s_revision, CONFIG_SCHEMA_VERSION);
          } else {
            cJSON_Delete(s_root);
            s_root = NULL;
            s_config = NULL;
            s_revision = 0;
          }
        } else {
          /* Stored but unreadable. Defaults are better than refusing to boot,
           * and saying so is better than silently starting fresh. */
          ESP_LOGW(TAG, "stored config unparseable; using defaults");
          if (parsed) cJSON_Delete(parsed);
        }
      }
      free(text);
    }
    nvs_close(h);
  }

  if (s_root == NULL) {
    build_default_envelope("");
    ESP_LOGI(TAG, "no stored config; defaults built");
  }
  return ESP_OK;
}

/* ------------------------------------------------------------------ */
/* Dotted-path readers                                                 */
/* ------------------------------------------------------------------ */

static const cJSON *resolve(const char *path) {
  if (s_config == NULL || path == NULL) return NULL;
  const cJSON *node = s_config;
  char buf[64];
  snprintf(buf, sizeof buf, "%s", path);
  char *save = NULL;
  for (char *part = strtok_r(buf, ".", &save); part != NULL;
       part = strtok_r(NULL, ".", &save)) {
    node = cJSON_GetObjectItem(node, part);
    if (node == NULL) return NULL;
  }
  return node;
}

int config_int(const char *path, int fallback) {
  lock();
  const cJSON *n = resolve(path);
  const int v = cJSON_IsNumber(n) ? (int)n->valuedouble : fallback;
  unlock();
  return v;
}

bool config_bool(const char *path, bool fallback) {
  lock();
  const cJSON *n = resolve(path);
  const bool v = cJSON_IsBool(n) ? cJSON_IsTrue(n) : fallback;
  unlock();
  return v;
}

/**
 * String reads copy into a small per-call ring rather than handing back a
 * pointer into the document.
 *
 * Returning the cJSON pointer was a use-after-free waiting for its moment: the
 * caller reads it after the lock is dropped, and the next SET_CONFIG frees
 * exactly that string. The ring is there so a caller can hold two results at
 * once - a printf with two settings in it is ordinary.
 */
const char *config_str(const char *path, const char *fallback) {
  static char ring[4][48];
  static int slot;
  lock();
  const cJSON *n = resolve(path);
  const char *v = fallback;
  if (cJSON_IsString(n) && n->valuestring) {
    slot = (slot + 1) & 3;
    snprintf(ring[slot], sizeof ring[slot], "%s", n->valuestring);
    v = ring[slot];
  }
  unlock();
  return v;
}

/**
 * The same read, into the caller's own buffer.
 *
 * The ring above is four slots shared by every task in the firmware. Holding
 * one across anything that blocks - a draw, a klog, a KDP round trip - means
 * four more string reads from any other task overwrite it, and the caller
 * then acts on a value that belongs to somewhere else. Nothing has been seen
 * doing that, and nothing should have to reason about it: a caller that keeps
 * the value copies it here instead.
 *
 * Returns the length of the source string so truncation is detectable rather
 * than silent - a return >= cap means the copy is short. 0 when the path is
 * missing or is not a string, which is also what an empty stored string
 * returns; the two are the same for every setting this reads.
 */
size_t config_str_copy(const char *path, char *out, size_t cap) {
  if (out == NULL || cap == 0) return 0;
  out[0] = '\0';
  lock();
  const cJSON *n = resolve(path);
  size_t len = 0;
  if (cJSON_IsString(n) && n->valuestring) {
    len = strlen(n->valuestring);
    /* Copied under the lock, because the string this points at is freed by
     * the next merge. */
    strlcpy(out, n->valuestring, cap);
  }
  unlock();
  return len;
}
