#include "board_i2c.h"

#include <stdbool.h>
#include <stdio.h>

#include "board_d4v1.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "board_i2c";
static i2c_master_bus_handle_t s_bus;

/*
 * One creator, decided once.
 *
 * `if (s_bus == NULL) create` is a check-then-act, and the two callers are
 * different tasks: touch_init() from the display branch and audio_init() from
 * the codec bring-up. Both arriving before either finished would call
 * i2c_new_master_bus twice on I2C_NUM_0, and the second one fails with the
 * port already installed - which reads as "the codec is broken" on a board
 * where the codec is fine, the exact confusion this file exists to prevent.
 *
 * A mutex rather than a critical section, because the work it guards
 * allocates and talks to a driver. The mutex itself is created under a
 * portMUX one-shot, the same pattern hardware_validation.c uses, so there is
 * no init ordering requirement on whoever asks for the bus first.
 */
static SemaphoreHandle_t s_lock;
static portMUX_TYPE s_init_mux = portMUX_INITIALIZER_UNLOCKED;

static void lock_once(void) {
  if (s_lock == NULL) {
    portENTER_CRITICAL(&s_init_mux);
    if (s_lock == NULL) s_lock = xSemaphoreCreateMutex();
    portEXIT_CRITICAL(&s_init_mux);
  }
  if (s_lock) xSemaphoreTake(s_lock, portMAX_DELAY);
}

static void unlock(void) {
  if (s_lock) xSemaphoreGive(s_lock);
}

esp_err_t board_i2c_bus(i2c_master_bus_handle_t *out) {
  if (out == NULL) return ESP_ERR_INVALID_ARG;
  if (s_bus != NULL) {
    *out = s_bus;
    return ESP_OK;
  }

  lock_once();
  if (s_bus != NULL) {
    /* Someone else created it while this caller waited. */
    unlock();
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
    unlock();
    return err;
  }
  ESP_LOGI(TAG, "I2C0 up on SDA%d/SCL%d", BOARD_I2C_SDA, BOARD_I2C_SCL);
  unlock();

  *out = s_bus;
  /* The scan is 112 probes at a 50 ms timeout - up to 5.6 s on a quiet bus -
   * and it used to run inside the creation path, holding the second caller
   * off the bus for all of it. It stays here, so the boot log is unchanged
   * and the first driver up still pays for it, but it is outside the lock:
   * anything else asking for the handle now gets it immediately. */
  board_i2c_scan_once();
  return ESP_OK;
}

void board_i2c_scan_once(void) {
  static bool scanned;
  bool go = false;
  portENTER_CRITICAL(&s_init_mux);
  if (!scanned) {
    scanned = true;
    go = true;
  }
  portEXIT_CRITICAL(&s_init_mux);
  if (go) board_i2c_scan();
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
