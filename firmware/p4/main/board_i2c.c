#include "board_i2c.h"

#include "board_d4v1.h"
#include "esp_log.h"

static const char *TAG = "board_i2c";
static i2c_master_bus_handle_t s_bus;

esp_err_t board_i2c_bus(i2c_master_bus_handle_t *out) {
  if (s_bus != NULL) {
    *out = s_bus;
    return ESP_OK;
  }

  i2c_master_bus_config_t cfg = {
      .i2c_port = I2C_NUM_0,
      .sda_io_num = BOARD_I2C_SDA,
      .scl_io_num = BOARD_I2C_SCL,
      .clk_source = I2C_CLK_SRC_DEFAULT,
      .glitch_ignore_cnt = 7,
      .flags.enable_internal_pullup = true,
  };
  esp_err_t err = i2c_new_master_bus(&cfg, &s_bus);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "bus on SDA%d/SCL%d failed: %s", BOARD_I2C_SDA, BOARD_I2C_SCL,
             esp_err_to_name(err));
    s_bus = NULL;
    return err;
  }
  ESP_LOGI(TAG, "I2C0 up on SDA%d/SCL%d", BOARD_I2C_SDA, BOARD_I2C_SCL);
  *out = s_bus;
  board_i2c_scan();
  return ESP_OK;
}

void board_i2c_scan(void) {
  if (s_bus == NULL) return;
  /* Logged once at bring-up because the board notes disagree with the parts:
   * they list the codec at 0x5d, which is the touch controller's address, and
   * the ES8311's own address depends on its CE pin (0x18 or 0x19). One scan
   * settles what is actually on the wire instead of picking a datasheet
   * default and hoping. */
  char found[96];
  int len = 0;
  int count = 0;
  for (uint8_t addr = 0x08; addr < 0x78; addr++) {
    if (i2c_master_probe(s_bus, addr, 50) != ESP_OK) continue;
    count++;
    if (len < (int)sizeof(found) - 8) {
      len += snprintf(found + len, sizeof(found) - len, "0x%02x ", addr);
    }
  }
  if (count == 0) ESP_LOGW(TAG, "I2C scan: nothing answered on SDA%d/SCL%d", BOARD_I2C_SDA,
                           BOARD_I2C_SCL);
  else ESP_LOGI(TAG, "I2C scan: %d device(s): %s", count, found);
}
