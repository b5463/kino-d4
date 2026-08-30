#include "kdp_recipes.h"

#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "config_store.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "klog.h"
#include "kdp/packet.h"
#include "kdp/protocol.h"
#include "recipe_rules.h"
#include "storage.h"

static const char *TAG = "recipes";

#define RECIPES_DIR "/sdcard/KINO/RECIPES"

/* How many custom looks the camera keeps, and how big one may be.
 *
 * 24 is not a storage limit - a look is about 500 bytes and the card holds
 * millions - it is a listing limit. GET_RECIPES answers in one KDP frame and
 * the LOOK screen cycles the list one press at a time, so an unbounded
 * directory becomes an oversized reply and a picker nobody can reach the end
 * of. 4096 bytes is the same argument from the other side: a look is a
 * hundred numbers, and a document larger than this is not a look. */
#define RECIPES_MAX 24
#define RECIPE_MAX_BYTES 2048
/* GET_RECIPES answers in one frame: the eleven factory documents (about 6 KB
 * with descriptions) plus every custom document must fit KDP_MAX_PAYLOAD.
 * The count cap above cannot guarantee that on its own - 24 documents at the
 * byte cap would be 48 KB - so an upload is also refused when the listing it
 * would produce no longer fits. Without this, four large looks would break
 * GET_RECIPES for good, and a host that cannot list looks cannot delete one. */
#define RECIPES_LISTING_SLACK 512

/* Long enough for a capture to finish writing four frames' worth of directory
 * entries. Same budget the UI uses for a photograph decode; a look that
 * cannot be listed for two seconds is a BUSY the host retries, not a fault. */
#define RECIPES_CARD_WAIT_MS 2000

/* The compiled-in factory looks. EMBED_TXTFILES appends a NUL, so the blob is
 * a C string and cJSON_Parse takes it directly. */
extern const char factory_recipes_json_start[] asm("_binary_factory_recipes_json_start");

/* Parsed once at boot and kept for the life of the image. Re-parsing per
 * request would cost about 8 KB of heap churn on a command Studio issues on
 * every page load, and the document is immutable. */
static cJSON *s_factory;

/* The custom looks, mirrored in RAM.
 *
 * The directory is the truth; this is what the LOOK screen reads while the
 * card is held by a capture, and what GET_RECIPES serialises without opening
 * eleven files. Rebuilt on the first list after a change, not on every one -
 * `s_custom_valid` is what makes an upload or a delete visible. */
typedef struct {
  char id[KDP_RECIPE_ID_MAX];
  char name[KDP_RECIPE_NAME_MAX];
  uint32_t bytes; /* document size on the card; what the listing will carry */
} recipe_entry_t;

static recipe_entry_t s_custom[RECIPES_MAX];
static int s_custom_count;
static bool s_custom_valid;

/* ------------------------------------------------------------------ */
/* Factory looks                                                       */
/* ------------------------------------------------------------------ */

static const cJSON *factory_by_id(const char *id) {
  if (s_factory == NULL || id == NULL) return NULL;
  const cJSON *r = NULL;
  cJSON_ArrayForEach(r, s_factory) {
    const cJSON *rid = cJSON_GetObjectItem(r, "id");
    if (cJSON_IsString(rid) && rid->valuestring && strcmp(rid->valuestring, id) == 0) return r;
  }
  return NULL;
}

/* ------------------------------------------------------------------ */
/* The card                                                            */
/* ------------------------------------------------------------------ */

static void recipe_path(char *out, size_t cap, const char *id) {
  snprintf(out, cap, "%s/%s.json", RECIPES_DIR, id);
}

/* The read buffer for one look document, in PSRAM, allocated once.
 *
 * Not on the stack: recipe_read() runs on the main task at boot (3584 bytes
 * of stack, CONFIG_ESP_MAIN_TASK_STACK_SIZE) through kdp_recipes_init(), and
 * on the KDP server task for every listing. A 4 KB local there is a stack
 * overflow the first time a card carries one custom look - a panic that an
 * empty bench card never shows. One request is served before the next is
 * decoded, so one buffer is enough. */
static char *s_read_buf;

/** Read one look document off the card. Caller deletes the result. `bytes`,
 * when given, receives the document's size on the card. */
static cJSON *recipe_read(const char *id, size_t *bytes) {
  if (bytes) *bytes = 0;
  if (s_read_buf == NULL) {
    s_read_buf = heap_caps_malloc(RECIPE_MAX_BYTES + 1, MALLOC_CAP_SPIRAM);
    if (s_read_buf == NULL) return NULL;
  }
  char path[160];
  recipe_path(path, sizeof path, id);
  FILE *f = fopen(path, "rb");
  if (f == NULL) return NULL;

  const size_t n = fread(s_read_buf, 1, RECIPE_MAX_BYTES, f);
  fclose(f);
  s_read_buf[n] = '\0';
  if (bytes) *bytes = n;
  return cJSON_Parse(s_read_buf);
}

/**
 * Rebuild the RAM mirror from the directory.
 *
 * The card lock is the caller's. Files that do not parse or do not validate
 * are skipped rather than deleted: a look the camera cannot read is still the
 * user's file, and a boot that quietly erased it would be the worst possible
 * answer to a half-written upload.
 */
static void custom_reload(void) {
  s_custom_count = 0;
  s_custom_valid = true;

  DIR *d = opendir(RECIPES_DIR);
  if (d == NULL) return; /* no card, or no directory yet - zero custom looks */

  struct dirent *e;
  while ((e = readdir(d)) != NULL && s_custom_count < RECIPES_MAX) {
    const size_t len = strlen(e->d_name);
    if (len < 6 || strcmp(e->d_name + len - 5, ".json") != 0) continue;

    char id[KDP_RECIPE_ID_MAX];
    if (len - 5 >= sizeof id) continue;
    memcpy(id, e->d_name, len - 5);
    id[len - 5] = '\0';
    if (!recipe_rules_id_ok(id)) continue;

    size_t bytes = 0;
    cJSON *doc = recipe_read(id, &bytes);
    if (doc == NULL) continue;
    if (recipe_rules_check(doc, NULL, 0)) {
      /* recipe_rules_check() has already established that `name` is a string
       * of 1..RECIPE_NAME_MAX characters, so it is read without a fallback -
       * a fallback to `id` would be up to 48 bytes into a 41-byte field. */
      const cJSON *name = cJSON_GetObjectItem(doc, "name");
      snprintf(s_custom[s_custom_count].id, sizeof s_custom[0].id, "%s", id);
      snprintf(s_custom[s_custom_count].name, sizeof s_custom[0].name, "%s", name->valuestring);
      s_custom[s_custom_count].bytes = (uint32_t)bytes;
      s_custom_count++;
    } else {
      ESP_LOGW(TAG, "%s.json is not a look; skipped", id);
    }
    cJSON_Delete(doc);
  }
  closedir(d);
}

/** custom_reload() only when something has changed since the last one. */
static void custom_sync(void) {
  if (!s_custom_valid) custom_reload();
}

static bool custom_has(const char *id) {
  for (int i = 0; i < s_custom_count; i++)
    if (strcmp(s_custom[i].id, id) == 0) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

esp_err_t kdp_recipes_init(void) {
  s_factory = cJSON_Parse(factory_recipes_json_start);
  if (!cJSON_IsArray(s_factory)) {
    /* The blob is compiled in, so this is a build fault rather than a runtime
     * one - but it must not take the KDP server down with it. */
    ESP_LOGE(TAG, "embedded factory_recipes.json did not parse as an array");
    cJSON_Delete(s_factory);
    s_factory = NULL;
    return ESP_FAIL;
  }

  /* mkdir before the first upload rather than inside it: the directory is
   * also what the LOOK screen lists, and creating it here means an empty
   * camera lists zero custom looks instead of failing to open a path. */
  bool took = false;
  if (storage_acquire_unless_held(STORAGE_USER_UI, RECIPES_CARD_WAIT_MS, &took)) {
    /* Under the card lock like every other card write here. EEXIST is the
     * normal case and no card at all is a reported state, not a failure:
     * factory looks still list either way. */
    mkdir("/sdcard/KINO", 0777);
    mkdir(RECIPES_DIR, 0777);
    custom_reload();
    storage_release_if_taken(STORAGE_USER_UI, took);
  } else {
    s_custom_valid = false; /* listed on the first request that gets the card */
  }

  klog("P4", "looks: %d factory, %d custom", cJSON_GetArraySize(s_factory), s_custom_count);
  return ESP_OK;
}

bool kdp_recipes_capable(void) { return s_factory != NULL; }

/* ------------------------------------------------------------------ */
/* The LOOK screen's view                                              */
/* ------------------------------------------------------------------ */

int kdp_recipes_count(void) {
  if (s_factory == NULL) return 0;
  return cJSON_GetArraySize(s_factory) + s_custom_count;
}

bool kdp_recipes_name(int index, char *id, size_t id_cap, char *name, size_t name_cap) {
  if (id && id_cap) id[0] = '\0';
  if (name && name_cap) name[0] = '\0';
  if (s_factory == NULL || index < 0) return false;

  const int n_factory = cJSON_GetArraySize(s_factory);
  if (index < n_factory) {
    const cJSON *r = cJSON_GetArrayItem(s_factory, index);
    const cJSON *rid = cJSON_GetObjectItem(r, "id");
    const cJSON *rname = cJSON_GetObjectItem(r, "name");
    if (!cJSON_IsString(rid) || rid->valuestring == NULL) return false;
    if (id && id_cap) snprintf(id, id_cap, "%s", rid->valuestring);
    if (name && name_cap)
      snprintf(name, name_cap, "%s",
               cJSON_IsString(rname) && rname->valuestring ? rname->valuestring : rid->valuestring);
    return true;
  }

  const int c = index - n_factory;
  if (c >= s_custom_count) return false;
  if (id && id_cap) snprintf(id, id_cap, "%s", s_custom[c].id);
  if (name && name_cap) snprintf(name, name_cap, "%s", s_custom[c].name);
  return true;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

static kdp_module_reply_t handle_get_recipes(void) {
  cJSON *json = cJSON_CreateObject();
  cJSON *factory = cJSON_AddArrayToObject(json, "factory");
  const cJSON *r = NULL;
  cJSON_ArrayForEach(r, s_factory) { cJSON_AddItemToArray(factory, cJSON_Duplicate(r, true)); }

  cJSON *custom = cJSON_AddArrayToObject(json, "custom");
  for (int i = 0; i < s_custom_count; i++) {
    /* Read back rather than served from the mirror: the mirror holds an id
     * and a name, and the host asked for the documents. */
    cJSON *doc = recipe_read(s_custom[i].id, NULL);
    if (doc != NULL) cJSON_AddItemToArray(custom, doc);
  }
  return kdp_module_json(json);
}

/* Which config paths a SET_RECIPE writes.
 *
 * No `cam` is the wiggle look, which is also what GET_DEVICE_INFO reports as
 * activeRecipe - so a host that knows nothing about quad gets the mock's
 * behaviour exactly. "all" writes every quad slot AND wiggle, so "give this
 * look to the whole camera" is one command rather than five. */
static kdp_module_reply_t handle_set_recipe(const cJSON *req) {
  const cJSON *id = cJSON_GetObjectItem(req, "id");
  if (!cJSON_IsString(id) || id->valuestring == NULL) {
    return kdp_module_fail("BAD_REQUEST", "Expected {\"id\":\"<look>\"}");
  }
  const char *rid = id->valuestring;

  const cJSON *cam = cJSON_GetObjectItem(req, "cam");
  const char *target = NULL;
  if (cam != NULL && !cJSON_IsNull(cam)) {
    if (!cJSON_IsString(cam) || cam->valuestring == NULL) {
      return kdp_module_fail("INVALID_ARGUMENT", "cam must be cam1..cam4 or all");
    }
    target = cam->valuestring;
    if (strcmp(target, "all") != 0 && (strlen(target) != 4 || strncmp(target, "cam", 3) != 0 ||
                                       target[3] < '1' || target[3] > '4')) {
      return kdp_module_fail("INVALID_ARGUMENT", "cam must be cam1..cam4 or all");
    }
  }

  /* The look has to exist before it is named in the config, or a camera comes
   * back from a reboot pointing at nothing and the LOOK screen has no name to
   * show. Custom looks are checked against the mirror, which needs the card
   * only when something changed since the last listing. */
  if (factory_by_id(rid) == NULL) {
    bool took = false;
    if (!s_custom_valid) {
      if (!storage_acquire_unless_held(STORAGE_USER_UI, RECIPES_CARD_WAIT_MS, &took))
        return kdp_module_fail("BUSY", "Card is busy with a capture");
      custom_sync();
      storage_release_if_taken(STORAGE_USER_UI, took);
    }
    if (!custom_has(rid)) return kdp_module_fail("NOT_FOUND", "No look with that id");
  }

  cJSON *patch = cJSON_CreateObject();
  if (target == NULL || strcmp(target, "all") == 0) {
    cJSON *w = cJSON_AddObjectToObject(patch, "wiggle");
    cJSON_AddStringToObject(w, "recipeId", rid);
  }
  if (target != NULL) {
    cJSON *q = cJSON_AddObjectToObject(patch, "quad");
    cJSON *slots = cJSON_AddObjectToObject(q, "slots");
    static const char *const CAMS[4] = {"cam1", "cam2", "cam3", "cam4"};
    for (int i = 0; i < 4; i++) {
      if (strcmp(target, "all") != 0 && strcmp(target, CAMS[i]) != 0) continue;
      cJSON *s = cJSON_AddObjectToObject(slots, CAMS[i]);
      cJSON_AddStringToObject(s, "recipeId", rid);
    }
  }

  const esp_err_t err = config_merge(patch);
  cJSON_Delete(patch);
  if (err != ESP_OK) return kdp_module_fail("BAD_REQUEST", "Look could not be stored");

  /* Not saved here, for the same reason SET_CONFIG does not save: SAVE_CONFIG
   * is what makes a setting survive a power cycle, and a look tried on the
   * bench should be as forgettable as any other setting. */
  klog("P4", "look %s -> %s", rid, target ? target : "wiggle");

  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  cJSON_AddStringToObject(json, "id", rid);
  if (target != NULL) cJSON_AddStringToObject(json, "cam", target);
  else cJSON_AddNullToObject(json, "cam");
  cJSON_AddNumberToObject(json, "configRevision", config_revision());
  return kdp_module_json(json);
}

static kdp_module_reply_t handle_upload_recipe(const cJSON *req) {
  const cJSON *recipe = cJSON_GetObjectItem(req, "recipe");
  if (recipe == NULL) return kdp_module_fail("BAD_REQUEST", "Expected {\"recipe\":{...}}");

  char why[KDP_MODULE_MSG_LEN];
  if (!recipe_rules_check(recipe, why, sizeof why)) {
    return kdp_module_fail("INVALID_ARGUMENT", why);
  }
  const char *rid = cJSON_GetObjectItem(recipe, "id")->valuestring;

  if (factory_by_id(rid) != NULL) {
    return kdp_module_fail("FACTORY_LOCKED", "Factory recipe ids cannot be overwritten");
  }

  /* Stored with factory:false regardless of what arrived. The flag says where
   * a look came from, and a custom look claiming to be factory would be
   * undeletable in Studio and locked here on its next upload. */
  cJSON *doc = cJSON_Duplicate(recipe, true);
  if (doc == NULL) return kdp_module_fail("STORAGE_ERROR", "Out of memory");
  cJSON_DeleteItemFromObject(doc, "factory");
  cJSON_AddBoolToObject(doc, "factory", false);

  char *text = cJSON_PrintUnformatted(doc);
  cJSON_Delete(doc);
  if (text == NULL) return kdp_module_fail("STORAGE_ERROR", "Out of memory");

  const size_t len = strlen(text);
  if (len > RECIPE_MAX_BYTES) {
    cJSON_free(text);
    char msg[KDP_MODULE_MSG_LEN];
    snprintf(msg, sizeof msg, "Look document exceeds %d bytes", RECIPE_MAX_BYTES);
    return kdp_module_fail("INVALID_ARGUMENT", msg);
  }

  bool took = false;
  if (!storage_acquire_unless_held(STORAGE_USER_UI, RECIPES_CARD_WAIT_MS, &took)) {
    cJSON_free(text);
    return kdp_module_fail("BUSY", "Card is busy with a capture");
  }
  custom_sync();

  /* The ceiling applies to NEW ids only, so re-uploading an edited look at
   * the limit still works - the alternative is a camera that will not let you
   * fix the look you already have. */
  if (s_custom_count >= RECIPES_MAX && !custom_has(rid)) {
    storage_release_if_taken(STORAGE_USER_UI, took);
    cJSON_free(text);
    char msg[KDP_MODULE_MSG_LEN];
    snprintf(msg, sizeof msg, "The camera holds %d custom looks; delete one first", RECIPES_MAX);
    return kdp_module_fail("STORAGE_ERROR", msg);
  }

  /* The listing this upload would produce has to fit one frame. Factory
   * documents are what the embedded blob serialises to; each custom document
   * is what is on the card, minus the one being replaced; plus the envelope. */
  {
    size_t listing = strlen(factory_recipes_json_start) + RECIPES_LISTING_SLACK + len;
    for (int i = 0; i < s_custom_count; i++) {
      if (strcmp(s_custom[i].id, rid) != 0) listing += s_custom[i].bytes;
    }
    if (listing > KDP_MAX_PAYLOAD) {
      storage_release_if_taken(STORAGE_USER_UI, took);
      cJSON_free(text);
      char msg[KDP_MODULE_MSG_LEN];
      snprintf(msg, sizeof msg,
               "Looks would total %u bytes; the camera lists at most %u. Delete one first",
               (unsigned)listing, (unsigned)KDP_MAX_PAYLOAD);
      return kdp_module_fail("STORAGE_ERROR", msg);
    }
  }

  char path[160];
  recipe_path(path, sizeof path, rid);
  FILE *f = fopen(path, "wb");
  bool opened = f != NULL;
  bool ok = false;
  if (opened) {
    ok = fwrite(text, 1, len, f) == len;
    /* fclose is where a full card usually reports itself, not fwrite - the
     * bytes sit in the stdio buffer until then. */
    if (fclose(f) != 0) ok = false;
  }
  cJSON_free(text);

  if (!ok) {
    /* A half-written look is not a look. Leaving it would make the next
     * listing skip a file the host believes it uploaded. */
    if (opened) unlink(path);
    storage_release_if_taken(STORAGE_USER_UI, took);
    return kdp_module_fail("STORAGE_ERROR", "Could not write the look to the card");
  }

  s_custom_valid = false;
  custom_sync();
  storage_release_if_taken(STORAGE_USER_UI, took);

  const cJSON *name = cJSON_GetObjectItem(recipe, "name");
  klog("P4", "look stored: %s", cJSON_IsString(name) ? name->valuestring : rid);

  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  cJSON_AddStringToObject(json, "id", rid);
  return kdp_module_json(json);
}

static kdp_module_reply_t handle_delete_recipe(const cJSON *req) {
  const cJSON *id = cJSON_GetObjectItem(req, "id");
  if (!cJSON_IsString(id) || id->valuestring == NULL) {
    return kdp_module_fail("BAD_REQUEST", "Expected {\"id\":\"<look>\"}");
  }
  const char *rid = id->valuestring;

  if (factory_by_id(rid) != NULL) {
    return kdp_module_fail("FACTORY_LOCKED", "Factory recipes cannot be deleted");
  }
  /* Checked before the card is opened: an id that could not name a file is a
   * bad request, not a missing look. */
  if (!recipe_rules_id_ok(rid)) {
    return kdp_module_fail("BAD_REQUEST", "Look id must be lowercase letters, digits and dashes");
  }

  bool took = false;
  if (!storage_acquire_unless_held(STORAGE_USER_UI, RECIPES_CARD_WAIT_MS, &took)) {
    return kdp_module_fail("BUSY", "Card is busy with a capture");
  }

  char path[160];
  recipe_path(path, sizeof path, rid);
  const bool gone = unlink(path) != 0;
  if (!gone) {
    s_custom_valid = false;
    custom_sync();
  }
  storage_release_if_taken(STORAGE_USER_UI, took);

  if (gone) return kdp_module_fail("NOT_FOUND", "No look with that id");

  klog("P4", "look deleted: %s", rid);
  cJSON *json = cJSON_CreateObject();
  cJSON_AddBoolToObject(json, "ok", true);
  cJSON_AddStringToObject(json, "id", rid);
  return kdp_module_json(json);
}

kdp_module_reply_t kdp_recipes_handle(uint8_t cmd, const cJSON *req) {
  if (s_factory == NULL) {
    return kdp_module_fail("UNSUPPORTED_COMMAND", "Looks are not available in this firmware");
  }

  switch (cmd) {
    case KDP_CMD_GET_RECIPES: {
      /* The listing reads every custom document off the card, so it holds
       * the card for the whole reply - up to RECIPES_MAX opens landing in the
       * middle of a four-frame capture is exactly the stall the arbiter
       * exists to prevent. A camera mid-capture answers BUSY to a page load
       * and Studio retries; factory-only cameras never touch the card here
       * because s_custom_count is zero. */
      if (s_custom_count == 0 && s_custom_valid) return handle_get_recipes();
      bool took = false;
      if (!storage_acquire_unless_held(STORAGE_USER_UI, RECIPES_CARD_WAIT_MS, &took)) {
        return kdp_module_fail("BUSY", "Card is busy with a capture");
      }
      custom_sync();
      kdp_module_reply_t reply = handle_get_recipes();
      storage_release_if_taken(STORAGE_USER_UI, took);
      return reply;
    }
    case KDP_CMD_SET_RECIPE: return handle_set_recipe(req);
    case KDP_CMD_UPLOAD_RECIPE: return handle_upload_recipe(req);
    case KDP_CMD_DELETE_RECIPE: return handle_delete_recipe(req);
    default: return kdp_module_fail("UNSUPPORTED_COMMAND", "Not a look command");
  }
}
