#include "touch.h"

#include "board_d4v1.h"
#include "display.h"
#include "driver/i2c_master.h"
#include "esp_lcd_touch_gt911.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "klog.h"

static const char *TAG = "touch";

static esp_lcd_touch_handle_t s_tp;
static bool s_ready;
static uint32_t s_count;
static uint16_t s_x, s_y;
static bool s_down;

bool touch_ready(void) { return s_ready; }
uint32_t touch_count(void) { return s_count; }

bool touch_get(uint16_t *x, uint16_t *y) {
  if (!s_down) return false;
  if (x != NULL) *x = s_x;
  if (y != NULL) *y = s_y;
  return true;
}

/**
 * Polled, not interrupt driven. The board notes do not give an INT line for
 * the GT911 and a wrong guess at one is a pin driven for no reason, so this
 * reads the controller on a timer instead. A touch UI does not need better
 * than 50 Hz, and polling removes a pin from the unknowns.
 */
static void touch_task(void *arg) {
  (void)arg;
  uint16_t xs[1], ys[1], strength[1];
  uint8_t points = 0;
  bool was_down = false;

  for (;;) {
    if (esp_lcd_touch_read_data(s_tp) == ESP_OK &&
        esp_lcd_touch_get_coordinates(s_tp, xs, ys, strength, &points, 1) && points > 0) {
      s_x = xs[0];
      s_y = ys[0];
      s_down = true;
      if (!was_down) {
        s_count++;
        /* Logged every press during bring-up: raw coordinates are how the
         * panel's orientation gets established, rather than by asking
         * someone to judge which edge is the top. */
        ESP_LOGI(TAG, "touch #%lu at x=%u y=%u (native %dx%d), strength %u",
                 (unsigned long)s_count, xs[0], ys[0], DISPLAY_H_RES, DISPLAY_V_RES, strength[0]);
        klog("P4", "touch %u,%u", xs[0], ys[0]);
        was_down = true;
      }
    } else {
      s_down = false;
      was_down = false;
    }
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

esp_err_t touch_init(void) {
  if (s_ready) return ESP_OK;

  /* The GT911 shares this bus with the ES8311 audio codec, so the bus is
   * created here but must not be assumed exclusive: anything else that ever
   * talks to the codec has to take the same handle rather than re-create it. */
  i2c_master_bus_handle_t bus = NULL;
  i2c_master_bus_config_t bus_cfg = {
      .i2c_port = I2C_NUM_0,
      .sda_io_num = BOARD_TOUCH_I2C_SDA,
      .scl_io_num = BOARD_TOUCH_I2C_SCL,
      .clk_source = I2C_CLK_SRC_DEFAULT,
      .glitch_ignore_cnt = 7,
      .flags.enable_internal_pullup = true,
  };
  esp_err_t err = i2c_new_master_bus(&bus_cfg, &bus);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "I2C bus on SDA%d/SCL%d failed: %s", BOARD_TOUCH_I2C_SDA,
             BOARD_TOUCH_I2C_SCL, esp_err_to_name(err));
    return err;
  }

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
             BOARD_TOUCH_I2C_SDA, BOARD_TOUCH_I2C_SCL, esp_err_to_name(err));
    return err;
  }

  s_ready = true;
  ESP_LOGI(TAG, "TOUCH_READY gt911 at 0x%02x, polled, %dx%d native", BOARD_TOUCH_I2C_ADDR,
           DISPLAY_H_RES, DISPLAY_V_RES);
  klog("P4", "touch up gt911");
  xTaskCreate(touch_task, "touch", 4096, NULL, 4, NULL);
  return ESP_OK;
}
