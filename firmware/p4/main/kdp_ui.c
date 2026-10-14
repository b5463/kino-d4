#include "kdp_ui.h"

#include <stdbool.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "gfx.h"
#include "kdp/protocol.h"
#include "pure.h"
#include "ui.h"

#define SCREEN_BYTES ((uint32_t)UI_W * (uint32_t)UI_H * 2u)
/* How long a render may wait for the UI task. A pass is 20 ms and a render
 * of the busiest screen straight into the canvas is tens of ms; past this the
 * task is in a long blocking draw (a dissolve, a format) and the host asks
 * again rather than holding the KDP task. */
#define SHOT_WAIT_US (1500 * 1000)

static const char *const SCREEN_ID[UI_SCREEN_COUNT] = {UI_SCREEN_IDS};

/* One page of the canvas, copied out before it is sent so the copy can be
 * checked against the canvas generation afterwards. PSRAM, made once. */
static uint8_t *s_page;

/* A JSON number that is a whole value in [lo, hi]. */
static bool whole(const cJSON *j, double lo, double hi, double *out) {
  if (!cJSON_IsNumber(j)) return false;
  const double v = j->valuedouble;
  if (!(v >= lo && v <= hi) || v != (double)(int64_t)v) return false;
  *out = v;
  return true;
}

static kdp_module_reply_t screen_render(void) {
  if (!gfx_ready() || gfx_canvas() == NULL) {
    return kdp_module_fail("INVALID_STATE", "The screen is not running.");
  }
  const uint32_t ticket = ui_shot_ask();
  const int64_t until = esp_timer_get_time() + SHOT_WAIT_US;
  ui_shot_t shot = {0};
  ui_shot_state_t st;
  /* One tick at a time: pdMS_TO_TICKS() of a few ms is 0 at 100 Hz, which
   * would spin instead of yielding to the UI task. */
  while ((st = ui_shot_poll(ticket, &shot)) == UI_SHOT_WAITING && esp_timer_get_time() < until) {
    vTaskDelay(1);
  }
  if (st == UI_SHOT_WAITING) return kdp_module_fail("BUSY", "The screen did not answer. Ask again.");
  if (st == UI_SHOT_BUSY) return kdp_module_fail("BUSY", "The screen is moving. Ask again.");

  cJSON *j = cJSON_CreateObject();
  if (j == NULL) return kdp_module_fail("BUSY", "Out of memory");
  cJSON_AddNumberToObject(j, "shot", (double)shot.gen);
  cJSON_AddNumberToObject(j, "width", UI_W);
  cJSON_AddNumberToObject(j, "height", UI_H);
  cJSON_AddStringToObject(j, "format", "rgb565le");
  cJSON_AddNumberToObject(j, "bytes", (double)SCREEN_BYTES);
  cJSON_AddNumberToObject(j, "chunkMax", PURE_SCREEN_CHUNK_MAX);
  cJSON_AddStringToObject(j, "screen", shot.screen < UI_SCREEN_COUNT ? SCREEN_ID[shot.screen] : "menu");
  cJSON_AddBoolToObject(j, "plate", shot.plate);
  return kdp_module_json(j);
}

static kdp_module_reply_t screen_page(const cJSON *req) {
  double shot = 0, offset = 0, length = 0;
  if (!whole(cJSON_GetObjectItem(req, "shot"), 1, 4294967295.0, &shot)) {
    return kdp_module_fail("INVALID_ARGUMENT", "shot must be the number GET_SCREEN gave");
  }
  const cJSON *joff = cJSON_GetObjectItem(req, "offset");
  const cJSON *jlen = cJSON_GetObjectItem(req, "length");
  if ((joff != NULL && !whole(joff, -1e9, 1e9, &offset)) || (jlen != NULL && !whole(jlen, -1e9, 1e9, &length))) {
    return kdp_module_fail("INVALID_ARGUMENT", "offset and length must be whole numbers");
  }
  if (ui_screen_moving()) return kdp_module_fail("BUSY", "The screen is moving. Ask again.");

  const uint32_t want = (uint32_t)shot;
  uint32_t start = 0, len = 0;
  switch (pure_screen_page(want, gfx_canvas_gen(), SCREEN_BYTES, (int64_t)offset, (int64_t)length, &start, &len)) {
    case PURE_SCREEN_PAGE_OK: break;
    case PURE_SCREEN_PAGE_STALE: return kdp_module_fail("INVALID_STATE", "The screen changed. Ask again.");
    default: return kdp_module_fail("INVALID_ARGUMENT", "offset is past the end of the screen");
  }
  if (s_page == NULL) s_page = heap_caps_malloc(PURE_SCREEN_CHUNK_MAX, MALLOC_CAP_SPIRAM);
  if (s_page == NULL) return kdp_module_fail("BUSY", "Out of memory");
  const uint16_t *canvas = gfx_canvas();
  if (canvas == NULL) return kdp_module_fail("INVALID_STATE", "The screen is not running.");
  if (len > 0) memcpy(s_page, (const uint8_t *)canvas + start, len);
  /* Read again after the copy: a move that began while it ran bumped the
   * generation before it drew, so a page that passes this is one picture. */
  if (gfx_canvas_gen() != want) return kdp_module_fail("INVALID_STATE", "The screen changed. Ask again.");
  return kdp_module_bytes(s_page, len);
}

static kdp_module_reply_t screen_plate(const cJSON *req) {
  const cJSON *on = cJSON_GetObjectItem(req, "on");
  if (!cJSON_IsBool(on)) return kdp_module_fail("INVALID_ARGUMENT", "Expected {\"on\": true|false}");
  if (!gfx_ready()) return kdp_module_fail("INVALID_STATE", "The screen is not running.");
  ui_plate_post(cJSON_IsTrue(on));
  cJSON *j = cJSON_CreateObject();
  if (j == NULL) return kdp_module_fail("BUSY", "Out of memory");
  cJSON_AddBoolToObject(j, "ok", true);
  cJSON_AddBoolToObject(j, "on", cJSON_IsTrue(on));
  return kdp_module_json(j);
}

static kdp_module_reply_t ui_tap(const cJSON *req) {
  const cJSON *jx = cJSON_GetObjectItem(req, "x");
  const cJSON *jy = cJSON_GetObjectItem(req, "y");
  const cJSON *jh = cJSON_GetObjectItem(req, "holdMs");
  const double hold = jh == NULL ? PURE_SCREEN_TAP_HOLD_MS : (cJSON_IsNumber(jh) ? jh->valuedouble : -1);
  if (!cJSON_IsNumber(jx) || !cJSON_IsNumber(jy) ||
      !pure_screen_tap_ok(jx->valuedouble, jy->valuedouble, hold, UI_W, UI_H)) {
    return kdp_module_fail("INVALID_ARGUMENT", "x must be 0..799, y 0..479 and holdMs 20..4000");
  }
  const int queued = ui_tap_post((int)jx->valuedouble, (int)jy->valuedouble, (int)hold);
  if (queued == 0) return kdp_module_fail("BUSY", "Four taps are waiting. Ask again.");
  cJSON *j = cJSON_CreateObject();
  if (j == NULL) return kdp_module_fail("BUSY", "Out of memory");
  cJSON_AddBoolToObject(j, "ok", true);
  cJSON_AddNumberToObject(j, "queued", queued);
  return kdp_module_json(j);
}

static kdp_module_reply_t ui_key(const cJSON *req) {
  const cJSON *jk = cJSON_GetObjectItem(req, "key");
  const cJSON *jl = cJSON_GetObjectItem(req, "longPress");
  const char *key = cJSON_IsString(jk) ? jk->valuestring : NULL;
  const bool shutter = key != NULL && strcmp(key, "shutter") == 0;
  if (key == NULL || (!shutter && strcmp(key, "fn") != 0)) {
    return kdp_module_fail("INVALID_ARGUMENT", "key must be shutter or fn");
  }
  if (jl != NULL && !cJSON_IsBool(jl)) return kdp_module_fail("INVALID_ARGUMENT", "longPress must be true or false");
  if (!ui_key_post(shutter, cJSON_IsTrue(jl))) return kdp_module_fail("BUSY", "The key queue is full. Ask again.");
  cJSON *j = cJSON_CreateObject();
  if (j == NULL) return kdp_module_fail("BUSY", "Out of memory");
  cJSON_AddBoolToObject(j, "ok", true);
  cJSON_AddStringToObject(j, "key", shutter ? "shutter" : "fn");
  return kdp_module_json(j);
}

kdp_module_reply_t kdp_ui_handle(uint8_t cmd, const cJSON *req) {
  switch (cmd) {
    case KDP_CMD_GET_SCREEN:
      return cJSON_GetObjectItem(req, "shot") == NULL ? screen_render() : screen_page(req);
    case KDP_CMD_SCREEN_PLATE: return screen_plate(req);
    case KDP_CMD_UI_TAP: return ui_tap(req);
    case KDP_CMD_UI_KEY: return ui_key(req);
    default: return kdp_module_fail("UNSUPPORTED_COMMAND", "Not a Screen command");
  }
}
