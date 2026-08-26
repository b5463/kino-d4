#include "display.h"

#include <string.h>

#include "board_d4v1.h"
#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_st7701.h"
#include "esp_ldo_regulator.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "klog.h"

static const char *TAG = "display";

static esp_lcd_panel_handle_t s_panel;
static bool s_ready;

bool display_ready(void) { return s_ready; }

/* The panel's own reset line, held per the panel's timing requirement. */
static void panel_reset_pulse(void) {
  gpio_config_t cfg = {
      .pin_bit_mask = 1ULL << BOARD_LCD_RESET,
      .mode = GPIO_MODE_OUTPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };
  gpio_config(&cfg);
  gpio_set_level(BOARD_LCD_RESET, 0);
  vTaskDelay(pdMS_TO_TICKS(20));
  gpio_set_level(BOARD_LCD_RESET, 1);
  vTaskDelay(pdMS_TO_TICKS(120));
}

/* Backlight is a plain GPIO on this board, not an LEDC channel. Driving it
 * as PWM would be a quiet way to get a dark panel that looks like a dead
 * one. Brightness control, if it is ever wanted, needs a hardware answer. */
static void backlight(bool on) {
  gpio_config_t cfg = {
      .pin_bit_mask = 1ULL << BOARD_LCD_BACKLIGHT,
      .mode = GPIO_MODE_OUTPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };
  gpio_config(&cfg);
  gpio_set_level(BOARD_LCD_BACKLIGHT, on ? 1 : 0);
}

esp_err_t display_init(void) {
  if (s_ready) return ESP_OK;

  /* DSI-PHY power. A different LDO channel from the SD card's ch4, so the
   * two do not contend — worth stating because both are on-chip and a
   * channel collision would present as a card that stops mounting when the
   * screen comes up. */
  esp_ldo_channel_handle_t phy_ldo = NULL;
  esp_ldo_channel_config_t ldo_cfg = {
      .chan_id = BOARD_LCD_DSI_LDO_CHANNEL,
      .voltage_mv = BOARD_LCD_DSI_LDO_MV,
  };
  esp_err_t err = esp_ldo_acquire_channel(&ldo_cfg, &phy_ldo);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "DSI PHY LDO ch%d failed: %s", BOARD_LCD_DSI_LDO_CHANNEL, esp_err_to_name(err));
    return err;
  }

  panel_reset_pulse();

  esp_lcd_dsi_bus_handle_t bus = NULL;
  esp_lcd_dsi_bus_config_t bus_cfg = {
      .bus_id = 0,
      .num_data_lanes = 2,
      .phy_clk_src = MIPI_DSI_PHY_CLK_SRC_DEFAULT,
      .lane_bit_rate_mbps = 500,
  };
  err = esp_lcd_new_dsi_bus(&bus_cfg, &bus);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "DSI bus failed: %s", esp_err_to_name(err));
    return err;
  }

  /* Command channel. The panel's registers are written over DBI; pixels go
   * over DPI below. */
  esp_lcd_panel_io_handle_t io = NULL;
  esp_lcd_dbi_io_config_t dbi_cfg = {
      .virtual_channel = 0,
      .lcd_cmd_bits = 8,
      .lcd_param_bits = 8,
  };
  err = esp_lcd_new_panel_io_dbi(bus, &dbi_cfg, &io);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "DBI io failed: %s", esp_err_to_name(err));
    return err;
  }

  esp_lcd_dpi_panel_config_t dpi_cfg = {
      .virtual_channel = 0,
      .dpi_clk_src = MIPI_DSI_DPI_CLK_SRC_DEFAULT,
      .dpi_clock_freq_mhz = 34,
      .pixel_format = LCD_COLOR_PIXEL_FORMAT_RGB565,
      .num_fbs = 1,
      .video_timing = {
          .h_size = DISPLAY_H_RES,
          .v_size = DISPLAY_V_RES,
          .hsync_pulse_width = 12,
          .hsync_back_porch = 42,
          .hsync_front_porch = 42,
          .vsync_pulse_width = 2,
          .vsync_back_porch = 8,
          .vsync_front_porch = 166,
      },
      .flags.use_dma2d = true,
  };

  /* init_cmds NULL takes the component's own ST7701 sequence. The field
   * notes for this board report the stock component giving a black screen
   * and a hand-written table being needed, so this may not be the end of the
   * story — but it is one build against a maintained sequence rather than
   * 150 lines of register pokes copied from a panel that might not be ours.
   * If the screen stays dark, a board-specific table goes here and the
   * reason is recorded next to it. */
  st7701_vendor_config_t vendor_cfg = {
      .init_cmds = NULL,
      .init_cmds_size = 0,
      .mipi_config = {.dsi_bus = bus, .dpi_config = &dpi_cfg},
      .flags = {.use_mipi_interface = 1},
  };
  esp_lcd_panel_dev_config_t panel_cfg = {
      .reset_gpio_num = -1, /* pulsed above, before the bus existed */
      .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
      .bits_per_pixel = 16,
      .vendor_config = &vendor_cfg,
  };
  err = esp_lcd_new_panel_st7701(io, &panel_cfg, &s_panel);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "ST7701 panel failed: %s", esp_err_to_name(err));
    return err;
  }

  err = esp_lcd_panel_reset(s_panel);
  if (err != ESP_OK) ESP_LOGW(TAG, "panel reset: %s", esp_err_to_name(err));
  err = esp_lcd_panel_init(s_panel);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "panel init failed: %s", esp_err_to_name(err));
    return err;
  }

  backlight(true);
  s_ready = true;
  ESP_LOGI(TAG, "LCD_READY %dx%d st7701 mipi-dsi 2 lanes 500 Mbps, backlight on GPIO%d",
           DISPLAY_H_RES, DISPLAY_V_RES, BOARD_LCD_BACKLIGHT);
  klog("P4", "display up %dx%d", DISPLAY_H_RES, DISPLAY_V_RES);
  return ESP_OK;
}

esp_err_t display_test_pattern(void) {
  if (!s_ready) return ESP_ERR_INVALID_STATE;

  /* RGB565, five bands down the panel's long axis. One row is built and
   * repeated so this needs a row, not a framebuffer. */
  static const uint16_t BANDS[5] = {
      0xF800, /* red   */
      0x07E0, /* green */
      0x001F, /* blue  */
      0xFFFF, /* white */
      0x0000, /* black */
  };
  const int band_rows = DISPLAY_V_RES / 5;
  uint16_t *row = heap_caps_malloc(DISPLAY_H_RES * sizeof(uint16_t), MALLOC_CAP_DMA);
  if (row == NULL) {
    ESP_LOGE(TAG, "no room for a %d-pixel row buffer", DISPLAY_H_RES);
    return ESP_ERR_NO_MEM;
  }

  for (int b = 0; b < 5; b++) {
    for (int x = 0; x < DISPLAY_H_RES; x++) row[x] = BANDS[b];
    const int y_end = (b == 4) ? DISPLAY_V_RES : (b + 1) * band_rows;
    for (int y = b * band_rows; y < y_end; y++) {
      esp_err_t e = esp_lcd_panel_draw_bitmap(s_panel, 0, y, DISPLAY_H_RES, y + 1, row);
      if (e != ESP_OK) {
        ESP_LOGE(TAG, "draw failed at row %d: %s", y, esp_err_to_name(e));
        free(row);
        return e;
      }
    }
  }
  free(row);
  ESP_LOGI(TAG, "test pattern drawn: red, green, blue, white, black top to bottom");
  return ESP_OK;
}
