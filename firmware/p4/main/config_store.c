#include "config_store.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "klog.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "config";

#define NVS_NAMESPACE "kino"
#define NVS_KEY "config"
#define CONFIG_SCHEMA_VERSION 1

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
  cJSON_AddNumberToObject(w, "fps", 8);
  cJSON_AddStringToObject(w, "loop", "bounce");
  cJSON_AddStringToObject(w, "direction", "ltr");
  cJSON_AddStringToObject(w, "recipeId", "");
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
    cJSON_AddStringToObject(s, "recipeId", "");
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
static void merge_into(cJSON *dst, const cJSON *patch) {
  const cJSON *item = NULL;
  cJSON_ArrayForEach(item, patch) {
    if (item->string == NULL) continue;
    cJSON *existing = cJSON_GetObjectItem(dst, item->string);
    if (cJSON_IsObject(item) && cJSON_IsObject(existing)) {
      merge_into(existing, item);
      continue;
    }
    cJSON *copy = cJSON_Duplicate(item, true);
    if (copy == NULL) continue;
    if (existing != NULL) cJSON_ReplaceItemInObject(dst, item->string, copy);
    else cJSON_AddItemToObject(dst, item->string, copy);
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
    if (nvs_get_str(h, NVS_KEY, NULL, &len) == ESP_OK && len > 2 && len < 16384) {
      char *text = malloc(len);
      if (text != NULL && nvs_get_str(h, NVS_KEY, text, &len) == ESP_OK) {
        cJSON *parsed = cJSON_Parse(text);
        cJSON *cfg = parsed ? cJSON_GetObjectItem(parsed, "config") : NULL;
        if (cJSON_IsObject(cfg)) {
          s_root = parsed;
          s_config = cfg;
          const cJSON *rev = cJSON_GetObjectItem(s_root, "configRevision");
          s_revision = cJSON_IsNumber(rev) ? (uint32_t)rev->valuedouble : 0;
          ESP_LOGI(TAG, "loaded revision %lu from NVS", (unsigned long)s_revision);
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
