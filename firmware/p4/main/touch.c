#include "touch.h"

#include "board_d4v1.h"
#include "board_i2c.h"
#include "display.h"
#include "driver/i2c_master.h"
#include "esp_lcd_touch_gt911.h"
#include "esp_log.h"
#include "taskmon.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "klog.h"
#include "hardware_validation.h"
#include "power.h"

static const char *TAG = "touch";

static esp_lcd_touch_handle_t s_tp;
static bool s_ready;
static uint32_t s_count;
/* Consecutive failed reads of the controller. Non-zero means the bus, not
 * the absence of a finger. */
static uint32_t s_read_fail;

/* The point is published as one 32-bit word.
 *
 * Two uint16_t fields are two stores, and the UI task reads them between the
 * two - so a finger crossing a tile boundary could hand the hit test the new
 * x with the old y, and register a press on a tile the finger never touched.
 * One aligned word is written and read indivisibly on this core. */
static volatile uint32_t s_point;
static volatile bool s_down;

bool touch_ready(void) { return s_ready; }
uint32_t touch_count(void) { return s_count; }

bool touch_get(uint16_t *x, uint16_t *y) {
  if (!s_down) return false;
  const uint32_t p = s_point;
  if (x != NULL) *x = (uint16_t)(p >> 16);
  if (y != NULL) *y = (uint16_t)(p & 0xFFFF);
  return true;
}

/**
 * Polled, not interrupt driven. The board notes do not give an INT line for
 * the GT911 and a wrong guess at one is a pin driven for no reason, so this
 * reads the controller on a timer instead. A touch UI does not need better
 * than 50 Hz, and polling removes a pin from the unknowns.
 */
/* How many empty polls in a row before the finger is called lifted.
 *
 * One is not enough. The GT911 shares SDA/SCL with the ES8311, so a codec
 * transaction can make a single read fail or return no points while the
 * finger is still very much down - and a release is an event, not just an
 * absence, because it is what fires a tile. Treating one empty poll as a
 * lift made presses let go by themselves mid-tap, worst of all exactly when
 * a sound was playing. Three polls is 45 ms, far below the ~80 ms a real tap
 * takes to lift, so nothing a person does is slowed by it. */
#define RELEASE_POLLS 3

static void touch_task(void *arg) {
  (void)arg;
  uint16_t xs[1], ys[1], strength[1];
  uint8_t points = 0;
  bool was_down = false;
  int empty = 0;

  for (;;) {
    points = 0;
    /* Split out from the old one-line condition so a failing bus is loud.
     *
     * A GT911 that has stopped answering and a finger that is not on the
     * glass produced exactly the same thing here - `got` false, silently,
     * forever - which is indistinguishable from a working driver nobody is
     * touching. That is the wrong way round for the one input the camera
     * has: a controller that has gone away should say so. */
    const esp_err_t rerr = esp_lcd_touch_read_data(s_tp);
    bool got = false;
    if (rerr == ESP_OK) {
      if (s_read_fail != 0) {
        ESP_LOGW(TAG, "GT911 answering again after %lu failed reads",
                 (unsigned long)s_read_fail);
        klog("P4", "touch bus recovered after %lu failures", (unsigned long)s_read_fail);
        s_read_fail = 0;
      }
      got = esp_lcd_touch_get_coordinates(s_tp, xs, ys, strength, &points, 1) && points > 0;
    } else {
      /* Rate limited: at 15 ms a hard failure would otherwise fill the log
       * at 66 lines a second and push out the thing that caused it. */
      if (s_read_fail % 200 == 0) {
        ESP_LOGE(TAG, "GT911 read failed: %s (%lu in a row)", esp_err_to_name(rerr),
                 (unsigned long)s_read_fail + 1);
        klog("P4", "touch read failed: %s", esp_err_to_name(rerr));
      }
      s_read_fail++;
    }

    if (got) {
      empty = 0;
      /* A finger on the glass is the definition of activity. Doing this on
       * every poll rather than only on the press edge means a long drag keeps
       * the panel awake too. */
      power_activity();
      s_point = ((uint32_t)xs[0] << 16) | ys[0];
      s_down = true;
      if (!was_down) {
        s_count++;
        /* A finger, not a probe: the controller reported a real contact. */
        hwv_mark_validated(HWV_TOUCH_GT911, "reported a contact");
        ESP_LOGI(TAG, "touch #%lu at x=%u y=%u (native %dx%d), strength %u",
                 (unsigned long)s_count, xs[0], ys[0], DISPLAY_H_RES, DISPLAY_V_RES, strength[0]);
        klog("P4", "touch %u,%u", xs[0], ys[0]);
        was_down = true;
      }
    } else if (was_down && ++empty < RELEASE_POLLS) {
      /* Hold the last point: a gap in the reads is not a lift. */
    } else {
      s_down = false;
      was_down = false;
      empty = 0;
    }
    /* 15 ms, so a press is seen within one frame of the UI's own loop. */
    vTaskDelay(pdMS_TO_TICKS(15));
  }
}

esp_err_t touch_init(void) {
  if (s_ready) return ESP_OK;

  /* Shared bus, not ours to create: the codec is on the same two pins. */
  i2c_master_bus_handle_t bus = NULL;
  esp_err_t err = board_i2c_bus(&bus);
  if (err != ESP_OK) return err;

  esp_lcd_panel_io_handle_t io = NULL;
  esp_lcd_panel_io_i2c_config_t io_cfg = ESP_LCD_TOUCH_IO_I2C_GT911_CONFIG();
  err = esp_lcd_new_panel_io_i2c(bus, &io_cfg, &io);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "GT911 panel io failed: %s", esp_err_to_name(err));
    return err;
  }

  esp_lcd_touch_config_t tp_cfg = {
      .x_max = DISPLAY_H_RES,
      .y_max = DISPLAY_V_RES,
      .rst_gpio_num = BOARD_TOUCH_RESET,
      .int_gpio_num = GPIO_NUM_NC,
      .levels = {.reset = 0, .interrupt = 0},
      /* No swap or mirror. The panel draws red at the top and the bands come
       * out in draw order, so the display's coordinate space is already
       * understood; touch is left raw so the two can be compared directly
       * and any transform applied once, in the UI, where it is visible. */
      .flags = {.swap_xy = 0, .mirror_x = 0, .mirror_y = 0},
  };
  err = esp_lcd_touch_new_i2c_gt911(io, &tp_cfg, &s_tp);
  if (err != ESP_OK) {
    /* The controller not answering is worth naming precisely: the address is
     * one of two on this part, and the board shares the bus with a codec. */
    ESP_LOGE(TAG, "GT911 not found at 0x%02x on SDA%d/SCL%d: %s", BOARD_TOUCH_I2C_ADDR,
             BOARD_I2C_SDA, BOARD_I2C_SCL, esp_err_to_name(err));
    return err;
  }

  s_ready = true;
  ESP_LOGI(TAG, "TOUCH_READY gt911 at 0x%02x, polled, %dx%d native", BOARD_TOUCH_I2C_ADDR,
           DISPLAY_H_RES, DISPLAY_V_RES);
  klog("P4", "touch up gt911");
  TaskHandle_t h = NULL;
  xTaskCreate(touch_task, "touch", 4096, NULL, 4, &h);
  taskmon_register("touch", h);
  return ESP_OK;
}
